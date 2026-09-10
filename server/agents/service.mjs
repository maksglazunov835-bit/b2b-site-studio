import { randomUUID } from "node:crypto";
import pg from 'pg';
import { getDatabasePool, withTransaction } from "../persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID, acquireIdempotencyLock } from "../persistence/repository.mjs";
import { assertProjectId, assertIdempotencyKey } from "../persistence/service.mjs";
import { sha256Json } from "../persistence/canonical-json.mjs";
import { agentError, emptyRequest, registerRequest, healthRequest, validSecret, secretHash, newSecret, hashMatches, assertAgentId, agentPage } from "./requests.mjs";
import { findPairing, pairingById, agentById, event, agentRows } from "./repository.mjs";
import { pairingPermission, createGrant, pairingGrant, agentGrant, grantProfile } from "../execution/grants.mjs";
import { VALIDATOR, compatible } from "../execution/contract.mjs";
import { cancelActiveAgent } from "../execution/transitions.mjs";
import { ADAPTER, adapterCompatible } from '../design/contract.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';

const profile = { mode: "presence_only", selectedApiVersion: "v1", executionEnabled: false, freeSlots: 0, currentJobId: null, grantedCapabilities: [] };
const id = (kind) => `${kind}_${randomUUID().replaceAll("-", "")}`;
async function registrationResponse(agent, client = getDatabasePool()) {
  const grant = await agentGrant(client, agent.workspace_id, agent.id);
  return { ...profile, ...(grant ? grantProfile(grant, !!agent.revoked_at) : {}), agentId: agent.id, status: "registered", heartbeatIntervalSeconds: agent.heartbeat_interval_seconds };
}
export async function agentView(agent, now, client = getDatabasePool()) {
  return { ...await registrationResponse(agent, client), agentName: agent.agent_name, agentVersion: agent.agent_version, os: agent.os,
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
      const permission = pairingPermission(input);
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
        if (permission) await createGrant(client, workspaceId, pairingId, permission.projectId, now, permission.mode);
        // Deliberately not recorded in api_idempotency_records or an event payload.
        return { ...pairingView(result.rows[0], now), pairingSecret: secret,
          ...(permission ? { mode: permission.mode, projectId: permission.projectId, ...(permission.mode === 'codex_design' ? { adapter: ADAPTER } : { validator: VALIDATOR }) } : {}) };
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
      const request = registerRequest(input, {now:clock().getTime()});
      if (request.runtime?.provider === 'test_stub') {
        const config = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL, { devDatabaseUrl: null });
        const actual = new pg.Client(getDatabasePool().options).connectionParameters;
        if (['host','port','database'].some((field) => actual[field] !== config[field])) agentError('TEST_PROVIDER_DISABLED', 403);
      }
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
        const grant = await pairingGrant(client, workspaceId, pairing.id);
        if (!!grant !== (request.mode !== 'presence_only') || (grant && grant.mode !== request.mode)) agentError("EXECUTION_SCOPE_MISMATCH", 403);
        if (grant && (grant.project_status !== 'active' || (grant.mode === 'codex_design'
          ? !adapterCompatible(request.adapter) || grant.validator_sha256.trim() !== ADAPTER.sha256
          : !compatible(request.validator) || grant.validator_sha256.trim() !== VALIDATOR.sha256))) agentError("VALIDATOR_MISMATCH", 409);
        if (pairing.consumed_at) {
          if (pairing.registration_sha256.trim() !== requestHash || !hashMatches(key, pairing.registration_key_sha256)) agentError("PAIRING_CONSUMED", 409);
          const agent = await agentById(client, workspaceId, pairing.agent_id, true);
          if (!agent || agent.revoked_at) agentError("AGENT_REVOKED", 401);
          if (clock() >= pairing.expires_at) agentError("PAIRING_EXPIRED", 401);
          return { response: await registrationResponse(agent, client), responseStatus: 201, replayed: true };
        }
        const agentId = id("agent");
        const result = await client.query(`INSERT INTO agents(id,workspace_id,agent_name,agent_version,os,api_version,credential_sha256,heartbeat_interval_seconds,created_at)
          VALUES($1,$2,$3,$4,$5,'v1',$6,$7,$8) ON CONFLICT (credential_sha256) DO NOTHING RETURNING *`, [agentId,workspaceId,request.agentName,request.agentVersion,request.os,credentialHash,interval(),now]);
        if (!result.rows.length) agentError("UNAUTHORIZED_AGENT", 401);
        await client.query(`UPDATE agent_pairings SET consumed_at=$3,agent_id=$4,registration_key_sha256=$5,registration_sha256=$6
          WHERE workspace_id=$1 AND id=$2`, [workspaceId,pairing.id,now,agentId,secretHash(key),requestHash]);
        await event(client, workspaceId, "registered", now, { agentId, pairingId: pairing.id });
        if (grant) await client.query("UPDATE agent_execution_grants SET agent_id=$3 WHERE workspace_id=$1 AND pairing_id=$2", [workspaceId, pairing.id, agentId]);
        if (grant?.mode === 'codex_design') await client.query('INSERT INTO design_agent_profiles(pairing_id,runtime) VALUES($1,$2::jsonb)', [pairing.id, JSON.stringify(request.runtime)]);
        return { response: await registrationResponse(result.rows[0], client), responseStatus: 201, replayed: false };
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
        const grant = await agentGrant(client, workspaceId, agentId);
        return { ...profile, ...(grant ? grantProfile(grant) : {}), agentId, accepted: true, serverTime: now.toISOString(), heartbeatIntervalSeconds: agent.heartbeat_interval_seconds };
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
          await cancelActiveAgent(client, workspaceId, agentId, now);
        }
        return { agent: await agentView(await agentById(client, workspaceId, agentId), now, client), noOp: !!agent.revoked_at };
      });
    },
    async get(agentId) {
      assertAgentId(agentId);
      const agent = await agentById(getDatabasePool(), workspaceId, agentId);
      if (!agent) agentError("AGENT_NOT_FOUND", 404);
      return { agent: await agentView(agent, clock()) };
    },
    async list(params) {
      const page = agentPage(params, workspaceId);
      const rows = await agentRows(getDatabasePool(), workspaceId, page);
      const shown = rows.slice(0, page.limit); const last = shown.at(-1); const now = clock();
      return { agents: await Promise.all(shown.map((row) => agentView(row, now))), serverTime: now.toISOString(),
        nextCursor: rows.length > page.limit ? Buffer.from(JSON.stringify({ v: 1, workspaceId, id: last.id, at: last.created_at.toISOString() })).toString("base64url") : null };
    }
  };
}
export const agents = createAgentService();
