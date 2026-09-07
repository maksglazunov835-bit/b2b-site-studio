import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";

const safe = "postgresql://test_user:secret@127.0.0.1:55433/studio_test";

void test("test configuration rejects redirects, protocols, sockets, fragments, dev collisions and PG environment", () => {
  for (const value of [
    safe + "?host=remote.example", safe + "?port=5432", safe + "?database=dev", safe + "?sslmode=disable",
    safe + "#fragment", safe + "?", safe.replace("postgresql:", "https:"),
    safe.replace("127.0.0.1", "remote.example"), safe.replace("127.0.0.1", "%2Fvar%2Frun%2Fpostgresql"),
    safe.replace("studio_test", "production"), safe.replace("studio_test", "test%2Fother")
  ]) assert.throws(() => assertSafeTestDatabaseUrl(value, { devDatabaseUrl: undefined, environment: {} }), { code: "TEST_DATABASE_RESET_REFUSED" });
  assert.throws(() => assertSafeTestDatabaseUrl(safe, { devDatabaseUrl: safe.replace("127.0.0.1", "localhost"), environment: {} }), { code: "TEST_DATABASE_RESET_REFUSED" });
  for (const variable of ["PGHOST", "PGPORT", "PGDATABASE", "PGSERVICE", "PGOPTIONS", "PGPASSWORD", "PGSSLMODE"]) {
    assert.throws(() => assertSafeTestDatabaseUrl(safe, { devDatabaseUrl: undefined, environment: { [variable]: "override" } }), { code: "TEST_DATABASE_RESET_REFUSED" });
  }
  const config = assertSafeTestDatabaseUrl(safe, { devDatabaseUrl: safe.replace("studio_test", "studio_local"), environment: {} });
  assert.equal(config.database, "studio_test");
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 55433);
});

void test("all test entrypoints refuse missing TEST_DATABASE_URL before a connection or SQL", async () => {
  let connections = 0;
  const listener = net.createServer((socket) => { connections++; socket.destroy(); });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  try {
    for (const args of [
      ...["full", "service", "http", "ui", "jobs", "jobs-http", "jobs-ui", "agents", "agents-http", "agents-process", "agents-ui", "execution", "execution-http", "execution-process", "execution-ui", "migrate", "status"].map((mode) => ["scripts/persistence/run-tests.mjs", mode]),
      ["scripts/db/test-reset.mjs"], ["scripts/persistence/http-smoke.mjs"], ["tests/persistence/ui.test.mjs"],
      ...["service", "upgrade", "http", "ui"].map((name) => [`tests/jobs/${name}.test.mjs`]),
      ...["service", "upgrade", "transport", "http", "process", "ui"].map((name) => [`tests/agents/${name}.test.mjs`]),
      ...['design','design-process','design-ui'].map((mode)=>['scripts/persistence/run-tests.mjs',mode]),
      ...['service','upgrade','process','ui'].map((name)=>[`tests/design/${name}.test.mjs`]),
      ...["service", "upgrade", "worker", "http", "process", "ui"].map((name) => [`tests/execution/${name}.test.mjs`])
    ]) {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { env: {
          ...process.env, TEST_DATABASE_URL: "", DATABASE_URL: `postgresql://dev:must_not_leak@127.0.0.1:${port}/dev`
        }, stdio: ["ignore", "pipe", "pipe"] });
        let text = "";
        child.stdout.on("data", (chunk) => { text += chunk; });
        child.stderr.on("data", (chunk) => { text += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => resolve({ code, text }));
      });
      assert.notEqual(output.code, 0);
      assert.match(output.text, /TEST_DATABASE_URL/);
      assert.doesNotMatch(output.text, /must_not_leak|postgresql:\/\//);
    }
    assert.equal(connections, 0);
  } finally { await new Promise((resolve) => listener.close(resolve)); }
});
