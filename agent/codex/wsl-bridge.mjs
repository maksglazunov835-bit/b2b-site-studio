import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { LAB, labEnvironment } from './wsl-policy.mjs';
import { RunnerError } from '../transport.mjs';

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
  const source = runtime.replace("'./wsl-policy.mjs'", JSON.stringify(uri));
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
  { signal, onData, onStarted, timeoutMs = 45000, diagnosticFault } = {},
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
    return await new Promise((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        env: command.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let result,
        error,
        bytes = 0,
        stopping = false,
        cleanupTimer;
      const stop = (code) => {
        error ??= new RunnerError(code);
        if (stopping) return;
        stopping = true;
        clearInterval(pulse);
        child.stdin.end('stop\n');
        // A dead wsl.exe is not proof of a dead Linux process tree.
        cleanupTimer = setTimeout(() => {
          error = new RunnerError('STOP_UNCONFIRMED');
          child.kill();
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
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          bytes += Buffer.byteLength(line);
          if (bytes > 262144) return stop('CODEX_OUTPUT_LIMIT');
          const value = JSON.parse(line);
          if (value.type === 'result') result = value.value;
          else if (value.type === 'error')
            error = new RunnerError(
              /^[A-Z_]{1,64}$/.test(value.code)
                ? value.code
                : 'LAB_SETUP_REQUIRED',
            );
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
          } else if (['stdout', 'stderr'].includes(value.type))
            onData?.(value.type, Buffer.from(value.data, 'base64'));
          else stop('CODEX_INVALID_OUTPUT');
        } catch {
          stop('CODEX_INVALID_OUTPUT');
        }
      });
      child.stderr.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 262144) stop('CODEX_OUTPUT_LIMIT');
      });
      child.stdin.on('error', () => {});
      child.once('error', () => {
        error = new RunnerError('LAB_SETUP_REQUIRED');
      });
      child.once('close', async (code, signalCode) => {
        clearInterval(pulse);
        clearTimeout(deadline);
        clearTimeout(cleanupTimer);
        lines.close();
        signal?.removeEventListener('abort', abort);
        if (signalCode || code !== 0 || (!result && !error)) {
          let confirmed = false;
          if (request.operation !== 'receipt') {
            for (let n = 0; n < 4 && !confirmed; n++) {
              await new Promise((r) => setTimeout(r, 800));
              try {
                confirmed =
                  (
                    await callLab(
                      { operation: 'receipt', receiptId: runId },
                      { timeoutMs: 6000 },
                    )
                  ).stopped === true;
              } catch {}
            }
          }
          error = new RunnerError(
            confirmed ? 'RUNNER_STOPPED' : 'STOP_UNCONFIRMED',
          );
        }
        if (error) reject(error);
        else resolve(result);
      });
      child.stdin.write(packet + '\n');
    });
  } finally {
    listener?.close();
  }
}
