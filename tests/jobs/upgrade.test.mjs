import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { configureDatabase, closeDatabasePool, getDatabasePool } from "../../server/persistence/database.mjs";
import { createProject, saveDraft, getProject, getSiteSpecRevision } from "../../server/persistence/service.mjs";
import { editableDraft } from "../persistence/helpers.mjs";

const config = assertSafeTestDatabaseUrl();

void test("001 to 002 upgrade preserves every old table, snapshot and checksum on test DB", async () => {
  await resetTestDatabase();
  const prefix = path.join(os.tmpdir(), "b2b-jobs-upgrade-");
  const temporary = await mkdtemp(prefix);
  try {
    await copyFile("db/migrations/001_initial_persistence.sql", path.join(temporary, "001_initial_persistence.sql"));
    await runMigrations({ databaseConfig: config, migrationsDir: temporary });
    configureDatabase(config);
    const created = await createProject({ displayName: "Upgrade fixture", draft: editableDraft() }, "upgrade-fixture");
    const id = created.response.project.id;
    await saveDraft(id, { expectedRevision: 1, draft: editableDraft({ niche: "Existing revision two" }) }, "upgrade-rev-two");
    const before = await getProject(id);
    const old = await getSiteSpecRevision(id, 1);
    const snapshot = async () => {
      const result = {};
      for (const table of ["projects", "workspaces", "site_spec_revisions", "site_spec_readiness_checks", "project_events", "api_idempotency_records"]) {
        result[table] = (await getDatabasePool().query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return result;
    };
    const rows = await snapshot();
    const checksum = (await getDatabasePool().query("SELECT checksum FROM _schema_migrations WHERE name='001_initial_persistence.sql'")).rows;
    await copyFile("db/migrations/002_job_queue.sql", path.join(temporary, "002_job_queue.sql"));
    const upgraded = await runMigrations({ databaseConfig: config, migrationsDir: temporary });
    assert.deepEqual(upgraded.applied, ["002_job_queue.sql"]);
    assert.deepEqual(await snapshot(), rows);
    assert.deepEqual(await getProject(id), before);
    assert.deepEqual(await getSiteSpecRevision(id, 1), old);
    assert.deepEqual((await getDatabasePool().query("SELECT checksum FROM _schema_migrations WHERE name='001_initial_persistence.sql'")).rows, checksum);
    assert.deepEqual((await runMigrations({ databaseConfig: config, migrationsDir: temporary })).applied, []);
  } finally {
    await closeDatabasePool();
    assert.ok(temporary.startsWith(prefix));
    await rm(temporary, { recursive: true });
  }
});
