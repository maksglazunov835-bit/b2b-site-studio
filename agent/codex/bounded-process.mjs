import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RunnerError } from '../transport.mjs';

async function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
  if (process.platform !== 'linux') return true;
  // Linux containers may retain orphan zombies. They cannot execute or hold pipes.
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0]))
        return true;
    } catch (e) {
      if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e;
    }
  }
  return false;
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let nativeHelper;
function windowsHelper() {
  nativeHelper ??= new Promise((resolve, reject) => {
    const root = realpathSync(tmpdir());
    const directory = mkdtempSync(path.join(root, 'b2b-job-host-'));
    process.once('exit', () => {
      if (
        path.dirname(directory) === root &&
        realpathSync(directory) === directory
      )
        rmSync(directory, { recursive: true });
    });
    const output = path.join(directory, 'job-host.exe');
    const compiler = spawn(
      path.join(
        process.env.SystemRoot,
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ),
      [
        '/nologo',
        '/target:exe',
        '/reference:System.Web.Extensions.dll',
        `/out:${output}`,
        fileURLToPath(new URL('./WindowsJob.cs', import.meta.url)),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: Object.fromEntries(
          ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']
            .filter((k) => process.env[k])
            .map((k) => [k, process.env[k]]),
        ),
      },
    );
    const timer = setTimeout(() => {
      compiler.kill();
      reject(new RunnerError('CODEX_NOT_AVAILABLE'));
    }, 5000);
    compiler.once('error', () => {
      clearTimeout(timer);
      reject(new RunnerError('CODEX_NOT_AVAILABLE'));
    });
    compiler.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new RunnerError('CODEX_NOT_AVAILABLE'));
    });
  });
  return nativeHelper;
}

export async function runBounded(
  file,
  args,
  {
    cwd,
    input = '',
    signal,
    timeoutMs = 5000,
    env,
    maxBytes = 131072,
    onStdout,
    onStderr,
    capture = true,
  } = {},
) {
  if (signal?.aborted) throw new RunnerError('RUNNER_STOPPED');
  const started = Date.now();
  const helper = process.platform === 'win32' ? await windowsHelper() : null;
  if (Date.now() - started >= timeoutMs) throw new RunnerError('CODEX_TIMEOUT');
  timeoutMs -= Date.now() - started;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RunnerError('RUNNER_STOPPED'));
    const windows = process.platform === 'win32';
    const child = spawn(windows ? helper : file, windows ? [] : args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: !windows,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '',
      bytes = 0,
      failure,
      settled = false,
      exited = false,
      exitCode,
      signalCode;
    let cleaning = false,
      drainTimer;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!confirmed) failure = new RunnerError('STOP_UNCONFIRMED');
      if (failure) reject(failure);
      else resolve({ stdout, stderr, code: exitCode, signalCode });
    };
    const cleanup = async () => {
      if (cleaning || settled) return;
      cleaning = true;
      if (windows) {
        child.stdin.end('stop\n');
        // The supervisor confirms ActiveProcesses==0; leader exit alone never does.
        drainTimer = setTimeout(() => {
          child.kill();
          finish(false);
        }, 4000);
        return;
      }
      drainTimer = setTimeout(() => finish(false), 3500);
      try {
        if (!child.pid) return finish(true);
        const alive = await groupAlive(child.pid);
        if (alive && exited && !failure)
          failure = new RunnerError('CODEX_PROCESS_FAILED');
        if (alive) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch (e) {
            if (e.code !== 'ESRCH') throw e;
          }
          await delay(150);
          // Never cancel escalation merely because the group leader closed stdio.
          if (await groupAlive(child.pid)) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch (e) {
              if (e.code !== 'ESRCH') throw e;
            }
          }
        }
        const end = Date.now() + 1200;
        while (await groupAlive(child.pid)) {
          if (Date.now() >= end) return finish(false);
          await delay(20);
        }
        const drainEnd = Date.now() + 500;
        while (
          (!exited ||
            !child.stdout.readableEnded ||
            !child.stderr.readableEnded) &&
          Date.now() < drainEnd
        )
          await delay(10);
        finish(
          exited && child.stdout.readableEnded && child.stderr.readableEnded,
        );
      } catch {
        finish(false);
      }
    };
    const terminate = (code) => {
      failure ??= new RunnerError(code);
      void cleanup();
    };
    const abort = () => terminate('RUNNER_STOPPED');
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => terminate('CODEX_TIMEOUT'), timeoutMs);
    const consume = (chunk, isError) => {
      if (settled || failure) return;
      bytes += chunk.length;
      if (bytes > maxBytes) return terminate('CODEX_OUTPUT_LIMIT');
      try {
        (isError ? onStderr : onStdout)?.(chunk);
        if (capture) {
          if (isError) stderr += chunk.toString('utf8');
          else stdout += chunk.toString('utf8');
        }
      } catch (e) {
        terminate(e instanceof RunnerError ? e.code : 'CODEX_INVALID_OUTPUT');
      }
    };
    child.stdout.on('data', (c) => consume(c, false));
    child.stderr.on('data', (c) => consume(c, true));
    child.stdin.on('error', () => {});
    child.once('error', () => {
      failure ??= new RunnerError('CODEX_NOT_AVAILABLE');
      if (!child.pid) finish(true);
      else void cleanup();
    });
    child.once('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      signalCode = sig;
      if (!windows) void cleanup();
      else {
        const confirmed = sig === null && [0, 121, 122, 123].includes(code);
        if (!confirmed) return finish(false);
        if (code === 121) failure ??= new RunnerError('CODEX_NOT_AVAILABLE');
        if (code === 123) failure ??= new RunnerError('RUNNER_STOPPED');
        // Stream data is drained before close; bound pipes even if the supervisor fails.
        drainTimer ??= setTimeout(() => finish(false), 1000);
      }
    });
    child.once('close', () => {
      if (windows && exited)
        finish(signalCode === null && [0, 121, 122, 123].includes(exitCode));
    });
    if (windows)
      child.stdin.write(
        JSON.stringify({ file, args, cwd: cwd ?? process.cwd(), input }) + '\n',
      );
    else child.stdin.end(input);
  });
}
