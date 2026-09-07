import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { closeDatabasePool, getDatabasePool, withTransaction } from "../../server/persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID, insertRevision, updateProjectCurrentRevision } from "../../server/persistence/repository.mjs";
import { newSecret } from "../../server/agents/requests.mjs";
import { saveDraft, getProject } from "../../server/persistence/service.mjs";
import { jobs } from "../../server/jobs/service.mjs";
import { createExecutionService } from "../../server/execution/service.mjs";
import { sha256Json } from "../../server/persistence/canonical-json.mjs";
import { validationReport, VALIDATOR } from "../../server/execution/contract.mjs";
import { fixture } from "./helpers.mjs";

assertSafeTestDatabaseUrl(); before(prepareTestDatabase); after(closeDatabasePool);
const query = (sql, values) => getDatabasePool().query(sql, values);
const rejects = (value, code) => assert.rejects(value, { code });
async function running(f) { const { assignment } = await f.claim(); await f.action(assignment, "start"); await f.action(assignment, "heartbeat", { phase: "validating" }); return assignment; }
async function result(f, assignment, key = randomUUID()) {
  const report = validationReport(assignment.jobSpec, assignment.attempt);
  return f.action(assignment, "result", { report, resultDigest: sha256Json(report) }, key);
}
void test("explicit scoped dispatch pins a complete immutable spec and independently confirms report", async () => {
  const f = await fixture(); const before = await getProject(f.projectId);
  await saveDraft(f.projectId, { expectedRevision: 1, draft: { companyName: "Later draft" } }, randomUUID());
  const assignment = await running(f);
  assert.equal(assignment.jobSpec.input.revision, 1); assert.equal(assignment.jobSpec.input.snapshot.business.name, before.siteSpec.value.business.name);
  const ack = await result(f, assignment); assert.equal(ack.state, "succeeded");
  const detail = await f.execution.detail(f.projectId, f.jobId);
  assert.equal(detail.report.validationStatus, "valid"); assert.equal(detail.acceptanceResult, null);
  assert.equal(detail.attempts[0].state, "succeeded");
  assert.equal((await getProject(f.projectId)).project.currentRevision, 2);
  const oldReadiness = (await query("SELECT canonical_site_spec->'readiness' AS readiness FROM site_spec_revisions WHERE project_id=$1 AND revision=1", [f.projectId])).rows[0].readiness;
  assert.deepEqual(oldReadiness, before.siteSpec.value.readiness);
  for (const table of ["agent_pairings","agents","agent_execution_grants","job_executions","job_attempts","job_results","execution_operations","job_events","api_idempotency_records"]) {
    const data = JSON.stringify((await query(`SELECT to_jsonb(t) FROM ${table} t`)).rows);
    for (const secret of [f.credential, f.pairing.pairingSecret, assignment.leaseToken]) assert.equal(data.includes(secret), false);
  }
});
void test("presence stays unprivileged and workspace/project/agent assignments remain isolated", async () => {
  const f = await fixture({ presence: true, dispatch: false });
  await rejects(f.claim(), "EXECUTION_NOT_GRANTED");
  await rejects(f.execution.dispatch(f.projectId, f.jobId, { agentId: f.agentId, expectedVersion: 1 }, randomUUID()), "EXECUTION_NOT_GRANTED");
  const other = await fixture({ dispatch: false });
  await rejects(other.execution.dispatch(f.projectId, f.jobId, { agentId: other.agentId, expectedVersion: 1 }, randomUUID()), "EXECUTION_NOT_GRANTED");
  const foreign = createExecutionService({ workspaceId: randomUUID() });
  await rejects(foreign.claim(other.agentId, other.credential, {}, randomUUID()), "UNAUTHORIZED_AGENT");
  const assigned = await fixture(); const second = await fixture({ projectId: assigned.projectId, dispatch: false });
  assert.equal((await second.claim()).assignment, null);
  const a = (await assigned.claim()).assignment;
  await rejects(second.execution.action(second.agentId, assigned.jobId, second.credential, "start", { attempt: a.attempt, leaseToken: a.leaseToken }, randomUUID()), "STALE_ATTEMPT");
});
void test("concurrent dispatch/claim create one assignment and occupy exactly one slot", async () => {
  const f = await fixture({ dispatch: false }); const key = randomUUID();
  const dispatched = await Promise.all([0,1].map(() => f.execution.dispatch(f.projectId, f.jobId, { agentId: f.agentId, expectedVersion: 1 }, key)));
  assert.equal(dispatched.filter((item) => item.replayed).length, 1);
  await rejects(f.execution.dispatch(f.projectId, f.jobId, { agentId: f.agentId, expectedVersion: 2 }, key), "IDEMPOTENCY_CONFLICT");
  const claims = await Promise.all([f.claim(), f.claim()]);
  assert.equal(claims.filter((item) => item.assignment).length, 1);
  assert.equal((await query("SELECT count(*)::int n FROM job_attempts WHERE agent_id=$1 AND finished_at IS NULL", [f.agentId])).rows[0].n, 1);
});
void test("lost claim is not replayed in plaintext; lease sweep fences old attempts and bounds retries", async () => {
  const f = await fixture(); const key = randomUUID(); const old = (await f.claim(key)).assignment;
  await rejects(f.claim(key), "CLAIM_REPLY_UNAVAILABLE");
  f.time.now += 10000; await f.execution.sweep();
  const next = (await f.claim()).assignment; assert.equal(next.attempt, 2);
  await rejects(f.action(old, "start"), "STALE_ATTEMPT");
  f.time.now += 10000; await f.execution.sweep();
  const third = (await f.claim()).assignment; assert.equal(third.attempt, 3);
  f.time.now += 10000; await f.execution.sweep();
  assert.equal((await f.claim()).assignment, null);
  assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "failed");
  assert.equal((await f.execution.detail(f.projectId, f.jobId)).attempts[2].failure_code, "ATTEMPTS_EXHAUSTED");
});
void test("start/result replies replay safely and modified result/key payload is rejected", async () => {
  const f = await fixture(); const a = (await f.claim()).assignment; const startKey = randomUUID();
  await f.action(a, "start", {}, startKey); assert.equal((await f.action(a, "start", {}, startKey)).replayed, true);
  await f.action(a, "heartbeat", { phase: "validating" });
  const key = randomUUID(); await result(f, a, key); assert.equal((await result(f, a, key)).replayed, true);
  const report = validationReport(a.jobSpec, a.attempt); report.validationStatus = "invalid";
  await rejects(f.action(a, "result", { report, resultDigest: sha256Json(report) }, key), "IDEMPOTENCY_CONFLICT");
  assert.equal((await query("SELECT count(*)::int n FROM job_results WHERE job_id=$1", [f.jobId])).rows[0].n, 1);
  await f.agents.revoke(f.agentId, {}); await rejects(result(f, a, key), "AGENT_REVOKED");
});
void test("tampered report/input binding cannot produce success or independent acceptance", async () => {
  const f = await fixture(); const a = await running(f); const report = validationReport(a.jobSpec, a.attempt);
  for (const changed of [{ ...report, inputSha256: "0".repeat(64) }, { ...report, validationStatus: "invalid" }, { ...report, counts: { schema: 1, semantic: 0 } }]) {
    await rejects(f.action(a, "result", { report: changed, resultDigest: sha256Json(changed) }), "REPORT_MISMATCH");
  }
  await rejects(f.action(a, "result", { report: { ...report, acceptanceResult: "accepted" }, resultDigest: sha256Json(report) }), "VALIDATION_FAILED");
  assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "validating");
  assert.equal((await f.execution.detail(f.projectId, f.jobId)).report, null);
  await result(f, a);
});
void test("lease heartbeat is separate from presence and cannot exceed the 30-second deadline", async () => {
  const f = await fixture(); const a = await running(f); const deadline = a.deadlineAt;
  for (let i = 0; i < 3; i++) { f.time.now += 9000; const ack = await f.action(a, "heartbeat", { phase: "validating" }); assert.equal(ack.deadlineAt, deadline); assert.ok(Date.parse(ack.leaseExpiresAt) <= Date.parse(deadline)); }
  f.time.now += 3000;
  await f.agents.health(f.agentId, f.credential, { selectedApiVersion: "v1" });
  await rejects(result(f, a), "LEASE_EXPIRED");
});
void test("active cancel requires acknowledgement; revoke never permits a late success or fake cancelled", async () => {
  const f = await fixture(); const a = await running(f);
  const version = (await jobs.get(f.projectId, f.jobId)).job.version;
  await jobs.cancel(f.projectId, f.jobId, { expectedVersion: version }, randomUUID());
  assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "cancel_requested");
  assert.equal((await f.action(a, "heartbeat", { phase: "validating" })).cancelRequested, true);
  await rejects(result(f, a), "CANCEL_REQUESTED");
  const key = randomUUID(); await f.action(a, "cancel-ack", {}, key); assert.equal((await f.action(a, "cancel-ack", {}, key)).replayed, true);
  assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "cancelled");
  const revoked = await fixture(); const active = await running(revoked);
  await revoked.agents.revoke(revoked.agentId, {});
  assert.equal((await jobs.get(revoked.projectId, revoked.jobId)).job.state, "cancel_requested");
  await rejects(result(revoked, active), "AGENT_REVOKED");
  await rejects(revoked.action(active, "cancel-ack"), "AGENT_REVOKED");
  revoked.time.now += 10000; await revoked.execution.sweep();
  const detail = await revoked.execution.detail(revoked.projectId, revoked.jobId);
  assert.equal(detail.attempts[0].failure_code, "STOP_UNCONFIRMED");
  assert.equal((await jobs.get(revoked.projectId, revoked.jobId)).job.state, "failed");
});
void test("event/result/deferred commit errors roll back every part of completion; terminal data immutable", async () => {
  const f = await fixture(); const a = await running(f);
  for (const target of ["job_events", "job_results"]) {
    await query("CREATE FUNCTION reject_execution_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected'; END; $$");
    await query(`CREATE TRIGGER reject_execution_test BEFORE INSERT ON ${target} FOR EACH ROW EXECUTE FUNCTION reject_execution_test()`);
    try { await assert.rejects(result(f, a)); }
    finally { await query(`DROP TRIGGER reject_execution_test ON ${target}`); await query("DROP FUNCTION reject_execution_test()"); }
    assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "validating");
    assert.equal((await f.execution.detail(f.projectId, f.jobId)).report, null);
  }
  await query("CREATE FUNCTION reject_execution_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected commit'; END; $$");
  await query("CREATE CONSTRAINT TRIGGER reject_execution_test AFTER INSERT ON job_results DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_execution_test()");
  try { await assert.rejects(result(f, a)); }
  finally { await query("DROP TRIGGER reject_execution_test ON job_results"); await query("DROP FUNCTION reject_execution_test()"); }
  assert.equal((await f.execution.detail(f.projectId, f.jobId)).report, null);
  await result(f, a);
  for (const sql of ["DELETE FROM job_results WHERE job_id=$1", "UPDATE job_results SET report='{}' WHERE job_id=$1", "UPDATE job_attempts SET state='running' WHERE job_id=$1", "DELETE FROM job_executions WHERE job_id=$1"]) await assert.rejects(query(sql, [f.jobId]), { code: "55000" });
});
void test("pairing mode is purpose-bound; incompatible registration never consumes permission", async () => {
  const f = await fixture({ dispatch: false });
  const data = await f.agents.pair({ mode: "data_validation", projectId: f.projectId });
  const presence = await f.agents.pair({});
  const registration = { mode: "presence_only", agentName: "Mode fixture", agentVersion: "0.3.1", os: "linux", supportedApiVersions: ["v1"], agentSecret: newSecret("agt") };
  await rejects(f.agents.register(data.pairingSecret, registration, randomUUID()), "EXECUTION_SCOPE_MISMATCH");
  await rejects(f.agents.register(presence.pairingSecret, { ...registration, mode: "data_validation", validator: VALIDATOR }, randomUUID()), "EXECUTION_SCOPE_MISMATCH");
  await rejects(f.agents.register(data.pairingSecret, { ...registration, mode: "data_validation", validator: { ...VALIDATOR, sha256: "f".repeat(64) } }, randomUUID()), "VALIDATOR_MISMATCH");
  assert.equal((await f.agents.pairing(data.pairingId)).status, "pending");
  const input = { ...registration, mode: "data_validation", validator: VALIDATOR }; const key = randomUUID();
  const replies = await Promise.all([f.agents.register(data.pairingSecret, input, key), f.agents.register(data.pairingSecret, input, key)]);
  assert.deepEqual(replies[0].response, replies[1].response);
  assert.equal(replies.filter((item) => item.replayed).length, 1);
  await f.agents.cancelPairing(presence.pairingId, {});
});
void test("concurrent result/cancel and result/revoke linearize without false acknowledgement", async () => {
  for (const operation of ["cancel", "revoke"]) for (let index = 0; index < 3; index++) {
    const f = await fixture(); const a = await running(f);
    const current = (await jobs.get(f.projectId, f.jobId)).job;
    const stop = () => operation === "cancel" ? jobs.cancel(f.projectId, f.jobId, { expectedVersion: current.version }, randomUUID()) : f.agents.revoke(f.agentId, {});
    const replies = await Promise.allSettled(index % 2 ? [result(f, a), stop()] : [stop(), result(f, a)]);
    const state = (await jobs.get(f.projectId, f.jobId)).job.state;
    assert.ok(["succeeded", "cancel_requested"].includes(state));
    for (const reply of replies.filter((item) => item.status === "rejected")) assert.ok(["AGENT_REVOKED", "CANCEL_REQUESTED", "JOB_VERSION_CONFLICT"].includes(reply.reason.code));
    const detail = await f.execution.detail(f.projectId, f.jobId);
    assert.equal(!!detail.report, state === "succeeded");
    if (state === "cancel_requested") {
      if (operation === "cancel") await f.action(a, "cancel-ack");
      else { f.time.now += 10000; await f.execution.sweep(); }
    }
    if (operation === "revoke") await rejects(result(f, a), "AGENT_REVOKED");
  }
});
void test("an invalid historical snapshot produces a completed invalid report without changing data/readiness", async () => {
  const existing = await fixture({ dispatch: false });
  const snapshot = { projectId: existing.projectId, revision: 2, schemaVersion: "1.2.0" };
  // Simulate a structurally JSON legacy import, never bypass checks in public persistence APIs.
  await withTransaction(async (client) => {
    await insertRevision(client, { id: randomUUID(), workspaceId: DEFAULT_WORKSPACE_ID, projectId: existing.projectId,
      revision: 2, schemaVersion: "1.2.0", documentStage: "draft", siteSpec: snapshot, canonicalSha256: sha256Json(snapshot),
      editableSha256: sha256Json({}), idempotencyKey: randomUUID(), actorType: "test", source: "legacy_fixture" });
    await updateProjectCurrentRevision(client, DEFAULT_WORKSPACE_ID, existing.projectId, 2);
  });
  const before = (await query("SELECT to_jsonb(r) AS row FROM site_spec_revisions r WHERE project_id=$1 ORDER BY revision", [existing.projectId])).rows;
  const readiness = (await query("SELECT to_jsonb(c) AS row FROM site_spec_readiness_checks c JOIN site_spec_revisions r ON r.id=c.revision_id WHERE r.project_id=$1 ORDER BY c.check_id,c.gate", [existing.projectId])).rows;
  const f = await fixture({ projectId: existing.projectId, revision: 2 }); const a = await running(f); await result(f, a);
  const detail = await f.execution.detail(f.projectId, f.jobId);
  assert.equal(detail.report.validationStatus, "invalid"); assert.ok(detail.report.counts.schema > 0);
  assert.equal((await jobs.get(f.projectId, f.jobId)).job.state, "succeeded");
  assert.deepEqual((await query("SELECT to_jsonb(r) AS row FROM site_spec_revisions r WHERE project_id=$1 ORDER BY revision", [existing.projectId])).rows, before);
  assert.deepEqual((await query("SELECT to_jsonb(c) AS row FROM site_spec_readiness_checks c JOIN site_spec_revisions r ON r.id=c.revision_id WHERE r.project_id=$1 ORDER BY c.check_id,c.gate", [existing.projectId])).rows, readiness);
});
