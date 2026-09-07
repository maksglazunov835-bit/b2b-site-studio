import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { sha256Json } from "../../server/persistence/canonical-json.mjs";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";

export const write = (body = {}, secret, key = randomUUID()) => ({ method: "POST", headers: {
  "Content-Type": "application/json", "Idempotency-Key": key, ...(secret ? { Authorization: `Bearer ${secret}` } : {})
}, body: JSON.stringify(body) });
export async function api(origin, path, init) {
  const response = await fetch(origin + "/api/v1" + path, { ...init, signal: AbortSignal.timeout(6000) });
  assert.match(response.headers.get("cache-control"), /no-store/);
  return { status: response.status, body: await response.json() };
}
export async function ok(origin, path, init) {
  const result = await api(origin, path, init);
  assert.ok(result.status >= 200 && result.status < 300, `API ${path}: ${result.status} ${result.body.error?.code ?? ""}`);
  return result.body;
}
export async function httpFixture(origin) {
  const project = (await ok(origin, "/projects", write({ displayName: "Validation HTTP fixture", draft: {} }))).project;
  const base = `/projects/${project.id}/jobs`;
  const job = (await ok(origin, base, write({ type: "site_spec_validation", expectedRevision: 1 }))).job;
  const pairing = await ok(origin, "/agents/pairings", write({ mode: "data_validation", projectId: project.id }));
  return { projectId: project.id, base, job, pairing };
}
// Fixed loopback transport fault injection. Plaintext is transient and never emitted in evidence.
export async function lossProxy(origin, { drop = [], holdResult = false, terminalAfterDeadline = false, malformedTerminal = false } = {}) {
  assertSafeTestDatabaseUrl();
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const fingerprints = new Map(); const secrets = []; const dropped = new Set(); const terminalReplies = [];
  let release; let arrived; const waiting = new Promise((resolve) => { arrived = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const proxy = http.createServer(async (request, response) => {
    let timer;
    try {
      assert.match(request.url, /^\/api\/v1\/agents\//);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 18000); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString(); const parsed = JSON.parse(body);
      if (parsed.agentSecret) secrets.push(parsed.agentSecret);
      if (parsed.leaseToken && !secrets.includes(parsed.leaseToken)) secrets.push(parsed.leaseToken);
      const kind = request.url.split("/").at(-1);
      const digest = sha256Json({ body, key: request.headers["idempotency-key"] ?? null });
      fingerprints.set(kind, [...(fingerprints.get(kind) ?? []), digest].slice(-100));
      if (holdResult && kind === "result") {
        arrived();
        await Promise.race([hold, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
      }
      const result = await fetch(origin + request.url, { method: "POST", signal: AbortSignal.timeout(5000),
        headers: { Authorization: request.headers.authorization, "Content-Type": "application/json",
          ...(request.headers["idempotency-key"] ? { "Idempotency-Key": request.headers["idempotency-key"] } : {}) }, body });
      const text = await result.text(); assert.ok(Buffer.byteLength(text) <= 81920);
      const answer = JSON.parse(text);
      if (answer.assignment?.leaseToken) secrets.push(answer.assignment.leaseToken);
      if (malformedTerminal && kind === "result" && result.ok) {
        const count = fingerprints.get(kind).length;
        if (count === 1) {
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 20000 }); response.end(); return;
        }
        if (count === 2) {
          response.writeHead(307, { Location: "http://127.0.0.1:1/never-follow" }); response.end(); return;
        }
      }
      if (terminalAfterDeadline && kind === "result" && result.ok) {
        arrived();
        const receipt = { receivedAt: Date.now(), leaseExpiresAt: Date.parse(answer.leaseExpiresAt),
          deadlineAt: Date.parse(answer.deadlineAt), replayed: answer.replayed === true, delivered: false };
        terminalReplies.push(receipt);
        assert.ok(terminalReplies.length <= 10);
        if (Date.now() < receipt.deadlineAt + 200) {
          // The real server already committed. Hide replies across both expiry boundaries.
          await Promise.race([hold, new Promise((resolve) => { timer = setTimeout(resolve, Math.min(5000, receipt.deadlineAt + 200 - Date.now())); })]);
          response.destroy(); return;
        }
        receipt.delivered = true;
      }
      if (drop.includes(kind) && !dropped.has(kind) && result.ok && (kind !== "claim" || answer.assignment)) {
        dropped.add(kind); response.destroy(); return;
      }
      response.writeHead(result.status, { "Content-Type": "application/json" }); response.end(text);
    } catch { response.destroy(); }
    finally { clearTimeout(timer); }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${proxy.address().port}`, async waitHeld() {
    let timer;
    try { await Promise.race([waiting, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("Result request was not received.")), 12000); })]); }
    finally { clearTimeout(timer); }
  }, release, fingerprints, secrets, dropped, terminalReplies,
    async close() { release(); proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); } };
}
