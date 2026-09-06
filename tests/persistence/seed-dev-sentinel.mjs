import "../../scripts/local-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertSafeTestDatabaseUrl, localConnectionConfig } from "../../scripts/db/test-config.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { configureDatabase, closeDatabasePool } from "../../server/persistence/database.mjs";
import { createProject } from "../../server/persistence/service.mjs";

// Explicit fixture setup, never part of the test gate and never a reset.
assertSafeTestDatabaseUrl();
const config = localConnectionConfig(process.env.DATABASE_URL);
assert.ok(config.database.endsWith("_dev_fixture"), "Sentinel setup requires a disposable dev fixture database.");
// Keep the disposable CI dev fixture on 001. The test gate must not upgrade it.
const prefix = path.join(os.tmpdir(), "b2b-dev-sentinel-");
const temporary = await mkdtemp(prefix);
try {
  await copyFile("db/migrations/001_initial_persistence.sql", path.join(temporary, "001_initial_persistence.sql"));
  await runMigrations({ databaseConfig: config, migrationsDir: temporary });
} finally {
  assert.ok(temporary.startsWith(prefix));
  await rm(temporary, { recursive: true });
}
configureDatabase(config);
try {
  const result = await createProject({ displayName: "Dev sentinel - must survive", draft: {
    companyName: "Dev sentinel - must survive", niche: "Preserved before and after the full suite"
  } }, "dev-sentinel-setup");
  console.log(`DEV_SENTINEL_READY ${result.response.project.id} revision ${result.response.siteSpec.revision}`);
} finally { await closeDatabasePool(); }
