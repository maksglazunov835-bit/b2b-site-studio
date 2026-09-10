import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { assertSafeTestDatabaseUrl } from '../db/test-config.mjs';
const config = assertSafeTestDatabaseUrl();
const reservation = await readFile('.test-results/real-codex-attempt.json');
const previous = await readFile('.test-results/post-login-smoke-report.json');
const report = JSON.parse(previous);
const old = report.database.projects;
if (
  report.smoke.modelInvocations !== 0 ||
  report.smoke.dispatchReached !== false ||
  old.length !== 1
)
  throw Error('SMOKE_HISTORY_UNCERTAIN');
const client = new pg.Client(config);
try {
  await client.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows = (
    await client.query(
      `SELECT j.id AS job_id,j.project_id,j.state,j.version,
    (SELECT count(*)::int FROM agent_execution_grants g WHERE g.project_id=j.project_id AND g.agent_id IS NOT NULL) AS registered_agents,
    (SELECT count(*)::int FROM job_executions e WHERE e.job_id=j.id) AS dispatches,
    (SELECT count(*)::int FROM job_attempts a WHERE a.job_id=j.id) AS attempts,
    (SELECT count(*)::int FROM design_invocations i WHERE i.job_id=j.id) AS invocation_permits,
    (SELECT count(*)::int FROM job_results r WHERE r.job_id=j.id) AS results,
    ARRAY(SELECT event_type FROM job_events ev WHERE ev.job_id=j.id ORDER BY sequence) AS events
    FROM jobs j WHERE j.id=$1 AND j.project_id=$2`,
      [old[0].job_id, old[0].project_id],
    )
  ).rows;
  if (
    rows.length !== 1 ||
    rows[0].state !== 'queued' ||
    rows[0].version !== 1 ||
    [
      'registered_agents',
      'dispatches',
      'attempts',
      'invocation_permits',
      'results',
    ].some((k) => rows[0][k] !== 0) ||
    JSON.stringify(rows[0].events) !== '["job_queued"]'
  )
    throw Error('SMOKE_HISTORY_UNCERTAIN');
  await client.query('COMMIT');
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const proof = {
    version: 1,
    capturedAt: new Date().toISOString(),
    beforeTestReset: true,
    reservationSha256: hash(reservation),
    previousReportSha256: hash(previous),
    previousHead: report.headSha,
    modelInvocations: 0,
    row: rows[0],
  };
  await writeFile(
    '.test-results/real-codex-prior-proof.json',
    JSON.stringify(proof, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log('SMOKE_PRIOR_PROOF_PRESERVED_BEFORE_RESET');
} finally {
  await client.end();
}
