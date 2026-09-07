import Ajv from "ajv";
import { VALIDATOR } from "./contract.mjs";
import { executionError } from "./transitions.mjs";

const validate = new Ajv({ strict: true }).compile({ type: "object", additionalProperties: false,
  required: ["mode", "projectId"], properties: { mode: { const: "data_validation" },
    projectId: { type: "string", pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" } } });
export function pairingPermission(input) {
  if (input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0) return null;
  if (!validate(input)) executionError("VALIDATION_FAILED", 422);
  return input;
}
export async function createGrant(client, workspaceId, pairingId, projectId, now) {
  const project = (await client.query("SELECT status FROM projects WHERE workspace_id=$1 AND id=$2 FOR SHARE", [workspaceId, projectId])).rows[0];
  if (!project || project.status !== "active") executionError("PROJECT_NOT_AVAILABLE");
  await client.query(`INSERT INTO agent_execution_grants(pairing_id,workspace_id,project_id,validator_sha256,created_at)
    VALUES($1,$2,$3,$4,$5)`, [pairingId, workspaceId, projectId, VALIDATOR.sha256, now]);
}
export async function pairingGrant(client, workspaceId, pairingId) {
  return (await client.query(`SELECT g.*,p.status AS project_status FROM agent_execution_grants g
    JOIN projects p ON p.id=g.project_id AND p.workspace_id=g.workspace_id WHERE g.workspace_id=$1 AND g.pairing_id=$2`, [workspaceId, pairingId])).rows[0] ?? null;
}
export async function agentGrant(client, workspaceId, agentId) {
  return (await client.query(`SELECT g.*,p.status AS project_status,
    (SELECT a.job_id FROM job_attempts a WHERE a.agent_id=g.agent_id AND a.finished_at IS NULL LIMIT 1) AS current_job_id
    FROM agent_execution_grants g JOIN projects p ON p.id=g.project_id AND p.workspace_id=g.workspace_id
    WHERE g.workspace_id=$1 AND g.agent_id=$2`, [workspaceId, agentId])).rows[0] ?? null;
}
export function grantProfile(grant, revoked = false) {
  const enabled = !revoked && grant.project_status === "active" && grant.validator_sha256.trim() === VALIDATOR.sha256;
  return { mode: "data_validation", projectId: grant.project_id, validator: { ...VALIDATOR, sha256: grant.validator_sha256.trim() },
    executionEnabled: enabled, freeSlots: enabled && !grant.current_job_id ? 1 : 0,
    currentJobId: grant.current_job_id ?? null, grantedCapabilities: enabled ? ["validate_site_spec"] : [] };
}
