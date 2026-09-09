import { officialAdapter } from './codex/adapter.mjs';
import { options, readSecret, runSession } from './session.mjs';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.on('message', (value) => {
  if (value === 'STOP') stop();
});
process.once('disconnect', stop);
try {
  const args = process.argv.slice(2);
  const wslIndex = args.indexOf('--codex-wsl');
  const index = args.indexOf('--codex-bin');
  if (
    (wslIndex >= 0 && index >= 0) ||
    (wslIndex < 0 && (index < 0 || !args[index + 1]))
  )
    throw new Error();
  const binary =
    wslIndex >= 0 ? (args.splice(wslIndex, 1), null) : args.splice(index, 2)[1];
  const config = options(args);
  const adapter = await officialAdapter(binary, {
    transport: wslIndex >= 0 ? 'wsl' : 'native',
    signal: controller.signal,
  });
  if (controller.signal.aborted)
    throw Object.assign(Error('RUNNER_STOPPED'), { code: 'RUNNER_STOPPED' });
  console.log(
    `CODEX_PREFLIGHT ${adapter.runtime.cliVersion} ${adapter.runtime.status}`,
  );
  const secret = await readSecret(controller.signal);
  await runSession({
    ...config,
    mode: 'codex_design',
    pairingSecret: secret,
    signal: controller.signal,
    designAdapter: adapter,
  });
} catch (error) {
  if (!controller.signal.aborted || error.code === 'STOP_UNCONFIRMED') {
    console.error(
      `RUNNER_STOPPED ${/^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'INVALID_OPTIONS'}`,
    );
    process.exitCode = 1;
  }
} finally {
  controller.abort();
  process.stdin.pause();
  if (process.connected) process.disconnect();
  console.log('RUNNER_STOPPED');
}
