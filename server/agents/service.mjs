import { randomUUID } from "node:crypto";
import { getDatabasePool, withTransaction } from "../persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID, acquireIdempotencyLock } from "../persistence/repository.mjs";
import { assertProjectId, assertIdempotencyKey } from "../persistence/service.mjs";
import { sha256Json } from "../persistence/canonical-json.mjs";
import { agentError, emptyRequest, registerRequest, healthRequest, validSecret, secretHash, newSecret, hashMatches, assertAgentId, agentPage } from "./requests.mjs";
import { findPairing, pairingById, agentById, event, agentRows } from "./repository.mjs";

const profile = { mode: "presence_only", selectedApiVersion: "v1", executionEnabled: false, freeSlots: 0, currentJobId: null, grantedCapabilities: [] };
const id = (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`;
function registrationResponse(agent) {
  return { ...profile, agentId: agent.id, status: "registered", heartbeatIntervalSeconds: agent.heartbeat_interval_seconds };
}
export function agentView(agent, now) {
  return { ...registrationResponse(agent), agentName: agent.agent_name, agentVersion: agent.agent_version, os: agent.os,
    status: agent.revoked_at ? "revoked" : agent.last_seen_at && now >= agent.last_seen_at && now - agent.last_seen_at < agent.heartbeat_interval_seconds * 3000 ? "online" : "offline",
    createdAt: agent.created_at.toISOString(), lastSeenAt: agent.last_seen_at?.toISOString() ?? null,
    revokedAt: agent.revoked_at?.toISOString() ?? null };
}
function pairingView(pairing, now) {
  if (!pairing) agentError("PAIRING_NOT_FOUND", 404);
  return { pairingId: pairing.id, expiresAt: pairing.expires_at.toISOString(), agentId: pairing.agent_id,
    status: pairing.revoked_at ? "revoked" : pairing.consumed_at ? "consumed" : now >= pairing.expires_at ? "expired" : "pending" };
}

// Clock/interval injection is for service tests, never accepted from request data.
export function createAgentService({ workspaceId = DEFAULT_WORKSPACE_ID, clock = () => new Date(), intervalSeconds } = {}) {
  assertProjectId(workspaceId);
  function interval() {
    const value = intervalSeconds ?? Number(process.env.AGENT_HEARTBEAT_INTERVAL_SECONDS ?? 20);
    if (!Number.isInteger(value) || value < 1 || value > 30) agentError("INVALID_PRESENCE_CONFIG", 503);
    return value;
  }
  return {
    async pair(input) {
      emptyRequest(input);
      return withTransaction(async (client) => {
        await acquireIdempotencyLock(client, workspaceId, "agent_pairing_issue", "workspace");
        const now = clock();
        const count = (await client.query(`SELECT count(*)::int AS count FROM agent_pairings
          WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2`, [workspaceId,now])).rows[0].count;
        if (count >= 10) agentError("PAIRING_LIMIT_REACHED", 429);
        const secret = newSecret("pair");
        const pairingId = id("pairing");
        const result = await client.query(`INSERT INTO agent_pairings(id,workspace_id,secret_sha256,created_at,expires_at)
          VALUES($1,$2,$3,$4,$4::timestamptz + interval '5 minutes') RETURNING *`, [pairingId,workspaceId,secretHash(secret),now]);
        await event(client, workspaceId, "paired", now, { pairingId });
        // Deliberately not recorded in api_idempotency_records or an event payload.
        return { ...pairingView(result.rows[0], now), pairingSecret: secret };
      });
    },
    async pairing(pairingId) {
      assertAgentId(pairingId, "pairing");
      return pairingView(await pairingById(getDatabasePool(), workspaceId, pairingId), clock());
    },
    async cancelPairing(pairingId, input) {
      assertAgentId(pairingId, "pairing"); emptyRequest(input);
      return withTransaction(async (client) => {
        const pairing = await pairingById(client, workspaceId, pairingId, true);
        if (!pairing) agentError("PAIRING_NOT_FOUND", 404);
        if (pairing.consumed_at) agentError("PAIRING_CONSUMED", 409);
        if (!pairing.revoked_at) {
          const now = clock();
          await client.query("UPDATE agent_pairings SET revoked_at=$3 WHERE workspace_id=$1 AND id=$2", [workspaceId,pairingId,now]);
          await event(client, workspaceId, "pairing_revoked", now, { pairingId });
        }
        return { status: "revoked", pairingId };
      });
    },
    async register(secret, input, key) {
      if (!validSecret(secret, "pair")) agentError("UNAUTHORIZED_AGENT", 401);
      const request = registerRequest(input);
      key = assertIdempotencyKey(key);
      const credentialHash = secretHash(request.agentSecret);
      const requestHash = sha256Json({ ...request, agentSecret: credentialHash });
      return withTransaction(async (client) => {
        // All registration attempts serialize on their single-use pairing, then the agent.
        const pairing = await findPairing(client, workspaceId, secretHash(secret), true);
        if (!pairing) agentError("UNAUTHORIZED_AGENT", 401);
        const now = clock();
        if (pairing.revoked_at) agentError("PAIRING_REVOKED", 401);
        if (now >= pairing.expires_at) agentError("PAIRING_EXPIRED", 401);
        if (pairing.consumed_at) {
          if (pairing.registration_sha256.trim() !== requestHash || !hashMatches(key, pairing.registration_key_sha256)) agentError("PAIRING_CONSUMED", 409);
          const agent = await agentById(client, workspaceId, pairing.agent_id, true);
          if (!agent || agent.revoked_at) agentError("AGENT_REVOKED", 401);
          if (clock() >= pairing.expires_at) agentError("PAIRING_EXPIRED", 401);
          return { response: registrationResponse(agent), responseStatus: 201, replayed: true };
        }
        const agentId = id("agent");
        const result = await client.query(`INSERT INTO agents(id,workspace_id,agent_name,agent_version,os,api_version,credential_sha256,heartbeat_interval_seconds,created_at)
          VALUES($1,$2,$3,$4,$5,'v1',$6,$7,$8) ON CONFLICT (credential_sha256) DO NOTHING RETURNING *`, [agentId,workspaceId,request.agentName,request.agentVersion,request.os,credentialHash,interval(),now]);
        if (!result.rows.length) agentError("UNAUTHORIZED_AGENT", 401);
        await client.query(`UPDATE agent_pairings SET consumed_at=$3,agent_id=$4,registration_key_sha256=$5,registration_sha256=$6
          WHERE workspace_id=$1 AND id=$2`, [workspaceId,pairing.id,now,agentId,secretHash(key),requestHash]);
        await event(client, workspaceId, "registered", now, { agentId, pairingId: pairing.id });
        return { response: registrationResponse(result.rows[0]), responseStatus: 201, replayed: false };
      });
    },
    async health(agentId, secret, input) {
      assertAgentId(agentId);
      if (!validSecret(secret, "agt")) agentError("UNAUTHORIZED_AGENT", 401);
      healthRequest(input);
      return withTransaction(async (client) => {
        const agent = await agentById(client, workspaceId, agentId, true);
        if (!agent || !hashMatches(secret, agent.credential_sha256)) agentError("UNAUTHORIZED_AGENT", 401);
        if (agent.revoked_at) agentError("AGENT_REVOKED", 401);
        const now = clock();
        await client.query("UPDATE agents SET last_seen_at=GREATEST(last_seen_at,$3::timestamptz) WHERE workspace_id=$1 AND id=$2", [workspaceId,agentId,now]);
        return { ...profile, agentId, accepted: true, serverTime: now.toISOString(), heartbeatIntervalSeconds: agent.heartbeat_interval_seconds };
      });
    },
    async revoke(agentId, input) {
      assertAgentId(agentId); emptyRequest(input);
      return withTransaction(async (client) => {
        const agent = await agentById(client, workspaceId, agentId, true);
        if (!agent) agentError("AGENT_NOT_FOUND", 404);
        const now = clock();
        if (!agent.revoked_at) {
          await client.query("UPDATE agents SET status='revoked',revoked_at=$3 WHERE workspace_id=$1 AND id=$2", [workspaceId,agentId,now]);
          await event(client, workspaceId, "agent_revoked", now, { agentId });
        }
        return { agent: agentView(await agentById(client, workspaceId, agentId), now), noOp: !!agent.revoked_at };
      });
    },
    async get(agentId) {
      assertAgentId(agentId);
      const agent = await agentById(getDatabasePool(), workspaceId, agentId);
      if (!agent) agentError("AGENT_NOT_FOUND", 404);
      return { agent: agentView(agent, clock()) };
    },
    async list(params) {
      const page = agentPage(params, workspaceId);
      const rows = await agentRows(getDatabasePool(), workspaceId, page);
      const shown = rows.slice(0, page.limit); const last = shown.at(-1); const now = clock();
      return { agents: shown.map((row) => agentView(row, now)), serverTime: now.toISOString(),
        nextCursor: rows.length > page.limit ? Buffer.from(JSON.stringify({ v: 1, workspaceId, id: last.id, at: last.created_at.toISOString() })).toString("base64url") : null };
    }
  };
}
export const agents = createAgentService();
