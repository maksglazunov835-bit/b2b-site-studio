import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { configureDatabase, closeDatabasePool, getDatabasePool } from "../../server/persistence/database.mjs";
import { createProject, saveDraft } from "../../server/persistence/service.mjs";
import { legacyJob } from "../execution/legacy-fixture.mjs";

const config = assertSafeTestDatabaseUrl();
void test("001+002 to 003 preserves every old row, pinned job and migration checksum", async () => {
  await resetTestDatabase();
  const prefix = path.join(os.tmpdir(), "b2b-agent-upgrade-"); const temporary = await mkdtemp(prefix);
  try {
    for (const name of ["001_initial_persistence.sql","002_job_queue.sql"]) await copyFile(`db/migrations/${name}`, path.join(temporary,name));
    await runMigrations({ databaseConfig: config, migrationsDir: temporary });
    configureDatabase(config);
    const project = (await createProject({ displayName: "Agent upgrade fixture", draft: { companyName: "Fixture" } }, "agent-upgrade-project")).response.project;
    const old = await legacyJob(project.id);
    await saveDraft(project.id, { expectedRevision: 1, draft: { companyName: "New fixture" } }, "agent-upgrade-save");
    await legacyJob(project.id, true);
    const snapshot = async () => {
      const data = {};
      for (const table of ["workspaces","projects","site_spec_revisions","site_spec_readiness_checks","project_events","api_idempotency_records","jobs","job_events"]) {
        data[table] = (await getDatabasePool().query(`SELECT to_jsonb(t) FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      data.migrations = (await getDatabasePool().query("SELECT * FROM _schema_migrations WHERE name IN ('001_initial_persistence.sql','002_job_queue.sql') ORDER BY name")).rows;
      return data;
    };
    const before = await snapshot();
    await copyFile("db/migrations/003_agent_connections.sql", path.join(temporary,"003_agent_connections.sql"));
    assert.deepEqual((await runMigrations({ databaseConfig: config, migrationsDir: temporary })).applied, ["003_agent_connections.sql"]);
    assert.deepEqual(await snapshot(), before);
    const oldRow = (await getDatabasePool().query("SELECT input_revision,state FROM jobs WHERE id=$1", [old])).rows[0];
    assert.equal(oldRow.input_revision, 1); assert.equal(oldRow.state, "queued");
    assert.deepEqual((await runMigrations({ databaseConfig: config, migrationsDir: temporary })).applied, []);
  } finally {
    await closeDatabasePool(); assert.ok(temporary.startsWith(prefix)); await rm(temporary, { recursive: true });
  }
});
