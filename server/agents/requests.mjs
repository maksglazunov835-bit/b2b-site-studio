import Ajv from "ajv";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PersistenceError } from "../persistence/errors.mjs";

const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false });
const empty = ajv.compile({ type: "object", additionalProperties: false, properties: {} });
const registrationSchema = { type: "object", additionalProperties: false,
  required: ["mode","agentName","agentVersion","os","supportedApiVersions","agentSecret"], properties: {
    mode: { const: "presence_only" }, agentName: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9 ._-]+$" },
    agentVersion: { type: "string", maxLength: 32, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" },
    os: { enum: ["windows","linux","macos"] },
    supportedApiVersions: { type: "array", minItems: 1, maxItems: 4, uniqueItems: true, items: { type: "string", pattern: "^v[1-9][0-9]{0,2}$" } },
    agentSecret: { type: "string", pattern: "^agt_[A-Za-z0-9_-]{43}$" }
  }
};
const registration = ajv.compile(registrationSchema);
const dataRegistration = ajv.compile({ ...registrationSchema, required: [...registrationSchema.required, "validator"], properties: {
  ...registrationSchema.properties, mode: { const: "data_validation" }, validator: { type: "object", additionalProperties: false,
    required: ["id","version","sha256"], properties: { id: { const: "site_spec_builtin" }, version: { const: "1.0.0" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } } }
} });
const health = ajv.compile({ type: "object", additionalProperties: false, required: ["selectedApiVersion"],
  properties: { selectedApiVersion: { type: "string", maxLength: 8 } }
});

export function agentError(code, status = 422) {
  throw new PersistenceError(code, "The local Runner request could not be authorized or completed.", { status });
}
export function emptyRequest(value) {
  if (!empty(value)) agentError("VALIDATION_FAILED");
}
export function secretHash(value) { return createHash("sha256").update(value).digest("hex"); }
export function newSecret(kind) { return `${kind}_${randomBytes(32).toString("base64url")}`; }
export function validSecret(value, kind) {
  if (typeof value !== "string" || !new RegExp(`^${kind}_[A-Za-z0-9_-]{43}$`).test(value)) return false;
  return Buffer.from(value.slice(kind.length + 1), "base64url").toString("base64url") === value.slice(kind.length + 1);
}
export function hashMatches(secret, stored) {
  return typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored.trim()) &&
    timingSafeEqual(Buffer.from(secretHash(secret), "hex"), Buffer.from(stored.trim(), "hex"));
}
export function registerRequest(value) {
  if (!(value?.mode === "data_validation" ? dataRegistration(value) : registration(value)) || !value.agentName.trim() || !validSecret(value.agentSecret, "agt") || /(?:pair|agt|lease)_[A-Za-z0-9_-]{43}/.test(value.agentName)) agentError("VALIDATION_FAILED");
  if (!value.supportedApiVersions.includes("v1")) agentError("INCOMPATIBLE_PROTOCOL_VERSION", 409);
  return { ...value, agentName: value.agentName.trim(), supportedApiVersions: [...value.supportedApiVersions].sort((a,b) => a.localeCompare(b)) };
}
export function healthRequest(value) {
  if (!health(value)) agentError("VALIDATION_FAILED");
  if (value.selectedApiVersion !== "v1") agentError("INCOMPATIBLE_PROTOCOL_VERSION", 409);
}
export function assertAgentId(id, kind = "agent") {
  if (typeof id !== "string" || !new RegExp(`^${kind}_[a-f0-9]{32}$`).test(id)) agentError("VALIDATION_FAILED");
}
export function bearer(request) {
  const header = request.headers.get("authorization");
  const match = typeof header === "string" && /^Bearer ((?:pair|agt)_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) agentError("UNAUTHORIZED_AGENT", 401);
  return match[1];
}
export function agentPage(params = new URLSearchParams(), workspaceId) {
  for (const key of params.keys()) if (!["limit","cursor"].includes(key) || params.getAll(key).length !== 1) agentError("VALIDATION_FAILED");
  const limit = params.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100) agentError("VALIDATION_FAILED");
  let cursor = null;
  if (params.has("cursor")) {
    try {
      const text = params.get("cursor");
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(text)) throw new Error();
      cursor = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
      if (!cursor || Object.keys(cursor).sort().join() !== "at,id,v,workspaceId" || cursor.v !== 1 || cursor.workspaceId !== workspaceId) throw new Error();
      assertAgentId(cursor.id);
      if (typeof cursor.at !== "string" || !/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(cursor.at) ||
          new Date(cursor.at).toISOString() !== cursor.at) throw new Error();
    } catch { agentError("INVALID_CURSOR"); }
  }
  return { limit: Number(limit), cursor };
}
