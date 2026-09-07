import { fileURLToPath } from 'node:url';
import { options, readSecret, runSession } from '../../agent/session.mjs';
import { isolatedInvocation } from '../../agent/codex/adapter.mjs';
import { runtime } from './fixtures.mjs';
import { RunnerError } from '../../agent/transport.mjs';
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.on('message', (value) => {
  if (['STOP', 'SIGTERM', 'SIGINT'].includes(value)) stop();
});
process.once('disconnect', stop);
let calls = 0;
try {
  const config = options(process.argv.slice(2));
  const secret = await readSecret(controller.signal);
  await runSession({
    ...config,
    mode: 'codex_design',
    pairingSecret: secret,
    signal: controller.signal,
    designAdapter: {
      runtime,
      async execute(spec, attempt, options) {
        calls++;
        console.log('TEST_CLI_INVOCATION');
        try {
          return await isolatedInvocation(
            process.execPath,
            [fileURLToPath(new URL('./stub-cli.mjs', import.meta.url))],
            spec,
            attempt,
            options,
          );
        } catch (error) {
          if (
            spec.input.brief.niche === 'fixture-stop-unconfirmed' &&
            options.signal.aborted
          )
            throw new RunnerError('STOP_UNCONFIRMED');
          throw error;
        }
      },
    },
  });
} catch (error) {
  if (!controller.signal.aborted || error.code === 'STOP_UNCONFIRMED') {
    console.error(
      `RUNNER_STOPPED ${/^[A-Z_]+$/.test(error.code) ? error.code : 'TEST_FAILED'}`,
    );
    process.exitCode = 1;
  }
} finally {
  controller.abort();
  process.stdin.pause();
  if (process.connected) process.disconnect();
  console.log(`TEST_CLI_CALLS ${calls}`);
  console.log('RUNNER_STOPPED');
}
