import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import {
  DEFAULT_MIGRATIONS_DIR,
  getMigrationStatus,
  runMigrations
} from "../../scripts/db/migration-lib.mjs";
import { assertSafeTestDatabaseUrl, resetTestDatabase } from "../../scripts/db/test-reset.mjs";
import { requireTestDatabaseUrl } from "./helpers.mjs";

const { Client } = pg;

void test("clean migrations apply once and detect a changed checksum", async () => {
  const databaseUrl = requireTestDatabaseUrl();
  await resetTestDatabase({ databaseUrl });

  const first = await runMigrations({ databaseUrl });
  assert.deepEqual(first.applied, ["001_initial_persistence.sql"]);
  assert.deepEqual(first.skipped, []);

  const second = await runMigrations({ databaseUrl });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, ["001_initial_persistence.sql"]);

  const status = await getMigrationStatus({ databaseUrl });
  assert.deepEqual(status.map((item) => item.state), ["applied"]);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [[
        "api_idempotency_records",
        "project_events",
        "projects",
        "site_spec_readiness_checks",
        "site_spec_revisions",
        "workspaces"
      ]]
    );
    assert.equal(result.rowCount, 6);
  } finally {
    await client.end();
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "b2b-site-studio-migrations-"));
  try {
    const migration = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, "001_initial_persistence.sql"), "utf8");
    await writeFile(
      path.join(temporaryDirectory, "001_initial_persistence.sql"),
      `${migration}\n-- checksum mismatch fixture\n`,
      "utf8"
    );
    await assert.rejects(
      runMigrations({ databaseUrl, migrationsDir: temporaryDirectory }),
      (error) => error?.code === "MIGRATION_CHECKSUM_MISMATCH"
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

void test("test reset rejects non-test and non-local database URLs", () => {
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://user:secret@db.example.com/production"),
    (error) => error?.code === "TEST_DATABASE_RESET_REFUSED"
  );
  assert.throws(
    () => assertSafeTestDatabaseUrl("postgresql://user:secret@127.0.0.1/b2b_site_studio"),
    (error) => error?.code === "TEST_DATABASE_RESET_REFUSED"
  );
});
