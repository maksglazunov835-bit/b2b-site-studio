import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { configureDatabase, closeDatabasePool, getDatabasePool } from "../../server/persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID } from "../../server/persistence/repository.mjs";
import { createProject, saveDraft } from "../../server/persistence/service.mjs";
import { agents } from "../../server/agents/service.mjs";
import { jobs } from "../../server/jobs/service.mjs";
import { execution } from "../../server/execution/service.mjs";
import { newSecret, secretHash } from "../../server/agents/requests.mjs";
import { legacyJob } from "./legacy-fixture.mjs";

const config = assertSafeTestDatabaseUrl();
void test("001-003 upgrade preserves every historical row/checksum and presence-only authority", async () => {
  await closeDatabasePool(); await resetTestDatabase();
  const prefix = path.join(os.tmpdir(), "b2b-execution-upgrade-"); const temporary = await mkdtemp(prefix);
  const names = ["001_initial_persistence.sql","002_job_queue.sql","003_agent_connections.sql"];
  try {
    for (const name of names) await copyFile(`db/migrations/${name}`, path.join(temporary,name));
    await runMigrations({ databaseConfig: config, migrationsDir: temporary }); configureDatabase(config);
    const pool = getDatabasePool();
    const project = (await createProject({ displayName: "Historical project", draft: {} }, randomUUID())).response.project;
    const queued = await legacyJob(project.id);
    await saveDraft(project.id, { expectedRevision: 1, draft: { niche: "Historical revision two" } }, randomUUID());
    const cancelled = await legacyJob(project.id, true);
    const agentId = `agent_${randomUUID().replaceAll("-", "")}`; const pairingId = `pairing_${randomUUID().replaceAll("-", "")}`;
    const credential = newSecret("agt"); const pairingSecret = newSecret("pair"); const now = new Date();
    await pool.query(`INSERT INTO agents(id,workspace_id,agent_name,agent_version,os,api_version,credential_sha256,heartbeat_interval_seconds,created_at)
      VALUES($1,$2,'Historical presence','0.3.0','linux','v1',$3,20,$4)`, [agentId,DEFAULT_WORKSPACE_ID,secretHash(credential),now]);
    await pool.query(`INSERT INTO agent_pairings(id,workspace_id,secret_sha256,created_at,expires_at,consumed_at,agent_id,registration_key_sha256,registration_sha256)
      VALUES($1,$2,$3,$4,$4::timestamptz+interval '5 minutes',$4,$5,$6,$6)`, [pairingId,DEFAULT_WORKSPACE_ID,secretHash(pairingSecret),now,agentId,secretHash("historical fingerprint")]);
    await pool.query(`INSERT INTO agent_events(workspace_id,agent_id,pairing_id,event_type,created_at) VALUES
      ($1,NULL,$2,'paired',$4),($1,$3,$2,'registered',$4)`, [DEFAULT_WORKSPACE_ID,pairingId,agentId,now]);
    const snapshot = async () => {
      const data = {};
      for (const table of ["workspaces","projects","site_spec_revisions","site_spec_readiness_checks","project_events","api_idempotency_records","jobs","job_events","agents","agent_pairings","agent_events"]) data[table] = (await pool.query(`SELECT to_jsonb(t) FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      data.migrations = (await pool.query("SELECT * FROM _schema_migrations WHERE name=ANY($1::text[]) ORDER BY name", [names])).rows;
      return data;
    };
    const before = await snapshot();
    assert.deepEqual((await runMigrations({ databaseConfig: config })).applied, ["004_validation_execution.sql", "005_design_proposals.sql", "006_astra_preflight_failures.sql"]);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await runMigrations({ databaseConfig: config })).applied, []);
    assert.equal((await jobs.get(project.id,queued)).job.siteSpec.revision, 1);
    assert.equal((await jobs.get(project.id,queued)).job.dispatchable, false);
    assert.equal((await jobs.get(project.id,cancelled)).job.state, "cancelled");
    const health = await agents.health(agentId, credential, { selectedApiVersion: "v1" });
    assert.equal(health.mode, "presence_only"); assert.equal(health.executionEnabled, false); assert.equal(health.freeSlots, 0);
    await assert.rejects(execution.claim(agentId, credential, {}, randomUUID()), { code: "EXECUTION_NOT_GRANTED" });
  } finally {
    await closeDatabasePool(); assert.ok(temporary.startsWith(prefix)); await rm(temporary, { recursive: true });
  }
});
