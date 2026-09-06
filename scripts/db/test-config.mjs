import pg from "pg";
import { MigrationError } from "./migration-lib.mjs";

function refused() {
  throw new MigrationError("TEST_DATABASE_RESET_REFUSED", "Refusing unsafe or ambiguous test database configuration.");
}

function hasControl(value) {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function localConnectionConfig(value) {
  try {
    if (typeof value !== "string" || !value || /\s/.test(value) || hasControl(value)) refused();
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash || value.includes("?") || value.includes("#")) refused();
    const hostname = url.hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) refused();
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!/^[a-zA-Z0-9_-]+$/.test(database) || !user || !password || hasControl(user + password)) refused();
    const config = {
      host: hostname === "[::1]" ? "::1" : "127.0.0.1",
      port: Number(url.port || 5432), database, user, password,
      ssl: false, connectionTimeoutMillis: 3000,
      statement_timeout: 10000, query_timeout: 12000
    };
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) refused();
    return config;
  } catch {
    refused();
  }
}

export function assertSafeTestDatabaseUrl(value = process.env.TEST_DATABASE_URL, {
  devDatabaseUrl = process.env.DATABASE_URL,
  environment = process.env
} = {}) {
  if (!value) throw new MigrationError("TEST_DATABASE_URL_REQUIRED", "TEST_DATABASE_URL is required; DATABASE_URL is never a fallback.");
  if (Object.keys(environment).some((key) => /^PG/i.test(key))) refused();
  const config = localConnectionConfig(value);
  if (!/(^|[_-])test(?:ing)?([_-]|$)/i.test(config.database)) refused();
  if (devDatabaseUrl) {
    // Loopback aliases are conservatively treated as the same host.
    const dev = localConnectionConfig(devDatabaseUrl);
    if (dev.port === config.port && dev.database === config.database) refused();
  }
  // Inspect pg's actual parameters without connecting or executing any SQL.
  const actual = new pg.Client(config).connectionParameters;
  for (const key of ["host", "port", "database", "user", "password", "ssl"]) {
    if (actual[key] !== config[key]) refused();
  }
  return Object.freeze(config);
}
