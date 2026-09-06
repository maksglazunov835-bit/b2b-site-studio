import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase, editableDraft } from "../persistence/helpers.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "../persistence/production-server.mjs";

const config = assertSafeTestDatabaseUrl();
await prepareTestDatabase();
const server = await startProductionServer();
const write = (body, key = randomUUID()) => ({ method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });
async function json(origin, path, init) {
  const response = await fetch(origin + path, init);
  assert.match(response.headers.get("cache-control"), /no-store/);
  return { status: response.status, headers: response.headers, body: await response.json() };
}
let projectId; let jobId;
try {
  await waitForHomepage(server);
  const created = await json(server.origin, "/api/v1/projects", write({ displayName: "HTTP queue fixture", draft: editableDraft() }));
  projectId = created.body.project.id;
  const base = `/api/v1/projects/${projectId}/jobs`;
  const key = randomUUID();
  const input = { type: "site_spec_validation", expectedRevision: 1 };
  const pair = await Promise.all([json(server.origin, base, write(input, key)), json(server.origin, base, write(input, key))]);
  assert.deepEqual(pair.map((r) => r.status), [201, 201]);
  assert.equal(pair.filter((r) => r.headers.get("idempotency-replayed") === "true").length, 1);
  assert.deepEqual(pair[0].body, pair[1].body);
  jobId = pair[0].body.job.id;
  assert.equal(pair[0].body.job.siteSpec.sha256, created.body.siteSpec.sha256);
  assert.equal(pair[0].body.job.dispatchable, false);
  assert.equal(pair[0].body.job.reason, "EXECUTOR_NOT_CONFIGURED");
  assert.equal((await json(server.origin, base)).body.jobs.length, 1);
  const saved = await json(server.origin, `/api/v1/projects/${projectId}/site-spec`, {
    ...write({ expectedRevision: 1, draft: editableDraft({ niche: "HTTP changed brief" }) }), method: "PUT"
  });
  assert.equal(saved.status, 200);
  const detail = await json(server.origin, `${base}/${jobId}`);
  assert.equal(detail.body.job.currentRevision, 2);
  assert.equal(detail.body.job.isInputStale, true);
  assert.equal(detail.body.job.siteSpec.revision, 1);
  assert.deepEqual((await json(server.origin, base, write(input, key))).body, pair[0].body);
  assert.equal((await json(server.origin, base, write(input))).body.error.code, "REVISION_CONFLICT");
  assert.equal((await json(server.origin, base, write({ ...input, expectedRevision: 2 }, key))).body.error.code, "IDEMPOTENCY_CONFLICT");
  for (const input of [{ type: "execute", expectedRevision: 2 }, { type: "site_spec_validation", expectedRevision: 2, shell: "blocked" }]) {
    assert.equal((await json(server.origin, base, write(input))).status, 422);
  }
  assert.equal((await json(server.origin, `${base}?limit=101`)).status, 422);
  assert.equal((await json(server.origin, `${base}?cursor=bad`)).body.error.code, "INVALID_CURSOR");
  assert.equal((await json(server.origin, base, { ...write(input), body: "{" })).status, 400);
  assert.equal((await json(server.origin, base, write({ payload: "x".repeat(70_000) }))).status, 413);
  assert.equal((await json(server.origin, base, { ...write(input), headers: { "Content-Type": "text/plain" } })).status, 415);
  const cancelKey = randomUUID();
  const cancelPath = `${base}/${jobId}/cancel`;
  const cancelled = await json(server.origin, cancelPath, write({ expectedVersion: 1 }, cancelKey));
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.job.state, "cancelled");
  assert.equal(cancelled.body.job.acceptanceResult, null);
  assert.deepEqual((await json(server.origin, cancelPath, write({ expectedVersion: 1 }, cancelKey))).body, cancelled.body);
  assert.equal((await json(server.origin, cancelPath, write({ expectedVersion: 2 }))).body.noOp, true);
  assert.equal((await json(server.origin, cancelPath, write({ expectedVersion: 1 }))).body.error.code, "JOB_VERSION_CONFLICT");
  const first = await json(server.origin, `${base}/${jobId}/events?limit=1`);
  const second = await json(server.origin, `${base}/${jobId}/events?limit=1&cursor=${first.body.nextCursor}`);
  assert.deepEqual([...first.body.events, ...second.body.events].map((e) => e.type), ["job_queued", "job_cancelled"]);
  const other = await json(server.origin, "/api/v1/projects", write({ displayName: "Other HTTP project", draft: editableDraft() }));
  const wrong = `/api/v1/projects/${other.body.project.id}/jobs/${jobId}`;
  assert.equal((await json(server.origin, wrong)).body.error.code, "JOB_NOT_FOUND");
  assert.equal((await json(server.origin, wrong + "/events")).body.error.code, "JOB_NOT_FOUND");
  assert.equal((await json(server.origin, wrong + "/cancel", write({ expectedVersion: 1 }, cancelKey))).body.error.code, "JOB_NOT_FOUND");
  console.log("JOBS_HTTP_PINNING_CONCURRENCY_REPLAY_CANCEL_PAGINATION passed");
} finally { await stopServer(server); }

const client = new pg.Client(config);
await client.connect();
try {
  const snapshot = async () => (await client.query(`SELECT
    (SELECT count(*) FROM jobs)::int AS jobs,(SELECT count(*) FROM job_events)::int AS events,
    (SELECT count(*) FROM api_idempotency_records)::int AS idempotency`)).rows;
  const before = await snapshot();
  for (const launch of [{ mode: null }, { mode: "local", host: "0.0.0.0" }]) {
    const publicServer = await startProductionServer(launch);
    try {
      await waitForHomepage(publicServer);
      const base = `/api/v1/projects/${projectId}/jobs`;
      for (const headers of [{}, { Host: "localhost", "X-Forwarded-Host": "127.0.0.1", "X-Forwarded-For": "127.0.0.1" }]) {
        for (const [path, init] of [[base, {}], [base, write({ type: "site_spec_validation", expectedRevision: 2 })],
          [`${base}/${jobId}`, {}], [`${base}/${jobId}/events`, {}], [`${base}/${jobId}/cancel`, write({ expectedVersion: 2 })]]) {
          const result = await json(publicServer.origin, path, { ...init, headers: { ...init.headers, ...headers } });
          assert.equal(result.status, 403);
          assert.equal(result.body.error.code, "PERSISTENCE_DISABLED");
        }
      }
      const connections = await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='b2b-site-studio'");
      assert.equal(connections.rows[0].count, 0);
    } finally { await stopServer(publicServer); }
  }
  assert.deepEqual(await snapshot(), before);
  console.log("JOBS_HTTP_PUBLIC_GATE passed (all endpoints, spoofed headers, zero application DB connections)");
  console.log("JOBS_HTTP_SHUTDOWN passed");
} finally { await client.end(); }
