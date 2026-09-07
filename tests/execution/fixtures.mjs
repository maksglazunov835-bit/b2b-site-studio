import { materialize, VALIDATOR } from "../../server/execution/contract.mjs";
import { buildDraftSiteSpec } from "../../server/persistence/site-spec.mjs";
import { DEFAULT_WORKSPACE_ID } from "../../server/persistence/repository.mjs";
import { sha256Json } from "../../server/persistence/canonical-json.mjs";
export function dataFixture(snapshot) {
  const projectId = "11111111-1111-4111-8111-111111111111";
  snapshot ??= buildDraftSiteSpec({ projectId, revision: 1, draft: {} }).siteSpec;
  return materialize({ id: `job_${"1".repeat(32)}`, project_id: projectId, template_version: "site_spec_validation@1",
    site_spec_revision_id: "22222222-2222-4222-8222-222222222222", input_revision: 1, input_schema_version: "1.2.0", input_sha256: sha256Json(snapshot) }, snapshot, DEFAULT_WORKSPACE_ID).spec;
}
export const negativeProfiles = [
  { name: "unknown version", fields: { jobSpecVersion: "9.0.0" }, code: "UNSUPPORTED_EXECUTION_PROFILE" },
  { name: "unknown profile", fields: { executionProfile: "codex" }, code: "UNSUPPORTED_EXECUTION_PROFILE" },
  { name: "shell field", fields: { command: "must never run" }, code: "INVALID_EXECUTION_SPEC" },
  { name: "external URL", fields: { url: "https://invalid.example" }, code: "INVALID_EXECUTION_SPEC" },
  { name: "workspace path", fields: { workspacePath: "C:/forbidden" }, code: "INVALID_EXECUTION_SPEC" },
  { name: "repository", fields: { repository: {} }, code: "INVALID_EXECUTION_SPEC" },
  { name: "validator mismatch", fields: { validator: { ...VALIDATOR, sha256: "0".repeat(64) } }, code: "VALIDATOR_MISMATCH" }
];
