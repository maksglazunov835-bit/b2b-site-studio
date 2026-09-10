// Test-only relay wiring. Production callLab never accepts this executable.
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { supervise } from '../../agent/codex/wsl-runtime.mjs';
import { boundedProcess } from '../../agent/codex/adapter.mjs';
import { diagnostic } from '../../agent/codex/invocation-receipt.mjs';
const scenario = process.argv[2],
  controller = new AbortController();
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line === 'stop') controller.abort();
});
await new Promise((resolve) => lines.once('line', resolve));
try {
  const args = [
    fileURLToPath(new URL('./protocol-child.mjs', import.meta.url)),
    scenario === 'parser-exception'
      ? 'success'
      : scenario === 'stop-unconfirmed'
        ? 'auth'
        : scenario,
  ];
  const options = {
    cwd: process.cwd(),
    signal: controller.signal,
    timeoutMs: scenario === 'timeout' ? 600 : 6000,
    onData: (type, data) => emit({ type, data: data.toString('base64') }),
  };
  let result;
  if (process.platform === 'linux') {
    result = await supervise(
      await readFile(
        new URL('../../agent/codex/wsl-supervisor.py', import.meta.url),
        'utf8',
      ),
      [process.execPath, ...args],
      {
        ...options,
        onStarted: () => emit({ type: 'process', value: { started: true } }),
      },
    );
  } else {
    if (scenario === 'timeout') await boundedProcess(process.execPath,['-e',''],{timeoutMs:15000});
    result = await boundedProcess(process.execPath, args, {
      ...options,
      capture: false,
      onStdout: (data) => options.onData('stdout', data),
      onStderr: (data) => options.onData('stderr', data),
      onProcess: (value) => emit({ type: 'process', value }),
    });
  }
  const { code, signalCode, confirmed, reason } = result;
  const facts = {
    code,
    signalCode,
    confirmed,
    ...(reason ? { reason } : {}),
    started: true,
  };
  if (scenario === 'stop-unconfirmed') {
    // Actual child is reaped; simulate loss of its confirmation, never leak a process.
    emit({
      type: 'error',
      code: 'STOP_UNCONFIRMED',
      processResult: { confirmed: false, code: null, signalCode: null },
    });
  } else {
    emit({ type: 'process', value: facts });
    emit({ type: 'result', value: facts });
  }
} catch (error) {
  if (scenario === 'stop-unconfirmed')
    emit({
      type: 'error',
      code: 'STOP_UNCONFIRMED',
      processResult: { confirmed: false, code: null, signalCode: null },
    });
  else
    emit({
      type: 'error',
      code: error.code ?? 'CODEX_PROCESS_FAILED',
      diagnostic: diagnostic(error),
      processResult: error.processResult,
    });
} finally {
  lines.close();
  process.stdin.destroy();
}
