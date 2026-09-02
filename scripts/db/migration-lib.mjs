import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(SCRIPT_DIR, "../../db/migrations");
const MIGRATION_FILE_PATTERN = /^(\d{3,})_[a-z0-9][a-z0-9_-]*\.sql$/;
const MIGRATION_LOCK_ID = "726274789327015321";

export class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MigrationError";
    this.code = code;
    this.details = details;
  }
}

export function requireDatabaseUrl(databaseUrl = process.env.DATABASE_URL) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new MigrationError("DATABASE_UNAVAILABLE", "DATABASE_URL is required for database commands.");
  }
  return databaseUrl.trim();
}

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function discoverMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const names = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const seenVersions = new Set();
  const migrations = [];

  for (const name of names) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    if (!match) {
      throw new MigrationError("MIGRATION_NAME_INVALID", `Invalid migration filename: ${name}`);
    }
    if (seenVersions.has(match[1])) {
      throw new MigrationError("MIGRATION_VERSION_DUPLICATE", `Duplicate migration version: ${match[1]}`);
    }
    seenVersions.add(match[1]);
    const sql = await fs.readFile(path.join(migrationsDir, name), "utf8");
    migrations.push({ name, checksum: migrationChecksum(sql), sql });
  }

  if (migrations.length === 0) {
    throw new MigrationError("MIGRATIONS_EMPTY", "No SQL migrations were found.");
  }

  return migrations;
}

async function connect(databaseUrl) {
  const client = new Client({
    connectionString: requireDatabaseUrl(databaseUrl),
    application_name: "b2b-site-studio-migrations"
  });
  await client.connect();
  return client;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT schema_migrations_checksum_format CHECK (checksum ~ '^[0-9a-f]{64}$')
    )
  `);
}

export async function runMigrations({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
} = {}) {
  const migrations = await discoverMigrations(migrationsDir);
  const client = await connect(databaseUrl);
  let lockHeld = false;
  const applied = [];
  const skipped = [];

  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    lockHeld = true;
    await ensureMigrationTable(client);

    const existingResult = await client.query("SELECT name, checksum FROM _schema_migrations ORDER BY name");
    const existing = new Map(existingResult.rows.map((row) => [row.name, row.checksum.trim()]));

    for (const migration of migrations) {
      const appliedChecksum = existing.get(migration.name);
      if (appliedChecksum) {
        if (appliedChecksum !== migration.checksum) {
          throw new MigrationError(
            "MIGRATION_CHECKSUM_MISMATCH",
            `Migration checksum mismatch: ${migration.name}`,
            { migration: migration.name }
          );
        }
        skipped.push(migration.name);
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO _schema_migrations (name, checksum) VALUES ($1, $2)",
          [migration.name, migration.checksum]
        );
        await client.query("COMMIT");
        applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return { applied, skipped };
  } finally {
    if (lockHeld) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      } catch {
        // The session close below also releases the advisory lock.
      }
    }
    await client.end().catch(() => undefined);
  }
}

export async function getMigrationStatus({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
} = {}) {
  const migrations = await discoverMigrations(migrationsDir);
  const client = await connect(databaseUrl);

  try {
    const tableResult = await client.query("SELECT to_regclass('public._schema_migrations') AS table_name");
    const appliedRows = tableResult.rows[0]?.table_name
      ? (await client.query("SELECT name, checksum, applied_at FROM _schema_migrations ORDER BY name")).rows
      : [];
    const appliedByName = new Map(appliedRows.map((row) => [row.name, row]));

    return migrations.map((migration) => {
      const applied = appliedByName.get(migration.name);
      const state = !applied
        ? "pending"
        : applied.checksum.trim() === migration.checksum
          ? "applied"
          : "checksum_mismatch";
      return {
        name: migration.name,
        state,
        appliedAt: applied?.applied_at?.toISOString?.() ?? null
      };
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function safeDatabaseCommandError(error) {
  if (error instanceof MigrationError) return `${error.code}: ${error.message}`;
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  return `Database command failed (${code}).`;
}
