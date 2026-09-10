import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStartup } from '../../agent/startup-receipt.mjs';
import {
  recordedInvocation,
  clientEnvironment,
} from '../../agent/codex/adapter.mjs';
import { relayProcess } from '../../agent/codex/wsl-bridge.mjs';
import { specFor } from './fixtures.mjs';
const startup = createStartup({ send: (value) => process.send(value) });
try {
  await recordedInvocation(
    specFor(),
    1,
    { runId: startup.snapshot().runId, onInvocation: (r) => process.send(r) },
    async (parser, observer) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('./protocol-relay.mjs', import.meta.url)),
          process.argv[2],
        ],
        {
          env: clientEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: false,
        },
      );
      return relayProcess(child, '{}', {
        timeoutMs: 8000,
        onProcess: (r) => observer.process(r),
        onData: (kind, data) => {
          if (process.argv[2] === 'parser-exception')
            throw Error('SYNTHETIC_SECRET_PARSER');
          parser[kind](data);
        },
      });
    },
  );
  startup.stop(true);
} catch (error) {
  startup.stop(error.code !== 'STOP_UNCONFIRMED');
  process.exitCode = 1;
}
process.disconnect();
