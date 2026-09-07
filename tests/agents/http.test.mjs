import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer,waitForHomepage,stopServer } from "../persistence/production-server.mjs";
import { newSecret } from "../../server/agents/requests.mjs";

const config = assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer();
const write = (body = {},secret,key) => ({ method:"POST",headers:{ "Content-Type":"application/json",...(secret ? { Authorization:`Bearer ${secret}` } : {}),...(key ? { "Idempotency-Key":key } : {}) },body:JSON.stringify(body) });
async function api(origin,path,init) {
  const response = await fetch(origin + "/api/v1" + path,init);
  assert.match(response.headers.get("cache-control"),/no-store/);
  return { status:response.status,body:await response.json() };
}
let pairing; let agentId; let agentSecret;
try {
  await waitForHomepage(server);
  pairing = (await api(server.origin,"/agents/pairings",write())).body;
  agentSecret = newSecret("agt");
  const input = { mode:"presence_only",agentName:"HTTP fixture",agentVersion:"0.3.0",os:"linux",supportedApiVersions:["v1"],agentSecret };
  const key = randomUUID();
  const results = await Promise.all([api(server.origin,"/agents/register",write(input,pairing.pairingSecret,key)),api(server.origin,"/agents/register",write(input,pairing.pairingSecret,key))]);
  assert.deepEqual(results.map((r) => r.status),[201,201]); assert.deepEqual(results[0],results[1]);
  agentId = results[0].body.agentId;
  assert.equal((await api(server.origin,"/agents")).body.agents.length,1);
  assert.equal((await api(server.origin,`/agents/pairings/${pairing.pairingId}`)).body.status,"consumed");
  assert.equal((await api(server.origin,`/agents/${agentId}/health`,write({ selectedApiVersion:"v1" },agentSecret))).status,200);
  assert.equal((await api(server.origin,`/agents/${agentId}`)).body.agent.status,"online");
  assert.equal((await api(server.origin,`/agents/${agentId}/health`,write({ selectedApiVersion:"v1" },pairing.pairingSecret))).status,401);
  assert.equal((await api(server.origin,`/agents/${agentId}/health`,write({ selectedApiVersion:"v2" },agentSecret))).body.error.code,"INCOMPATIBLE_PROTOCOL_VERSION");
  assert.equal((await api(server.origin,"/agents/register",write(input,agentSecret,key))).status,401);
  for (const [path,init] of [["/agents",{}],[`/agents/${agentId}`,{}],["/agents/pairings",write()],
    [`/agents/pairings/${pairing.pairingId}`,{}],[`/agents/pairings/${pairing.pairingId}/cancel`,write()],[`/agents/${agentId}/revoke`,write()],
    ["/projects",{}],["/projects",write({ displayName:"must not be created" })],["/health/database",{}]]) {
    const result = await api(server.origin,path,{ ...init,headers:{ ...init.headers,Authorization:`Bearer ${agentSecret}` } });
    assert.equal(result.status,403); assert.equal(result.body.error.code,"UNAUTHORIZED_OPERATOR");
  }
  for (const [body,status] of [[{ workspaceId:randomUUID() },422],[{ payload:"x".repeat(70000) },413]]) {
    assert.equal((await api(server.origin,"/agents/pairings",write(body))).status,status);
  }
  assert.equal((await api(server.origin,"/agents/pairings",{ ...write(),body:"{" })).status,400);
  assert.equal((await api(server.origin,"/agents/pairings",{ ...write(),headers:{ "Content-Type":"text/plain" } })).status,415);
  const cancelled = (await api(server.origin,"/agents/pairings",write())).body;
  await api(server.origin,`/agents/pairings/${cancelled.pairingId}/cancel`,write());
  assert.equal((await api(server.origin,"/agents/register",write({ ...input,agentSecret:newSecret("agt") },cancelled.pairingSecret,randomUUID()))).body.error.code,"PAIRING_REVOKED");
  const revoked = await api(server.origin,`/agents/${agentId}/revoke`,write());
  assert.equal(revoked.body.agent.status,"revoked");
  assert.equal((await api(server.origin,`/agents/${agentId}/revoke`,write())).body.noOp,true);
  assert.equal((await api(server.origin,`/agents/${agentId}/health`,write({ selectedApiVersion:"v1" },agentSecret))).body.error.code,"AGENT_REVOKED");
  assert.equal((await api(server.origin,"/agents/register",write(input,pairing.pairingSecret,key))).body.error.code,"AGENT_REVOKED");
  for (const secret of [pairing.pairingSecret,agentSecret,cancelled.pairingSecret]) assert.equal(server.output().includes(secret),false);
  console.log("AGENTS_HTTP_PAIR_REGISTER_CONCURRENCY_HEALTH_REVOKE_OPERATOR_SEPARATION passed");
} finally { await stopServer(server); }

const client = new pg.Client(config); await client.connect();
try {
  const snapshot = async () => {
    const data = {};
    for (const table of ["agents","agent_pairings","agent_events","api_idempotency_records"]) data[table] = (await client.query(`SELECT to_jsonb(t) FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return data;
  };
  const before = await snapshot();
  assert.doesNotMatch(JSON.stringify(before),/(?:pair|agt)_[A-Za-z0-9_-]{43}/);
  for (const launch of [{ mode:null },{ mode:"local",host:"0.0.0.0" }]) {
    const publicServer = await startProductionServer(launch);
    try {
      await waitForHomepage(publicServer);
      for (const spoofed of [false,true]) for (const [path,init] of [["/agents",{}],["/agents/pairings",write()],
        [`/agents/pairings/${pairing.pairingId}`,{}],[`/agents/pairings/${pairing.pairingId}/cancel`,write()],
        ["/agents/register",write({},pairing.pairingSecret,randomUUID())],[`/agents/${agentId}`,{}],
        [`/agents/${agentId}/revoke`,write()],[`/agents/${agentId}/health`,write({ selectedApiVersion:"v1" },agentSecret)]]) {
        const result = await api(publicServer.origin,path,{ ...init,headers:{ ...init.headers,...(spoofed ? { Host:"localhost","X-Forwarded-Host":"127.0.0.1","X-Forwarded-For":"127.0.0.1" } : {}) } });
        assert.equal(result.status,403); assert.equal(result.body.error.code,"PERSISTENCE_DISABLED");
      }
      assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='b2b-site-studio'")).rows[0].count,0);
    } finally { await stopServer(publicServer); }
  }
  assert.deepEqual(await snapshot(),before);
  console.log("AGENTS_HTTP_PUBLIC_GATE_ZERO_DB_CONNECTIONS_NO_SECRET_STORAGE_SHUTDOWN passed");
} finally { await client.end(); }
