import "../local-env.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";
import { assertSafeTestDatabaseUrl, localConnectionConfig } from "../db/test-config.mjs";
import { runMigrations, getMigrationStatus, safeDatabaseCommandError } from "../db/migration-lib.mjs";

const modes = new Set(["full", "service", "http", "ui", "migrate", "status"]);

async function devFingerprint() {
  if (!process.env.DATABASE_URL) return null;
  const client = new pg.Client(localConnectionConfig(process.env.DATABASE_URL));
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const hash = createHash("sha256");
    // Fixed identifiers only. No test command writes to the dev connection.
    for (const table of ["workspaces", "projects", "site_spec_revisions", "site_spec_readiness_checks", "project_events", "api_idempotency_records", "_schema_migrations"]) {
      const exists = await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
      if (exists.rows[0].name) {
        const rows = await client.query(`SELECT to_jsonb(t)::text AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`);
        hash.update(table + JSON.stringify(rows.rows));
      }
    }
    await client.query("COMMIT");
    return hash.digest("hex");
  } finally { await client.end(); }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error("Validation child failed.")));
  });
}

async function main() {
  // This is deliberately before migration, test imports, dev reads, or cleanup.
  const config = assertSafeTestDatabaseUrl();
  const mode = process.argv[2];
  if (!modes.has(mode)) throw new Error("Unknown test command.");
  const before = await devFingerprint();
  let failure;
  try {
    if (["full", "migrate"].includes(mode)) {
      const result = await runMigrations({ databaseConfig: config });
      console.log("TEST_MIGRATIONS", JSON.stringify(result));
    }
    if (["full", "status"].includes(mode)) {
      const status = await getMigrationStatus({ databaseConfig: config });
      if (status.some((item) => item.state !== "applied")) throw new Error("Test migrations are not current.");
      console.log("TEST_MIGRATION_STATUS applied", status.length);
    }
    if (["full", "service"].includes(mode)) await run(["--test", "--test-concurrency=1", "tests/persistence/config.test.mjs", "tests/persistence/migrations.test.mjs", "tests/persistence/service.test.mjs"]);
    if (mode === "full") {
      if (!process.env.npm_execpath) throw new Error("Run ci:full through npm.");
      await run([process.env.npm_execpath, "run", "ci"]);
    }
    if (["full", "http"].includes(mode)) await run(["scripts/persistence/http-smoke.mjs"]);
    if (["full", "ui"].includes(mode)) await run(["tests/persistence/ui.test.mjs"]);
  } catch (error) { failure = error; }
  const after = await devFingerprint();
  if (before !== after) throw new Error("DEV_DATABASE_CHANGED: dev data changed during tests.");
  console.log(before ? `DEV_DATABASE_UNCHANGED ${before}` : "DEV_DATABASE_NOT_CONFIGURED (no dev connection)");
  if (failure) throw failure;
}

main().catch((error) => {
  console.error(error instanceof Error && !error.code ? error.message : safeDatabaseCommandError(error));
  process.exitCode = 1;
});
