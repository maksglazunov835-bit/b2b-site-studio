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
  SMOKE_AUTHORIZATION_03,
  authorizationDirectory,
  reserveAuthorization,
  bindAuthorization,
  consumeAuthorization,
  preservedConsumedHistory,
  writeSmokeEvidence,
  continueUnusedAuthorization,
  continuationDirectory,
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

async function preflightFailure(root) {
  const reservation = await reserveAuthorization(
    root,
    SMOKE_AUTHORIZATION.id,
    context,
  );
  const directory = authorizationDirectory(root);
  await writeSmokeEvidence(directory, 'preflight.json', {
    runtime: {
      provider: 'codex',
      model: SMOKE_AUTHORIZATION.model,
      effort: SMOKE_AUTHORIZATION.effort,
      policySha256: context.manifestSha256,
      status: 'CODEX_ISOLATION_UNVERIFIED',
    },
    diagnostics: { status: 'LAB_HOST_MOUNTS_PRESENT', modelInvocations: 0 },
    modelInvocations: 0,
  });
  await writeSmokeEvidence(directory, 'failure.json', {
    authorizationId: SMOKE_AUTHORIZATION.id,
    headSha: context.headSha,
    stage: 'preflight',
    errorCode: 'LAB_HOST_MOUNTS_PRESENT',
    consumed: false,
    projectId: null,
    jobId: null,
    at: new Date().toISOString(),
  });
  return reservation;
}
void test('same unused authorization continuation and consumption are exclusive across processes, old receipts unchanged', async () => {
  const root = await consumedFixture();
  try {
    const reservation = await preflightFailure(root);
    const directory = authorizationDirectory(root);
    const names = ['reservation.json', 'preflight.json', 'failure.json'];
    const before = await Promise.all(
      names.map((n) => readFile(path.join(directory, n), 'utf8')),
    );
    const moduleUrl = new URL(
      '../../scripts/lab/smoke-budget.mjs',
      import.meta.url,
    ).href;
    const run = (source) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import * as b from ${JSON.stringify(moduleUrl)}; import {readFile} from 'node:fs/promises'; try { ${source} } catch { process.exitCode=10; }`,
            root,
            JSON.stringify({ ...context, headSha: '1'.repeat(40) }),
          ],
          { stdio: 'ignore', windowsHide: true },
        );
        child.once('error', reject);
        child.once('exit', (c, s) =>
          s ? reject(Error('signal')) : resolve(c),
        );
      });
    const start = `await b.continueUnusedAuthorization(process.argv[1], 'pr15-live-smoke-02', JSON.parse(process.argv[2]));`;
    assert.deepEqual(
      (await Promise.all([run(start), run(start)])).sort((a, b) => a - b),
      [0, 10],
    );
    const continuation = JSON.parse(
      await readFile(
        path.join(continuationDirectory(root), 'continuation.json'),
      ),
    );
    await assert.rejects(bindAuthorization(root, reservation, binding));
    const bound = await bindAuthorization(
      root,
      reservation,
      binding,
      continuation,
    );
    const consume = `const root=process.argv[1]; const r=JSON.parse(await readFile(b.authorizationDirectory(root)+'/reservation.json')); const c=JSON.parse(await readFile(b.continuationDirectory(root)+'/continuation.json')); const j=JSON.parse(await readFile(b.authorizationDirectory(root)+'/job-binding.json')); await b.consumeAuthorization(root,r,j,c);`;
    assert.deepEqual(
      (await Promise.all([run(consume), run(consume)])).sort((a, b) => a - b),
      [0, 10],
    );
    await assert.rejects(
      consumeAuthorization(root, reservation, bound, continuation),
    );
    assert.deepEqual(
      await Promise.all(
        names.map((n) => readFile(path.join(directory, n), 'utf8')),
      ),
      before,
    );
    const consumed = JSON.parse(
      await readFile(path.join(directory, 'provider-start.json')),
    );
    assert.equal(consumed.headSha, continuation.headSha);
    assert.equal(consumed.maximumCalls, 1);
    assert.equal(consumed.runId, continuation.runId);
  } finally {
    await rm(root, { recursive: true });
  }
});
void test('continuation rejects consumed, damaged, mismatched or uncertain preflight history without new budget', async () => {
  for (const scenario of [
    'consumed',
    'binding',
    'invocation',
    'damaged',
    'head',
    'stage',
    'payload',
    'model',
    'input',
  ]) {
    const root = await consumedFixture();
    try {
      await preflightFailure(root);
      const dir = authorizationDirectory(root);
      if (['consumed', 'binding', 'invocation'].includes(scenario))
        await writeSmokeEvidence(
          dir,
          {
            consumed: 'provider-start.json',
            binding: 'job-binding.json',
            invocation: 'invocation-unknown.json',
          }[scenario],
          {},
        );
      if (scenario === 'damaged')
        await writeFile(path.join(root, 'real-codex-attempt.json'), '{}');
      if (['head', 'stage', 'payload'].includes(scenario)) {
        const f = JSON.parse(await readFile(path.join(dir, 'failure.json')));
        if (scenario === 'head') f.headSha = '9'.repeat(40);
        if (scenario === 'stage') f.stage = 'registration';
        if (scenario === 'payload') f.projectId = binding.projectId;
        await writeFile(path.join(dir, 'failure.json'), JSON.stringify(f));
      }
      if (scenario === 'model') {
        const f = JSON.parse(await readFile(path.join(dir, 'preflight.json')));
        f.modelInvocations = 1;
        await writeFile(path.join(dir, 'preflight.json'), JSON.stringify(f));
      }
      await assert.rejects(
        continueUnusedAuthorization(root, SMOKE_AUTHORIZATION.id, {
          ...context,
          ...(scenario === 'input' ? { inputSha256: '9'.repeat(64) } : {}),
        }),
        { code: 'SMOKE_HISTORY_UNCERTAIN' },
      );
      await assert.rejects(
        readFile(path.join(continuationDirectory(root), 'continuation.json')),
        { code: 'ENOENT' },
      );
    } finally {
      await rm(root, { recursive: true });
    }
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
      reserveAuthorization(root, 'pr15-live-smoke-04', context),
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

async function consumedSecondFixture() {
  const root = await consumedFixture();
  const reservation = await reserveAuthorization(
    root,
    SMOKE_AUTHORIZATION.id,
    context,
  );
  const bound = await bindAuthorization(root, reservation, binding);
  await consumeAuthorization(root, reservation, bound);
  const directory = authorizationDirectory(root);
  for (const name of ['preflight.json', 'failure.json'])
    await writeSmokeEvidence(directory, name, { historical: true });
  await writeFile(
    path.join(directory, 'report.md'),
    'Historical failed smoke, no refund.',
  );
  const continuation = continuationDirectory(root);
  await mkdir(continuation);
  for (const name of [
    'continuation.json',
    'lab-session.json',
    'preflight.json',
    'project.json',
    'failure.json',
    'startup.json',
    'database.json',
    'invocation-fixture.json',
  ])
    await writeSmokeEvidence(continuation, name, { historical: true });
  await writeSmokeEvidence(continuation, 'terminal-failure.json', {
    jobId: binding.jobId,
    state: 'failed',
  });
  return root;
}

void test('smoke-03 has its own exclusive reservation/start across processes, preserving both consumed histories', async () => {
  const root = await consumedSecondFixture();
  try {
    const original = await preservedConsumedHistory(root);
    const oldDirectory = authorizationDirectory(root);
    const oldStart = await readFile(
      path.join(oldDirectory, 'provider-start.json'),
      'utf8',
    );
    const moduleUrl = new URL(
      '../../scripts/lab/smoke-budget.mjs',
      import.meta.url,
    ).href;
    const run = (body) =>
      new Promise((resolve, reject) => {
        const source = `import * as b from ${JSON.stringify(moduleUrl)}; import {readFile} from 'node:fs/promises'; try { ${body} } catch(e) { process.exitCode=e.code==='EEXIST'?10:11; }`;
        const child = spawn(
          process.execPath,
          ['--input-type=module', '-e', source, root, JSON.stringify(context)],
          { stdio: 'ignore', windowsHide: true },
        );
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          signal ? reject(Error('signal')) : resolve(code),
        );
      });
    const reserve = `await b.reserveAuthorization(process.argv[1], 'pr15-live-smoke-03', JSON.parse(process.argv[2]));`;
    assert.deepEqual(
      (await Promise.all([run(reserve), run(reserve)])).sort((a, b) => a - b),
      [0, 10],
    );
    const directory = authorizationDirectory(root, SMOKE_AUTHORIZATION_03.id);
    const reservation = JSON.parse(
      await readFile(path.join(directory, 'reservation.json')),
    );
    assert.equal(reservation.id, SMOKE_AUTHORIZATION_03.id);
    assert.equal(reservation.reviewedHead, SMOKE_AUTHORIZATION_03.reviewedHead);
    assert.match(reservation.previousAuthorizationSha256, /^[a-f0-9]{64}$/);
    const newBinding = { ...binding, jobId: 'job_' + '1'.repeat(32) };
    const bound = await bindAuthorization(root, reservation, newBinding);
    const consume = `const d=b.authorizationDirectory(process.argv[1],'pr15-live-smoke-03');await b.consumeAuthorization(process.argv[1],JSON.parse(await readFile(d+'/reservation.json')),JSON.parse(await readFile(d+'/job-binding.json')));`;
    assert.deepEqual(
      (await Promise.all([run(consume), run(consume)])).sort((a, b) => a - b),
      [0, 10],
    );
    const started = await readFile(
      path.join(directory, 'provider-start.json'),
      'utf8',
    );
    const marker = JSON.parse(started);
    assert.equal(marker.state, 'consumed');
    assert.equal(marker.maximumCalls, 1);
    assert.equal(marker.headSha, context.headSha);
    assert.equal(marker.manifestSha256, context.manifestSha256);
    assert.equal(marker.inputSha256, context.inputSha256);
    assert.equal(marker.jobId, newBinding.jobId);
    await writeSmokeEvidence(directory, 'failure.json', {
      errorCode: 'CODEX_TIMEOUT',
    });
    await assert.rejects(
      reserveAuthorization(root, SMOKE_AUTHORIZATION_03.id, context),
      { code: 'EEXIST' },
    );
    await assert.rejects(consumeAuthorization(root, reservation, bound), {
      code: 'EEXIST',
    });
    await assert.rejects(
      continueUnusedAuthorization(root, SMOKE_AUTHORIZATION_03.id, context),
    );
    assert.equal(
      await readFile(path.join(directory, 'provider-start.json'), 'utf8'),
      started,
    );
    assert.equal(
      await readFile(path.join(oldDirectory, 'provider-start.json'), 'utf8'),
      oldStart,
    );
    assert.deepEqual(await preservedConsumedHistory(root), original);
  } finally {
    await rm(root, { recursive: true });
  }
});

void test('smoke-03 refuses missing/tampered second history and never creates a new provider marker', async () => {
  const missing = await consumedFixture();
  try {
    await assert.rejects(
      reserveAuthorization(missing, SMOKE_AUTHORIZATION_03.id, context),
    );
  } finally {
    await rm(missing, { recursive: true });
  }
  const root = await consumedSecondFixture();
  try {
    const reservation = await reserveAuthorization(
      root,
      SMOKE_AUTHORIZATION_03.id,
      context,
    );
    const bound = await bindAuthorization(root, reservation, binding);
    await writeFile(
      path.join(authorizationDirectory(root), 'report.md'),
      'Changed history',
    );
    await assert.rejects(consumeAuthorization(root, reservation, bound), {
      code: 'SMOKE_HISTORY_UNCERTAIN',
    });
    await assert.rejects(
      readFile(
        path.join(
          authorizationDirectory(root, SMOKE_AUTHORIZATION_03.id),
          'provider-start.json',
        ),
      ),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      bindAuthorization(
        root,
        { ...reservation, id: 'pr15-live-smoke-04' },
        binding,
      ),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
