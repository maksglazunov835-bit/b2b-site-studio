const jobColumns = `j.*, p.current_revision,
  to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;

export function jobResponse(row) {
  return {
    id: row.id, projectId: row.project_id, type: row.type, templateVersion: row.template_version,
    siteSpec: { revisionId: row.site_spec_revision_id, revision: row.input_revision,
      schemaVersion: row.input_schema_version, sha256: row.input_sha256.trim() },
    requestSnapshot: row.request_snapshot, state: row.state, version: row.version,
    currentRevision: row.current_revision, isInputStale: row.input_revision !== row.current_revision,
    dispatchable: false, reason: "EXECUTOR_NOT_CONFIGURED",
    executionResult: row.state === "cancelled" ? "cancelled" : null, acceptanceResult: null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null
  };
}

export async function findJob(client, workspaceId, projectId, id, lock = false) {
  const result = await client.query(`SELECT ${jobColumns} FROM jobs j
    JOIN projects p ON p.id = j.project_id AND p.workspace_id = j.workspace_id
    WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.id=$3 ${lock ? "FOR UPDATE OF j" : ""}`,
  [workspaceId, projectId, id]);
  return result.rows[0] ?? null;
}

export async function insertJob(client, workspaceId, projectId, id, revision, requestSnapshot) {
  await client.query(`INSERT INTO jobs (id,workspace_id,project_id,site_spec_revision_id,input_revision,
    input_schema_version,input_sha256,type,template_version,request_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'site_spec_validation','site_spec_validation@1',$8::jsonb)`,
  [id, workspaceId, projectId, revision.id, revision.revision, revision.schemaVersion, revision.sha256, JSON.stringify(requestSnapshot)]);
}

export async function insertEvent(client, workspaceId, projectId, id, cancelled = false) {
  await client.query(`INSERT INTO job_events (job_id,sequence,event_type,from_state,to_state,payload)
    SELECT id,$4,$5,$6,$7,$8::jsonb FROM jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,
  [workspaceId, projectId, id, cancelled ? 2 : 1, cancelled ? "job_cancelled" : "job_queued",
    cancelled ? "queued" : null, cancelled ? "cancelled" : "queued",
    JSON.stringify(cancelled ? { reason: "OPERATOR_CANCELLED" } : { template: "site_spec_validation@1" })]);
}

export async function cancelJobRow(client, workspaceId, projectId, id) {
  await client.query(`UPDATE jobs SET state='cancelled',version=version+1,
    updated_at=clock_timestamp(),cancelled_at=clock_timestamp()
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [workspaceId, projectId, id]);
}

export async function jobRows(client, workspaceId, projectId, { limit, cursor }) {
  const result = await client.query(`SELECT ${jobColumns} FROM jobs j
    JOIN projects p ON p.id=j.project_id AND p.workspace_id=j.workspace_id
    WHERE j.workspace_id=$1 AND j.project_id=$2
    AND ($3::timestamptz IS NULL OR (j.created_at,j.id) < ($3::timestamptz,$4::text))
    ORDER BY j.created_at DESC,j.id DESC LIMIT $5`,
  [workspaceId, projectId, cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
  return result.rows;
}

export async function eventRows(client, workspaceId, projectId, id, { limit, cursor }) {
  const result = await client.query(`SELECT e.* FROM job_events e JOIN jobs j ON j.id=e.job_id
    WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.id=$3 AND e.sequence > $4
    ORDER BY e.sequence ASC LIMIT $5`, [workspaceId, projectId, id, cursor?.sequence ?? 0, limit + 1]);
  return result.rows;
}
