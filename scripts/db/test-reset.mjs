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
        design_invocations,
        design_agent_profiles,
        execution_operations,
        job_results,
        job_attempts,
        job_executions,
        agent_execution_grants,
        agent_events,
        agent_pairings,
        agents,
        job_events,
        jobs,
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
    await client.query("DROP FUNCTION IF EXISTS protect_job_source_and_transition() CASCADE");
    await client.query("DROP FUNCTION IF EXISTS check_job_journal() CASCADE");
    await client.query("DROP FUNCTION IF EXISTS protect_agent_connection() CASCADE");
    await client.query("DROP FUNCTION IF EXISTS protect_agent_pairing() CASCADE");
    await client.query("DROP FUNCTION IF EXISTS protect_execution_grant() CASCADE");
    await client.query("DROP FUNCTION IF EXISTS protect_job_attempt() CASCADE");
    await client.query('DROP FUNCTION IF EXISTS check_typed_attempt_policy() CASCADE');
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
