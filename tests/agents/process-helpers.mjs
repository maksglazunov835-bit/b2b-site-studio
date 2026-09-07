import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runnerEnvironment } from "../../agent/environment.mjs";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";

export function startRunner(origin, secret, { name = "Process Runner fixture", launcher = false, mode } = {}) {
  assertSafeTestDatabaseUrl();
  const windows = process.platform === "win32";
  const env = runnerEnvironment();
  // Launcher must strip even an accidentally inherited credential before session startup.
  if (launcher) Object.assign(env, { DATABASE_URL: "must-not-reach-runner", GH_TOKEN: "must-not-reach-runner", OPENAI_API_KEY: "must-not-reach-runner" });
  if (mode !== undefined) assert.equal(mode, "data-validation");
  const child = spawn(process.execPath, [launcher ? "agent/connect.mjs" : windows ? "tests/agents/windows-signal-runner.mjs" : "agent/session.mjs", "--origin",origin,"--name",name, ...(mode ? ["--mode", mode] : [])], {
    env, stdio: !launcher && windows ? ["pipe","pipe","pipe","ipc"] : ["pipe","pipe","pipe"], windowsHide: true
  });
  let output = "";
  const exited = new Promise((resolve,reject) => {
    child.once("error",reject); child.once("exit",(code,signal) => resolve({ code,signal }));
  });
  const capture = (chunk) => { output = (output + chunk).slice(-16384); };
  child.stdout.on("data",capture); child.stderr.on("data",capture);
  child.stdin.on("error", () => {});
  child.stdin.end(secret + "\n");
  return { child, exited, output: () => output, launcher };
}
export async function until(check, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve,50));
  }
  throw new Error("Runner test condition timed out.");
}
export async function finishRunner(runner, expectedCode = 0) {
  let timer;
  try {
    const result = await Promise.race([runner.exited, new Promise((resolve,reject) => { timer = setTimeout(() => reject(new Error("Runner did not exit within seven seconds.")),7000); })]);
    assert.deepEqual(result,{ code:expectedCode,signal:null });
    assert.match(runner.output(),/RUNNER_STOPPED/);
    assert.equal(runner.child.exitCode,expectedCode); assert.equal(runner.child.signalCode,null);
  } catch (error) {
    if (runner.child.exitCode === null && runner.child.signalCode === null) { runner.child.kill("SIGKILL"); await runner.exited; }
    throw error;
  } finally { clearTimeout(timer); }
}
export async function stopRunner(runner, signal = "SIGTERM") {
  if (runner.child.exitCode !== null || runner.child.signalCode !== null) return;
  assert.equal(runner.launcher,false,"Launcher shutdown is verified by revocation, not platform-dependent process-tree termination.");
  if (process.platform === "win32") runner.child.send(signal); else runner.child.kill(signal);
  await finishRunner(runner);
}
