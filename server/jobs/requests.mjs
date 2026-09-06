import Ajv from "ajv";
import { PersistenceError } from "../persistence/errors.mjs";

const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false });
const positiveInteger = { type: "integer", minimum: 1, maximum: 2147483647 };
const createValidator = ajv.compile({ type: "object", additionalProperties: false,
  required: ["type", "expectedRevision"], properties: {
    type: { type: "string", maxLength: 64 }, expectedRevision: positiveInteger
  }
});
const cancelValidator = ajv.compile({ type: "object", additionalProperties: false,
  required: ["expectedVersion"], properties: { expectedVersion: positiveInteger }
});

export function jobError(code, message, status = 422) {
  throw new PersistenceError(code, message, { status });
}

export function createRequest(input) {
  if (!createValidator(input)) jobError("VALIDATION_FAILED", "Expected only type and positive expectedRevision.");
  if (input.type !== "site_spec_validation") jobError("UNSUPPORTED_JOB_TYPE", "This job type is not supported.");
  return { type: input.type, expectedRevision: input.expectedRevision };
}

export function cancelRequest(input) {
  if (!cancelValidator(input)) jobError("VALIDATION_FAILED", "Expected only positive expectedVersion.");
  return { expectedVersion: input.expectedVersion };
}

export function assertJobId(value) {
  if (typeof value !== "string" || !/^job_[a-f0-9]{32}$/.test(value)) jobError("VALIDATION_FAILED", "Invalid job ID.");
  return value;
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function pagination(params = new URLSearchParams(), scope) {
  for (const key of params.keys()) {
    if (!["limit", "cursor"].includes(key) || params.getAll(key).length !== 1) jobError("VALIDATION_FAILED", "Invalid list parameters.");
  }
  const rawLimit = params.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) jobError("VALIDATION_FAILED", "limit must be between 1 and 100.");
  const value = params.get("cursor");
  if (value === null) return { limit: Number(rawLimit), cursor: null };
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    const cursor = JSON.parse(bytes.toString("utf8"));
    const fields = [...Object.keys(scope), "v", ...(scope.kind === "jobs" ? ["at", "id"] : ["sequence"])];
    if (!cursor || Object.keys(cursor).length !== fields.length || Object.keys(cursor).some((key) => !fields.includes(key))) throw new Error();
    if (cursor.v !== 1 || Object.entries(scope).some(([key, expected]) => cursor[key] !== expected)) throw new Error();
    if (scope.kind === "jobs") {
      assertJobId(cursor.id);
      if (typeof cursor.at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at) ||
          new Date(cursor.at).toISOString().slice(0, 19) !== cursor.at.slice(0, 19)) throw new Error();
    } else if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1 || cursor.sequence > 2147483647) throw new Error();
    return { limit: Number(rawLimit), cursor };
  } catch {
    jobError("INVALID_CURSOR", "Invalid cursor for this list.");
  }
}
