import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { localOrigin, post, RunnerError } from "./transport.mjs";
import { reply } from "./protocol.mjs";
import { runnerEnvironment } from "./environment.mjs";
import { installedManifest } from "../scripts/contracts/execution-manifest.mjs";
import { VALIDATOR } from "../server/execution/contract.mjs";
import { dataSession } from "./data-session.mjs";
import { ADAPTER } from '../server/design/contract.mjs';
import { installedDesignManifest } from '../scripts/contracts/design-manifest.mjs';

export function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!["--origin","--name","--mode"].includes(key) || !value || Object.hasOwn(values,key)) throw new RunnerError("INVALID_OPTIONS");
    values[key] = value;
  }
  const name = values["--name"] ?? "Local Node Runner";
  if (!/^[A-Za-z0-9 ._-]{1,64}$/.test(name) || !name.trim() || /(?:pair|agt|lease)_[A-Za-z0-9_-]{43}/.test(name)) throw new RunnerError("INVALID_OPTIONS");
  if (values["--mode"] !== undefined && !["presence-only","data-validation"].includes(values["--mode"])) throw new RunnerError("INVALID_OPTIONS");
  return { origin: localOrigin(values["--origin"]), name: name.trim(), mode: values["--mode"] === "data-validation" ? "data_validation" : "presence_only" };
}

export function readSecret(signal, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    let value = "";
    const tty = input.isTTY;
    const cleanup = () => {
      clearTimeout(timer); input.off("data", data); input.off("end", end); signal.removeEventListener("abort", abort);
      if (tty) input.setRawMode(false);
      input.pause();
    };
    const finish = (error) => {
      cleanup();
      if (error) reject(error);
      else if (!/^pair_[A-Za-z0-9_-]{43}$/.test(value)) reject(new RunnerError("INVALID_PAIRING_INPUT"));
      else resolve(value);
      value = "";
    };
    const abort = () => finish(signal.reason);
    const end = () => finish();
    const data = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) return finish(new RunnerError("INPUT_CANCELLED"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
        if (byte < 32 || byte > 126 || value.length >= 128) return finish(new RunnerError("INVALID_PAIRING_INPUT"));
        value += String.fromCharCode(byte);
      }
    };
    if (signal.aborted) return reject(signal.reason);
    output.write("Pairing secret (hidden input, expires in five minutes): ");
    if (tty) input.setRawMode(true);
    input.on("data", data); input.once("end", end); signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => finish(new RunnerError("INPUT_TIMEOUT")), 60000);
    input.resume();
  });
}

export async function runSession({ origin, name, pairingSecret, signal, mode = "presence_only", log = console.log, designAdapter, startup, registrationOnly = false, readDesignManifest = installedDesignManifest }) {
  startup?.begin('manifest_validation');
  if (mode === 'codex_design' && !designAdapter) throw new RunnerError('CODEX_NOT_AVAILABLE');
  if (mode === 'codex_design' && (await readDesignManifest()).sha256 !== ADAPTER.sha256) throw new RunnerError('CODEX_UNSUPPORTED_VERSION');
  if (mode === "data_validation" && (await installedManifest()).sha256 !== VALIDATOR.sha256) throw new RunnerError("VALIDATOR_MISMATCH");
  if (designAdapter?.runtime.provider === 'codex') {
    if (typeof designAdapter.assertRegistrationAdmission !== 'function') throw new RunnerError('CODEX_ISOLATION_UNVERIFIED');
    designAdapter.assertRegistrationAdmission();
  }
  startup?.complete('manifest_validation'); startup?.begin('registration');
  const agentSecret = `agt_${randomBytes(32).toString("base64url")}`;
  const os = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform];
  if (!os) throw new RunnerError("UNSUPPORTED_OS");
  const body = JSON.stringify({ mode, agentName: name, agentVersion: mode === "presence_only" ? "0.3.0" : "0.3.1", os, supportedApiVersions: ["v1"], agentSecret,
    ...(mode === "data_validation" ? { validator: VALIDATOR } : mode === 'codex_design' ? { adapter: ADAPTER, runtime: designAdapter.runtime } : {}) });
  const key = randomUUID();
  const deadline = Date.now() + 300000;
  let registered;
  for (let attempt = 0; attempt < 5; attempt++) {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new RunnerError("PAIRING_EXPIRED");
    try { registered = reply(await post(origin, "/api/v1/agents/register", pairingSecret, body, { key, signal }), "register", undefined, mode); break; }
    catch (error) {
      if (!error.retryable || attempt === 4) throw error;
      log("RUNNER_REGISTRATION_RETRY");
      await delay(Math.min(1000 * 2 ** attempt, 10000), undefined, { signal });
    }
  }
  pairingSecret = undefined;
  if (designAdapter) {
    const { sha256Json } = await import('../server/persistence/canonical-json.mjs');
    if (sha256Json(registered.runtime) !== sha256Json(designAdapter.runtime)) throw new RunnerError('INVALID_RESPONSE');
  }
  startup?.complete('registration');
  log(`RUNNER_REGISTERED ${registered.agentId} ${mode}`);
  if (mode === "data_validation") return dataSession({ origin, registration: registered, credential: agentSecret, signal, log });
  if (mode === 'codex_design') return dataSession({ origin, registration: registered, credential: agentSecret, signal, log, designAdapter, startup, registrationOnly });
  let interval = registered.heartbeatIntervalSeconds;
  let failures = 0;
  while (!signal.aborted) {
    try {
      const health = reply(await post(origin, `/api/v1/agents/${registered.agentId}/health`, agentSecret,
        JSON.stringify({ selectedApiVersion: "v1" }), { signal }), "health", registered.agentId);
      failures = 0; interval = health.heartbeatIntervalSeconds;
      log("RUNNER_HEARTBEAT_ACK");
    } catch (error) {
      if (!error.retryable || ++failures >= 5) throw error;
      log("RUNNER_HEARTBEAT_RETRY");
    }
    await delay(failures ? Math.min(1000 * 2 ** failures, 10000) : interval * 1000, undefined, { signal });
  }
}

export async function main(args = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const message = (value) => { if (value === "STOP") stop(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (process.connected) { process.on("message", message); process.once("disconnect", stop); }
  try {
    const allowed = runnerEnvironment();
    // Windows injects login/system metadata even with an explicit spawn env.
    const injected = new Set(process.platform === "win32" ? ["HOMEDRIVE","HOMEPATH","LOGONSERVER","PATH","SYSTEMDRIVE","USERDOMAIN","USERNAME","USERPROFILE"] : []);
    if (Object.keys(process.env).some((key) => !Object.hasOwn(allowed, key) && !injected.has(key))) throw new RunnerError("UNSAFE_RUNNER_ENVIRONMENT");
    for (const key of injected) delete process.env[key];
    const config = options(args);
    let secret = await readSecret(controller.signal);
    const operation = runSession({ ...config, pairingSecret: secret, signal: controller.signal });
    secret = undefined;
    await operation;
  } catch (error) {
    if (!controller.signal.aborted && error.code !== "INPUT_CANCELLED") {
      console.error(`RUNNER_STOPPED ${error instanceof RunnerError ? error.code : "LOCAL_CONNECTION_FAILED"}`);
      process.exitCode = 1;
    }
  } finally {
    controller.abort(); process.stdin.pause();
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    process.removeListener("message", message); process.removeListener("disconnect", stop);
    if (process.connected) process.disconnect();
    console.log("RUNNER_STOPPED");
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
