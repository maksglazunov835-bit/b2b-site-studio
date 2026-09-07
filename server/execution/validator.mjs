import validateSchema from "../persistence/generated/site-spec-validator.mjs";
import { validateSiteSpecSemantics } from "../contracts/validate-site-spec-semantics.mjs";
import schema from "../../docs/contracts/site-spec.schema.json" with { type: "json" };
import { boundedJson, LIMITS } from "./bounds.mjs";

const safeSegments = new Set();
const stack = [schema];
while (stack.length) {
  const item = stack.pop();
  if (!item || typeof item !== "object") continue;
  for (const key of Object.keys(item.properties ?? {})) safeSegments.add(key);
  stack.push(...Object.values(item));
}
const pathOnly = (path) => path.split("/").map((part) => safeSegments.has(part) || /^(0|[1-9][0-9]{0,4})$/.test(part) || part === "" ? part : "*").join("/").slice(0, 256);

// Only schema keyword/path and registered semantic codes; never values or messages.
export function validateSnapshot(snapshot) {
  boundedJson(snapshot, LIMITS.snapshot);
  const schemaValid = validateSchema(snapshot);
  const schemaErrors = schemaValid ? [] : (validateSchema.errors ?? []).map((error) => ({ kind: "schema", code: error.keyword, path: pathOnly(error.instancePath) }));
  const semanticErrors = schemaValid ? validateSiteSpecSemantics(snapshot).map((error) => ({ kind: "semantic", code: error.code, path: pathOnly(error.path) })) : [];
  const all = [...schemaErrors, ...semanticErrors];
  all.sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
  return { validationStatus: all.length ? "invalid" : "valid", schemaValid, semanticChecked: !!schemaValid,
    counts: { schema: schemaErrors.length, semantic: semanticErrors.length }, details: all.slice(0, 100), truncated: all.length > 100 };
}
