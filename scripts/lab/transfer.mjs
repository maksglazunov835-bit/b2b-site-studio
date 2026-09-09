import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
// Fixed setup input over stdin, not a drive mount, shell string or platform env.
const child = spawn(
  'wsl.exe',
  ['-d', 'B2B-Codex-Lab', '-u', 'root', '--cd', '/', '--exec', '/bin/sh', '-s'],
  {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  },
);
child.stdin.end(
  await readFile(new URL('./prepare-mounts.sh', import.meta.url)),
);
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
