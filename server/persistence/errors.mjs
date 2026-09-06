const DATABASE_ERROR_CODES = new Set([
  "3D000",
  "57P01",
  "57P02",
  "57P03",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);

export class PersistenceError extends Error {
  constructor(code, message, { status = 500, details = {} } = {}) {
    super(message);
    this.name = "PersistenceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isDatabaseUnavailableError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  return DATABASE_ERROR_CODES.has(code) || code.startsWith("08");
}

export function asPersistenceError(error) {
  if (error instanceof PersistenceError) return error;
  if (isDatabaseUnavailableError(error)) {
    return new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "The project database is unavailable.",
      { status: 503 }
    );
  }
  return new PersistenceError("INTERNAL_ERROR", "The request could not be completed.", { status: 500 });
}
