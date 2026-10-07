import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { prepareLab } from './transfer.mjs';
import { holdPreparedLab } from './session.mjs';
import { callLab, labBundle } from '../../agent/codex/wsl-bridge.mjs';
import { validDiagnostic } from '../../agent/codex/invocation-receipt.mjs';

// Operator-only, no DB imports or provider permission. Never invokes invoke.
assert.equal(process.platform, 'win32');
assert.deepEqual(process.argv.slice(2), ['--confirm-model-free']);
const evidence = {
  kind: 'actual-wsl-pre-invocation',
  at: new Date().toISOString(),
  bundleSha256: (await labBundle()).sha256,
  modelInvocations: 0,
  passes: [],
};
await mkdir('.test-results', { recursive: true });
const file = `.test-results/pre-invocation-${randomUUID()}.json`;
let held;
try {
  const prepared = await prepareLab();
  assert.equal(prepared.status, 'LAB_PREPARED');
  held = await holdPreparedLab();
  for (let i = 0; i < 3; i++) {
    const result = await callLab(
      { operation: 'prepare-only' },
      { timeoutMs: 60000 },
    );
    held.assertActive();
    assert.equal(result.status, 'ready');
    assert.equal(result.modelInvocations, 0);
    assert.equal(result.preparation.providerStarted, false);
    assert.equal(result.preparation.phase, 'final_compare');
    evidence.passes.push({
      at: new Date().toISOString(),
      hashes: result.hashes,
      configSha256: result.configSha256,
      managedRequirements: result.managedRequirements,
      accountType: result.accountType,
      modelSelection: result.modelSelection,
      canary: result.canary,
      preparation: result.preparation,
    });
    console.log(
      JSON.stringify({
        pass: i + 1,
        status: 'prepared_without_provider',
        comparison: result.preparation.comparison,
      }),
    );
  }
} catch (error) {
  evidence.errorCode = /^[A-Z_]+$/.test(error.code ?? '')
    ? error.code
    : 'LAB_VERIFICATION_FAILED';
  evidence.diagnostic = validDiagnostic(error.diagnostic)
    ? error.diagnostic
    : null;
  process.exitCode = 1;
} finally {
  try {
    await held?.stop();
  } catch {
    evidence.cleanupCode = 'STOP_UNCONFIRMED';
    process.exitCode = 1;
  }
  await writeFile(file, JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      file,
      completed: evidence.passes.length,
      errorCode: evidence.errorCode ?? null,
      diagnostic: evidence.diagnostic ?? null,
      cleanupCode: evidence.cleanupCode ?? null,
      modelInvocations: 0,
    }),
  );
}
