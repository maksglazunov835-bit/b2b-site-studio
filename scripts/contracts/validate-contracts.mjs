import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  SITE_SPEC_SEMANTIC_ERROR_CODES,
  validateSiteSpecSemantics
} from "./validate-site-spec-semantics.mjs";
import {
  JOB_SPEC_SEMANTIC_ERROR_CODES,
  validateJobSpecSemantics
} from "./validate-job-spec-semantics.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const CONTRACTS = [
  {
    id: "site-spec",
    schemaPath: "docs/contracts/site-spec.schema.json",
    semanticValidator: validateSiteSpecSemantics,
    semanticCodes: SITE_SPEC_SEMANTIC_ERROR_CODES
  },
  {
    id: "job-spec",
    schemaPath: "docs/contracts/job.schema.json",
    semanticValidator: validateJobSpecSemantics,
    semanticCodes: JOB_SPEC_SEMANTIC_ERROR_CODES
  }
];

function readJson(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function createAjv() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: true
  });
  addFormats(ajv, ["date-time", "uri", "email"]);
  return ajv;
}

function formatAjvErrors(errors = []) {
  return errors.map((error) => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    message: error.message
  }));
}

function addFailure(failures, scope, contractId, fixtureName, message, details = []) {
  failures.push({
    scope,
    contract: contractId,
    fixture: fixtureName,
    message,
    details
  });
}

function assertArrayFixture(schema, propertyName, contract, failures) {
  const fixtures = schema[propertyName];
  if (!Array.isArray(fixtures)) {
    addFailure(failures, "metadata", contract.id, propertyName, `${propertyName} must be an array`);
    return [];
  }
  return fixtures;
}

function schemaNegativeExpectation(negative) {
  const expected = negative.expectedError;
  if (!expected || typeof expected !== "object") return null;
  const keyword = typeof expected.keyword === "string" ? expected.keyword : null;
  const instancePath = typeof expected.instancePath === "string" ? expected.instancePath : null;
  const errorCategory = typeof expected.errorCategory === "string" ? expected.errorCategory : null;
  if (!keyword && !errorCategory) return null;
  return { keyword, instancePath, errorCategory };
}

function ajvErrorMatchesExpectation(error, expectation) {
  if (expectation.keyword && error.keyword !== expectation.keyword) return false;
  if (expectation.instancePath !== null && expectation.instancePath !== undefined && error.instancePath !== expectation.instancePath) {
    return false;
  }
  if (expectation.errorCategory && error.keyword !== expectation.errorCategory) return false;
  return true;
}

function validateSchemaFixtures(contract, schema, validate, failures, summary) {
  const examples = assertArrayFixture(schema, "examples", contract, failures);
  const negativeExamples = assertArrayFixture(schema, "x-negativeExamples", contract, failures);

  for (const [index, example] of examples.entries()) {
    const fixtureName = example.id ?? example.projectId ?? `${contract.id}-example-${index}`;
    summary.schemaPositive += 1;
    if (!validate(example)) {
      addFailure(
        failures,
        "schema-positive",
        contract.id,
        fixtureName,
        "Positive schema fixture must validate",
        formatAjvErrors(validate.errors)
      );
    }
  }

  for (const [index, negative] of negativeExamples.entries()) {
    const fixtureName = negative.name ?? `${contract.id}-negative-${index}`;
    const expectation = schemaNegativeExpectation(negative);
    summary.schemaNegative += 1;

    if (!negative.name || typeof negative.name !== "string") {
      addFailure(failures, "metadata", contract.id, fixtureName, "Negative schema fixture must have a stable name");
    }
    if (!negative.expectedReason || typeof negative.expectedReason !== "string") {
      addFailure(failures, "metadata", contract.id, fixtureName, "Negative schema fixture must describe expectedReason");
    }
    if (!expectation) {
      addFailure(failures, "metadata", contract.id, fixtureName, "Negative schema fixture must include expectedError metadata");
    }
    if (!("value" in negative)) {
      addFailure(failures, "metadata", contract.id, fixtureName, "Negative schema fixture must include value");
      continue;
    }

    const valid = validate(negative.value);
    const errors = validate.errors ?? [];
    if (valid) {
      addFailure(failures, "schema-negative", contract.id, fixtureName, "Negative schema fixture unexpectedly validated");
      continue;
    }
    if (expectation && !errors.some((error) => ajvErrorMatchesExpectation(error, expectation))) {
      addFailure(
        failures,
        "schema-negative",
        contract.id,
        fixtureName,
        "Negative schema fixture failed, but not with the expected stable error metadata",
        formatAjvErrors(errors)
      );
    }
  }
}

function validateSemanticFixtures(contract, schema, validate, failures, summary) {
  const examples = assertArrayFixture(schema, "examples", contract, failures);
  const negativeExamples = assertArrayFixture(schema, "x-semanticNegativeExamples", contract, failures);

  for (const [index, example] of examples.entries()) {
    const fixtureName = example.id ?? example.projectId ?? `${contract.id}-example-${index}`;
    summary.semanticPositive += 1;
    if (!validate(example)) {
      addFailure(
        failures,
        "semantic-positive-schema",
        contract.id,
        fixtureName,
        "Positive semantic fixture must pass JSON Schema before semantic checks",
        formatAjvErrors(validate.errors)
      );
      continue;
    }
    const semanticErrors = contract.semanticValidator(example);
    if (semanticErrors.length > 0) {
      addFailure(
        failures,
        "semantic-positive",
        contract.id,
        fixtureName,
        "Positive semantic fixture must not produce semantic errors",
        semanticErrors
      );
    }
  }

  for (const [index, negative] of negativeExamples.entries()) {
    const fixtureName = negative.name ?? `${contract.id}-semantic-negative-${index}`;
    summary.semanticNegative += 1;

    if (!negative.name || typeof negative.name !== "string") {
      addFailure(failures, "metadata", contract.id, fixtureName, "Semantic negative fixture must have a stable name");
    }
    if (!negative.expectedReason || typeof negative.expectedReason !== "string") {
      addFailure(failures, "metadata", contract.id, fixtureName, "Semantic negative fixture must describe expectedReason");
    }
    if (!negative.expectedCode || typeof negative.expectedCode !== "string") {
      addFailure(failures, "metadata", contract.id, fixtureName, "Semantic negative fixture must include expectedCode");
    } else if (!contract.semanticCodes.includes(negative.expectedCode)) {
      addFailure(failures, "metadata", contract.id, fixtureName, `Unknown semantic expectedCode ${negative.expectedCode}`);
    }
    if (!("value" in negative)) {
      addFailure(failures, "metadata", contract.id, fixtureName, "Semantic negative fixture must include value");
      continue;
    }

    if (!validate(negative.value)) {
      addFailure(
        failures,
        "semantic-negative-schema",
        contract.id,
        fixtureName,
        "Semantic negative fixture must be JSON Schema-valid before semantic rejection",
        formatAjvErrors(validate.errors)
      );
      continue;
    }

    const semanticErrors = contract.semanticValidator(negative.value);
    if (semanticErrors.length === 0) {
      addFailure(failures, "semantic-negative", contract.id, fixtureName, "Semantic negative fixture unexpectedly passed");
      continue;
    }
    if (!semanticErrors.some((error) => error.code === negative.expectedCode)) {
      addFailure(
        failures,
        "semantic-negative",
        contract.id,
        fixtureName,
        `Semantic negative fixture did not produce expectedCode ${negative.expectedCode}`,
        semanticErrors
      );
    }
  }
}

function validateContracts({ schemaChecks, semanticChecks }) {
  const failures = [];
  const summary = {
    schemaPositive: 0,
    schemaNegative: 0,
    semanticPositive: 0,
    semanticNegative: 0,
    semanticErrorCodes: [
      ...SITE_SPEC_SEMANTIC_ERROR_CODES,
      ...JOB_SPEC_SEMANTIC_ERROR_CODES
    ].sort()
  };

  for (const contract of CONTRACTS) {
    const schema = readJson(contract.schemaPath);
    const ajv = createAjv();
    let validate;

    try {
      validate = ajv.compile(schema);
    } catch (error) {
      addFailure(failures, "schema-compile", contract.id, contract.schemaPath, error.message);
      continue;
    }

    if (schemaChecks) {
      validateSchemaFixtures(contract, schema, validate, failures, summary);
    }
    if (semanticChecks) {
      validateSemanticFixtures(contract, schema, validate, failures, summary);
    }
  }

  return { failures, summary };
}

function parseMode(argv) {
  const modeArgs = argv.filter((arg) => arg.startsWith("--"));
  const knownArgs = new Set(["--schema-only", "--semantic-only"]);
  for (const arg of modeArgs) {
    if (!knownArgs.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    schemaChecks: !modeArgs.includes("--semantic-only"),
    semanticChecks: !modeArgs.includes("--schema-only")
  };
}

try {
  const mode = parseMode(process.argv.slice(2));
  const result = validateContracts(mode);

  for (const failure of result.failures) {
    console.error(`[${failure.scope}] ${failure.contract}/${failure.fixture}: ${failure.message}`);
    for (const detail of failure.details ?? []) {
      console.error(`  - ${JSON.stringify(detail)}`);
    }
  }

  console.log(`CONTRACT_VALIDATION_SUMMARY ${JSON.stringify(result.summary)}`);

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
}
