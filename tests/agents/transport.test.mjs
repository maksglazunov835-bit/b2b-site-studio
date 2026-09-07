import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { localOrigin, post } from "../../agent/transport.mjs";
import { reply } from "../../agent/protocol.mjs";
import { runnerEnvironment } from "../../agent/environment.mjs";
import { options } from "../../agent/session.mjs";

assertSafeTestDatabaseUrl();
const body = { mode: "presence_only", selectedApiVersion: "v1", executionEnabled: false, freeSlots: 0, currentJobId: null,
  grantedCapabilities: [], agentId: `agent_${"1".repeat(32)}`, heartbeatIntervalSeconds: 1, status: "registered" };
async function fixture(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

void test("Runner permits explicit numeric loopback only, fixed endpoints and allowlisted environment", async () => {
  for (const origin of ["http://remote.example:3000","http://localhost:3000","http://127.1:3000","http://2130706433:3000",
    "http://127.0.0.1","http://user:secret@127.0.0.1:3000","http://127.0.0.1:3000/path","http://127.0.0.1:3000?",
    "http://127.0.0.1:3000#","http://127.0.0.1:99999","https://127.0.0.1:3000"]) assert.throws(() => localOrigin(origin), { code: "LOCAL_ORIGIN_REQUIRED" });
  assert.equal(localOrigin("http://[::1]:3000/"), "http://[::1]:3000");
  assert.deepEqual(runnerEnvironment({ SystemRoot: "system", PATH: "ignored", DATABASE_URL: "private", TEST_DATABASE_URL: "private",
    GH_TOKEN: "private", OPENAI_API_KEY: "private", NODE_OPTIONS: "private", HTTPS_PROXY: "private" }), { SystemRoot: "system" });
  assert.throws(() => options(["--origin","http://127.0.0.1:3000","--secret","never"]), { code: "INVALID_OPTIONS" });
  await assert.rejects(post("http://127.0.0.1:3000", "/api/v1/projects", "secret", "{}"), { code: "INVALID_ENDPOINT" });
});

void test("real HTTP transport refuses redirects, timeouts, oversized bodies, broken JSON and bad content type", async () => {
  let redirected = 0;
  await fixture((req,res) => { redirected++; res.end(); }, async (destination) => {
    await fixture((req,res) => { res.writeHead(302, { Location: destination }); res.end(); }, async (origin) => {
      await assert.rejects(post(origin,"/api/v1/agents/register","fixture-secret","{}"), { code: "REDIRECT_REFUSED" });
    });
  });
  assert.equal(redirected,0);
  await fixture(() => {}, async (origin) => {
    await assert.rejects(post(origin,"/api/v1/agents/register","fixture-secret","{}", { timeoutMs: 75 }), { code: "REQUEST_TIMEOUT" });
  });
  for (const [text,headers,code] of [["{", { "Content-Type": "application/json" }, "INVALID_RESPONSE"],
    ["{}", { "Content-Type": "text/html" }, "INVALID_RESPONSE"],
    ["x".repeat(17000), { "Content-Type": "application/json" }, "RESPONSE_TOO_LARGE"]]) {
    await fixture((req,res) => { res.writeHead(201,headers); res.end(text); }, async (origin) => {
      await assert.rejects(post(origin,"/api/v1/agents/register","fixture-secret","{}"), { code });
    });
  }
});

void test("Runner validates the server-selected profile and never accepts executable capabilities or arbitrary URLs", async () => {
  assert.deepEqual(reply({ status:201, body }, "register"), body);
  for (const invalid of [{ ...body, selectedApiVersion:"v2" }, { ...body, executionEnabled:true }, { ...body, freeSlots:1 },
    { ...body, grantedCapabilities:["codex"] }, { ...body, heartbeatIntervalSeconds:0 }, { ...body, heartbeatIntervalSeconds:31 },
    { ...body, healthUrl:"http://external.example" }, { ...body, agentId:"other" }, { ...body, maxLeaseSeconds:1 }]) {
    await fixture((req,res) => { res.writeHead(201, { "Content-Type":"application/json" }); res.end(JSON.stringify(invalid)); }, async (origin) => {
      const response = await post(origin,"/api/v1/agents/register","fixture-secret","{}");
      assert.throws(() => reply(response,"register"));
    });
  }
});
