import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Synthetic diagnostics only. This module never sends thread/start or turn/start.
if (
  process.platform !== 'linux' ||
  process.env.WSL_DISTRO_NAME !== 'B2B-Codex-Lab' ||
  process.getuid() === 0
)
  throw Error('LAB_SCOPE_REQUIRED');
const binary = '/opt/b2b-lab/codex-0.153.4/bin/codex';
const binaryHash = createHash('sha256')
  .update(await readFile(binary))
  .digest('hex');
if (
  binaryHash !==
  '56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da'
)
  throw Error('BINARY_MISMATCH');
const root = await mkdtemp('/home/codexlab/b2b-linux-canary-');
let hits = 0;
const listener = net.createServer((socket) => {
  hits++;
  socket.destroy();
});
const connect = (host) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port: listener.address().port });
    const finish = (value) => {
      s.destroy();
      resolve(value);
    };
    s.setTimeout(800, () => finish(false));
    s.once('error', () => finish(false));
    s.once('connect', () => finish(true));
  });
const nodeRoot = path.dirname(path.dirname(process.execPath));
const profile = 'b2b-design-json';
const permissionArgs = [
  '-c',
  `default_permissions="${profile}"`,
  '-c',
  `permissions.${profile}.filesystem={ ":root"="deny", ":minimal"="read", "/opt/b2b-lab"="read", ":workspace_roots"={ "."="read", "output"="write" } }`,
  '-c',
  `permissions.${profile}.network.enabled=false`,
  '-c',
  'approval_policy="never"',
];
const task = path.join(root, 'task'),
  outside = path.join(root, 'outside');
const home = path.join(root, 'client-home');
for (const dir of [task, outside, home, path.join(task, 'output')])
  await mkdir(dir);
const marker = 'SYNTHETIC-CREDENTIAL-MARKER';
await writeFile(path.join(task, 'input.json'), '{"synthetic":true}');
await writeFile(path.join(outside, 'marker'), marker);
await writeFile(path.join(home, 'credential-marker'), marker);
await symlink(outside, path.join(task, 'escape'));
listener.listen(0, '0.0.0.0');
await once(listener, 'listening');
const privateHost = Object.values(os.networkInterfaces())
  .flat()
  .find((v) => v.family === 'IPv4' && !v.internal)?.address;
const hosts = ['127.0.0.1', ...(privateHost ? [privateHost] : [])];
const positiveControls = {};
for (const host of hosts) positiveControls[host] = await connect(host);
hits = 0;
const probe = `
import fs from 'node:fs/promises'; import net from 'node:net';
const denialCodes=[];
const denied=async(f)=>{try{await f();return false}catch(e){denialCodes.push(e.code);return ['EACCES','EPERM','EROFS','ENOENT'].includes(e.code)}};
const deniedNet=host=>new Promise(r=>{const s=net.connect({host,port:${listener.address().port}});const end=v=>{s.destroy();r(v)};s.setTimeout(800,()=>end(true));s.once('error',()=>end(true));s.once('connect',()=>end(false))});
console.log(JSON.stringify({
 nonRoot:process.getuid()!==0,
 inputRead:(await fs.readFile('input.json','utf8'))==='{"synthetic":true}',
 outputWrite:await fs.writeFile('output/result','synthetic').then(()=>true,()=>false),
 inputWriteDenied:await denied(()=>fs.writeFile('input.json','changed')),
 siblingReadDenied:await denied(()=>fs.readFile(${JSON.stringify(path.join(outside, 'marker'))})),
 symlinkReadDenied:await denied(()=>fs.readFile('escape/marker')),
 alternateReadDenied:await denied(()=>fs.readFile('../outside/marker')),
 credentialMarkerDenied:await denied(()=>fs.readFile(${JSON.stringify(path.join(home, 'credential-marker'))})),
 loopbackDenied:await deniedNet('127.0.0.1'),
 privateDenied:${privateHost ? `await deniedNet(${JSON.stringify(privateHost)})` : 'false'},
 initDenied:await denied(()=>fs.readFile('/init')),
 environmentClean:!['DATABASE_URL','TEST_DATABASE_URL','GITHUB_TOKEN','OPENAI_API_KEY','WSL_INTEROP'].some(k=>process.env[k]),
 denialCodes
}));`;
await writeFile(path.join(task, 'probe.mjs'), probe);
let child;
try {
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const hostMountsAbsent =
    !/ (?:\/mnt\/(?:[a-z]|wsl|wslg)(?:\/[^ ]*)?|\/usr\/lib\/wsl\/[^ ]*|\/tmp\/\.X11-unix) /m.test(
      mounts,
    );
  child = spawn(
    binary,
    [
      'app-server',
      '--listen',
      'stdio://',
      '--strict-config',
      ...permissionArgs,
    ],
    {
      cwd: task,
      env: {
        HOME: '/home/codexlab',
        CODEX_HOME: home,
        PATH: `${nodeRoot}/bin:/usr/bin:/bin`,
        LANG: 'C.UTF-8',
      },
      shell: false,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let buffer = '',
    bytes = 0,
    config,
    result,
    failed = false;
  const stop = () => {
    failed = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  };
  const timer = setTimeout(stop, 20000);
  child.stdin.on('error', stop);
  child.once('error', stop);
  const send = (id, method, params) =>
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  child.stdout.on('data', (c) => {
    bytes += c.length;
    if (bytes > 131072) return stop();
    buffer += c.toString();
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      try {
        const r = JSON.parse(line);
        if (r.error) {
          result = { rpcError: r.error.code };
          child.stdin.end();
          continue;
        }
        if (r.id === 1) {
          child.stdin.write('{"method":"initialized"}\n');
          send(2, 'config/read', { cwd: task, includeLayers: false });
        }
        if (r.id === 2) {
          const c = r.result.config;
          config = {
            legacySandbox: c.sandbox_mode,
            defaultPermissions: c.default_permissions,
            profile: c.permissions?.[profile],
          };
          send(3, 'command/exec', {
            command: [process.execPath, path.join(task, 'probe.mjs')],
            cwd: task,
            permissionProfile: profile,
            timeoutMs: 6000,
          });
        }
        if (r.id === 3) {
          result = r.result;
          child.stdin.end();
        }
      } catch {
        stop();
      }
    }
  });
  child.stderr.on('data', (c) => {
    bytes += c.length;
    if (bytes > 131072) stop();
  });
  send(1, 'initialize', {
    clientInfo: { name: 'b2b_linux_canary', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  const [exitCode, signalCode] = await once(child, 'close');
  clearTimeout(timer);
  let checks = null;
  try {
    checks = JSON.parse(result.stdout.trim());
  } catch {}
  const inputUnchangedAfterAppServer =
    (await readFile(path.join(task, 'input.json'), 'utf8')) ===
    '{"synthetic":true}';
  await writeFile(path.join(task, 'input.json'), '{"synthetic":true}');
  const sandboxCli = await new Promise((resolve, reject) => {
    const p = spawn(
      binary,
      [
        'sandbox',
        ...permissionArgs,
        '-P',
        profile,
        '-C',
        task,
        '--',
        process.execPath,
        path.join(task, 'probe.mjs'),
      ],
      {
        cwd: task,
        env: {
          HOME: '/home/codexlab',
          CODEX_HOME: home,
          PATH: `${nodeRoot}/bin:/usr/bin:/bin`,
          LANG: 'C.UTF-8',
        },
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '',
      bytes = 0,
      timedOut = false;
    const kill = () => {
      timedOut = true;
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL');
      } catch {}
    };
    const timer = setTimeout(kill, 10000);
    p.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > 32768) return kill();
      stdout += c.toString();
    });
    p.stderr.on('data', (c) => {
      bytes += c.length;
      if (bytes > 32768) return kill();
      stderr += c.toString();
    });
    p.once('error', reject);
    p.once('close', (exitCode, signalCode) => {
      clearTimeout(timer);
      let checks = null;
      try {
        checks = JSON.parse(stdout.trim());
      } catch {}
      resolve({
        exitCode,
        signalCode,
        checks,
        timedOut,
        diagnostic: stderr.slice(0, 1200),
        stdout: stdout.slice(0, 2000),
      });
    });
  });
  const inputUnchangedAfterCli =
    (await readFile(path.join(task, 'input.json'), 'utf8')) ===
    '{"synthetic":true}';
  console.log(
    JSON.stringify(
      {
        kind: 'local-wsl-canary',
        modelInvocations: 0,
        binaryHash,
        hostMountsAbsent,
        config,
        positiveControls,
        checks,
        connections: hits,
        commandExitCode: result?.exitCode,
        exitCode,
        signalCode,
        diagnostic: result?.stderr?.slice(0, 1200),
        failed,
        sandboxCli,
        inputUnchangedAfterAppServer,
        inputUnchangedAfterCli,
        status: 'blocked_pending_complete_matrix',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  listener.close();
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  await rm(root, { recursive: true, force: true });
}
