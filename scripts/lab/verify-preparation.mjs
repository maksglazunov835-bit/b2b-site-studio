import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { prepareLab } from './transfer.mjs';
import { holdPreparedLab } from './session.mjs';
import { callLab } from '../../agent/codex/wsl-bridge.mjs';
// Opt-in operator verification only, not CI and never reachable from a job.
assert.equal(process.argv[2], '--confirm-lab-only-restart');
assert.equal(process.argv.length, 3);
assert.equal(process.platform, 'win32');
const evidence = {
  kind: 'actual-windows-wsl-preparation',
  at: new Date().toISOString(),
  modelInvocations: 0,
  cycles: [],
};
await mkdir('.test-results', { recursive: true });
const file = `.test-results/lab-preparation-${randomUUID()}.json`;
try {
  for (let cycle = 0; cycle < 2; cycle++) {
    // Inspect workloads before terminating only this lab. Never stop another
    // distro, a running application, or a busy lab to make preparation pass.
    await prepareLab('--operator-inspect');
    execFileSync('wsl.exe', ['--terminate', 'B2B-Codex-Lab'], {
      timeout: 10000,
      windowsHide: true,
      stdio: 'ignore',
    });
    const cold = await prepareLab('--operator-inspect');
    const entry = { cold };
    evidence.cycles.push(entry);
    await assert.rejects(callLab({ operation: 'preflight' }), {
      code: 'LAB_HOST_MOUNTS_PRESENT',
    });
    entry.coldDenied = true;
    let prepared = await prepareLab();
    if (prepared.status === 'LAB_DNS_RESTART_REQUIRED') {
      entry.dnsPreservedRestartRequired = true;
      await prepareLab('--operator-inspect');
      execFileSync('wsl.exe', ['--terminate', 'B2B-Codex-Lab'], {
        timeout: 10000,
        windowsHide: true,
        stdio: 'ignore',
      });
      await prepareLab('--operator-inspect');
      await assert.rejects(callLab({ operation: 'preflight' }), {
        code: 'LAB_HOST_MOUNTS_PRESENT',
      });
      prepared = await prepareLab();
    }
    entry.prepared = prepared;
    const repeated = await prepareLab();
    entry.repeated = repeated;
    assert.deepEqual(repeated.removed, []);
    const held = await holdPreparedLab();
    try {
      assert.equal(held.receipt.namespace, prepared.namespace);
      const preflight = await callLab({ operation: 'preflight' });
      held.assertActive();
      Object.assign(entry, { held: held.receipt, preflight });
      assert.equal(preflight.status, 'ready');
    } finally {
      await held.stop();
    }
    await prepareLab('--operator-inspect');
  }
} catch (error) {
  evidence.errorCode = /^[A-Z_]+$/.test(error.code ?? error.message)
    ? (error.code ?? error.message)
    : 'LAB_VERIFICATION_FAILED';
  process.exitCode = 1;
} finally {
  await writeFile(file, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      file,
      cycles: evidence.cycles.length,
      errorCode: evidence.errorCode ?? null,
      modelInvocations: 0,
    }),
  );
}
