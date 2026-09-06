import "../../scripts/local-env.mjs";
import assert from "node:assert/strict";
import { assertSafeTestDatabaseUrl, localConnectionConfig } from "../../scripts/db/test-config.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { configureDatabase, closeDatabasePool } from "../../server/persistence/database.mjs";
import { createProject } from "../../server/persistence/service.mjs";

// Explicit fixture setup, never part of the test gate and never a reset.
assertSafeTestDatabaseUrl();
const config = localConnectionConfig(process.env.DATABASE_URL);
assert.ok(config.database.endsWith("_dev_fixture"), "Sentinel setup requires a disposable dev fixture database.");
await runMigrations({ databaseConfig: config });
configureDatabase(config);
try {
  const result = await createProject({ displayName: "Dev sentinel - must survive", draft: {
    companyName: "Dev sentinel - must survive", niche: "Preserved before and after the full suite"
  } }, "dev-sentinel-setup");
  console.log(`DEV_SENTINEL_READY ${result.response.project.id} revision ${result.response.siteSpec.revision}`);
} finally { await closeDatabasePool(); }
