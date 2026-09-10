"""Fixed local lifecycle helper, never exposed to the model or accepted from a job."""
import ctypes
import base64
import json
import hashlib
import os
import selectors
import signal
import subprocess
import sys
import time


def main():
    libc = ctypes.CDLL(None, use_errno=True)
    # Adopt orphan descendants. Parent death requests cleanup, not immediate exit.
    if libc.prctl(36, 1, 0, 0, 0) or libc.prctl(1, signal.SIGTERM, 0, 0, 0):
        raise RuntimeError('STOP_UNCONFIRMED')
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append('STOP'))
    signal.signal(signal.SIGINT, lambda *_: stopping.append('STOP'))
    if os.getppid() == 1:
        stopping.append('PARENT_LOST')
    request = json.loads(sys.stdin.buffer.readline(262145))
    if request['timeoutMs'] > 150000 or request['timeoutMs'] < 100:
        raise RuntimeError('LAB_SETUP_REQUIRED')
    selector = selectors.DefaultSelector()
    start = time.monotonic()
    bytes_seen = 0
    code = None
    child = None
    control_buffer = b''

    def descendants():
        rows = {}
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            try:
                with open('/proc/' + name + '/stat') as file:
                    fields = file.read().rsplit(')', 1)[1].split()
                rows[int(name)] = (int(fields[1]), fields[0], fields[19])
            except (FileNotFoundError, ProcessLookupError):
                pass
        owned = {os.getpid()}
        for _ in range(len(rows)):
            new = {pid for pid, row in rows.items() if row[0] in owned}
            if new <= owned:
                break
            owned |= new
        return {pid: rows[pid] for pid in owned - {os.getpid()} if pid in rows}

    def emit(value):
        try:
            print(json.dumps(value), flush=True)
        except BrokenPipeError:
            stopping.append('RELAY_LOST')

    try:
        child = subprocess.Popen(request['args'], cwd=request['cwd'], env=request['env'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True)
        child.stdin.write(request.get('input', '').encode())
        if not request.get('interactive'):
            child.stdin.close()
        for stream, kind in [(child.stdout, 'stdout'), (child.stderr, 'stderr'),
                             (sys.stdin.buffer, 'control')]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, kind)
        emit({'type': 'started'})
        while not stopping:
            if time.monotonic() - start > request['timeoutMs'] / 1000:
                stopping.append('TIMEOUT')
                break
            for key, _ in selector.select(.05):
                data = os.read(key.fileobj.fileno(), 4096)
                if key.data == 'control':
                    if not data:
                        stopping.append('RELAY_LOST')
                    control_buffer += data
                    if len(control_buffer) > 131072:
                        stopping.append('CONTROL_LIMIT')
                    while b'\n' in control_buffer:
                        line, control_buffer = control_buffer.split(b'\n', 1)
                        if line == b'stop':
                            stopping.append('STOP')
                            continue
                        message = json.loads(line)
                        if message.get('type') == 'input' and request.get('interactive'):
                            child.stdin.write(base64.b64decode(message['data'], validate=True))
                            child.stdin.flush()
                        elif message.get('type') == 'end' and request.get('interactive'):
                            child.stdin.close()
                        else:
                            stopping.append('CONTROL_INVALID')
                elif not data:
                    selector.unregister(key.fileobj)
                else:
                    bytes_seen += len(data)
                    if bytes_seen > 131072:
                        stopping.append('OUTPUT_LIMIT')
                        break
                    emit({'type': key.data, 'data': base64.b64encode(data).decode()})
            code = child.poll()
            if code is not None and not any(k.data != 'control' for k in selector.get_map().values()):
                break
    except Exception as error:
        text = str(error)
        sample = text[:4096].encode('utf-8')[:4096]
        emit({'type': 'failure', 'diagnostic': {
            'source': 'transport', 'stage': 'stream' if child else 'provider_start',
            'primaryCode': 'CODEX_PROCESS_FAILED', 'category': 'unclassified',
            'httpStatus': None, 'byteLength': len(text.encode('utf-8')),
            'fingerprintBytes': len(sample),
            'fingerprint': hashlib.sha256(sample).hexdigest() if text else None}})
    finally:
        for pid, row in descendants().items():
            if row[1] not in ('Z', 'X'):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        time.sleep(.15)
        # Freeze, kill and reap all still-owned children, including setsid adoptees.
        end = time.monotonic() + 2
        signalled = set()
        while True:
            rows = descendants()
            live = {pid for pid, row in rows.items() if row[1] not in ('Z', 'X')}
            for pid in live:
                try:
                    os.kill(pid, signal.SIGSTOP)
                    os.kill(pid, signal.SIGKILL)
                    signalled.add(pid)
                except ProcessLookupError:
                    pass
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                    if child is not None and pid == child.pid:
                        code = os.waitstatus_to_exitcode(status)
                    if pid == 0:
                        break
                except ChildProcessError:
                    break
            if not descendants():
                break
            if time.monotonic() > end:
                raise RuntimeError('STOP_UNCONFIRMED')
            time.sleep(.02)
        selector.close()
        if request.get('receipt'):
            with open(request['receipt'], 'x', encoding='utf-8') as file:
                with open('/proc/self/stat') as stat:
                    start_ticks = stat.read().rsplit(')', 1)[1].split()[19]
                json.dump({'nonce': request['nonce'], 'stopped': True,
                           'pid': os.getpid(), 'startTicks': start_ticks}, file)
        signal_code = signal.Signals(-code).name if code is not None and code < 0 else None
        emit({'type': 'stopped', 'started': child is not None, 'confirmed': True, 'code': code if code is None or code >= 0 else None,
              'signalCode': signal_code,
              'reason': stopping[0] if stopping else ('DESCENDANTS' if signalled else None)})


try:
    main()
except Exception as error:
    text = str(error)
    sample = text[:4096].encode('utf-8')[:4096]
    print(json.dumps({'type': 'failure', 'code': 'STOP_UNCONFIRMED', 'diagnostic': {
        'source': 'transport', 'stage': 'cleanup', 'primaryCode': 'STOP_UNCONFIRMED',
        'category': 'unclassified', 'httpStatus': None, 'byteLength': len(text.encode('utf-8')),
        'fingerprintBytes': len(sample), 'fingerprint': hashlib.sha256(sample).hexdigest() if text else None}}), flush=True)
    sys.exit(1)
