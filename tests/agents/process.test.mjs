import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer,waitForHomepage,stopServer } from "../persistence/production-server.mjs";
import { startRunner,until,finishRunner,stopRunner } from "./process-helpers.mjs";

assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer({ agentIntervalSeconds:1 });
const runners = []; const secrets = [];
const write = { method:"POST",headers:{ "Content-Type":"application/json" },body:"{}" };
const pair = async () => { const result = await (await fetch(`${server.origin}/api/v1/agents/pairings`,write)).json(); secrets.push(result.pairingSecret); return result; };
const agents = async () => (await (await fetch(`${server.origin}/api/v1/agents`)).json()).agents;
const registrations = [];
let proxy;
try {
  await waitForHomepage(server);
  // The child uses real sockets through this loopback loss injector to the built server.
  proxy = http.createServer(async (request,response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      if (request.url === "/api/v1/agents/register") {
        registrations.push({ body,key:request.headers["idempotency-key"] });
        secrets.push(JSON.parse(body).agentSecret);
      }
      const result = await fetch(server.origin + request.url, { method:"POST",headers:{ Authorization:request.headers.authorization,"Content-Type":"application/json",...(request.headers["idempotency-key"] ? { "Idempotency-Key":request.headers["idempotency-key"] } : {}) },body });
      const text = await result.text();
      if (request.url === "/api/v1/agents/register" && registrations.length === 1) { response.destroy(); return; }
      response.writeHead(result.status,{ "Content-Type":"application/json" }); response.end(text);
    } catch { response.destroy(); }
  });
  await new Promise((resolve) => proxy.listen(0,"127.0.0.1",resolve));
  const pairing = await pair();
  const runner = startRunner(`http://127.0.0.1:${proxy.address().port}`,pairing.pairingSecret);
  runners.push(runner);
  await until(() => {
    if (runner.child.exitCode !== null || runner.child.signalCode !== null) throw new Error(`Runner exited before heartbeat: ${runner.output().match(/RUNNER_STOPPED ([A-Z_]+)/)?.[1] ?? "UNKNOWN"}`);
    return (runner.output().match(/RUNNER_HEARTBEAT_ACK/g) ?? []).length >= 3;
  });
  assert.equal(registrations.length,2);
  const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(fingerprint(registrations[0]),fingerprint(registrations[1]));
  const listed = await agents(); assert.equal(listed.length,1); assert.equal(listed[0].status,"online");
  assert.equal(listed[0].executionEnabled,false); assert.equal(listed[0].freeSlots,0);
  await stopRunner(runner,"SIGTERM");
  const stopped = (await agents())[0].lastSeenAt;
  await until(async () => (await agents())[0].status === "offline",6000);
  assert.equal((await agents())[0].lastSeenAt,stopped);
  console.log("RUNNER_REAL_HTTP_REGISTRATION_RETRY_THREE_HEARTBEATS_OFFLINE_SIGTERM passed");

  const second = startRunner(server.origin,(await pair()).pairingSecret);
  runners.push(second); await until(() => second.output().includes("RUNNER_HEARTBEAT_ACK"));
  await stopRunner(second,"SIGINT");
  console.log("RUNNER_SIGINT_CLEAN_EXIT passed");

  const third = startRunner(server.origin,(await pair()).pairingSecret,{ launcher:true,name:"Launcher environment fixture" });
  runners.push(third); await until(() => third.output().includes("RUNNER_HEARTBEAT_ACK"));
  const thirdAgent = (await agents()).find((agent) => agent.agentName === "Launcher environment fixture");
  await fetch(`${server.origin}/api/v1/agents/${thirdAgent.agentId}/revoke`,write);
  await finishRunner(third,1);
  assert.match(third.output(),/AGENT_REVOKED/);
  assert.doesNotMatch(third.output(),/must-not-reach-runner|UNSAFE_RUNNER_ENVIRONMENT/);
  assert.equal((await agents()).find((agent) => agent.agentId === thirdAgent.agentId).status,"revoked");
  for (const output of [...runners.map((r) => r.output()),server.output()]) for (const secret of secrets) assert.equal(output.includes(secret),false);
  console.log("RUNNER_FOREGROUND_LAUNCHER_ENV_REVOKE_NO_SECRET_LOGS passed");
} finally {
  for (const runner of runners) if (!runner.launcher) await stopRunner(runner);
  for (const runner of runners) if (runner.launcher && runner.child.exitCode === null && runner.child.signalCode === null) {
    for (const agent of await agents()) await fetch(`${server.origin}/api/v1/agents/${agent.agentId}/revoke`,write);
    await finishRunner(runner,1);
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
  await stopServer(server);
}
