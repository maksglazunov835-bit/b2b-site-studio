import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { prepareTestDatabase } from '../persistence/helpers.mjs';
import {
  getDatabasePool,
  closeDatabasePool,
} from '../../server/persistence/database.mjs';
import { saveDraft } from '../../server/persistence/service.mjs';
import { jobs, createJobService } from '../../server/jobs/service.mjs';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
import { fixture, running, result, report } from './helpers.mjs';
import { brief, runtime } from './fixtures.mjs';
import { fixture as dataFixture } from '../execution/helpers.mjs';
before(prepareTestDatabase);
after(closeDatabasePool);
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => error.code === code);
const query = (sql, args = []) => getDatabasePool().query(sql, args);
void test('design pins immutable revision, concurrent claim has one slot, validates result and recovers exact receipt after deadline', async () => {
  const f = await fixture();
  const responses = await Promise.all([f.claim(), f.claim()]);
  const a = responses.find((r) => r.assignment).assignment;
  assert.equal(responses.filter((r) => r.assignment).length, 1);
  assert.equal(a.attempt, 1);
  assert.equal(Date.parse(a.deadlineAt) - f.time.now, 180000);
  const key = randomUUID();
  await f.action(a, 'start', {}, key);
  await rejects(f.action(a, 'start', {}, key), 'INVOCATION_REPLY_UNAVAILABLE');
  await f.action(a, 'heartbeat', { phase: 'validating' });
  await saveDraft(
    f.projectId,
    { expectedRevision: 1, draft: { ...brief, niche: 'Updated niche' } },
    randomUUID(),
  );
  assert.equal(a.jobSpec.input.brief.niche, brief.niche);
  const reportKey = randomUUID();
  const ack = await result(f, a, reportKey);
  f.time.now = Date.parse(a.deadlineAt) + 1;
  const before = (
    await query('SELECT to_jsonb(t) FROM job_attempts t WHERE job_id=$1', [
      f.jobId,
    ])
  ).rows;
  assert.deepEqual(await result(f, a, reportKey), { ...ack, replayed: true });
  assert.deepEqual(
    (
      await query('SELECT to_jsonb(t) FROM job_attempts t WHERE job_id=$1', [
        f.jobId,
      ])
    ).rows,
    before,
  );
  assert.equal(
    (
      await query(
        'SELECT count(*)::int n FROM design_invocations WHERE job_id=$1',
        [f.jobId],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await query('SELECT count(*)::int n FROM job_results WHERE job_id=$1', [
        f.jobId,
      ])
    ).rows[0].n,
    1,
  );
  await rejects(result(f, a), 'TERMINAL_ACK_NOT_FOUND');
  await rejects(
    f.action(a, 'heartbeat', { phase: 'validating' }),
    'LEASE_EXPIRED',
  );
  await f.agents.revoke(f.agentId, {});
  await rejects(result(f, a, reportKey), 'AGENT_REVOKED');
});
void test('one invocation grant; expired/lost claim or start never schedules another attempt', async () => {
  for (const started of [false, true]) {
    const f = await fixture();
    const key = randomUUID();
    const a = (await f.claim(key)).assignment;
    await rejects(f.claim(key), 'CLAIM_REPLY_UNAVAILABLE');
    if (started) await f.action(a, 'start');
    f.time.now += 10001;
    await f.execution.sweep();
    assert.equal((await f.claim()).assignment, null);
    assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, 'failed');
    const detail = await f.execution.detail(f.projectId, f.jobId);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.attempts[0].failure_code, 'INVOCATION_UNCERTAIN');
    await rejects(result(f, a), 'LEASE_EXPIRED');
  }
});
void test('proposal tampering, scope, cancellation and revocation cannot produce a result', async () => {
  const f = await fixture();
  const a = await running(f);
  const wrong = report(a);
  wrong.provider = 'codex';
  await rejects(
    f.action(a, 'result', { report: wrong, resultDigest: sha256Json(wrong) }),
    'DESIGN_REPORT_MISMATCH',
  );
  const malicious = report(a);
  malicious.proposal.concepts[0].html = '<script/>';
  await rejects(
    f.action(a, 'result', {
      report: malicious,
      resultDigest: sha256Json(malicious),
    }),
    'CODEX_INVALID_OUTPUT',
  );
  const other = await fixture({ projectId: f.projectId, dispatch: false });
  await rejects(
    other.execution.action(
      other.agentId,
      f.jobId,
      other.credential,
      'result',
      {
        attempt: 1,
        leaseToken: a.leaseToken,
        report: report(a),
        resultDigest: sha256Json(report(a)),
      },
      randomUUID(),
    ),
    'STALE_ATTEMPT',
  );
  await rejects(
    createJobService(randomUUID()).get(f.projectId, f.jobId),
    'JOB_NOT_FOUND',
  );
  await jobs.cancel(
    f.projectId,
    f.jobId,
    { expectedVersion: (await jobs.get(f.projectId, f.jobId)).job.version },
    randomUUID(),
  );
  await rejects(result(f, a), 'CANCEL_REQUESTED');
  await f.action(a, 'cancel-ack');
  assert.equal((await f.execution.detail(f.projectId, f.jobId)).report, null);
  const revoke = await fixture();
  const b = await running(revoke);
  await revoke.agents.revoke(revoke.agentId, {});
  await rejects(result(revoke, b), 'AGENT_REVOKED');
});
void test('official unverified runtime is visible but cannot dispatch; prior credentials are not upgraded', async () => {
  const f = await fixture({
    dispatch: false,
    profile: {
      ...runtime,
      provider: 'codex',
      modelSelection: {
        ...runtime.modelSelection,
        source: 'official_model_list',
      },
      cliVersion: '0.153.4',
      status: 'CODEX_SAFE_PROFILE_UNVERIFIED',
    },
  });
  assert.equal(f.registration.executionEnabled, false);
  await rejects(
    f.execution.dispatch(
      f.projectId,
      f.jobId,
      { agentId: f.agentId, expectedVersion: 1 },
      randomUUID(),
    ),
    'CODEX_SAFE_PROFILE_UNVERIFIED',
  );
  assert.equal(
    (
      await query(
        'SELECT count(*)::int n FROM design_invocations WHERE job_id=$1',
        [f.jobId],
      )
    ).rows[0].n,
    0,
  );
});
void test('concurrent creation and dispatch replay are idempotent and new payload conflicts', async () => {
  const f = await fixture({ dispatch: false });
  const key = randomUUID();
  const input = { type: 'design_proposal', expectedRevision: 1 };
  const replies = await Promise.all([
    jobs.create(f.projectId, input, key),
    jobs.create(f.projectId, input, key),
  ]);
  assert.equal(replies[0].response.job.id, replies[1].response.job.id);
  await rejects(
    jobs.create(f.projectId, { ...input, type: 'site_spec_validation' }, key),
    'IDEMPOTENCY_CONFLICT',
  );
  const dkey = randomUUID();
  const d = { agentId: f.agentId, expectedVersion: 1 };
  const [first, second] = await Promise.all([
    f.execution.dispatch(f.projectId, f.jobId, d, dkey),
    f.execution.dispatch(f.projectId, f.jobId, d, dkey),
  ]);
  assert.deepEqual(second.response, first.response);
});
void test('data/presence grants cannot dispatch design and test profile cannot run in normal mode', async () => {
  const f = await fixture({ dispatch: false });
  for (const presence of [false, true]) {
    const old = await dataFixture({
      projectId: f.projectId,
      dispatch: false,
      presence,
    });
    await rejects(
      f.execution.dispatch(
        f.projectId,
        f.jobId,
        { agentId: old.agentId, expectedVersion: 1 },
        randomUUID(),
      ),
      presence ? 'EXECUTION_NOT_GRANTED' : 'EXECUTION_SCOPE_MISMATCH',
    );
  }
  delete process.env.B2B_DESIGN_TEST_STUB;
  try {
    await rejects(f.claim(), 'TEST_PROVIDER_DISABLED');
    assert.equal((await f.agents.get(f.agentId)).agent.executionEnabled, false);
  } finally {
    process.env.B2B_DESIGN_TEST_STUB = '1';
  }
});
void test('failed start/event commit does not consume invocation budget and saved cancel/fail receipts remain bounded', async () => {
  const f = await fixture();
  const a = (await f.claim()).assignment;
  await query(
    "CREATE FUNCTION fail_design_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test event failure'; END; $$",
  );
  await query(
    'CREATE TRIGGER fail_design_event BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION fail_design_event()',
  );
  try {
    await assert.rejects(f.action(a, 'start'));
    assert.equal(
      (
        await query(
          'SELECT count(*)::int n FROM design_invocations WHERE job_id=$1',
          [f.jobId],
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await query('DROP TRIGGER fail_design_event ON job_events');
    await query('DROP FUNCTION fail_design_event()');
  }
  await f.action(a, 'start');
  await f.action(a, 'heartbeat', { phase: 'validating' });
  await result(f, a);
  for (const kind of ['cancel-ack', 'fail']) {
    const g = await fixture();
    const b = await running(g);
    if (kind === 'cancel-ack')
      await jobs.cancel(
        g.projectId,
        g.jobId,
        { expectedVersion: (await jobs.get(g.projectId, g.jobId)).job.version },
        randomUUID(),
      );
    const extra = kind === 'fail' ? { code: 'CODEX_INVALID_OUTPUT' } : {};
    const key = randomUUID();
    const ack = await g.action(b, kind, extra, key);
    const done = g.time.now;
    g.time.now = Date.parse(b.deadlineAt) + 1;
    assert.deepEqual(await g.action(b, kind, extra, key), {
      ...ack,
      replayed: true,
    });
    assert.equal(
      (
        await query(
          "SELECT count(*)::int n FROM job_events WHERE job_id=$1 AND to_state IN ('cancelled','failed')",
          [g.jobId],
        )
      ).rows[0].n,
      1,
    );
    g.time.now = done + 300000;
    await rejects(g.action(b, kind, extra, key), 'TERMINAL_ACK_EXPIRED');
  }
});
