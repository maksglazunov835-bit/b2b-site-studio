import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { post, RunnerError } from "./transport.mjs";
import { reply } from "./protocol.mjs";
import { assertSpec } from "../server/execution/contract.mjs";
import { sha256Json } from "../server/persistence/canonical-json.mjs";
import { boundedJson, LIMITS } from "../server/execution/bounds.mjs";
import { validationTask } from "./validation-task.mjs";

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const exact = (value, keys) => object(value) && Object.keys(value).sort(compare).join() === [...keys].sort(compare).join();
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function successful(result) {
  if (result.status === 200) return result.body;
  const code = result.body?.error?.code;
  const known = ["AGENT_REVOKED","UNAUTHORIZED_AGENT","EXECUTION_NOT_GRANTED","VALIDATOR_MISMATCH","PROJECT_NOT_AVAILABLE",
    "CLAIM_REPLY_UNAVAILABLE","LEASE_EXPIRED","STALE_ATTEMPT","CANCEL_REQUESTED","REPORT_MISMATCH","IDEMPOTENCY_CONFLICT","PERSISTENCE_DISABLED"];
  if (known.includes(code)) throw new RunnerError(code);
  throw new RunnerError("EXECUTION_REQUEST_REJECTED", [429,500,502,503,504].includes(result.status));
}
export function assignmentReply(value, registration) {
  boundedJson(value);
  if (value?.assignment === null) {
    if (!exact(value, ["assignment","reason","retryAfterMs"]) || !["AGENT_BUSY","NO_ASSIGNED_JOB"].includes(value.reason) || value.retryAfterMs !== 1000) throw new RunnerError("INVALID_ASSIGNMENT");
    return null;
  }
  const item = value?.assignment;
  if (!exact(value, ["assignment"]) || !exact(item, ["jobSpec","jobSpecSha256","attempt","leaseToken","leaseExpiresAt","deadlineAt"]) ||
    !Number.isInteger(item.attempt) || item.attempt < 1 || item.attempt > 3 || !/^lease_[A-Za-z0-9_-]{43}$/.test(item.leaseToken) ||
    !iso(item.leaseExpiresAt) || !iso(item.deadlineAt) || Date.parse(item.leaseExpiresAt) <= Date.now() ||
    Date.parse(item.deadlineAt) < Date.parse(item.leaseExpiresAt) || Date.parse(item.deadlineAt) > Date.now() + 30000) throw new RunnerError("INVALID_ASSIGNMENT");
  assertSpec(item.jobSpec, item.jobSpecSha256);
  if (item.jobSpec.projectId !== registration.projectId) throw new RunnerError("ASSIGNMENT_SCOPE_MISMATCH");
  return item;
}
function actionReply(value, assignment) {
  const keys = ["jobId","attempt","state","cancelRequested","terminal","leaseExpiresAt","deadlineAt"];
  if (!exact(value, [...keys,...(value?.replayed === true ? ["replayed"] : [])]) || value.jobId !== assignment.jobSpec.jobId ||
    value.attempt !== assignment.attempt || !["running","validating","cancel_requested","succeeded","failed","cancelled"].includes(value.state) ||
    value.cancelRequested !== (value.state === "cancel_requested") || value.terminal !== ["succeeded","failed","cancelled"].includes(value.state) ||
    !iso(value.leaseExpiresAt) || value.deadlineAt !== assignment.deadlineAt || Date.parse(value.leaseExpiresAt) > Date.parse(value.deadlineAt)) throw new RunnerError("INVALID_EXECUTION_RESPONSE");
  assignment.leaseExpiresAt = value.leaseExpiresAt;
  return value;
}
async function execute({ origin, registration, credential, assignment, signal, log }) {
  const jobId = assignment.jobSpec.jobId;
  const operation = async (kind, extra = {}) => {
    const key = randomUUID();
    const body = JSON.stringify({ attempt: assignment.attempt, leaseToken: assignment.leaseToken, ...extra });
    for (let retry = 0; retry < 3; retry++) {
      signal.throwIfAborted();
      const remaining = Math.min(Date.parse(assignment.leaseExpiresAt), Date.parse(assignment.deadlineAt)) - Date.now();
      if (remaining < 50) throw new RunnerError("LEASE_EXPIRED");
      try {
        const response = await post(origin, `/api/v1/agents/${registration.agentId}/jobs/${jobId}/${kind}`, credential, body,
          { key, signal, timeoutMs: Math.min(5000, remaining) });
        return actionReply(successful(response), assignment);
      } catch (error) {
        if (!error.retryable || retry === 2) throw error;
        log("RUNNER_EXECUTION_RETRY"); await delay(100 * 2 ** retry, undefined, { signal });
      }
    }
  };
  const cancelAck = async () => { await operation("cancel-ack"); log("RUNNER_VALIDATION_CANCEL_ACK"); };
  let work; const workerController = new AbortController();
  const stop = () => workerController.abort(); signal.addEventListener("abort", stop, { once: true });
  try {
    await operation("start");
    const started = await operation("heartbeat", { phase: "validating" });
    if (started.cancelRequested) { await cancelAck(); return; }
    log(`RUNNER_VALIDATION_STARTED ${jobId} attempt_${assignment.attempt}`);
    work = validationTask(assignment.jobSpec, assignment.attempt, { signal: workerController.signal,
      timeoutMs: Math.max(1, Math.min(30000, Date.parse(assignment.deadlineAt) - Date.now())) }).then((report) => ({ report }), (error) => ({ error }));
    let outcome;
    while (!outcome) {
      let timer;
      try { outcome = await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]); }
      finally { clearTimeout(timer); }
      signal.throwIfAborted();
      if (!outcome) {
        const health = await operation("heartbeat", { phase: "validating" });
        if (health.cancelRequested) { workerController.abort(); await work; await cancelAck(); return; }
      }
    }
    if (outcome.error) throw outcome.error;
    boundedJson(outcome.report, LIMITS.report);
    await operation("result", { report: outcome.report, resultDigest: sha256Json(outcome.report) });
    log(`RUNNER_VALIDATION_RESULT_CONFIRMED ${jobId}`);
  } catch (error) {
    workerController.abort(); if (work) await work;
    if (signal.aborted) throw error;
    if (error.code === "CANCEL_REQUESTED") { await cancelAck(); return; }
    if (["AGENT_REVOKED","UNAUTHORIZED_AGENT","EXECUTION_NOT_GRANTED","VALIDATOR_MISMATCH","PERSISTENCE_DISABLED"].includes(error.code)) throw error;
    if (["LEASE_EXPIRED","STALE_ATTEMPT"].includes(error.code)) { log("RUNNER_VALIDATION_LEASE_LOST"); return; }
    await operation("fail", { code: error.code === "REPORT_MISMATCH" ? "REPORT_REJECTED" : "VALIDATOR_FAILED" });
    log("RUNNER_VALIDATION_FAILED");
  } finally {
    workerController.abort(); if (work) await work;
    signal.removeEventListener("abort", stop);
    assignment.leaseToken = undefined;
  }
}
export async function dataSession({ origin, registration, credential, signal, log }) {
  let lastPresence = 0; let failures = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastPresence >= registration.heartbeatIntervalSeconds * 1000) {
        reply(await post(origin, `/api/v1/agents/${registration.agentId}/health`, credential, '{"selectedApiVersion":"v1"}', { signal }), "health", registration.agentId, "data_validation");
        lastPresence = Date.now(); log("RUNNER_HEARTBEAT_ACK");
      }
      const assignment = assignmentReply(successful(await post(origin, `/api/v1/agents/${registration.agentId}/claim`, credential, "{}", { key: randomUUID(), signal })), registration);
      if (assignment) await execute({ origin, registration, credential, assignment, signal, log });
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.code !== "CLAIM_REPLY_UNAVAILABLE" && (!error.retryable || ++failures >= 5)) throw error;
      log("RUNNER_CLAIM_WAIT");
    }
    await delay(Math.min(1000 * 2 ** failures, 10000), undefined, { signal });
  }
}
