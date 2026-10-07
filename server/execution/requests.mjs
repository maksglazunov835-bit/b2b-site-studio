import Ajv from "ajv";
import { boundedJson, LIMITS } from "./bounds.mjs";
import { executionError } from "./transitions.mjs";
import { SITE_SPEC_SEMANTIC_ERROR_CODES } from "../contracts/validate-site-spec-semantics.mjs";
import { DESIGN_CODES } from '../design/contract.mjs';
const ajv = new Ajv({ strict: true, allErrors: false });
const object = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const text = (pattern) => ({ type: "string", pattern });
const integer = { type: "integer", minimum: 1, maximum: 2147483647 };
const hash = text("^[a-f0-9]{64}$");
const validator = object({ id: { const: "site_spec_builtin" }, version: { const: "1.0.0" }, sha256: hash });
const schemaCodes = ["type","required","additionalProperties","enum","const","format","pattern","minLength","maxLength","minimum","maximum","minItems","maxItems","uniqueItems","anyOf","oneOf","allOf","not","if","contains","minProperties","maxProperties","dependentRequired"];
const reportSchema = object({ reportVersion: { const: "1.0.0" }, jobId: text("^job_[a-f0-9]{32}$"), attempt: { type: "integer", minimum: 1, maximum: 3 },
  inputRevision: integer, inputSha256: hash, jobSpecSha256: hash, validator,
  validationStatus: { enum: ["valid","invalid"] }, schemaValid: { type: "boolean" }, semanticChecked: { type: "boolean" },
  counts: object({ schema: { type: "integer", minimum: 0, maximum: 100000 }, semantic: { type: "integer", minimum: 0, maximum: 100000 } }),
  details: { type: "array", maxItems: 100, items: object({ kind: { enum: ["schema","semantic"] },
    code: { enum: [...schemaCodes,...SITE_SPEC_SEMANTIC_ERROR_CODES] }, path: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9_/*]*$" } }) },
  truncated: { type: "boolean" }
});
const common = { attempt: { type: "integer", minimum: 1, maximum: 3 }, leaseToken: text("^lease_[A-Za-z0-9_-]{43}$") };
const validators = {
  dispatch: ajv.compile(object({ agentId: text("^agent_[a-f0-9]{32}$"), expectedVersion: integer })),
  claim: ajv.compile(object({})), start: ajv.compile(object(common)), "cancel-ack": ajv.compile(object(common)),
  heartbeat: ajv.compile(object({ ...common, phase: { const: "validating" } })),
  result: ajv.compile(object({ ...common, resultDigest: hash, report: reportSchema })),
  fail: ajv.compile(object({ ...common, code: { enum: ["VALIDATOR_FAILED","INPUT_REJECTED","REPORT_REJECTED","RUNNER_STOPPED"] } }))
};
const designValidators = {
  result: ajv.compile(object({ ...common, resultDigest: hash, report: { type: 'object' } })),
  fail: ajv.compile(object({ ...common, code: { enum: [...DESIGN_CODES,'INPUT_REJECTED','REPORT_REJECTED','RUNNER_STOPPED'] } }))
};
export function executionRequest(kind, value, design = false) {
  boundedJson(value, kind === "result" ? LIMITS.report + 1024 : 2048);
  const check = design && designValidators[kind] ? designValidators[kind] : validators[kind];
  if (!check || !check(value)) executionError("VALIDATION_FAILED", 422);
  if (kind === "result") boundedJson(value.report, LIMITS.report);
  return value;
}
