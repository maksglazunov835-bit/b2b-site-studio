import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  continueReservation,
  consumeProviderStart,
  unusedReservation,
} from '../../scripts/lab/smoke-budget.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
void test('preserved pre-reset evidence permits exactly one explicit continuation/start, not a reset inference', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b2b-budget-test-'));
  try {
    const original = JSON.stringify({
      reservedAt: new Date().toISOString(),
      maximumCalls: 1,
    });
    const row = {
      job_id: 'job_' + 'a'.repeat(32),
      project_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      state: 'queued',
      version: 1,
      registered_agents: 0,
      dispatches: 0,
      attempts: 0,
      invocation_permits: 0,
      results: 0,
      events: ['job_queued'],
    };
    const previous = JSON.stringify({
      headSha: 'a'.repeat(40),
      smoke: { modelInvocations: 0, dispatchReached: false },
      database: { projects: [row] },
    });
    const proof = {
      version: 1,
      capturedAt: new Date().toISOString(),
      beforeTestReset: true,
      reservationSha256: hash(original),
      previousReportSha256: hash(previous),
      previousHead: 'a'.repeat(40),
      modelInvocations: 0,
      row,
    };
    await writeFile(path.join(root, 'real-codex-attempt.json'), original);
    await assert.rejects(unusedReservation(root), {
      code: 'SMOKE_HISTORY_UNCERTAIN',
    });
    await writeFile(path.join(root, 'post-login-smoke-report.json'), previous);
    await writeFile(
      path.join(root, 'real-codex-prior-proof.json'),
      JSON.stringify(proof),
    );
    await unusedReservation(root);
    await unusedReservation(root); // Preparatory failure consumes nothing.
    const ctx = { projectId: row.project_id, jobId: row.job_id };
    const attempts = await Promise.allSettled([
      continueReservation(root, ctx),
      continueReservation(root, ctx),
    ]);
    assert.equal(attempts.filter((v) => v.status === 'fulfilled').length, 1);
    const saved = attempts.find((v) => v.status === 'fulfilled').value;
    const starts = await Promise.allSettled([
      consumeProviderStart(root, saved),
      consumeProviderStart(root, saved),
    ]);
    assert.equal(starts.filter((v) => v.status === 'fulfilled').length, 1);
    await assert.rejects(continueReservation(root, ctx));
    await assert.rejects(consumeProviderStart(root, saved));
    assert.equal(
      await readFile(path.join(root, 'real-codex-attempt.json'), 'utf8'),
      original,
    );
    proof.row.attempts = 1;
    await writeFile(
      path.join(root, 'real-codex-prior-proof.json'),
      JSON.stringify(proof),
    );
    await assert.rejects(unusedReservation(root), {
      code: 'SMOKE_HISTORY_UNCERTAIN',
    });
  } finally {
    await rm(root, { recursive: true });
  }
});
