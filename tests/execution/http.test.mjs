import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "../persistence/production-server.mjs";
import { newSecret } from "../../server/agents/requests.mjs";
import { VALIDATOR, validationReport } from "../../server/execution/contract.mjs";
import { sha256Json } from "../../server/persistence/canonical-json.mjs";
import { api, ok, write, httpFixture } from "./http-helpers.mjs";

const config = assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer();
let fixture; let agentId; const credential = newSecret("agt"); let leaseToken;
try {
  await waitForHomepage(server); fixture = await httpFixture(server.origin);
  const registration = { mode: "data_validation", agentName: "HTTP validator", agentVersion: "0.3.1", os: "linux",
    supportedApiVersions: ["v1"], agentSecret: credential, validator: VALIDATOR };
  const wrong = await api(server.origin, "/agents/register", write({ ...registration, validator: { ...VALIDATOR, sha256: "a".repeat(64) } }, fixture.pairing.pairingSecret));
  assert.equal(wrong.body.error.code, "VALIDATOR_MISMATCH");
  agentId = (await ok(server.origin, "/agents/register", write(registration, fixture.pairing.pairingSecret))).agentId;
  const path = `${fixture.base}/${fixture.job.id}`;
  assert.equal((await api(server.origin, `${path}/dispatch`, write({ agentId, expectedVersion: 1 }, credential))).body.error.code, "UNAUTHORIZED_OPERATOR");
  const dispatch = write({ agentId, expectedVersion: 1 });
  const pair = await Promise.all([ok(server.origin, `${path}/dispatch`, dispatch), ok(server.origin, `${path}/dispatch`, dispatch)]);
  assert.deepEqual(pair[0], pair[1]);
  const claims = await Promise.all([api(server.origin, `/agents/${agentId}/claim`, write({}, credential, "same-claim")),
    api(server.origin, `/agents/${agentId}/claim`, write({}, credential, "same-claim"))]);
  assert.equal(claims.filter((result) => result.status === 200).length, 1);
  assert.equal(claims.find((result) => result.status !== 200).body.error.code, "CLAIM_REPLY_UNAVAILABLE");
  const assignment = claims.find((result) => result.status === 200).body.assignment;
  leaseToken = assignment.leaseToken;
  const action = `/agents/${agentId}/jobs/${fixture.job.id}`;
  const bound = { leaseToken, attempt: assignment.attempt };
  assert.equal((await api(server.origin, `${action}/start`, write(bound, fixture.pairing.pairingSecret))).status, 401);
  assert.equal((await api(server.origin, `${action}/start`, write({ ...bound, leaseToken: `lease_${"x".repeat(43)}` }, credential))).body.error.code, "STALE_ATTEMPT");
  const start = write(bound, credential); await ok(server.origin, `${action}/start`, start);
  assert.equal((await ok(server.origin, `${action}/start`, start)).replayed, true);
  await ok(server.origin, `${action}/heartbeat`, write({ ...bound, phase: "validating" }, credential));
  const report = validationReport(assignment.jobSpec, assignment.attempt);
  const tampered = { ...report, validationStatus: "invalid" };
  assert.equal((await api(server.origin, `${action}/result`, write({ ...bound, report: tampered, resultDigest: sha256Json(tampered) }, credential))).body.error.code, "REPORT_MISMATCH");
  assert.equal((await ok(server.origin, `${path}/execution`)).report, null);
  const result = write({ ...bound, report, resultDigest: sha256Json(report) }, credential);
  await ok(server.origin, `${action}/result`, result);
  assert.equal((await ok(server.origin, `${action}/result`, result)).replayed, true);
  assert.equal((await ok(server.origin, path)).job.state, "succeeded");
  assert.equal((await ok(server.origin, `${path}/execution`)).acceptanceResult, null);
  for (const [body, expected] of [[{ command: "whoami" }, 422], [{ value: "x".repeat(3000) }, 413]]) {
    assert.equal((await api(server.origin, `/agents/${agentId}/claim`, write(body, credential))).status, expected);
  }
  assert.equal((await api(server.origin, `${action}/result`, write({ value: "x".repeat(18000) }, credential))).status, 413);
  assert.equal((await api(server.origin, `/agents/${agentId}/claim`, { ...write({}, credential), body: "{" })).status, 400);
  assert.equal((await api(server.origin, `/agents/${agentId}/claim`, { ...write({}, credential), headers: { "Content-Type": "text/plain", Authorization: `Bearer ${credential}` } })).status, 415);
  assert.equal((await api(server.origin, `/projects/${randomUUID()}/jobs/${fixture.job.id}/execution`)).status, 404);
  assert.equal((await api(server.origin, `${path}/execution`, { headers: { Authorization: `Bearer ${credential}` } })).status, 403);
  console.log("EXECUTION_HTTP_CONCURRENT_DISPATCH_CLAIM_STRICT_DTO_RESULT_RETRY_TAMPER_SCOPE passed");
} finally { await stopServer(server); }
const client = new pg.Client(config); await client.connect();
try {
  const snapshot = async () => {
    const data = {};
    for (const table of ["projects", "site_spec_revisions", "site_spec_readiness_checks", "jobs", "job_events", "agents", "agent_events", "agent_execution_grants", "job_executions", "job_attempts", "job_results", "execution_operations", "api_idempotency_records"]) {
      data[table] = (await client.query(`SELECT to_jsonb(t) FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return data;
  };
  const before = await snapshot();
  for (const secret of [credential, fixture.pairing.pairingSecret, leaseToken]) assert.equal(JSON.stringify(before).includes(secret), false);
  const path = `${fixture.base}/${fixture.job.id}`;
  const routes = [[`${path}/execution`, undefined], [`${path}/dispatch`, write({ agentId, expectedVersion: 1 })],
    [`/agents/${agentId}/claim`, write({}, credential)], ...["start", "heartbeat", "result", "fail", "cancel-ack"].map((kind) =>
      [`/agents/${agentId}/jobs/${fixture.job.id}/${kind}`, write({}, credential)])];
  for (const launch of [{ mode: null }, { mode: "local", host: "0.0.0.0" }]) {
    const publicServer = await startProductionServer(launch);
    try {
      await waitForHomepage(publicServer);
      for (const spoof of [false, true]) for (const [route, init] of routes) {
        const result = await api(publicServer.origin, route, { ...init, headers: { ...init?.headers,
          ...(spoof ? { Host: "localhost", "X-Forwarded-Host": "127.0.0.1", "X-Forwarded-For": "127.0.0.1" } : {}) } });
        assert.equal(result.status, 403); assert.equal(result.body.error.code, "PERSISTENCE_DISABLED");
      }
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='b2b-site-studio'")).rows[0].count, 0);
    } finally { await stopServer(publicServer); }
  }
  assert.deepEqual(await snapshot(), before);
  console.log("EXECUTION_HTTP_PUBLIC_WILDCARD_SPOOF_DENY_ZERO_SQL_NO_SECRET_STORAGE_SHUTDOWN passed");
} finally { await client.end(); }
