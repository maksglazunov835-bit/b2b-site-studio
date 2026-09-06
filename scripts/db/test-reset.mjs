import { pathToFileURL } from "node:url";

import pg from "pg";

import { safeDatabaseCommandError } from "./migration-lib.mjs";
import { assertSafeTestDatabaseUrl } from "./test-config.mjs";
export { assertSafeTestDatabaseUrl } from "./test-config.mjs";

const { Client } = pg;
export async function resetTestDatabase({ databaseUrl = process.env.TEST_DATABASE_URL } = {}) {
  const config = assertSafeTestDatabaseUrl(databaseUrl);
  const client = new Client({
    ...config,
    application_name: "b2b-site-studio-test-reset"
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      DROP TABLE IF EXISTS
        api_idempotency_records,
        project_events,
        site_spec_readiness_checks,
        site_spec_revisions,
        projects,
        workspaces,
        _schema_migrations
      CASCADE
    `);
    await client.query("DROP FUNCTION IF EXISTS reject_immutable_row_mutation() CASCADE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function main() {
  await resetTestDatabase();
  console.log("Local test database reset complete.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(safeDatabaseCommandError(error));
    process.exitCode = 1;
  });
}
