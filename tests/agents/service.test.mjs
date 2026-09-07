import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { getDatabasePool, closeDatabasePool } from "../../server/persistence/database.mjs";
import { createAgentService } from "../../server/agents/service.mjs";
import { newSecret, secretHash } from "../../server/agents/requests.mjs";

assertSafeTestDatabaseUrl();
before(prepareTestDatabase); after(closeDatabasePool);
let instant = Date.parse("2026-09-06T12:00:00.000Z");
const service = createAgentService({ clock: () => new Date(instant) });
const query = (sql, args) => getDatabasePool().query(sql, args);
const request = () => ({ mode: "presence_only", agentName: "Test Runner", agentVersion: "0.3.0", os: "windows", supportedApiVersions: ["v1"], agentSecret: newSecret("agt") });
const reject = (promise, code) => assert.rejects(promise, { code });
const counts = async () => (await query(`SELECT (SELECT count(*) FROM agents)::int AS agents,
  (SELECT count(*) FROM agent_pairings)::int AS pairings,(SELECT count(*) FROM agent_events)::int AS events,
  (SELECT count(*) FROM api_idempotency_records)::int AS idempotency`)).rows[0];
async function bound() {
  const pairing = await service.pair({}); const body = request(); const key = randomUUID();
  const registered = await service.register(pairing.pairingSecret, body, key);
  return { pairing, body, key, agentId: registered.response.agentId, response: registered.response };
}

void test("pairing and credential are independent; concurrent registration replays exactly once without stored secrets", async () => {
  const before = await counts();
  const pairing = await service.pair({}); const body = request(); const key = randomUUID();
  assert.equal(Date.parse(pairing.expiresAt) - instant, 300000);
  const results = await Promise.all([service.register(pairing.pairingSecret, body, key), service.register(pairing.pairingSecret, body, key)]);
  assert.deepEqual(results[0].response, results[1].response);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  const after = await counts();
  assert.deepEqual(after, { agents: before.agents + 1, pairings: before.pairings + 1, events: before.events + 2, idempotency: before.idempotency });
  const agentId = results[0].response.agentId;
  assert.equal(results[0].response.executionEnabled, false);
  assert.deepEqual(results[0].response.grantedCapabilities, []);
  assert.equal((await service.pairing(pairing.pairingId)).status, "consumed");
  assert.equal((await service.get(agentId)).agent.status, "offline");
  await service.health(agentId, body.agentSecret, { selectedApiVersion: "v1" });
  assert.deepEqual((await service.register(pairing.pairingSecret, body, key)).response, results[0].response);
  for (const changed of [{ ...body, agentName: "Other" }, { ...body, agentSecret: newSecret("agt") }]) await reject(service.register(pairing.pairingSecret, changed, key), "PAIRING_CONSUMED");
  await reject(service.register(pairing.pairingSecret, body, randomUUID()), "PAIRING_CONSUMED");
  for (const table of ["agents","agent_pairings","agent_events","api_idempotency_records"]) {
    const stored = JSON.stringify((await query(`SELECT to_jsonb(t) FROM ${table} t`)).rows);
    for (const secret of [pairing.pairingSecret,body.agentSecret,key]) assert.equal(stored.includes(secret), false);
  }
  const row = (await query("SELECT credential_sha256 FROM agents WHERE id=$1", [agentId])).rows[0];
  assert.equal(row.credential_sha256.trim(), secretHash(body.agentSecret));
});

void test("pairing expiry, cancellation and revoked registration replay are bounded and atomic", async () => {
  const expired = await service.pair({}); instant += 300000;
  await reject(service.register(expired.pairingSecret, request(), randomUUID()), "PAIRING_EXPIRED");
  assert.equal((await service.pairing(expired.pairingId)).status, "expired");
  const cancelled = await service.pair({});
  await service.cancelPairing(cancelled.pairingId, {});
  assert.deepEqual(await service.cancelPairing(cancelled.pairingId, {}), { status: "revoked", pairingId: cancelled.pairingId });
  await reject(service.register(cancelled.pairingSecret, request(), randomUUID()), "PAIRING_REVOKED");
  const binding = await bound();
  await service.revoke(binding.agentId, {});
  await reject(service.register(binding.pairing.pairingSecret, binding.body, binding.key), "AGENT_REVOKED");
  const timedReplay = await bound(); instant += 300000;
  await reject(service.register(timedReplay.pairing.pairingSecret, timedReplay.body, timedReplay.key), "PAIRING_EXPIRED");
});

void test("invalid metadata, protocol, identity and credential scopes never authorize presence", async () => {
  const binding = await bound(); const before = await counts();
  await reject(service.register(newSecret("pair"), request(), randomUUID()), "UNAUTHORIZED_AGENT");
  await reject(service.register(binding.body.agentSecret, request(), randomUUID()), "UNAUTHORIZED_AGENT");
  for (const body of [{ ...request(), workspaceId: randomUUID() }, { ...request(), agentName: " " },
    { ...request(), agentName: binding.pairing.pairingSecret }, { ...request(), command: "forbidden" }, { ...request(), environment: {} }]) {
    await reject(service.register(binding.pairing.pairingSecret, body, randomUUID()), "VALIDATION_FAILED");
  }
  await reject(service.register(binding.pairing.pairingSecret, { ...request(), supportedApiVersions: ["v2"] }, randomUUID()), "INCOMPATIBLE_PROTOCOL_VERSION");
  for (const secret of [binding.pairing.pairingSecret,newSecret("agt")]) await reject(service.health(binding.agentId, secret, { selectedApiVersion: "v1" }), "UNAUTHORIZED_AGENT");
  await reject(service.health(`agent_${randomUUID().replaceAll("-", "")}`, binding.body.agentSecret, { selectedApiVersion: "v1" }), "UNAUTHORIZED_AGENT");
  const foreign = createAgentService({ workspaceId: randomUUID() });
  await reject(foreign.health(binding.agentId, binding.body.agentSecret, { selectedApiVersion: "v1" }), "UNAUTHORIZED_AGENT");
  await reject(foreign.get(binding.agentId), "AGENT_NOT_FOUND");
  await reject(foreign.revoke(binding.agentId, {}), "AGENT_NOT_FOUND");
  await reject(foreign.pairing(binding.pairing.pairingId), "PAIRING_NOT_FOUND");
  assert.deepEqual((await foreign.list()).agents, []);
  await reject(service.health(binding.agentId, binding.body.agentSecret, { selectedApiVersion: "v2" }), "INCOMPATIBLE_PROTOCOL_VERSION");
  await reject(service.health(binding.agentId, binding.body.agentSecret, { selectedApiVersion: "v1", status: "online", lastSeenAt: "2099-01-01" }), "VALIDATION_FAILED");
  assert.equal((await service.get(binding.agentId)).agent.lastSeenAt, null);
  assert.deepEqual(await counts(), before);
});

void test("server clock derives offline after three intervals; heartbeat/revoke races never restore access", async () => {
  const { agentId, body } = await bound();
  await service.health(agentId, body.agentSecret, { selectedApiVersion: "v1" });
  const seen = (await service.get(agentId)).agent.lastSeenAt;
  assert.equal(seen, new Date(instant).toISOString());
  instant += 59999; assert.equal((await service.get(agentId)).agent.status, "online");
  instant++; assert.equal((await service.get(agentId)).agent.status, "offline");
  await service.health(agentId, body.agentSecret, { selectedApiVersion: "v1" });
  for (let i = 0; i < 6; i++) {
    const active = await bound();
    const actions = [() => service.health(active.agentId, active.body.agentSecret, { selectedApiVersion: "v1" }), () => service.revoke(active.agentId, {})];
    if (i % 2) actions.reverse();
    const results = await Promise.allSettled(actions.map((run) => run()));
    for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "AGENT_REVOKED");
    assert.equal((await service.get(active.agentId)).agent.status, "revoked");
    assert.equal((await service.revoke(active.agentId, {})).noOp, true);
    await reject(service.health(active.agentId, active.body.agentSecret, { selectedApiVersion: "v1" }), "AGENT_REVOKED");
    assert.equal((await query("SELECT count(*)::int AS count FROM agent_events WHERE agent_id=$1 AND event_type='agent_revoked'", [active.agentId])).rows[0].count, 1);
  }
});

void test("event failure rolls back registration/revoke; identity, revocation and event journal are immutable", async () => {
  const binding = await bound(); const pending = await service.pair({}); const body = request(); const before = await counts();
  await query(`CREATE FUNCTION fail_agent_event_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected failure'; END; $$`);
  await query("CREATE TRIGGER fail_agent_event_test BEFORE INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION fail_agent_event_test()");
  try {
    await assert.rejects(service.register(pending.pairingSecret, body, randomUUID()));
    await assert.rejects(service.revoke(binding.agentId, {}));
    assert.deepEqual(await counts(), before);
    assert.equal((await service.pairing(pending.pairingId)).status, "pending");
    assert.equal((await service.get(binding.agentId)).agent.status, "offline");
  } finally { await query("DROP TRIGGER fail_agent_event_test ON agent_events"); await query("DROP FUNCTION fail_agent_event_test()"); }
  for (const sql of ["UPDATE agents SET credential_sha256=repeat('0',64) WHERE id=$1", "DELETE FROM agents WHERE id=$1",
    "DELETE FROM agent_events WHERE agent_id=$1", "UPDATE agent_events SET payload='{}' WHERE agent_id=$1"]) await assert.rejects(query(sql, [binding.agentId]), { code: "55000" });
  await assert.rejects(query("UPDATE agent_pairings SET consumed_at=NULL WHERE id=$1", [binding.pairing.pairingId]), { code: "55000" });
  await service.revoke(binding.agentId, {});
  await assert.rejects(query("UPDATE agents SET status='registered',revoked_at=NULL WHERE id=$1", [binding.agentId]), { code: "55000" });
});

void test("lists have scoped validated cursors and pending pairing count is bounded", async () => {
  const first = await service.list(new URLSearchParams({ limit: "2" }));
  const second = await service.list(new URLSearchParams({ limit: "2", cursor: first.nextCursor }));
  assert.equal(new Set([...first.agents,...second.agents].map((a) => a.agentId)).size, 4);
  await reject(createAgentService({ workspaceId: randomUUID() }).list(new URLSearchParams({ cursor: first.nextCursor })), "INVALID_CURSOR");
  for (const params of ["limit=0","limit=101","limit=1&limit=2","workspaceId=other"]) await reject(service.list(new URLSearchParams(params)), "VALIDATION_FAILED");
  await reject(service.list(new URLSearchParams({ cursor: "bad" })), "INVALID_CURSOR");
  const decoded = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
  for (const at of ["0000-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "2026-02-30T00:00:00.000Z"]) {
    const cursor = Buffer.from(JSON.stringify({ ...decoded, at })).toString("base64url");
    await reject(service.list(new URLSearchParams({ cursor })), "INVALID_CURSOR");
  }
  instant += 300000;
  for (let i = 0; i < 10; i++) await service.pair({});
  await reject(service.pair({}), "PAIRING_LIMIT_REACHED");
  instant += 300000; assert.equal((await service.pair({})).status, "pending");
});
