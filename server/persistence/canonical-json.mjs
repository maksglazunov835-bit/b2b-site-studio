import { createHash } from "node:crypto";

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new TypeError(`Canonical JSON does not support undefined at ${key}.`);
      result[key] = canonicalValue(item);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON does not support values of type ${typeof value}.`);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}
