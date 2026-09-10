import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clientEnvironment } from './codex/adapter.mjs';
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./design-main.mjs', import.meta.url)),
    ...process.argv.slice(2),
  ],
  {
    env: clientEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  },
);
let timer;
const stop = () => {
  if (child.connected && !timer) {
    child.send('STOP');
    timer = setTimeout(() => child.kill('SIGKILL'), 7000);
  }
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
child.once('error', () => {
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  clearTimeout(timer);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  process.exitCode = code === 0 && signal === null ? 0 : 1;
});
