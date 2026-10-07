import validator from "../execution/validator-manifest.json" with { type: "json" };
import { ADAPTER } from '../design/contract.mjs';
const jobColumns = `j.*, p.current_revision, p.status AS project_status,
  e.agent_id AS assigned_agent_id,e.spec_sha256 AS execution_sha256,a.revoked_at AS assigned_revoked_at,g.validator_sha256,
  to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time`;
const executionJoins = `LEFT JOIN job_executions e ON e.job_id=j.id
  LEFT JOIN agents a ON a.id=e.agent_id AND a.workspace_id=j.workspace_id
  LEFT JOIN agent_execution_grants g ON g.agent_id=a.id AND g.project_id=j.project_id AND g.workspace_id=j.workspace_id`;

export function jobResponse(row) {
  const expectedHash = row.type === 'design_proposal' ? ADAPTER.sha256 : validator.sha256;
  return {
    id: row.id, projectId: row.project_id, type: row.type, templateVersion: row.template_version,
    siteSpec: { revisionId: row.site_spec_revision_id, revision: row.input_revision,
      schemaVersion: row.input_schema_version, sha256: row.input_sha256.trim() },
    requestSnapshot: row.request_snapshot, state: row.state, version: row.version,
    currentRevision: row.current_revision, isInputStale: row.input_revision !== row.current_revision,
    dispatchable: !!row.assigned_agent_id && row.state === "queued" && !row.assigned_revoked_at && row.project_status === "active" && row.validator_sha256?.trim() === expectedHash,
    reason: !row.assigned_agent_id ? "EXECUTOR_NOT_CONFIGURED" : row.assigned_revoked_at ? "AGENT_REVOKED" : row.validator_sha256?.trim() !== expectedHash ? "VALIDATOR_MISMATCH" : null,
    assignment: row.assigned_agent_id ? { agentId: row.assigned_agent_id, specSha256: row.execution_sha256.trim() } : null,
    executionResult: ["succeeded","failed","cancelled"].includes(row.state) ? row.state : null, acceptanceResult: null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null
  };
}

export async function findJob(client, workspaceId, projectId, id, lock = false) {
  const result = await client.query(`SELECT ${jobColumns} FROM jobs j
    JOIN projects p ON p.id = j.project_id AND p.workspace_id = j.workspace_id
    ${executionJoins}
    WHERE j.workspace_id=$1 AND j.project_id=$2 AND j.id=$3 ${lock ? "FOR UPDATE OF j" : ""}`,
  [workspaceId, projectId, id]);
  return result.rows[0] ?? null;
}

export async function insertJob(client, workspaceId, projectId, id, revision, requestSnapshot) {
  await client.query(`INSERT INTO jobs (id,workspace_id,project_id,site_spec_revision_id,input_revision,
    input_schema_version,input_sha256,type,template_version,request_snapshot)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$9,$10,$8::jsonb)`,
  [id, workspaceId, projectId, revision.id, revision.revision, revision.schemaVersion, revision.sha256, JSON.stringify(requestSnapshot), requestSnapshot.type, requestSnapshot.templateVersion]);
}

export async function insertEvent(client, workspaceId, projectId, id, cancelled = false) {
  await client.query(`INSERT INTO job_events (job_id,sequence,event_type,from_state,to_state,payload)
    SELECT id,version,$5,$6,$7,CASE WHEN $5='job_queued' THEN jsonb_build_object('template',template_version) ELSE $8::jsonb END FROM jobs WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND version>=$4`,
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
    ${executionJoins}
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
