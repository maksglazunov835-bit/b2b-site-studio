import { pathToFileURL } from "node:url";

import pg from "pg";

import { MigrationError, requireDatabaseUrl, safeDatabaseCommandError } from "./migration-lib.mjs";

const { Client } = pg;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertSafeTestDatabaseUrl(databaseUrl = process.env.DATABASE_URL) {
  const value = requireDatabaseUrl(databaseUrl);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new MigrationError("TEST_DATABASE_URL_INVALID", "DATABASE_URL is not a valid PostgreSQL URL.");
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const isLocal = LOCAL_HOSTS.has(parsed.hostname);
  const isExplicitTestDatabase = /(^|[_-])test(?:ing)?([_-]|$)/i.test(databaseName);
  if (!isLocal || !isExplicitTestDatabase) {
    throw new MigrationError(
      "TEST_DATABASE_RESET_REFUSED",
      "Refusing to reset a database that is not an explicitly named local test database."
    );
  }
  return value;
}

export async function resetTestDatabase({ databaseUrl = process.env.DATABASE_URL } = {}) {
  const safeUrl = assertSafeTestDatabaseUrl(databaseUrl);
  const client = new Client({
    connectionString: safeUrl,
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
