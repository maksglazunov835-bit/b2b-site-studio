import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { clientEnvironment } from '../../agent/codex/adapter.mjs';
import { validStartup } from '../../agent/startup-receipt.mjs';
import {
  INVOCATION_TYPE,
  validInvocation,
} from '../../agent/codex/invocation-receipt.mjs';

export function observeStartup(child, { drainMs = 500 } = {}) {
  const at = new Date().toISOString();
  let latest = {
    runId: randomUUID(),
    currentStage: 'bootstrap_import',
    lastCompletedStage: null,
    errorCode: null,
    httpStatus: null,
    httpErrorCode: null,
    startedAt: at,
    updatedAt: at,
    stopConfirmed: false,
  };
  let messages = 0,
    sequence = 0,
    bytes = 0,
    exited = false,
    closed = false,
    settled = false,
    timer;
  const invocations = [];
  let exitCode = null,
    signalCode = null,
    diagnosticError = null,
    finalReceipt = null,
    resolve;
  const finished = new Promise((r) => {
    resolve = r;
  });
  const stop = () => {
    try {
      if (child.connected) child.send('STOP', () => {});
    } catch {
      /* Channel raced with exit. */
    }
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finalReceipt = snapshot();
    resolve({ ...finalReceipt });
  };
  const snapshot = () =>
    finalReceipt
      ? { ...finalReceipt }
      : {
          ...latest,
          exitCode,
          signalCode,
          exited,
          closed,
          errorCode:
            diagnosticError ??
            latest.errorCode ??
            (exited && latest.lastCompletedStage !== 'first_heartbeat'
              ? 'RUNNER_BOOTSTRAP_ERROR'
              : null),
          stopConfirmed: closed && latest.stopConfirmed && !diagnosticError,
          observedAt: new Date().toISOString(),
        };
  child.on('message', (value) => {
    if (settled) return;
    if (value?.type === INVOCATION_TYPE) {
      if (
        invocations.length ||
        !validInvocation(value) ||
        value.runId !== latest.runId ||
        !value.finishedAt
      ) {
        diagnosticError = 'STARTUP_DIAGNOSTIC_INVALID';
        stop();
        return;
      }
      invocations.push(structuredClone(value));
      return;
    }
    if (
      ++messages > 24 ||
      !validStartup(value) ||
      Buffer.byteLength(JSON.stringify(value)) > 2048 ||
      value.sequence <= sequence ||
      (sequence && value.runId !== latest.runId)
    ) {
      diagnosticError = 'STARTUP_DIAGNOSTIC_INVALID';
      stop();
      return;
    }
    sequence = value.sequence;
    latest = { ...value };
  });
  // Drain but never retain stdout/stderr, even when startup fails.
  const discard = (data) => {
    bytes += data.length;
    if (bytes > 32768) {
      diagnosticError = 'STARTUP_OUTPUT_LIMIT';
      stop();
    }
  };
  child.stdout?.on('data', discard);
  child.stderr?.on('data', discard);
  child.stdin?.on('error', () => {});
  child.once('error', () => {
    diagnosticError = 'RUNNER_SPAWN_FAILED';
    exited = true;
    timer = setTimeout(finish, drainMs);
  });
  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    signalCode = signal;
    timer = setTimeout(finish, drainMs);
  });
  child.once('close', (code, signal) => {
    closed = true;
    exited = true;
    exitCode = code;
    signalCode = signal;
    finish();
  });
  return {
    child,
    finished,
    snapshot,
    invocations: () => structuredClone(invocations),
    async waitForHeartbeat(timeoutMs = 60000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (exited) {
          const receipt = await finished;
          throw Object.assign(Error(receipt.errorCode ?? 'RUNNER_STOPPED'), {
            code: receipt.errorCode ?? 'RUNNER_STOPPED',
          });
        }
        if (diagnosticError || latest.errorCode)
          throw Object.assign(Error(), {
            code: diagnosticError ?? latest.errorCode,
          });
        if (latest.lastCompletedStage === 'first_heartbeat') return snapshot();
        await delay(25);
      }
      stop();
      throw Object.assign(Error('STARTUP_TIMEOUT'), {
        code: 'STARTUP_TIMEOUT',
      });
    },
    async finish(timeoutMs = 8000) {
      let deadline;
      try {
        const receipt = await Promise.race([
          finished,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error('STOP_UNCONFIRMED')),
              timeoutMs,
            );
          }),
        ]);
        if (!receipt.stopConfirmed)
          throw Object.assign(Error('STOP_UNCONFIRMED'), {
            code: 'STOP_UNCONFIRMED',
          });
        return receipt;
      } catch (error) {
        if (!exited) {
          diagnosticError = 'STOP_UNCONFIRMED';
          stop();
          child.kill('SIGKILL');
          let cleanupTimer;
          try {
            await Promise.race([
              finished,
              new Promise((r) => {
                cleanupTimer = setTimeout(r, drainMs + 1000);
              }),
            ]);
          } finally {
            clearTimeout(cleanupTimer);
          }
          if (!settled) finish();
        }
        throw error;
      } finally {
        clearTimeout(deadline);
      }
    },
    stop,
  };
}
export function startOfficialRunner(
  origin,
  pairingSecret,
  { registrationOnly = false } = {},
) {
  const child = spawn(
    process.execPath,
    [
      'agent/design-main.mjs',
      '--origin',
      origin,
      '--name',
      'Opt-in WSL Runner',
      '--codex-wsl',
      ...(registrationOnly ? ['--registration-only'] : []),
    ],
    {
      env: clientEnvironment(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  const monitor = observeStartup(child);
  child.stdin.end(pairingSecret + '\n');
  return monitor;
}
