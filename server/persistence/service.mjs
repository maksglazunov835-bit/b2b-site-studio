import { randomUUID } from "node:crypto";

import { sha256Json } from "./canonical-json.mjs";
import { checkDatabaseConnection, getDatabasePool, withTransaction } from "./database.mjs";
import { PersistenceError } from "./errors.mjs";
import {
  DEFAULT_WORKSPACE_ID,
  acquireIdempotencyLock,
  findIdempotencyRecord,
  getCurrentRevisionForWorkspace,
  getProjectForWorkspace,
  getRevisionForWorkspace,
  insertIdempotencyRecord,
  insertProject,
  insertProjectEvent,
  insertReadinessChecks,
  insertRevision,
  listProjectsForWorkspace,
  listRevisionsForWorkspace,
  lockProject,
  updateProjectCurrentRevision,
  updateProjectMetadata
} from "./repository.mjs";
import {
  assertNoServerOwnedFields,
  buildDraftSiteSpec,
  editableDraftFromSiteSpec,
  normalizeEditableDraft,
  readinessRows
} from "./site-spec.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR_TYPE = "user";
const SOURCE = "web_ui";

function errorOutcome(code, message, status, details = {}) {
  return { error: { code, message, status, details } };
}

function unwrapOutcome(outcome) {
  if (!outcome.error) return outcome;
  throw new PersistenceError(outcome.error.code, outcome.error.message, {
    status: outcome.error.status,
    details: outcome.error.details
  });
}

function assertObject(value, message = "The request body must be a JSON object.") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PersistenceError("VALIDATION_FAILED", message, { status: 422 });
  }
}

function assertOnlyFields(value, allowed) {
  const unknown = Object.keys(value).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    throw new PersistenceError("VALIDATION_FAILED", "The request contains unsupported fields.", {
      status: 422,
      details: { fields: unknown.sort() }
    });
  }
}

function requiredText(value, field, maxLength = 200) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersistenceError("VALIDATION_FAILED", `${field} is required.`, {
      status: 422,
      details: { field }
    });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new PersistenceError("VALIDATION_FAILED", `${field} is too long.`, {
      status: 422,
      details: { field, maxLength }
    });
  }
  return normalized;
}

export function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !UUID_PATTERN.test(projectId)) {
    throw new PersistenceError("VALIDATION_FAILED", "projectId must be a UUID.", {
      status: 422,
      details: { field: "projectId" }
    });
  }
  return projectId;
}

export function assertIdempotencyKey(value) {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 200) {
    throw new PersistenceError("VALIDATION_FAILED", "Idempotency-Key is required and must not exceed 200 characters.", {
      status: 422,
      details: { header: "Idempotency-Key" }
    });
  }
  return value.trim();
}

function slugForProject(displayName, projectId) {
  const base = displayName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "project"}-${projectId.slice(0, 8)}`;
}

function revisionResponse(revision, noOp = false) {
  return {
    projectId: revision.projectId,
    revision: revision.revision,
    schemaVersion: revision.schemaVersion,
    documentStage: revision.documentStage,
    sha256: revision.sha256,
    createdAt: revision.createdAt,
    noOp,
    editableDraft: editableDraftFromSiteSpec(revision.value),
    value: revision.value
  };
}

function projectResponse(project) {
  return {
    id: project.id,
    displayName: project.displayName,
    slug: project.slug,
    status: project.status,
    currentRevision: project.currentRevision,
    version: project.version,
    currentSiteSpecSha256: project.currentSiteSpecSha256,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function idempotencyConflict(existing, projectId) {
  return errorOutcome(
    "IDEMPOTENCY_CONFLICT",
    "The Idempotency-Key was already used with a different request.",
    409,
    {
      projectId,
      originalCreatedAt: existing.created_at?.toISOString?.() ?? null
    }
  );
}

async function replayOrConflict(client, { workspaceId, operation, idempotencyKey, requestSha256, projectId }) {
  await acquireIdempotencyLock(client, workspaceId, operation, idempotencyKey);
  const existing = await findIdempotencyRecord(client, workspaceId, operation, idempotencyKey);
  if (!existing) return null;
  if (existing.request_sha256.trim() === requestSha256) {
    return { response: existing.response_body, responseStatus: Number(existing.response_status), replayed: true };
  }
  if (projectId) {
    await insertProjectEvent(client, {
      workspaceId,
      projectId,
      eventType: "idempotency_conflict",
      payload: { operation },
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
  }
  return idempotencyConflict(existing, projectId ?? existing.response_body?.project?.id ?? null);
}

export async function databaseHealth() {
  const checkedAt = await checkDatabaseConnection();
  return { status: "ok", database: "available", checkedAt };
}

export async function createProject(input, idempotencyKeyValue) {
  assertObject(input);
  assertNoServerOwnedFields(input);
  assertOnlyFields(input, ["displayName", "draft"]);
  const displayName = requiredText(input.displayName, "displayName");
  const idempotencyKey = assertIdempotencyKey(idempotencyKeyValue);
  const normalizedDraft = normalizeEditableDraft(input.draft ?? {});
  if (!normalizedDraft.companyName) normalizedDraft.companyName = displayName;
  const requestSha256 = sha256Json({ displayName, draft: normalizedDraft });
  const operation = "create_project";

  const outcome = await withTransaction(async (client) => {
    const replay = await replayOrConflict(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      operation,
      idempotencyKey,
      requestSha256,
      projectId: null
    });
    if (replay) return replay;

    const projectId = randomUUID();
    const built = buildDraftSiteSpec({ projectId, revision: 1, draft: normalizedDraft });
    await insertProject(client, {
      id: projectId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName,
      slug: slugForProject(displayName, projectId)
    });
    const revision = await insertRevision(client, {
      id: randomUUID(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      revision: 1,
      schemaVersion: built.siteSpec.schemaVersion,
      documentStage: built.siteSpec.documentStage,
      siteSpec: built.siteSpec,
      canonicalSha256: built.canonicalSha256,
      editableSha256: built.editableSha256,
      idempotencyKey: `${operation}:${idempotencyKey}`,
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
    await insertReadinessChecks(
      client,
      DEFAULT_WORKSPACE_ID,
      projectId,
      revision.id,
      readinessRows(built.siteSpec)
    );
    const project = await updateProjectCurrentRevision(client, DEFAULT_WORKSPACE_ID, projectId, 1);
    const response = {
      project: projectResponse({ ...project, currentSiteSpecSha256: revision.sha256 }),
      siteSpec: revisionResponse(revision)
    };
    await insertProjectEvent(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      eventType: "project_created",
      revision: 1,
      payload: { displayName },
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
    await insertProjectEvent(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      eventType: "draft_revision_created",
      revision: 1,
      payload: { siteSpecSha256: revision.sha256 },
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
    await insertIdempotencyRecord(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      operation,
      idempotencyKey,
      requestSha256,
      responseStatus: 201,
      responseBody: response
    });
    return { response, responseStatus: 201, replayed: false };
  });

  return unwrapOutcome(outcome);
}

export async function saveDraft(projectIdValue, input, idempotencyKeyValue) {
  const projectId = assertProjectId(projectIdValue);
  assertObject(input);
  assertNoServerOwnedFields(input);
  assertOnlyFields(input, ["expectedRevision", "draft"]);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new PersistenceError("VALIDATION_FAILED", "expectedRevision must be a positive integer.", {
      status: 422,
      details: { field: "expectedRevision" }
    });
  }
  const draft = normalizeEditableDraft(input.draft ?? {});
  const idempotencyKey = assertIdempotencyKey(idempotencyKeyValue);
  const requestSha256 = sha256Json({ expectedRevision: input.expectedRevision, draft });
  const operation = `save_site_spec:${projectId}`;

  const outcome = await withTransaction(async (client) => {
    const replay = await replayOrConflict(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      operation,
      idempotencyKey,
      requestSha256,
      projectId
    });
    if (replay) return replay;

    const project = await lockProject(client, DEFAULT_WORKSPACE_ID, projectId);
    if (!project) {
      return errorOutcome("PROJECT_NOT_FOUND", "The project does not exist.", 404, { projectId });
    }
    if (project.status === "archived") {
      return errorOutcome("PROJECT_ARCHIVED", "Archived projects cannot accept new revisions.", 409, { projectId });
    }
    if (project.currentRevision !== input.expectedRevision) {
      await insertProjectEvent(client, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        projectId,
        eventType: "draft_save_conflict",
        revision: project.currentRevision,
        payload: { expectedRevision: input.expectedRevision, currentRevision: project.currentRevision },
        actorType: ACTOR_TYPE,
        source: SOURCE
      });
      return errorOutcome(
        "REVISION_CONFLICT",
        "The draft changed on the server. Reload the current revision before saving again.",
        409,
        { projectId, expectedRevision: input.expectedRevision, currentRevision: project.currentRevision }
      );
    }

    const current = await getCurrentRevisionForWorkspace(client, DEFAULT_WORKSPACE_ID, projectId);
    if (!current) {
      return errorOutcome("REVISION_NOT_FOUND", "The current SiteSpec revision does not exist.", 404, {
        projectId,
        revision: project.currentRevision
      });
    }
    const built = buildDraftSiteSpec({ projectId, revision: project.currentRevision + 1, draft });
    if (built.editableSha256 === current.editableSha256) {
      const response = {
        project: projectResponse(project),
        siteSpec: revisionResponse(current, true)
      };
      await insertProjectEvent(client, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        projectId,
        eventType: "draft_save_noop",
        revision: current.revision,
        payload: { siteSpecSha256: current.sha256 },
        actorType: ACTOR_TYPE,
        source: SOURCE
      });
      await insertIdempotencyRecord(client, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        operation,
        idempotencyKey,
        requestSha256,
        responseStatus: 200,
        responseBody: response
      });
      return { response, responseStatus: 200, replayed: false };
    }

    const nextRevision = project.currentRevision + 1;
    const revision = await insertRevision(client, {
      id: randomUUID(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      revision: nextRevision,
      schemaVersion: built.siteSpec.schemaVersion,
      documentStage: built.siteSpec.documentStage,
      siteSpec: built.siteSpec,
      canonicalSha256: built.canonicalSha256,
      editableSha256: built.editableSha256,
      idempotencyKey: `${operation}:${idempotencyKey}`,
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
    await insertReadinessChecks(
      client,
      DEFAULT_WORKSPACE_ID,
      projectId,
      revision.id,
      readinessRows(built.siteSpec)
    );
    const updatedProject = await updateProjectCurrentRevision(
      client,
      DEFAULT_WORKSPACE_ID,
      projectId,
      nextRevision
    );
    const response = {
      project: projectResponse({ ...updatedProject, currentSiteSpecSha256: revision.sha256 }),
      siteSpec: revisionResponse(revision)
    };
    await insertProjectEvent(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      eventType: "draft_revision_created",
      revision: nextRevision,
      payload: { siteSpecSha256: revision.sha256 },
      actorType: ACTOR_TYPE,
      source: SOURCE
    });
    await insertIdempotencyRecord(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      operation,
      idempotencyKey,
      requestSha256,
      responseStatus: 200,
      responseBody: response
    });
    return { response, responseStatus: 200, replayed: false };
  });

  return unwrapOutcome(outcome);
}

export async function listProjects() {
  const projects = await listProjectsForWorkspace(getDatabasePool(), DEFAULT_WORKSPACE_ID);
  return { projects: projects.map(projectResponse) };
}

export async function getProject(projectIdValue) {
  const projectId = assertProjectId(projectIdValue);
  const pool = getDatabasePool();
  const project = await getProjectForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId);
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", "The project does not exist.", {
      status: 404,
      details: { projectId }
    });
  }
  const current = await getCurrentRevisionForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId);
  return {
    project: projectResponse(project),
    siteSpec: current ? revisionResponse(current) : null
  };
}

export async function getCurrentSiteSpec(projectIdValue) {
  const result = await getProject(projectIdValue);
  if (!result.siteSpec) {
    throw new PersistenceError("REVISION_NOT_FOUND", "The current SiteSpec revision does not exist.", {
      status: 404,
      details: { projectId: result.project.id }
    });
  }
  return result;
}

export async function listSiteSpecRevisions(projectIdValue) {
  const projectId = assertProjectId(projectIdValue);
  const pool = getDatabasePool();
  const project = await getProjectForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId);
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", "The project does not exist.", {
      status: 404,
      details: { projectId }
    });
  }
  const revisions = await listRevisionsForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId);
  return { project: projectResponse(project), revisions };
}

export async function getSiteSpecRevision(projectIdValue, revisionValue) {
  const projectId = assertProjectId(projectIdValue);
  const revisionNumber = Number(revisionValue);
  if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
    throw new PersistenceError("VALIDATION_FAILED", "revision must be a positive integer.", {
      status: 422,
      details: { field: "revision" }
    });
  }
  const pool = getDatabasePool();
  const project = await getProjectForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId);
  if (!project) {
    throw new PersistenceError("PROJECT_NOT_FOUND", "The project does not exist.", {
      status: 404,
      details: { projectId }
    });
  }
  const revision = await getRevisionForWorkspace(pool, DEFAULT_WORKSPACE_ID, projectId, revisionNumber);
  if (!revision) {
    throw new PersistenceError("REVISION_NOT_FOUND", "The requested SiteSpec revision does not exist.", {
      status: 404,
      details: { projectId, revision: revisionNumber }
    });
  }
  return { project: projectResponse(project), siteSpec: revisionResponse(revision) };
}

export async function patchProject(projectIdValue, input) {
  const projectId = assertProjectId(projectIdValue);
  assertObject(input);
  assertOnlyFields(input, ["displayName", "status", "expectedVersion"]);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new PersistenceError("VALIDATION_FAILED", "expectedVersion must be a positive integer.", {
      status: 422,
      details: { field: "expectedVersion" }
    });
  }
  const displayName = input.displayName === undefined ? null : requiredText(input.displayName, "displayName");
  const status = input.status === undefined ? null : input.status;
  if (displayName === null && status === null) {
    throw new PersistenceError("VALIDATION_FAILED", "Provide displayName or status.", { status: 422 });
  }
  if (status !== null && status !== "active" && status !== "archived") {
    throw new PersistenceError("VALIDATION_FAILED", "status must be active or archived.", {
      status: 422,
      details: { field: "status" }
    });
  }

  const outcome = await withTransaction(async (client) => {
    const existing = await lockProject(client, DEFAULT_WORKSPACE_ID, projectId);
    if (!existing) return errorOutcome("PROJECT_NOT_FOUND", "The project does not exist.", 404, { projectId });
    const updated = await updateProjectMetadata(client, {
      workspaceId: DEFAULT_WORKSPACE_ID,
      projectId,
      displayName,
      status,
      expectedVersion: input.expectedVersion
    });
    if (!updated) {
      return errorOutcome("REVISION_CONFLICT", "The project metadata changed on the server.", 409, {
        projectId,
        expectedVersion: input.expectedVersion,
        currentVersion: existing.version
      });
    }
    if (displayName !== null && displayName !== existing.displayName) {
      await insertProjectEvent(client, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        projectId,
        eventType: "project_renamed",
        revision: existing.currentRevision || null,
        payload: {},
        actorType: ACTOR_TYPE,
        source: SOURCE
      });
    }
    if (status === "archived" && existing.status !== "archived") {
      await insertProjectEvent(client, {
        workspaceId: DEFAULT_WORKSPACE_ID,
        projectId,
        eventType: "project_archived",
        revision: existing.currentRevision || null,
        payload: {},
        actorType: ACTOR_TYPE,
        source: SOURCE
      });
    }
    return { response: { project: projectResponse(updated) }, responseStatus: 200 };
  });
  return unwrapOutcome(outcome);
}
