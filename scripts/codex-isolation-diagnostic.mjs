import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  symlink,
  rm,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { clientEnvironment } from '../agent/codex/adapter.mjs';
import { windowsProbePassed } from './lab/probe-matrix.mjs';
import {
  DESIGN_PERMISSION_PROFILE,
  permissionArguments,
} from '../agent/codex/permission-profile.mjs';
const binary = process.argv[2];
const cleanHome = process.argv[3] === '--clean-home';
if (!path.isAbsolute(binary ?? ''))
  throw new Error('Absolute official binary required');
const root = await realpath(tmpdir());
const owned = await mkdtemp(path.join(root, 'b2b-isolation-canary-'));
let connections = 0;
const listener = net.createServer((socket) => {
  connections++;
  socket.destroy();
});
async function sandboxCommand(task, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        '--strict-config',
        ...permissionArguments(),
      ],
      {
        cwd: task,
        env: {
          ...clientEnvironment(),
          ...(cleanHome ? { CODEX_HOME: path.join(owned, 'clean-home') } : {}),
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let buffer = '',
      bytes = 0,
      failure,
      result,
      applied;
    const fail = () => {
      failure = true;
      child.kill();
    };
    const timer = setTimeout(fail, 15000);
    const send = (id, method, params) =>
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) return fail();
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const r = JSON.parse(line);
          if (r.error) {
            result = {
              rpcError: r.error.code,
              policyError: /not supported|unsupported/i.test(r.error.message),
              accessError: /denied/i.test(r.error.message),
            };
            child.stdin.end();
            continue;
          }
          if (r.id === 1) {
            child.stdin.write('{"method":"initialized"}\n');
            send(2, 'config/read', { cwd: task, includeLayers: false });
          }
          if (r.id === 2) {
            const c = r.result.config;
            applied = {
              windows: c.windows,
              defaultPermissions: c.default_permissions,
              profile: c.permissions?.[DESIGN_PERMISSION_PROFILE],
              legacySandbox: c.sandbox_mode,
            };
            send(4, 'windowsSandbox/readiness', {});
          }
          if (r.id === 4) {
            applied.readiness = r.result.status;
            if (r.result.status !== 'ready') {
              result = { setupRequired: true };
              child.stdin.end();
              continue;
            }
            send(3, 'command/exec', {
              command,
              cwd: task,
              permissionProfile: DESIGN_PERMISSION_PROFILE,
              timeoutMs: 6000,
            });
          }
          if (r.id === 3) {
            result = r.result;
            child.stdin.end();
          }
        } catch {
          fail();
        }
      }
    });
    child.stderr.on('data', (c) => {
      bytes += c.length;
      if (bytes > 131072) fail();
    });
    child.stdin.on('error', fail);
    child.once('error', fail);
    child.once('close', () => {
      clearTimeout(timer);
      if (failure || !result) reject(new Error('Sandbox command failed'));
      else resolve({ ...result, applied });
    });
    send(1, 'initialize', {
      clientInfo: { name: 'b2b_canary_probe', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
  });
}
try {
  const task = path.join(owned, 'task'),
    outside = path.join(owned, 'outside');
  await mkdir(task);
  if (cleanHome) await mkdir(path.join(owned, 'clean-home'));
  await mkdir(outside);
  await mkdir(path.join(task, 'output'));
  await writeFile(path.join(task, 'input.json'), '{"synthetic":true}');
  await writeFile(path.join(outside, 'marker.txt'), 'SYNTHETIC-DO-NOT-READ');
  await writeFile(
    path.join(task, 'canary.mjs'),
    await readFile(
      new URL('../tests/design/isolation-canary.mjs', import.meta.url),
    ),
  );
  await symlink(
    outside,
    path.join(task, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  listener.listen(0, '::');
  await once(listener, 'listening');
  const positiveControls = {};
  for (const host of ['127.0.0.1', '::1']) {
    positiveControls[host] = await new Promise((resolve) => {
      const socket = net.connect({ host, port: listener.address().port });
      const finish = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(1000, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  }
  connections = 0;
  const result = await sandboxCommand(task, [
    process.execPath,
    path.join(task, 'canary.mjs'),
    outside,
    String(listener.address().port),
  ]);
  let checks = null;
  try {
    checks = JSON.parse(result.stdout.trim());
  } catch {}
  const outsideUnchanged =
    (await readFile(path.join(outside, 'marker.txt'), 'utf8')) ===
    'SYNTHETIC-DO-NOT-READ';
  const passed = windowsProbePassed({
    exitCode: result.exitCode,
    checks,
    positiveControls,
    connections,
    outsideUnchanged,
  });
  console.log(
    JSON.stringify(
      {
        kind: 'official-sandbox-canary',
        modelInvocations: 0,
        configSource: cleanHome
          ? 'empty-owned-CODEX_HOME'
          : 'existing-user-config',
        positiveControls,
        setupRequired: result.setupRequired ?? false,
        exitCode: result.exitCode,
        rpcError: result.rpcError,
        policyError: result.policyError,
        accessError: result.accessError,
        applied: result.applied,
        profile: DESIGN_PERMISSION_PROFILE,
        checks,
        connections,
        outsideUnchanged,
        diagnostic: /not supported|unsupported/i.test(result.stderr)
          ? 'POLICY_UNSUPPORTED'
          : /access is denied|access denied/i.test(result.stderr)
            ? 'SANDBOX_ACCESS_DENIED'
            : result.stderr
              ? 'SANDBOX_DIAGNOSTIC'
              : null,
        status: passed ? 'canary_passed_not_live_approval' : 'blocked',
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} catch (e) {
  console.log(
    JSON.stringify({
      kind: 'official-sandbox-canary',
      modelInvocations: 0,
      status: 'blocked',
      reason: e.code ?? 'SANDBOX_PROBE_FAILED',
    }),
  );
  process.exitCode = 1;
} finally {
  listener.close();
  const link = path.join(owned, 'task', 'escape');
  if ((await lstat(link).catch(() => null))?.isSymbolicLink()) await rm(link);
  if (path.dirname(owned) === root && (await realpath(owned)) === owned)
    await rm(owned, { recursive: true });
}
