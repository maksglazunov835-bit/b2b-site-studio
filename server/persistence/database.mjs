import pg from "pg";

import { PersistenceError } from "./errors.mjs";

const { Pool } = pg;

let managedPool;
let shutdownHandlersInstalled = false;

export function requireDatabaseUrl(databaseUrl = process.env.DATABASE_URL) {
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "The project database is not configured.",
      { status: 503 }
    );
  }
  return databaseUrl.trim();
}

function installShutdownHandlers() {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  const close = () => {
    void closeDatabasePool();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

export function getDatabasePool() {
  if (managedPool) return managedPool;
  managedPool = new Pool({
    connectionString: requireDatabaseUrl(),
    application_name: "b2b-site-studio",
    max: 10,
    maxUses: process.env.NODE_ENV === "development" ? 1 : Infinity,
    allowExitOnIdle: process.env.NODE_ENV === "development",
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
  managedPool.on("error", (error) => {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    console.error(`[database] idle client error (${code})`);
  });
  installShutdownHandlers();
  return managedPool;
}

export async function closeDatabasePool() {
  const pool = managedPool;
  managedPool = undefined;
  if (pool) await pool.end();
}

export async function withTransaction(callback) {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabaseConnection() {
  const result = await getDatabasePool().query("SELECT current_timestamp AS checked_at");
  return result.rows[0].checked_at.toISOString();
}
