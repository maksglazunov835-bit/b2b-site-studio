import assert from "node:assert/strict";

import { closeDatabasePool } from "../../server/persistence/database.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";

export function requireTestDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL must be set for persistence tests");
  return databaseUrl;
}

export async function prepareTestDatabase() {
  const databaseUrl = requireTestDatabaseUrl();
  await closeDatabasePool();
  await resetTestDatabase({ databaseUrl });
  await runMigrations({ databaseUrl });
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
