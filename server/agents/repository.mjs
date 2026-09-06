export async function findPairing(client, workspace, hash, lock = false) {
  return (await client.query(`SELECT * FROM agent_pairings WHERE workspace_id=$1 AND secret_sha256=$2 ${lock ? "FOR UPDATE" : ""}`, [workspace,hash])).rows[0];
}
export async function pairingById(client, workspace, id, lock = false) {
  return (await client.query(`SELECT * FROM agent_pairings WHERE workspace_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`, [workspace,id])).rows[0];
}
export async function agentById(client, workspace, id, lock = false) {
  return (await client.query(`SELECT * FROM agents WHERE workspace_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`, [workspace,id])).rows[0];
}
export async function event(client, workspace, type, now, { agentId = null, pairingId = null } = {}) {
  await client.query(`INSERT INTO agent_events(workspace_id,event_type,created_at,agent_id,pairing_id) VALUES($1,$2,$3,$4,$5)`, [workspace,type,now,agentId,pairingId]);
}
export async function agentRows(client, workspace, { limit, cursor }) {
  return (await client.query(`SELECT * FROM agents WHERE workspace_id=$1
    AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text))
    ORDER BY created_at DESC,id DESC LIMIT $4`, [workspace,cursor?.at ?? null,cursor?.id ?? null,limit + 1])).rows;
}
