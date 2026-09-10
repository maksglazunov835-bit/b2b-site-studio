import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LAB, labEnvironment } from './wsl-policy.mjs';
import { RunnerError } from '../transport.mjs';
import {
  diagnostic,
  diagnosticError,
  validDiagnostic,
  validProcessResult,
} from './invocation-receipt.mjs';

const digest = (s) => createHash('sha256').update(s).digest('hex');
export async function labBundle() {
  const policy = (
    await readFile(new URL('./wsl-policy.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const runtime = (
    await readFile(new URL('./wsl-runtime.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const supervisor = (
    await readFile(new URL('./wsl-supervisor.py', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const uri =
    'data:text/javascript;base64,' + Buffer.from(policy).toString('base64');
  const dataUri = (value) =>
    'data:text/javascript;base64,' + Buffer.from(value).toString('base64');
  const errors = (
    await readFile(new URL('../runner-error.mjs', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const receipts = (
    await readFile(new URL('./invocation-receipt.mjs', import.meta.url), 'utf8')
  )
    .replaceAll('\r\n', '\n')
    .replace("'../runner-error.mjs'", JSON.stringify(dataUri(errors)));
  const source = runtime
    .replace("'./wsl-policy.mjs'", JSON.stringify(uri))
    .replace("'./invocation-receipt.mjs'", JSON.stringify(dataUri(receipts)));
  return { source, supervisor, sha256: digest(source + supervisor) };
}

// Only this committed bootstrap is a program. The brief stays in the separately
// parsed request. Neither a platform credential nor a user-selected program crosses.
export const BOOTSTRAP = `const r=require('readline').createInterface({input:process.stdin});
let size=0;process.stdin.on('data',c=>{size+=c.length;if(size>524288)process.exit(1)});
r.once('line',async line=>{r.close();try{const p=JSON.parse(line);
if(require('crypto').createHash('sha256').update(p.source+p.supervisor).digest('hex')!==p.sha256)throw Error();
const m=await import('data:text/javascript;base64,'+Buffer.from(p.source).toString('base64'));
await m.relay(p.request,p.supervisor);process.exit(0)}catch{process.exit(1)}});`;

export function wslCommand(source = process.env) {
  if (process.platform !== 'win32') throw new RunnerError('LAB_SETUP_REQUIRED');
  const executable = path.join(source.SystemRoot, 'System32', 'wsl.exe');
  return {
    executable,
    args: [
      '-d',
      LAB.distro,
      '-u',
      LAB.user,
      '--cd',
      LAB.home,
      '--exec',
      '/usr/bin/env',
      '-i',
      ...Object.entries({
        ...labEnvironment(),
        WSL_DISTRO_NAME: LAB.distro,
      }).map(([k, v]) => `${k}=${v}`),
      LAB.node,
      '-e',
      BOOTSTRAP,
    ],
    env: { SystemRoot: source.SystemRoot, WINDIR: source.WINDIR },
  };
}

export async function callLab(
  request,
  {
    signal,
    onData,
    onStarted,
    onProcess,
    timeoutMs = 45000,
    diagnosticFault,
  } = {},
) {
  if (signal?.aborted) throw new RunnerError('RUNNER_STOPPED');
  if (
    !['preflight', 'invoke', 'lifecycle', 'receipt'].includes(request.operation)
  )
    throw new RunnerError('LAB_SETUP_REQUIRED');
  if (diagnosticFault && request.operation !== 'lifecycle')
    throw new RunnerError('LAB_SETUP_REQUIRED');
  const bundle = await labBundle(),
    command = wslCommand();
  const runId = randomBytes(16).toString('hex');
  const host = Object.entries(os.networkInterfaces())
    .filter(([name]) => name.includes('WSL'))
    .flatMap(([, rows]) => rows)
    .find((row) => row.family === 'IPv4')?.address;
  let listener;
  if (['preflight', 'invoke'].includes(request.operation)) {
    if (!host) throw new RunnerError('LAB_SETUP_REQUIRED');
    listener = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('B2B_SYNTHETIC_CONTROL\n');
    });
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, host, resolve);
    });
  }
  const packet = JSON.stringify({
    ...bundle,
    request: {
      ...request,
      runId,
      windowsControl: listener ? { host, port: listener.address().port } : null,
    },
  });
  try {
    if (Buffer.byteLength(packet) > 262144)
      throw new RunnerError('LAB_INPUT_REJECTED');
    const child = spawn(command.executable, command.args, {
      env: command.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return await relayProcess(child, packet, {
      signal,
      onData,
      onStarted,
      onProcess,
      timeoutMs,
      diagnosticFault,
      recoverStop: async () => {
        if (request.operation === 'receipt') return false;
        for (let n = 0; n < 4; n++) {
          await new Promise((r) => setTimeout(r, 800));
          try {
            if (
              (
                await callLab(
                  { operation: 'receipt', receiptId: runId },
                  { timeoutMs: 6000 },
                )
              ).stopped === true
            )
              return true;
          } catch {}
        }
        return false;
      },
    });
  } finally {
    listener?.close();
  }
}

// Shared bounded pipe protocol. It accepts an already-owned child, not a
// job-selected executable. Production callLab always constructs the fixed WSL command.
export function relayProcess(
  child,
  packet,
  {
    signal,
    onData,
    onStarted,
    onProcess,
    timeoutMs = 45000,
    diagnosticFault,
    recoverStop = async () => false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let result,
      error,
      bytes = 0,
      stopping = false,
      cleanupTimer,
      drainTimer,
      settled = false,
      cleanupFailed = false,
      processResult = {};
    const measured = (value) => {
      if (!validProcessResult(value))
        throw diagnosticError(
          'CODEX_INVALID_OUTPUT',
          diagnostic({ code: 'CODEX_INVALID_OUTPUT' }, { source: 'transport' }),
        );
      processResult = { ...processResult, ...value };
      onProcess?.(value);
    };
    const stop = (value) => {
      error ??=
        typeof value === 'string'
          ? diagnosticError(
              value,
              diagnostic(
                { code: value },
                {
                  source: 'transport',
                  category:
                    value === 'CODEX_TIMEOUT'
                      ? 'timeout'
                      : value === 'RUNNER_STOPPED'
                        ? 'cancelled'
                        : 'unclassified',
                },
              ),
            )
          : value;
      if (stopping) return;
      stopping = true;
      clearInterval(pulse);
      child.stdin.end('stop\n');
      // A dead wsl.exe is not proof of a dead Linux process tree.
      cleanupTimer = setTimeout(() => {
        cleanupFailed = true;
        child.kill();
        void complete(null, null, false);
      }, 6500);
    };
    const abort = () => stop('RUNNER_STOPPED');
    const pulse = setInterval(() => {
      if (!stopping) child.stdin.write('pulse\n');
    }, 500);
    const deadline = setTimeout(
      () => stop('CODEX_TIMEOUT'),
      Math.min(timeoutMs, LAB.timeoutMs + 45000),
    );
    signal?.addEventListener('abort', abort, { once: true });
    // Bound bytes before readline can accumulate an unterminated hostile line.
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 262144) {
        lines.close();
        stop('CODEX_OUTPUT_LIMIT');
      }
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (settled || bytes > 262144) return;
      try {
        const value = JSON.parse(line);
        if (value.type === 'result') result = value.value;
        else if (value.type === 'error') {
          error ??= diagnosticError(
            value.code,
            validDiagnostic(value.diagnostic)
              ? value.diagnostic
              : diagnostic(
                  { code: value.code },
                  { source: 'sandbox', stage: 'preflight' },
                ),
          );
          if (value.processResult) measured(value.processResult);
          if (value.code === 'STOP_UNCONFIRMED') cleanupFailed = true;
        } else if (value.type === 'process') measured(value.value);
        else if (value.type === 'started') {
          onStarted?.();
          if (diagnosticFault === 'relay-eof') {
            clearInterval(pulse);
            child.stdin.end();
          }
          if (diagnosticFault === 'relay-kill') {
            clearInterval(pulse);
            child.kill();
          }
          if (diagnosticFault === 'pulse-loss') clearInterval(pulse);
        } else if (['stdout', 'stderr'].includes(value.type)) {
          if (!error) {
            try {
              onData?.(value.type, Buffer.from(value.data, 'base64'));
            } catch (failure) {
              const details = diagnostic(failure, {
                source: 'parser',
                stage: 'parser',
              });
              stop(diagnosticError(details.primaryCode, details));
            }
          }
        } else stop('CODEX_INVALID_OUTPUT');
      } catch (failure) {
        stop(
          diagnosticError(
            'CODEX_INVALID_OUTPUT',
            diagnostic(failure, { source: 'transport' }),
          ),
        );
      }
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 262144) stop('CODEX_OUTPUT_LIMIT');
    });
    child.stdin.on('error', () => {});
    child.once('error', (failure) => {
      error ??= diagnosticError(
        'LAB_SETUP_REQUIRED',
        diagnostic(failure, { source: 'transport', stage: 'provider_start' }),
      );
    });
    const complete = async (code, signalCode, closed) => {
      if (settled) return;
      settled = true;
      clearInterval(pulse);
      clearTimeout(deadline);
      clearTimeout(cleanupTimer);
      clearTimeout(drainTimer);
      lines.close();
      signal?.removeEventListener('abort', abort);
      if (!closed || signalCode || code !== 0 || (!result && !error)) {
        let confirmed = false;
        try {
          confirmed = await recoverStop();
        } catch {}
        cleanupFailed ||= !confirmed;
        measured({ confirmed });
        error ??= diagnosticError(
          'RUNNER_STOPPED',
          diagnostic({ code: 'RUNNER_STOPPED' }, { source: 'transport' }),
        );
      }
      if (cleanupFailed) {
        measured({ confirmed: false, cleanupCode: 'STOP_UNCONFIRMED' });
        error = diagnosticError(
          'STOP_UNCONFIRMED',
          diagnostic(error ?? { code: 'STOP_UNCONFIRMED' }, {
            source: 'transport',
            stage: 'cleanup',
          }),
        );
      }
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      if (error) {
        error.processResult = processResult;
        reject(error);
      } else resolve(result);
    };
    child.once('exit', (code, signalCode) => {
      drainTimer = setTimeout(() => {
        void complete(code, signalCode, false);
      }, 500);
    });
    child.once('close', (code, signalCode) => {
      void complete(code, signalCode, true);
    });
    child.stdin.write(packet + '\n');
  });
}
