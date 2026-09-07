import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../docs/contracts/job-data-validation.schema.json" with { type: "json" };
import manifest from "./validator-manifest.json" with { type: "json" };
import { boundedJson, ExecutionError, LIMITS } from "./bounds.mjs";
import { sha256Json } from "../persistence/canonical-json.mjs";
import { validateSnapshot } from "./validator.mjs";

export const VALIDATOR = Object.freeze({ id: manifest.id, version: manifest.version, sha256: manifest.sha256 });
export const POLICY = Object.freeze(schema.properties.policy.const);
const validate = new Ajv2020({ strict: true, allErrors: false }).compile(schema);
export function compatible(value) { return value && sha256Json(value) === sha256Json(VALIDATOR); }
export function assertSpec(spec, expectedHash) {
  boundedJson(spec);
  if (spec?.jobSpecVersion !== "1.3.0" || spec?.executionProfile !== "data_validation") throw new ExecutionError("UNSUPPORTED_EXECUTION_PROFILE");
  if (!validate(spec)) throw new ExecutionError("INVALID_EXECUTION_SPEC");
  boundedJson(spec.input.snapshot, LIMITS.snapshot);
  if (!compatible(spec.validator)) throw new ExecutionError("VALIDATOR_MISMATCH");
  if (sha256Json(spec.input.snapshot) !== spec.input.sha256 || (expectedHash && sha256Json(spec) !== expectedHash)) throw new ExecutionError("INPUT_HASH_MISMATCH");
  const snapshot = spec.input.snapshot;
  if (snapshot && typeof snapshot === "object") for (const [key, value] of Object.entries({ projectId: spec.projectId, revision: spec.input.revision, schemaVersion: spec.input.schemaVersion })) {
    if (Object.hasOwn(snapshot, key) && snapshot[key] !== value) throw new ExecutionError("SNAPSHOT_BINDING_MISMATCH");
  }
  return spec;
}
export function materialize(job, snapshot, workspaceId) {
  const spec = { jobSpecVersion: "1.3.0", executionProfile: "data_validation", type: "site_spec_validation",
    jobId: job.id, projectId: job.project_id, workspaceId, templateVersion: job.template_version, validator: VALIDATOR,
    input: { revisionId: job.site_spec_revision_id, revision: job.input_revision, schemaVersion: job.input_schema_version,
      sha256: job.input_sha256.trim(), snapshot }, policy: POLICY, resultContractVersion: "1.0.0" };
  assertSpec(spec);
  return { spec, sha256: sha256Json(spec) };
}
export function validationReport(spec, attempt) {
  assertSpec(spec);
  const report = { reportVersion: "1.0.0", jobId: spec.jobId, attempt, inputRevision: spec.input.revision,
    inputSha256: spec.input.sha256, jobSpecSha256: sha256Json(spec), validator: VALIDATOR, ...validateSnapshot(spec.input.snapshot) };
  while (Buffer.byteLength(JSON.stringify(report)) > LIMITS.report && report.details.length) { report.details.pop(); report.truncated = true; }
  boundedJson(report, LIMITS.report);
  return report;
}
