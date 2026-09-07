import { PersistenceError } from "../persistence/errors.mjs";

export function executionError(code, status = 409) {
  throw new PersistenceError(code, "The bounded validation operation could not be completed.", { status });
}
export async function transition(client, job, state, event, now, payload = {}, actor = "agent") {
  const previous = job.state;
  const result = await client.query(`UPDATE jobs SET state=$4,version=version+1,updated_at=$5,
    cancelled_at=CASE WHEN $4='cancelled' THEN $5::timestamptz ELSE NULL END
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND version=$6 RETURNING *`,
  [job.workspace_id, job.project_id, job.id, state, now, job.version]);
  if (!result.rows.length) executionError("JOB_VERSION_CONFLICT");
  Object.assign(job, result.rows[0]);
  await client.query(`INSERT INTO job_events(job_id,sequence,event_type,from_state,to_state,payload,actor_type,source,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`, [job.id, job.version, event, previous, state, JSON.stringify(payload), actor,
    actor === "agent" ? "local_runner" : actor === "system" ? "lease_sweep" : "local_ui", now]);
}
export async function cancelActiveAgent(client, workspaceId, agentId, now) {
  const rows = await client.query(`SELECT j.* FROM jobs j JOIN job_executions e ON e.job_id=j.id
    WHERE j.workspace_id=$1 AND e.agent_id=$2 AND j.state IN ('claimed','running','validating') ORDER BY j.id FOR UPDATE OF j`, [workspaceId, agentId]);
  for (const job of rows.rows) {
    await client.query("UPDATE job_attempts SET state='cancel_requested' WHERE job_id=$1 AND finished_at IS NULL", [job.id]);
    await transition(client, job, "cancel_requested", "job_cancel_requested", now, { reason: "AGENT_REVOKED" }, "operator");
  }
}
