import { randomUUID } from "node:crypto";
import { getDatabasePool, withTransaction } from "../persistence/database.mjs";
import { sha256Json } from "../persistence/canonical-json.mjs";
import { assertIdempotencyKey, assertProjectId } from "../persistence/service.mjs";
import { DEFAULT_WORKSPACE_ID, acquireIdempotencyLock, findIdempotencyRecord, insertIdempotencyRecord,
  getProjectForWorkspace, getCurrentRevisionForWorkspace, lockProject } from "../persistence/repository.mjs";
import { createRequest, cancelRequest, assertJobId, jobError, pagination, encodeCursor } from "./requests.mjs";
import { findJob, insertJob, insertEvent, cancelJobRow, jobRows, eventRows, jobResponse } from "./repository.mjs";
import { createExecutionService } from "../execution/service.mjs";
import { transition } from "../execution/transitions.mjs";

async function requireProject(client, workspaceId, projectId) {
  const project = await getProjectForWorkspace(client, workspaceId, projectId);
  if (!project) jobError("PROJECT_NOT_FOUND", "The project does not exist.", 404);
  return project;
}

async function requireJob(client, workspaceId, projectId, id, lock = false) {
  const job = await findJob(client, workspaceId, projectId, id, lock);
  if (!job) jobError("JOB_NOT_FOUND", "The job does not exist.", 404);
  return job;
}

// Workspace is supplied only by trusted server context, never HTTP body/query.
export function createJobService(workspaceId = DEFAULT_WORKSPACE_ID) {
  assertProjectId(workspaceId);
  async function replay(client, projectId, operation, key, hash) {
    await acquireIdempotencyLock(client, workspaceId, operation, key);
    await requireProject(client, workspaceId, projectId);
    const record = await findIdempotencyRecord(client, workspaceId, operation, key);
    if (!record) return null;
    if (record.request_sha256.trim() !== hash) jobError("IDEMPOTENCY_CONFLICT", "This key already identifies a different request.", 409);
    return { response: record.response_body, responseStatus: record.response_status, replayed: true };
  }
  async function recordResponse(client, operation, key, hash, response, status) {
    await insertIdempotencyRecord(client, { workspaceId, operation, idempotencyKey: key,
      requestSha256: hash, responseBody: response, responseStatus: status });
    return { response, responseStatus: status, replayed: false };
  }
  return {
    async create(projectId, input, key) {
      assertProjectId(projectId);
      const request = createRequest(input);
      key = assertIdempotencyKey(key);
      const hash = sha256Json(request);
      const operation = `create_job:${projectId}`;
      return withTransaction(async (client) => {
        const previous = await replay(client, projectId, operation, key, hash);
        if (previous) return previous;
        const project = await lockProject(client, workspaceId, projectId);
        if (project.status !== "active") jobError("PROJECT_ARCHIVED", "Archived projects cannot accept jobs.", 409);
        if (project.currentRevision !== request.expectedRevision) jobError("REVISION_CONFLICT", "Save or reload the current brief before creating a job.", 409);
        const revision = await getCurrentRevisionForWorkspace(client, workspaceId, projectId);
        if (!revision) jobError("REVISION_NOT_FOUND", "The saved revision does not exist.", 404);
        if (sha256Json(revision.value) !== revision.sha256) jobError("SITE_SPEC_INTEGRITY_ERROR", "The saved input failed its integrity check.", 409);
        const id = `job_${randomUUID().replaceAll("-", "")}`;
        const snapshot = { type: request.type, templateVersion: "site_spec_validation@1",
          input: { revisionId: revision.id, revision: revision.revision, schemaVersion: revision.schemaVersion, sha256: revision.sha256 },
          objective: "Validate the pinned SiteSpec without changing it.",
          acceptanceCriteria: ["Validate SiteSpec schema and semantics", "Report findings without modifying inputs"] };
        await insertJob(client, workspaceId, projectId, id, revision, snapshot);
        await insertEvent(client, workspaceId, projectId, id);
        const response = { job: jobResponse(await requireJob(client, workspaceId, projectId, id)) };
        return recordResponse(client, operation, key, hash, response, 201);
      });
    },
    async cancel(projectId, id, input, key) {
      assertProjectId(projectId); assertJobId(id);
      const request = cancelRequest(input);
      key = assertIdempotencyKey(key);
      const operation = `cancel_job:${projectId}:${id}`;
      const hash = sha256Json(request);
      return withTransaction(async (client) => {
        // Lock order: idempotency scope, then target job. Cancellation never locks a project.
        await requireJob(client, workspaceId, projectId, id);
        const previous = await replay(client, projectId, operation, key, hash);
        if (previous) return previous;
        const job = await requireJob(client, workspaceId, projectId, id, true);
        if (job.version !== request.expectedVersion) jobError("JOB_VERSION_CONFLICT", "Reload the job before cancelling it.", 409);
        const noOp = ["cancelled","cancel_requested"].includes(job.state);
        if (!noOp) {
          if (job.state === "queued") {
            await cancelJobRow(client, workspaceId, projectId, id);
            await insertEvent(client, workspaceId, projectId, id, true);
          } else if (["claimed","running","validating"].includes(job.state)) {
            await client.query("UPDATE job_attempts SET state='cancel_requested' WHERE job_id=$1 AND finished_at IS NULL", [id]);
            await transition(client, job, "cancel_requested", "job_cancel_requested", new Date(), { reason: "OPERATOR_CANCELLED" }, "operator");
          } else jobError("INVALID_JOB_TRANSITION", "Terminal jobs cannot be cancelled.", 409);
        }
        return recordResponse(client, operation, key, hash,
          { job: jobResponse(await requireJob(client, workspaceId, projectId, id)), noOp }, 200);
      });
    },
    async get(projectId, id) {
      assertProjectId(projectId); assertJobId(id);
      await createExecutionService({ workspaceId }).sweep(projectId);
      return { job: jobResponse(await requireJob(getDatabasePool(), workspaceId, projectId, id)) };
    },
    async list(projectId, params) {
      assertProjectId(projectId);
      await createExecutionService({ workspaceId }).sweep(projectId);
      const scope = { kind: "jobs", workspaceId, projectId };
      const page = pagination(params, scope);
      const client = getDatabasePool();
      await requireProject(client, workspaceId, projectId);
      const rows = await jobRows(client, workspaceId, projectId, page);
      const more = rows.length > page.limit;
      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      return { jobs: items.map(jobResponse), nextCursor: more ? encodeCursor({ ...scope, v: 1, at: last.cursor_time, id: last.id }) : null };
    },
    async events(projectId, id, params) {
      assertProjectId(projectId); assertJobId(id);
      const scope = { kind: "events", workspaceId, projectId, jobId: id };
      const page = pagination(params, scope);
      const client = getDatabasePool();
      await requireJob(client, workspaceId, projectId, id);
      const rows = await eventRows(client, workspaceId, projectId, id, page);
      const items = rows.slice(0, page.limit);
      return { events: items.map((row) => ({ jobId: row.job_id, sequence: row.sequence, type: row.event_type,
        fromState: row.from_state, toState: row.to_state, payload: row.payload,
        actorType: row.actor_type, source: row.source, createdAt: row.created_at.toISOString() })),
      nextCursor: rows.length > page.limit ? encodeCursor({ ...scope, v: 1, sequence: items.at(-1).sequence }) : null };
    }
  };
}

export const jobs = createJobService();
