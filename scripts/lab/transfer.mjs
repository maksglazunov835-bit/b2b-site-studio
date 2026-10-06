import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// Explicit operator tool only. Never imported by an adapter, Runner or job.
export async function prepareLab(mode = '--operator-prepare') {
  if (
    process.platform !== 'win32' ||
    !['--operator-inspect', '--operator-prepare'].includes(mode)
  )
    throw Error('LAB_PREPARATION_OPTIONS');
  const wrapper = (
    await readFile(new URL('./prepare-mounts.sh', import.meta.url), 'utf8')
  ).replaceAll('\r\n', '\n');
  const source = await readFile(
    new URL('./mount-preparation.mjs', import.meta.url),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      'wsl.exe',
      [
        '-d',
        'B2B-Codex-Lab',
        '-u',
        'root',
        '--cd',
        '/',
        '--exec',
        '/bin/sh',
        '-c',
        wrapper,
        'prepare-mounts',
        mode,
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
      },
    );
    let output = '',
      overflow = false;
    const timer = setTimeout(() => {
      overflow = true;
      child.kill();
    }, 30000);
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 65536) {
        overflow = true;
        child.kill();
      } else output += chunk;
    });
    child.stdin.on('error', () => {});
    child.stdin.end(source);
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('LAB_PREPARATION_START_FAILED'));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (overflow || signal || code !== 0)
          throw Error(result.status ?? 'LAB_PREPARATION_UNCONFIRMED');
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (
    process.argv.length > 3 ||
    (process.argv[2] && process.argv[2] !== '--inspect')
  )
    throw Error('LAB_PREPARATION_OPTIONS');
  console.log(
    JSON.stringify(
      await prepareLab(
        process.argv[2] ? '--operator-inspect' : '--operator-prepare',
      ),
    ),
  );
}
