import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";

export async function startProductionServer({ databaseUrl = process.env.TEST_DATABASE_URL, mode = "local", host = "127.0.0.1", agentIntervalSeconds, designStub = false } = {}) {
  assertSafeTestDatabaseUrl();
  if (databaseUrl) assertSafeTestDatabaseUrl(databaseUrl);
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { HOST: host, PORT: String(port), NODE_ENV: "production" });
  if (mode) env.PERSISTENCE_MODE = mode;
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  if (designStub) { assertSafeTestDatabaseUrl(databaseUrl); env.B2B_DESIGN_TEST_STUB='1'; env.TEST_DATABASE_URL=databaseUrl; }
  if (agentIntervalSeconds !== undefined) {
    assert.ok(Number.isInteger(agentIntervalSeconds) && agentIntervalSeconds >= 1 && agentIntervalSeconds <= 30);
    env.AGENT_HEARTBEAT_INTERVAL_SECONDS = String(agentIntervalSeconds);
  }
  const windows = process.platform === "win32";
  const child = spawn(process.execPath, [windows ? "tests/persistence/windows-signal-server.mjs" : "server/production.mjs"], {
    env, stdio: windows ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"]
  });
  let output = "";
  const capture = (chunk) => { output = `${output}${chunk}`.slice(-8000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return { child, origin: `http://127.0.0.1:${port}`, output: () => output };
}

export async function waitForHomepage(server) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("Built server exited during startup.");
    try {
      const response = await fetch(server.origin, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) { await response.text(); return response; }
    } catch { /* Retry while the listener starts. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Built server failed to start.");
}

export async function stopServer(server) {
  const { child } = server;
  assert.equal(child.exitCode, null, "Server must still be running before SIGTERM");
  assert.equal(child.signalCode, null, "Server must not already have been killed");
  let timer;
  try {
    const exited = new Promise((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => reject(new Error("SHUTDOWN_TIMEOUT: built server did not exit after SIGTERM")), 7000);
    });
    // Windows TerminateProcess cannot deliver POSIX signals. The test-only IPC
    // relay invokes the installed SIGTERM handler; Linux CI sends real SIGTERM.
    if (process.platform === "win32") child.send("SIGTERM");
    else child.kill("SIGTERM");
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.match(server.output(), /SERVER_SHUTDOWN_COMPLETE/);
  } catch (error) {
    // Force kill is cleanup only after a failed shutdown assertion.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    throw error;
  } finally { clearTimeout(timer); }
}
