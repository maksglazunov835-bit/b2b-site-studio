import assert from "node:assert/strict";

import { closeDatabasePool, configureDatabase } from "../../server/persistence/database.mjs";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";

export function requireTestDatabaseUrl() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL must be set for persistence tests");
  assertSafeTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

export async function prepareTestDatabase() {
  const databaseUrl = requireTestDatabaseUrl();
  await closeDatabasePool();
  await resetTestDatabase({ databaseUrl });
  const databaseConfig = assertSafeTestDatabaseUrl(databaseUrl);
  await runMigrations({ databaseConfig });
  configureDatabase(databaseConfig);
  return databaseUrl;
}

export function editableDraft(overrides = {}) {
  return {
    companyName: "Persistence Test Project",
    niche: "Test fixture niche",
    salesRegion: "Test fixture region",
    businessType: "wholesale",
    siteType: "catalog",
    networkType: "single",
    ...overrides
  };
}
