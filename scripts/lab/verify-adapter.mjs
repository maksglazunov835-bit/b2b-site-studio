import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { callLab, labBundle } from '../../agent/codex/wsl-bridge.mjs';
import { LAB, labEnvironment } from '../../agent/codex/wsl-policy.mjs';
if (process.platform !== 'win32') throw Error('ACTUAL_WINDOWS_WSL_REQUIRED');
const fixed = (file, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '';
    p.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > 32768) p.kill();
    });
    p.once('error', reject);
    p.once('close', (code) =>
      code === 0 ? resolve(output) : reject(Error('LAB_SETUP_REQUIRED')),
    );
  });
// Explicit operator diagnostic, never called by a job. No other distro is stopped.
await fixed('wsl.exe', ['--terminate', 'B2B-Codex-Lab']);
const evidence = {
  kind: 'actual-windows-wsl',
  at: new Date().toISOString(),
  modelInvocations: 0,
  bundleSha256: (await labBundle()).sha256,
};
await assert.rejects(callLab({ operation: 'preflight' }), {
  code: 'LAB_HOST_MOUNTS_PRESENT',
});
evidence.coldStartDenied = true;
await fixed(process.execPath, ['scripts/lab/transfer.mjs']);
evidence.preflight = await callLab({ operation: 'preflight' });
assert.equal(evidence.preflight.status, 'CODEX_LOGIN_REQUIRED');
evidence.lifecycle = [];
for (const mode of [
  'timeout',
  'abort',
  'relay-eof',
  'pulse-loss',
  'relay-kill',
]) {
  console.log('WSL_LIFECYCLE', mode);
  const controller = new AbortController();
  let timer;
  const start = Date.now();
  try {
    const result = await callLab(
      { operation: 'lifecycle', scenario: mode },
      {
        signal: controller.signal,
        diagnosticFault: ['relay-eof', 'relay-kill', 'pulse-loss'].includes(
          mode,
        )
          ? mode
          : undefined,
        onStarted: () => {
          if (mode === 'abort')
            timer = setTimeout(() => controller.abort(), 350);
        },
      },
    );
    assert.equal(result.confirmed, true);
    assert.ok(['TIMEOUT', 'STOP', 'RELAY_LOST'].includes(result.reason));
    evidence.lifecycle.push({
      mode,
      confirmed: true,
      reason: result.reason,
      elapsedMs: Date.now() - start,
    });
  } catch (e) {
    assert.equal(e.code, 'RUNNER_STOPPED');
    evidence.lifecycle.push({
      mode,
      confirmed: true,
      reason: e.code,
      elapsedMs: Date.now() - start,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
const help = await fixed('wsl.exe', [
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
  LAB.binary,
  'login',
  '--help',
]);
assert.ok(help.includes('--device-auth'));
evidence.deviceAuthSupported = true;
const processes = await fixed('wsl.exe', [
  '-d',
  LAB.distro,
  '-u',
  LAB.user,
  '--exec',
  '/bin/ps',
  '-eo',
  'comm=',
]);
assert.doesNotMatch(processes, /^(?:node|python3?|codex|bwrap)$/m);
evidence.noRemainingWorkloads = true;
await mkdir('.test-results', { recursive: true });
await writeFile(
  '.test-results/wsl-adapter.json',
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence, null, 2));
