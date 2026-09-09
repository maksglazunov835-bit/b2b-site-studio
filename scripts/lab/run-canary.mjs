import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const child = spawn(
  'wsl.exe',
  [
    '-d',
    'B2B-Codex-Lab',
    '-u',
    'codexlab',
    '--cd',
    '/home/codexlab',
    '--exec',
    '/usr/bin/env',
    '-i',
    'HOME=/home/codexlab',
    'WSL_DISTRO_NAME=B2B-Codex-Lab',
    'PATH=/usr/bin:/bin',
    '/opt/b2b-lab/node-24.19.0/bin/node',
    '--input-type=module',
    '-',
  ],
  {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
  },
);
child.stdin.on('error', () => {});
child.stdin.end(await readFile(new URL('./linux-canary.mjs', import.meta.url)));
child.once('close', (code) => {
  process.exitCode = code ?? 1;
});
