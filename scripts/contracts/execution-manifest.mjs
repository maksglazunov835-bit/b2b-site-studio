import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// Fixed shipped sources, never a path or module selected by a job.
const sources = ["docs/contracts/site-spec.schema.json", "server/persistence/generated/site-spec-validator.mjs",
  "server/contracts/validate-site-spec-semantics.mjs", "server/persistence/canonical-json.mjs",
  "server/execution/bounds.mjs", "server/execution/validator.mjs", "server/execution/contract.mjs", "docs/contracts/job-data-validation.schema.json",
  "node_modules/ajv/dist/runtime/equal.js", "node_modules/ajv/dist/runtime/ucs2length.js",
  "node_modules/ajv-formats/dist/formats.js", "node_modules/fast-deep-equal/index.js"];
const root = new URL("../../", import.meta.url);
export async function installedManifest() {
  const files = [];
  for (const path of sources) {
    const text = (await readFile(new URL(path, root), "utf8")).replaceAll("\r\n", "\n");
    files.push({ path, sha256: createHash("sha256").update(text).digest("hex") });
  }
  return { id: "site_spec_builtin", version: "1.0.0", sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files };
}
