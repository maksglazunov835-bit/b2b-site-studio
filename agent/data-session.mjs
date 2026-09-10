import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { post, RunnerError } from "./transport.mjs";
import { reply } from "./protocol.mjs";
import { assertSpec } from "../server/execution/contract.mjs";
import { sha256Json } from "../server/persistence/canonical-json.mjs";
import { boundedJson, LIMITS } from "../server/execution/bounds.mjs";
import { validationTask } from "./validation-task.mjs";
import { assertDesignSpec, assertDesignReport, DESIGN_CODES } from '../server/design/contract.mjs';

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const exact = (value, keys) => object(value) && Object.keys(value).sort(compare).join() === [...keys].sort(compare).join();
const iso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function successful(result) {
  if (result.status === 200) return result.body;
  const code = result.body?.error?.code;
  const known = ["AGENT_REVOKED","UNAUTHORIZED_AGENT","EXECUTION_NOT_GRANTED","VALIDATOR_MISMATCH","PROJECT_NOT_AVAILABLE",
    "CLAIM_REPLY_UNAVAILABLE","LEASE_EXPIRED","STALE_ATTEMPT","CANCEL_REQUESTED","REPORT_MISMATCH","IDEMPOTENCY_CONFLICT","PERSISTENCE_DISABLED",
    "TERMINAL_ACK_EXPIRED","TERMINAL_ACK_NOT_FOUND","ATTEMPT_FINISHED","INVOCATION_REPLY_UNAVAILABLE",...DESIGN_CODES];
  if (known.includes(code)) throw new RunnerError(code);
  throw new RunnerError("EXECUTION_REQUEST_REJECTED", [429,500,502,503,504].includes(result.status));
}
export function assignmentReply(value, registration) {
  const design = registration.mode === 'codex_design';
  boundedJson(value);
  if (value?.assignment === null) {
    if (!exact(value, ["assignment","reason","retryAfterMs"]) || !["AGENT_BUSY","NO_ASSIGNED_JOB"].includes(value.reason) || value.retryAfterMs !== 1000) throw new RunnerError("INVALID_ASSIGNMENT");
    return null;
  }
  const item = value?.assignment;
  if (!exact(value, ["assignment"]) || !exact(item, ["jobSpec","jobSpecSha256","attempt","leaseToken","leaseExpiresAt","deadlineAt"]) ||
    !Number.isInteger(item.attempt) || item.attempt < 1 || item.attempt > 3 || !/^lease_[A-Za-z0-9_-]{43}$/.test(item.leaseToken) ||
    !iso(item.leaseExpiresAt) || !iso(item.deadlineAt) || Date.parse(item.leaseExpiresAt) <= Date.now() ||
    Date.parse(item.deadlineAt) < Date.parse(item.leaseExpiresAt) || Date.parse(item.deadlineAt) > Date.now() + (design ? 180000 : 30000)) throw new RunnerError("INVALID_ASSIGNMENT");
  (design ? assertDesignSpec : assertSpec)(item.jobSpec, item.jobSpecSha256);
  if (design && (item.attempt !== 1 || sha256Json(item.jobSpec.runtime) !== sha256Json(registration.runtime))) throw new RunnerError('INVALID_ASSIGNMENT');
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
async function execute({ origin, registration, credential, assignment, signal, log, designAdapter, onInvocation, runId }) {
  const jobId = assignment.jobSpec.jobId;
  let terminalUncertain = false;
  const operation = async (kind, extra = {}) => {
    const key = randomUUID();
    const body = JSON.stringify({ attempt: assignment.attempt, leaseToken: assignment.leaseToken, ...extra });
    const terminalState = { result: "succeeded", "cancel-ack": "cancelled", fail: "failed" }[kind];
    const requestLimit = terminalState ? 10 : designAdapter && kind === 'start' ? 1 : 3;
    const recoveryDeadline = Date.now() + 45000;
    let recovering = false;
    for (let retry = 0; retry < requestLimit; retry++) {
      signal.throwIfAborted();
      // Only an uncertain already-sent terminal operation may outlive its write lease.
      // It retains the exact tuple; the server can only read a committed receipt after expiry.
      const remaining = (recovering ? recoveryDeadline : Math.min(Date.parse(assignment.leaseExpiresAt), Date.parse(assignment.deadlineAt))) - Date.now();
      if (remaining < 50) throw new RunnerError(recovering ? "TERMINAL_ACK_UNCONFIRMED" : "LEASE_EXPIRED");
      try {
        const response = await post(origin, `/api/v1/agents/${registration.agentId}/jobs/${jobId}/${kind}`, credential, body,
          { key, signal, timeoutMs: Math.min(5000, remaining) });
        const ack = actionReply(successful(response), assignment);
        if (terminalState && (!ack.terminal || ack.state !== terminalState)) throw new RunnerError("INVALID_EXECUTION_RESPONSE");
        if (recovering) log("RUNNER_TERMINAL_ACK_RECOVERED");
        if (terminalState) terminalUncertain = false;
        return ack;
      } catch (error) {
        if (terminalState && (error.retryable || ["INVALID_RESPONSE", "INVALID_EXECUTION_RESPONSE", "RESPONSE_TOO_LARGE", "REDIRECT_REFUSED"].includes(error.code))) {
          recovering = true; terminalUncertain = true;
          if (retry === requestLimit - 1) throw new RunnerError("TERMINAL_ACK_UNCONFIRMED");
          log("RUNNER_TERMINAL_ACK_RECOVERY");
        } else {
          if (recovering) throw new RunnerError(["AGENT_REVOKED", "UNAUTHORIZED_AGENT"].includes(error.code) ? error.code : "TERMINAL_ACK_UNCONFIRMED");
          if (!error.retryable || retry === requestLimit - 1) throw error;
          log("RUNNER_EXECUTION_RETRY");
        }
        await delay(Math.max(0, Math.min(100 * 2 ** retry, 500, recovering ? recoveryDeadline - Date.now() : 500)), undefined, { signal });
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
    const task = designAdapter ? (spec, attempt, options) => designAdapter.execute(spec, attempt, options) : validationTask;
    work = task(assignment.jobSpec, assignment.attempt, { signal: workerController.signal, onInvocation, runId,
      timeoutMs: Math.max(1, Math.min(designAdapter ? 175000 : 30000, Date.parse(assignment.deadlineAt) - Date.now())) }).then((report) => ({ report }), (error) => ({ error }));
    let outcome;
    while (!outcome) {
      let timer;
      try { outcome = await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]); }
      finally { clearTimeout(timer); }
      signal.throwIfAborted();
      if (!outcome) {
        const health = await operation("heartbeat", { phase: "validating" });
        if (health.cancelRequested) {
          workerController.abort(); const stopped = await work;
          if (designAdapter && stopped.error?.code === 'STOP_UNCONFIRMED') throw stopped.error;
          await cancelAck(); return;
        }
      }
    }
    if (outcome.error) throw outcome.error;
    boundedJson(outcome.report, LIMITS.report);
    if (designAdapter) assertDesignReport(outcome.report, assignment.jobSpec, assignment.attempt);
    await operation("result", { report: outcome.report, resultDigest: sha256Json(outcome.report) });
    log(`RUNNER_VALIDATION_RESULT_CONFIRMED ${jobId}`);
    if (designAdapter) log('RUNNER_DESIGN_RESULT_CONFIRMED');
  } catch (error) {
    workerController.abort(); const stopped = work ? await work : null;
    if (designAdapter && stopped?.error?.code === 'STOP_UNCONFIRMED') {
      if (!signal.aborted && !terminalUncertain) {
        try { await operation('fail', { code: 'STOP_UNCONFIRMED' }); }
        catch { /* Revoked or expired writes stay fenced; the server will sweep. */ }
      }
      throw stopped.error;
    }
    if (signal.aborted) throw error;
    if (terminalUncertain || error.code === "TERMINAL_ACK_UNCONFIRMED") throw error;
    if (designAdapter && (error.retryable || error.code === 'INVOCATION_REPLY_UNAVAILABLE')) throw new RunnerError('INVOCATION_UNCERTAIN');
    if (error.code === "CANCEL_REQUESTED") { await cancelAck(); return; }
    if (["AGENT_REVOKED","UNAUTHORIZED_AGENT","EXECUTION_NOT_GRANTED","VALIDATOR_MISMATCH","PERSISTENCE_DISABLED"].includes(error.code)) throw error;
    if (["LEASE_EXPIRED","STALE_ATTEMPT"].includes(error.code)) { log("RUNNER_VALIDATION_LEASE_LOST"); return; }
    await operation("fail", { code: designAdapter ? DESIGN_CODES.includes(error.code) ? error.code : 'CODEX_PROCESS_FAILED' : error.code === "REPORT_MISMATCH" ? "REPORT_REJECTED" : "VALIDATOR_FAILED" });
    log("RUNNER_VALIDATION_FAILED");
  } finally {
    workerController.abort(); if (work) await work;
    signal.removeEventListener("abort", stop);
    assignment.leaseToken = undefined;
  }
}
export async function dataSession({ origin, registration, credential, signal, log, designAdapter, startup, onInvocation, registrationOnly = false }) {
  let lastPresence = 0; let failures = 0;
  startup?.begin('first_heartbeat');
  let first = true;
  while (!signal.aborted) {
    try {
      if (Date.now() - lastPresence >= registration.heartbeatIntervalSeconds * 1000) {
        reply(await post(origin, `/api/v1/agents/${registration.agentId}/health`, credential, '{"selectedApiVersion":"v1"}', { signal }), "health", registration.agentId, designAdapter ? 'codex_design' : "data_validation");
        lastPresence = Date.now(); log("RUNNER_HEARTBEAT_ACK");
        if (first) { startup?.complete('first_heartbeat'); first=false; }
      }
      const assignment = registration.executionEnabled && !registrationOnly ? assignmentReply(successful(await post(origin, `/api/v1/agents/${registration.agentId}/claim`, credential, "{}", { key: randomUUID(), signal })), registration) : null;
      if (assignment) await execute({ origin, registration, credential, assignment, signal, log, designAdapter, onInvocation, runId: startup?.snapshot().runId });
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.code !== "CLAIM_REPLY_UNAVAILABLE" && (!error.retryable || ++failures >= 5)) throw error;
      log("RUNNER_CLAIM_WAIT");
    }
    await delay(Math.min(1000 * 2 ** failures, 10000), undefined, { signal });
  }
}
