import { spawn } from 'node:child_process';
import { LAB, labEnvironment } from '../../agent/codex/wsl-policy.mjs';
// Bounded operator-owned holder, not a service and not model-accessible. Keeps
// this prepared distro alive between separate preflight/registration/invoke.
const source = String.raw`const fs=require('node:fs');
if(process.getuid()!==1000 || fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').some(l=>/ (?:\/mnt\/(?:wsl|wslg)|\/usr\/lib\/wsl(?:\/| )|\/tmp\/\.X11-unix)/.test(l))) process.exit(2);
const namespace=fs.readlinkSync('/proc/self/ns/mnt');
let timer; const deadline=setTimeout(()=>process.exit(3),600000);
const pulse=()=>{clearTimeout(timer);timer=setTimeout(()=>process.exit(3),3000);};
process.stdin.on('data',b=>{if(b.toString().includes('STOP')){clearTimeout(timer);clearTimeout(deadline);process.exit(0);}pulse();});
process.stdin.on('end',()=>process.exit(0));pulse();
console.log(JSON.stringify({namespace,pid:process.pid,status:'LAB_SESSION_HELD'}));`;
export async function holdPreparedLab() {
  if (process.platform !== 'win32') throw Error('ACTUAL_WINDOWS_WSL_REQUIRED');
  const child = spawn(
    'wsl.exe',
    [
      '-d',
      LAB.distro,
      '-u',
      LAB.user,
      '--cd',
      LAB.home,
      '--exec',
      '/usr/bin/env',
      '-i',
      ...Object.entries(labEnvironment()).map(([k, v]) => `${k}=${v}`),
      LAB.node,
      '-e',
      source,
    ],
    {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    },
  );
  let output = '',
    interval;
  child.stdin.on('error', () => {});
  const ended = new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (c, s) => {
      clearInterval(interval);
      resolve(c === 0 && s === null);
    });
  });
  try {
    const receipt = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('LAB_SESSION_UNCONFIRMED')),
        10000,
      );
      child.once('error', () => {
        clearTimeout(timer);
        reject(Error('LAB_SESSION_UNCONFIRMED'));
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(Error('LAB_SETUP_REQUIRED'));
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.length > 2048) {
          clearTimeout(timer);
          reject(Error('LAB_SESSION_UNCONFIRMED'));
        } else if (output.includes('\n')) {
          clearTimeout(timer);
          try {
            const value = JSON.parse(output);
            if (
              !/^mnt:\[\d+\]$/.test(value.namespace) ||
              value.status !== 'LAB_SESSION_HELD'
            )
              throw Error();
            resolve(value);
          } catch {
            reject(Error('LAB_SESSION_UNCONFIRMED'));
          }
        }
      });
    });
    interval = setInterval(() => child.stdin.write('PULSE\n'), 500);
    return {
      receipt,
      assertActive() {
        if (child.exitCode !== null || child.signalCode !== null)
          throw Error('LAB_SESSION_LOST');
      },
      async stop() {
        clearInterval(interval);
        child.stdin.end('STOP\n');
        let timer;
        try {
          if (
            !(await Promise.race([
              ended,
              new Promise((r) => {
                timer = setTimeout(() => r(false), 6000);
              }),
            ]))
          )
            throw Error('LAB_SESSION_STOP_UNCONFIRMED');
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    child.stdin.end();
    let timer;
    try {
      await Promise.race([
        ended,
        new Promise((r) => {
          timer = setTimeout(r, 6000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    throw error;
  }
}
