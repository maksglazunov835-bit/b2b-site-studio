import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  continueReservation,
  consumeProviderStart,
  unusedReservation,
  SMOKE_AUTHORIZATION,
  authorizationDirectory,
  reserveAuthorization,
  bindAuthorization,
  consumeAuthorization,
  preservedConsumedHistory,
  writeSmokeEvidence,
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

const context = {
  headSha: 'b'.repeat(40),
  manifestSha256: 'c'.repeat(64),
  inputSha256: 'd'.repeat(64),
};
const binding = {
  projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  jobId: 'job_' + 'e'.repeat(32),
  revision: 1,
  siteSpecSha256: 'f'.repeat(64),
};
async function consumedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'b2b-budget-test-'));
  const archive = path.join(root, 'consumed-archive-ce270a0');
  await mkdir(archive);
  const names = [
    'real-codex-attempt.json',
    'real-codex-prior-proof.json',
    'post-login-smoke-report.json',
    'real-codex-continuation.json',
    'real-codex-provider-start.json',
    'real-codex-terminal-failure.json',
    'real-codex-post-smoke-database.json',
    'pre-invocation-preflight.json',
    'startup-24f44a61-8545-4465-8c27-13316010e109.json',
    'actual-smoke-failed-reload.json',
    'actual-smoke-failed-desktop.png',
    'actual-smoke-failed-mobile.png',
  ];
  const files = [];
  for (const name of names) {
    const data = Buffer.from(
      JSON.stringify({ fixture: name, failed: true, maximumCalls: 1 }),
    );
    for (const directory of [root, archive])
      await writeFile(path.join(directory, name), data);
    files.push({ file: name, bytes: data.length, sha256: hash(data) });
  }
  await writeFile(
    path.join(archive, 'manifest.json'),
    JSON.stringify({
      budget: 'consumed-no-retry',
      state: { state: 'failed', attempts: 1, permits: 1, results: 0 },
      files,
    }),
  );
  return root;
}
void test('new explicit authorization is exclusive across real processes and preserves consumed history', async () => {
  const root = await consumedFixture();
  try {
    const before = await preservedConsumedHistory(root);
    const moduleUrl = new URL(
      '../../scripts/lab/smoke-budget.mjs',
      import.meta.url,
    ).href;
    const source = `import { reserveAuthorization } from ${JSON.stringify(moduleUrl)};
      try { await reserveAuthorization(process.argv[1], 'pr15-live-smoke-02', JSON.parse(process.argv[2])); }
      catch (e) { process.exitCode = e.code === 'EEXIST' ? 10 : 11; }`;
    const reserve = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', source, root, JSON.stringify(context)],
          { stdio: 'ignore', windowsHide: true },
        );
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          signal ? reject(Error('Unexpected signal')) : resolve(code),
        );
      });
    assert.deepEqual(
      (await Promise.all([reserve(), reserve()])).sort((a, b) => a - b),
      [0, 10],
    );
    const directory = authorizationDirectory(root);
    const reservation = JSON.parse(
      await readFile(path.join(directory, 'reservation.json')),
    );
    assert.equal(reservation.id, SMOKE_AUTHORIZATION.id);
    assert.equal(reservation.maximumCalls, 1);
    assert.equal(reservation.manifestSha256, context.manifestSha256);
    assert.equal(reservation.reviewedHead, SMOKE_AUTHORIZATION.reviewedHead);
    assert.equal(
      reservation.archiveManifestSha256,
      before.archiveManifestSha256,
    );
    const bound = await bindAuthorization(root, reservation, binding);
    const starts = await Promise.allSettled([
      consumeAuthorization(root, reservation, bound),
      consumeAuthorization(root, reservation, bound),
    ]);
    assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1);
    const consumed = await readFile(
      path.join(directory, 'provider-start.json'),
      'utf8',
    );
    assert.equal(JSON.parse(consumed).state, 'consumed');
    // A provider timeout/failure is evidence only, never a refund or new budget.
    await writeSmokeEvidence(directory, 'failure.json', {
      code: 'CODEX_TIMEOUT',
      modelInvocations: 1,
    });
    await assert.rejects(
      reserveAuthorization(root, SMOKE_AUTHORIZATION.id, context),
      { code: 'EEXIST' },
    );
    await assert.rejects(bindAuthorization(root, reservation, binding), {
      code: 'EEXIST',
    });
    await assert.rejects(consumeAuthorization(root, reservation, bound), {
      code: 'EEXIST',
    });
    await assert.rejects(writeSmokeEvidence(directory, 'failure.json', {}), {
      code: 'EEXIST',
    });
    await assert.rejects(
      writeSmokeEvidence(directory, '../post-login-smoke-report.json', {}),
    );
    assert.equal(
      await readFile(path.join(directory, 'provider-start.json'), 'utf8'),
      consumed,
    );
    assert.deepEqual(await preservedConsumedHistory(root), before);
  } finally {
    await rm(root, { recursive: true });
  }
});
void test('unknown authorization, changed binding and missing/changed historical evidence fail closed', async () => {
  const root = await consumedFixture();
  try {
    await assert.rejects(
      reserveAuthorization(root, 'pr15-live-smoke-03', context),
      { code: 'SMOKE_HISTORY_UNCERTAIN' },
    );
    await assert.rejects(
      reserveAuthorization(root, SMOKE_AUTHORIZATION.id, {
        ...context,
        maximumCalls: 2,
      }),
    );
    const reservation = await reserveAuthorization(
      root,
      SMOKE_AUTHORIZATION.id,
      context,
    );
    await assert.rejects(
      bindAuthorization(
        root,
        { ...reservation, inputSha256: 'f'.repeat(64) },
        binding,
      ),
    );
    const bound = await bindAuthorization(root, reservation, binding);
    await assert.rejects(
      consumeAuthorization(root, reservation, {
        ...bound,
        jobId: 'job_' + 'f'.repeat(32),
      }),
    );
    await writeFile(path.join(root, 'real-codex-attempt.json'), '{}');
    await assert.rejects(consumeAuthorization(root, reservation, bound), {
      code: 'SMOKE_HISTORY_UNCERTAIN',
    });
    await assert.rejects(
      readFile(path.join(authorizationDirectory(root), 'provider-start.json')),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
