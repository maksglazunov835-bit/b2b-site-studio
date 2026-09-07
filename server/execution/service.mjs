import { randomBytes } from "node:crypto";
import { getDatabasePool, withTransaction } from "../persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID, acquireIdempotencyLock, findIdempotencyRecord, insertIdempotencyRecord } from "../persistence/repository.mjs";
import { assertIdempotencyKey, assertProjectId } from "../persistence/service.mjs";
import { sha256Json } from "../persistence/canonical-json.mjs";
import { findJob, jobResponse } from "../jobs/repository.mjs";
import { assertJobId } from "../jobs/requests.mjs";
import { assertAgentId, hashMatches, secretHash, validSecret } from "../agents/requests.mjs";
import { agentById } from "../agents/repository.mjs";
import { agentGrant } from "./grants.mjs";
import { assertSpec, materialize, POLICY, VALIDATOR, validationReport } from "./contract.mjs";
import { executionRequest } from "./requests.mjs";
import { executionError, transition } from "./transitions.mjs";

async function transaction(action) {
  return withTransaction(async (client) => { await client.query("SET LOCAL statement_timeout='5s'"); return action(client); });
}
export function createExecutionService({ workspaceId = DEFAULT_WORKSPACE_ID, clock = () => new Date() } = {}) {
  assertProjectId(workspaceId);
  async function authorize(client, agentId, secret, projectId) {
    assertAgentId(agentId);
    if (secret !== undefined && !validSecret(secret, "agt")) executionError("UNAUTHORIZED_AGENT", 401);
    const agent = await agentById(client, workspaceId, agentId, true);
    if (!agent || (secret !== undefined && !hashMatches(secret, agent.credential_sha256))) executionError("UNAUTHORIZED_AGENT", 401);
    if (agent.revoked_at) executionError("AGENT_REVOKED", 401);
    const grant = await agentGrant(client, workspaceId, agentId);
    if (!grant || (projectId && grant.project_id !== projectId)) executionError("EXECUTION_NOT_GRANTED", 403);
    if (grant.project_status !== "active") executionError("PROJECT_NOT_AVAILABLE");
    if (grant.validator_sha256.trim() !== VALIDATOR.sha256) executionError("VALIDATOR_MISMATCH");
    return { agent, grant };
  }
  async function lockedJob(client, projectId, jobId) {
    const job = await findJob(client, workspaceId, projectId, jobId, true);
    if (!job) executionError("JOB_NOT_FOUND", 404);
    return job;
  }
  async function sweepIn(client, projectId = null, agentId = null) {
      const now = clock();
      const rows = await client.query(`SELECT j.* FROM jobs j JOIN job_attempts a ON a.job_id=j.id AND a.finished_at IS NULL
        WHERE j.workspace_id=$1 AND a.expires_at<=$2 AND ($3::uuid IS NULL OR j.project_id=$3)
        AND ($4::text IS NULL OR a.agent_id=$4) ORDER BY a.expires_at,j.id LIMIT 25 FOR UPDATE OF j SKIP LOCKED`, [workspaceId, now, projectId, agentId]);
      for (const job of rows.rows) {
        const attempt = (await client.query("SELECT * FROM job_attempts WHERE job_id=$1 AND finished_at IS NULL FOR UPDATE", [job.id])).rows[0];
        if (!attempt || attempt.expires_at > now) continue;
        const cancelled = job.state === "cancel_requested";
        const exhausted = attempt.attempt >= POLICY.maxAttempts;
        const failure = cancelled ? "STOP_UNCONFIRMED" : exhausted ? "ATTEMPTS_EXHAUSTED" : "LEASE_EXPIRED";
        await client.query("UPDATE job_attempts SET state='expired',finished_at=$3,failure_code=$4 WHERE job_id=$1 AND attempt=$2", [job.id, attempt.attempt, now, failure]);
        await transition(client, job, cancelled || exhausted ? "failed" : "queued", cancelled || exhausted ? "job_failed" : "job_lease_expired", now,
          { attempt: attempt.attempt, reason: failure }, "system");
      }
      return rows.rows.length;
  }
  const sweep = (projectId = null) => transaction((client) => sweepIn(client, projectId));
  return {
    sweep,
    async dispatch(projectId, jobId, input, key) {
      assertProjectId(projectId); assertJobId(jobId); executionRequest("dispatch", input); key = assertIdempotencyKey(key);
      const operation = `dispatch_validation:${projectId}:${jobId}`; const hash = sha256Json(input);
      return transaction(async (client) => {
        await acquireIdempotencyLock(client, workspaceId, operation, key);
        await authorize(client, input.agentId, undefined, projectId);
        const job = await lockedJob(client, projectId, jobId);
        const previous = await findIdempotencyRecord(client, workspaceId, operation, key);
        if (previous) {
          if (previous.request_sha256.trim() !== hash) executionError("IDEMPOTENCY_CONFLICT");
          return { response: previous.response_body, responseStatus: 200, replayed: true };
        }
        if (job.version !== input.expectedVersion) executionError("JOB_VERSION_CONFLICT");
        if (job.state !== "queued") executionError("INVALID_JOB_TRANSITION");
        if ((await client.query("SELECT 1 FROM job_executions WHERE job_id=$1", [jobId])).rows.length) executionError("ALREADY_DISPATCHED");
        const revision = (await client.query(`SELECT r.canonical_site_spec FROM site_spec_revisions r JOIN projects p ON p.id=r.project_id
          WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='active' AND r.id=$3 AND r.revision=$4 AND r.canonical_sha256=$5 FOR SHARE OF p`,
        [workspaceId, projectId, job.site_spec_revision_id, job.input_revision, job.input_sha256])).rows[0];
        if (!revision) executionError("INPUT_HASH_MISMATCH");
        const spec = materialize(job, revision.canonical_site_spec, workspaceId);
        const now = clock();
        await client.query(`INSERT INTO job_executions(job_id,workspace_id,project_id,agent_id,job_spec,spec_sha256,created_at)
          VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [jobId, workspaceId, projectId, input.agentId, JSON.stringify(spec.spec), spec.sha256, now]);
        await transition(client, job, "queued", "job_dispatched", now, { agentId: input.agentId, specSha256: spec.sha256 }, "operator");
        const response = { job: jobResponse(await findJob(client, workspaceId, projectId, jobId)) };
        await insertIdempotencyRecord(client, { workspaceId, operation, idempotencyKey: key, requestSha256: hash, responseBody: response, responseStatus: 200 });
        return { response, responseStatus: 200, replayed: false };
      });
    },
    async claim(agentId, secret, input, key) {
      executionRequest("claim", input); key = assertIdempotencyKey(key);
      // No plaintext token is recoverable. A lost claim waits for bounded expiry before a new attempt.
      return transaction(async (client) => {
        const { grant } = await authorize(client, agentId, secret);
        await sweepIn(client, grant.project_id, agentId);
        if ((await client.query("SELECT 1 FROM job_attempts WHERE workspace_id=$1 AND agent_id=$2 AND claim_key_sha256=$3", [workspaceId, agentId, secretHash(key)])).rows.length) executionError("CLAIM_REPLY_UNAVAILABLE");
        if ((await client.query("SELECT 1 FROM job_attempts WHERE workspace_id=$1 AND agent_id=$2 AND finished_at IS NULL", [workspaceId, agentId])).rows.length) return { assignment: null, reason: "AGENT_BUSY", retryAfterMs: 1000 };
        const selected = await client.query(`SELECT j.* FROM jobs j JOIN job_executions e ON e.job_id=j.id
          WHERE j.workspace_id=$1 AND j.project_id=$2 AND e.agent_id=$3 AND j.state='queued'
          ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [workspaceId, grant.project_id, agentId]);
        const job = selected.rows[0];
        if (!job) return { assignment: null, reason: "NO_ASSIGNED_JOB", retryAfterMs: 1000 };
        const execution = (await client.query("SELECT * FROM job_executions WHERE job_id=$1", [job.id])).rows[0];
        assertSpec(execution.job_spec, execution.spec_sha256.trim());
        const attempt = (await client.query("SELECT coalesce(max(attempt),0)+1 AS next FROM job_attempts WHERE job_id=$1", [job.id])).rows[0].next;
        if (attempt > POLICY.maxAttempts) executionError("ATTEMPTS_EXHAUSTED");
        const now = clock(); const expiry = new Date(+now + POLICY.leaseDurationMs); const deadline = new Date(+now + POLICY.maxDurationMs);
        const leaseToken = `lease_${randomBytes(32).toString("base64url")}`;
        await client.query(`INSERT INTO job_attempts(job_id,attempt,workspace_id,project_id,agent_id,state,claim_key_sha256,lease_sha256,claimed_at,expires_at,deadline_at)
          VALUES($1,$2,$3,$4,$5,'claimed',$6,$7,$8,$9,$10)`, [job.id, attempt, workspaceId, job.project_id, agentId, secretHash(key), secretHash(leaseToken), now, expiry, deadline]);
        await transition(client, job, "claimed", "job_claimed", now, { attempt });
        return { assignment: { jobSpec: execution.job_spec, jobSpecSha256: execution.spec_sha256.trim(), attempt, leaseToken,
          leaseExpiresAt: expiry.toISOString(), deadlineAt: deadline.toISOString() } };
      });
    },
    async action(agentId, jobId, secret, kind, input, key) {
      assertAgentId(agentId); assertJobId(jobId); executionRequest(kind, input);
      if (!["start","heartbeat","result","fail","cancel-ack"].includes(kind)) executionError("VALIDATION_FAILED", 422);
      if (kind !== "heartbeat") key = assertIdempotencyKey(key);
      return transaction(async (client) => {
        const { grant } = await authorize(client, agentId, secret);
        const job = await lockedJob(client, grant.project_id, jobId);
        const attempt = (await client.query("SELECT * FROM job_attempts WHERE job_id=$1 ORDER BY attempt DESC LIMIT 1 FOR UPDATE", [jobId])).rows[0];
        if (!attempt || attempt.agent_id !== agentId || attempt.attempt !== input.attempt || !hashMatches(input.leaseToken, attempt.lease_sha256)) executionError("STALE_ATTEMPT", 403);
        const now = clock();
        if (now >= attempt.expires_at || now >= attempt.deadline_at) executionError("LEASE_EXPIRED");
        const hash = sha256Json({ ...input, leaseToken: secretHash(input.leaseToken) });
        if (kind !== "heartbeat") {
          const previous = (await client.query(`SELECT * FROM execution_operations WHERE job_id=$1 AND attempt=$2 AND operation=$3 AND key_sha256=$4`,
          [jobId, input.attempt, kind, secretHash(key)])).rows[0];
          if (previous) {
            if (previous.request_sha256.trim() !== hash) executionError("IDEMPOTENCY_CONFLICT");
            return { ...previous.response, replayed: true };
          }
        }
        if (attempt.finished_at) executionError("ATTEMPT_FINISHED");
        if (job.state === "cancel_requested" && !["cancel-ack","fail","heartbeat"].includes(kind)) executionError("CANCEL_REQUESTED");
        let terminal = false; let failure = null;
        if (kind === "start") {
          if (job.state !== "claimed") executionError("INVALID_JOB_TRANSITION");
          await client.query("UPDATE job_attempts SET state='running' WHERE job_id=$1 AND attempt=$2", [jobId, input.attempt]);
          await transition(client, job, "running", "job_started", now, { attempt: input.attempt });
        } else if (kind === "heartbeat") {
          if (!["running","validating","cancel_requested"].includes(job.state)) executionError("INVALID_JOB_TRANSITION");
          if (job.state !== "cancel_requested") {
            attempt.expires_at = new Date(Math.min(+now + POLICY.leaseDurationMs, +attempt.deadline_at));
            await client.query("UPDATE job_attempts SET state='validating',expires_at=$3 WHERE job_id=$1 AND attempt=$2", [jobId, input.attempt, attempt.expires_at]);
            if (job.state === "running") await transition(client, job, "validating", "job_validating", now, { attempt: input.attempt });
          }
        } else if (kind === "result") {
          if (job.state !== "validating") executionError("INVALID_JOB_TRANSITION");
          const execution = (await client.query("SELECT job_spec,spec_sha256 FROM job_executions WHERE job_id=$1", [jobId])).rows[0];
          assertSpec(execution.job_spec, execution.spec_sha256.trim());
          const expected = validationReport(execution.job_spec, input.attempt);
          if (sha256Json(input.report) !== input.resultDigest || sha256Json(expected) !== input.resultDigest) executionError("REPORT_MISMATCH");
          if (clock() >= attempt.expires_at || clock() >= attempt.deadline_at) executionError("LEASE_EXPIRED");
          await client.query("INSERT INTO job_results(job_id,attempt,result_digest,report,created_at) VALUES($1,$2,$3,$4::jsonb,$5)", [jobId, input.attempt, input.resultDigest, JSON.stringify(expected), now]);
          terminal = true;
          await client.query("UPDATE job_attempts SET state='succeeded',finished_at=$3 WHERE job_id=$1 AND attempt=$2", [jobId, input.attempt, now]);
          await transition(client, job, "succeeded", "job_succeeded", now, { attempt: input.attempt, validationStatus: expected.validationStatus, resultDigest: input.resultDigest });
        } else if (kind === "cancel-ack") {
          if (job.state !== "cancel_requested") executionError("INVALID_JOB_TRANSITION");
          terminal = true;
          await client.query("UPDATE job_attempts SET state='cancelled',finished_at=$3 WHERE job_id=$1 AND attempt=$2", [jobId, input.attempt, now]);
          await transition(client, job, "cancelled", "job_cancelled", now, { attempt: input.attempt, reason: "RUNNER_CANCEL_ACK" });
        } else {
          terminal = true; failure = job.state === "cancel_requested" ? "STOP_UNCONFIRMED" : input.code;
          await client.query("UPDATE job_attempts SET state='failed',finished_at=$3,failure_code=$4 WHERE job_id=$1 AND attempt=$2", [jobId, input.attempt, now, failure]);
          await transition(client, job, "failed", "job_failed", now, { attempt: input.attempt, reason: failure });
        }
        const response = { jobId, attempt: input.attempt, state: job.state, cancelRequested: job.state === "cancel_requested",
          terminal, leaseExpiresAt: attempt.expires_at.toISOString(), deadlineAt: attempt.deadline_at.toISOString() };
        if (kind !== "heartbeat") await client.query(`INSERT INTO execution_operations(job_id,attempt,operation,key_sha256,request_sha256,response)
          VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [jobId, input.attempt, kind, secretHash(key), hash, JSON.stringify(response)]);
        return response;
      });
    },
    async detail(projectId, jobId) {
      assertProjectId(projectId); assertJobId(jobId); await sweep(projectId);
      const row = (await getDatabasePool().query(`SELECT e.agent_id,e.spec_sha256,e.job_spec->'validator' AS validator,
        r.report,r.result_digest,(SELECT coalesce(jsonb_agg(x ORDER BY x.attempt),'[]'::jsonb) FROM
          (SELECT attempt,state,claimed_at,expires_at,deadline_at,finished_at,failure_code FROM job_attempts WHERE job_id=j.id) x) AS attempts
        FROM jobs j LEFT JOIN job_executions e ON e.job_id=j.id LEFT JOIN job_results r ON r.job_id=j.id
        WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.id=$3`, [workspaceId, projectId, jobId])).rows[0];
      if (!row) executionError("JOB_NOT_FOUND", 404);
      return { assignment: row.agent_id ? { agentId: row.agent_id, specSha256: row.spec_sha256.trim(), validator: row.validator } : null,
        report: row.report, resultDigest: row.result_digest?.trim() ?? null, attempts: row.attempts, acceptanceResult: null };
    }
  };
}
export const execution = createExecutionService();
