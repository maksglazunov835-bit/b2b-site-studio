import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Only built-ins load before this catchable bootstrap. Test module injection is
// a JS function parameter, never a CLI/env/job-selected module or program.
export async function main({
  load = () =>
    Promise.all([import('./codex/adapter.mjs'), import('./session.mjs')]),
  args = process.argv.slice(2),
  input = process.stdin,
  send = (value) => process.send?.(value),
  log = console.log,
} = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const message = (value) => {
    if (value === 'STOP') stop();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('message', message);
  process.once('disconnect', stop);
  const runId = randomUUID(),
    startedAt = new Date().toISOString();
  let startup, failure;
  try {
    const { createStartup } = await import('./startup-receipt.mjs');
    const { validInvocation } = await import('./codex/invocation-receipt.mjs');
    startup = createStartup({ runId, startedAt, send });
    const [{ officialAdapter }, { options, readSecret, runSession }] =
      await load();
    startup.complete('bootstrap_import');
    startup.begin('options');
    args = [...args];
    const wslIndex = args.indexOf('--codex-wsl'),
      index = args.indexOf('--codex-bin');
    if (
      (wslIndex >= 0 && index >= 0) ||
      (wslIndex < 0 && (index < 0 || !args[index + 1]))
    )
      throw Object.assign(Error(), { code: 'INVALID_OPTIONS' });
    const binary =
      wslIndex >= 0
        ? (args.splice(wslIndex, 1), null)
        : args.splice(index, 2)[1];
    const registrationOnly = args.includes('--registration-only');
    if (registrationOnly) args.splice(args.indexOf('--registration-only'), 1);
    const config = options(args);
    startup.complete('options');
    startup.begin('preflight');
    const adapter = await officialAdapter(binary, {
      transport: wslIndex >= 0 ? 'wsl' : 'native',
      signal: controller.signal,
    });
    if (controller.signal.aborted)
      throw Object.assign(Error(), { code: 'RUNNER_STOPPED' });
    if (adapter.runtime.status !== 'ready')
      throw Object.assign(Error(), {
        code: adapter.diagnostics?.status ?? adapter.runtime.status,
      });
    startup.complete('preflight');
    startup.begin('pairing_input');
    const secret = await readSecret(controller.signal, input);
    startup.complete('pairing_input');
    await runSession({
      ...config,
      mode: 'codex_design',
      pairingSecret: secret,
      signal: controller.signal,
      designAdapter: adapter,
      registrationOnly,
      startup,
      onInvocation: (value) => {
        if (!validInvocation(value) || value.runId !== runId)
          throw Object.assign(Error(), { code: 'CODEX_INVALID_OUTPUT' });
        send(value);
      },
      log,
    });
  } catch (error) {
    failure = error;
    if (startup)
      startup.fail(
        controller.signal.aborted && error?.code !== 'STOP_UNCONFIRMED'
          ? { code: 'RUNNER_STOPPED' }
          : error,
      );
    else
      send({
        type: 'B2B_RUNNER_STARTUP',
        runId,
        sequence: 1,
        startedAt,
        updatedAt: new Date().toISOString(),
        currentStage: 'bootstrap_import',
        lastCompletedStage: null,
        errorCode: 'RUNNER_BOOTSTRAP_ERROR',
        httpStatus: null,
        httpErrorCode: null,
        stopConfirmed: true,
      });
    if (!controller.signal.aborted || error?.code === 'STOP_UNCONFIRMED')
      process.exitCode = 1;
  } finally {
    controller.abort();
    input.pause();
    startup?.stop(failure?.code !== 'STOP_UNCONFIRMED');
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    process.removeListener('message', message);
    process.removeListener('disconnect', stop);
    if (process.connected) process.disconnect();
    log(`RUNNER_STOPPED ${startup?.snapshot().errorCode ?? 'NONE'}`);
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  await main();
