import { randomUUID } from "node:crypto";

export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

export function mapProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    displayName: row.display_name,
    slug: row.slug,
    status: row.status,
    currentRevision: Number(row.current_revision),
    version: Number(row.optimistic_version),
    currentSiteSpecSha256: row.current_site_spec_sha256?.trim?.() ?? null,
    archivedAt: iso(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export function mapRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    schemaVersion: row.schema_version,
    documentStage: row.document_stage,
    value: row.canonical_site_spec,
    sha256: row.canonical_sha256.trim(),
    editableSha256: row.editable_sha256.trim(),
    actorType: row.actor_type,
    source: row.source,
    createdAt: iso(row.created_at)
  };
}

export async function acquireIdempotencyLock(client, workspaceId, operation, idempotencyKey) {
  const scope = `${workspaceId}:${operation}:${idempotencyKey}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
}

export async function findIdempotencyRecord(client, workspaceId, operation, idempotencyKey) {
  const result = await client.query(
    `SELECT request_sha256, response_status, response_body, created_at
       FROM api_idempotency_records
      WHERE workspace_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [workspaceId, operation, idempotencyKey]
  );
  return result.rows[0] ?? null;
}

export async function insertIdempotencyRecord(
  client,
  { workspaceId, operation, idempotencyKey, requestSha256, responseStatus, responseBody }
) {
  await client.query(
    `INSERT INTO api_idempotency_records (
       id, workspace_id, operation, idempotency_key, request_sha256, response_status, response_body
     )
     SELECT $1, w.id, $3, $4, $5, $6, $7::jsonb
       FROM workspaces w
      WHERE w.id = $2`,
    [
      randomUUID(),
      workspaceId,
      operation,
      idempotencyKey,
      requestSha256,
      responseStatus,
      JSON.stringify(responseBody)
    ]
  );
}

export async function insertProject(client, { id, workspaceId, displayName, slug }) {
  const result = await client.query(
    `INSERT INTO projects (id, workspace_id, display_name, slug)
     SELECT $1, w.id, $3, $4
       FROM workspaces w
      WHERE w.id = $2
     RETURNING *`,
    [id, workspaceId, displayName, slug]
  );
  return mapProject(result.rows[0]);
}

export async function lockProject(client, workspaceId, projectId) {
  const result = await client.query(
    `SELECT p.*, current_revision_row.canonical_sha256 AS current_site_spec_sha256
       FROM projects p
       LEFT JOIN site_spec_revisions current_revision_row
         ON current_revision_row.project_id = p.id
        AND current_revision_row.revision = p.current_revision
      WHERE p.workspace_id = $1 AND p.id = $2
      FOR UPDATE OF p`,
    [workspaceId, projectId]
  );
  return mapProject(result.rows[0]);
}

export async function updateProjectCurrentRevision(client, workspaceId, projectId, revision) {
  const result = await client.query(
    `UPDATE projects
        SET current_revision = $3,
            optimistic_version = optimistic_version + 1,
            updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND id = $2
      RETURNING *`,
    [workspaceId, projectId, revision]
  );
  return mapProject(result.rows[0]);
}

export async function insertRevision(
  client,
  {
    id,
    workspaceId,
    projectId,
    revision,
    schemaVersion,
    documentStage,
    siteSpec,
    canonicalSha256,
    editableSha256,
    idempotencyKey,
    actorType,
    source
  }
) {
  const result = await client.query(
    `INSERT INTO site_spec_revisions (
       id, project_id, revision, schema_version, document_stage, canonical_site_spec,
       canonical_sha256, editable_sha256, idempotency_key, actor_type, source
     )
     SELECT $1, p.id, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12
       FROM projects p
      WHERE p.workspace_id = $2 AND p.id = $3
     RETURNING *`,
    [
      id,
      workspaceId,
      projectId,
      revision,
      schemaVersion,
      documentStage,
      JSON.stringify(siteSpec),
      canonicalSha256,
      editableSha256,
      idempotencyKey,
      actorType,
      source
    ]
  );
  return mapRevision(result.rows[0]);
}

export async function insertReadinessChecks(client, workspaceId, projectId, revisionId, checks) {
  if (checks.length === 0) return;
  const rows = checks.map((check) => ({
    gate: check.gate,
    check_id: check.id,
    is_required: check.required,
    status: check.status,
    message: check.message,
    evaluator_version: check.evaluatorVersion,
    checked_at: check.checkedAt
  }));
  await client.query(
    `INSERT INTO site_spec_readiness_checks (
       revision_id, gate, check_id, required, status, message, evaluator_version, checked_at
     )
     SELECT r.id, c.gate, c.check_id, c.is_required, c.status, c.message, c.evaluator_version, c.checked_at
       FROM site_spec_revisions r
       JOIN projects p ON p.id = r.project_id
       CROSS JOIN jsonb_to_recordset($4::jsonb) AS c(
         gate text,
         check_id text,
         is_required boolean,
         status text,
         message text,
         evaluator_version text,
         checked_at timestamptz
       )
      WHERE p.workspace_id = $1 AND p.id = $2 AND r.id = $3`,
    [workspaceId, projectId, revisionId, JSON.stringify(rows)]
  );
}

export async function insertProjectEvent(
  client,
  { workspaceId, projectId, eventType, revision = null, payload = {}, actorType, source }
) {
  await client.query(
    `INSERT INTO project_events (
       workspace_id, project_id, event_type, revision, payload, actor_type, source
     )
     SELECT p.workspace_id, p.id, $3, $4, $5::jsonb, $6, $7
       FROM projects p
      WHERE p.workspace_id = $1 AND p.id = $2`,
    [workspaceId, projectId, eventType, revision, JSON.stringify(payload), actorType, source]
  );
}

export async function listProjectsForWorkspace(queryable, workspaceId) {
  const result = await queryable.query(
    `SELECT p.*, current_revision_row.canonical_sha256 AS current_site_spec_sha256
       FROM projects p
       LEFT JOIN site_spec_revisions current_revision_row
         ON current_revision_row.project_id = p.id
        AND current_revision_row.revision = p.current_revision
      WHERE p.workspace_id = $1
      ORDER BY p.updated_at DESC, p.id`,
    [workspaceId]
  );
  return result.rows.map(mapProject);
}

export async function getProjectForWorkspace(queryable, workspaceId, projectId) {
  const result = await queryable.query(
    `SELECT p.*, current_revision_row.canonical_sha256 AS current_site_spec_sha256
       FROM projects p
       LEFT JOIN site_spec_revisions current_revision_row
         ON current_revision_row.project_id = p.id
        AND current_revision_row.revision = p.current_revision
      WHERE p.workspace_id = $1 AND p.id = $2`,
    [workspaceId, projectId]
  );
  return mapProject(result.rows[0]);
}

export async function getCurrentRevisionForWorkspace(queryable, workspaceId, projectId) {
  const result = await queryable.query(
    `SELECT r.*
       FROM site_spec_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE p.workspace_id = $1 AND p.id = $2 AND r.revision = p.current_revision`,
    [workspaceId, projectId]
  );
  return mapRevision(result.rows[0]);
}

export async function getRevisionForWorkspace(queryable, workspaceId, projectId, revision) {
  const result = await queryable.query(
    `SELECT r.*
       FROM site_spec_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE p.workspace_id = $1 AND p.id = $2 AND r.revision = $3`,
    [workspaceId, projectId, revision]
  );
  return mapRevision(result.rows[0]);
}

export async function listRevisionsForWorkspace(queryable, workspaceId, projectId) {
  const result = await queryable.query(
    `SELECT r.id, r.project_id, r.revision, r.schema_version, r.document_stage,
            r.canonical_sha256, r.editable_sha256, r.actor_type, r.source, r.created_at
       FROM site_spec_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE p.workspace_id = $1 AND p.id = $2
      ORDER BY r.revision DESC`,
    [workspaceId, projectId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    revision: Number(row.revision),
    schemaVersion: row.schema_version,
    documentStage: row.document_stage,
    sha256: row.canonical_sha256.trim(),
    editableSha256: row.editable_sha256.trim(),
    actorType: row.actor_type,
    source: row.source,
    createdAt: iso(row.created_at)
  }));
}

export async function updateProjectMetadata(
  client,
  { workspaceId, projectId, displayName, status, expectedVersion }
) {
  const result = await client.query(
    `UPDATE projects
        SET display_name = COALESCE($3, display_name),
            status = COALESCE($4, status),
            archived_at = CASE
              WHEN $4 = 'archived' THEN COALESCE(archived_at, clock_timestamp())
              WHEN $4 = 'active' THEN NULL
              ELSE archived_at
            END,
            optimistic_version = optimistic_version + 1,
            updated_at = clock_timestamp()
      WHERE workspace_id = $1 AND id = $2 AND optimistic_version = $5
      RETURNING *`,
    [workspaceId, projectId, displayName, status, expectedVersion]
  );
  return mapProject(result.rows[0]);
}

export async function countProjectRevisions(queryable, workspaceId, projectId) {
  const result = await queryable.query(
    `SELECT count(*)::integer AS count
       FROM site_spec_revisions r
       JOIN projects p ON p.id = r.project_id
      WHERE p.workspace_id = $1 AND p.id = $2`,
    [workspaceId, projectId]
  );
  return result.rows[0].count;
}

export async function listProjectEvents(queryable, workspaceId, projectId) {
  const result = await queryable.query(
    `SELECT event_type, revision, payload, actor_type, source, created_at
       FROM project_events
      WHERE workspace_id = $1 AND project_id = $2
      ORDER BY id`,
    [workspaceId, projectId]
  );
  return result.rows.map((row) => ({
    eventType: row.event_type,
    revision: row.revision === null ? null : Number(row.revision),
    payload: row.payload,
    actorType: row.actor_type,
    source: row.source,
    createdAt: iso(row.created_at)
  }));
}
