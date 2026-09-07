import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertSpec, validationReport, VALIDATOR } from "../../server/execution/contract.mjs";
import { installedManifest } from "../../scripts/contracts/execution-manifest.mjs";
import { boundedJson, parseBounded } from "../../server/execution/bounds.mjs";
import { dataFixture, negativeProfiles } from "./fixtures.mjs";
import { options } from "../../agent/session.mjs";
import { registerRequest, newSecret } from "../../server/agents/requests.mjs";
import { canonicalStringify, sha256Json } from "../../server/persistence/canonical-json.mjs";
import legacyHashes from "./canonical-legacy-hashes.json" with { type: "json" };

void test("complete 1.3 data profile, real manifest and invalid SiteSpec diagnostic fixtures", async () => {
  const spec = dataFixture(); assert.equal(assertSpec(spec), spec);
  assert.equal((await installedManifest()).sha256, VALIDATOR.sha256);
  const valid = validationReport(spec, 1); assert.equal(valid.validationStatus, "valid");
  const invalid = validationReport(dataFixture({}), 1);
  assert.equal(invalid.validationStatus, "invalid"); assert.equal(invalid.semanticChecked, false);
  for (const fixture of negativeProfiles) assert.throws(() => assertSpec({ ...spec, ...fixture.fields }), { code: fixture.code }, fixture.name);
  assert.throws(() => assertSpec(spec, "0".repeat(64)), { code: "INPUT_HASH_MISMATCH" });
  assert.throws(() => assertSpec({ ...spec, input: { ...spec.input, sha256: "0".repeat(64) } }), { code: "INPUT_HASH_MISMATCH" });
  const schema = JSON.parse(await readFile("docs/contracts/site-spec.schema.json", "utf8"));
  const semantic = { ...schema["x-semanticNegativeExamples"][0].value, projectId: spec.projectId, revision: 1 };
  const semanticSpec = dataFixture(semantic);
  assert.equal(validationReport(semanticSpec, 1).validationStatus, "invalid");
});
void test("canonical JSON preserves every own special key, round-trips and ignores key order", () => {
  const plain = JSON.parse('{"a":1}');
  const changed = JSON.parse('{"a":1,"__proto__":{"marker":"CHANGED"}}');
  assert.notEqual(canonicalStringify(plain), canonicalStringify(changed));
  assert.notEqual(sha256Json(plain), sha256Json(changed));
  for (const name of ["__proto__", "constructor", "prototype"]) {
    for (const wrap of [(value) => value, (value) => ({ nested: value }), (value) => ({ array: [value] })]) {
      const value = JSON.parse(`{"z":1,"${name}":{"marker":"original"},"a":2}`);
      const document = wrap(value); const before = sha256Json(document);
      assert.deepEqual(JSON.parse(canonicalStringify(document)), document);
      const reordered = JSON.parse(`{"a":2,"${name}":{"marker":"original"},"z":1}`);
      assert.equal(before, sha256Json(wrap(reordered)));
      value[name].marker = "changed";
      assert.notEqual(before, sha256Json(document));
      assert.deepEqual(JSON.parse(canonicalStringify(document)), document);
    }
  }
  assert.equal(Object.prototype.marker, undefined);
});
void test("changed special-key snapshot cannot pass the previous input or JobSpec digest", () => {
  for (const addition of ['{"__proto__":{"marker":"CHANGED"}}', '{"nested":{"__proto__":{"marker":"CHANGED"}}}', '{"items":[{"__proto__":{"marker":"CHANGED"}}]}']) {
    const spec = dataFixture({ a: 1 }); const oldSpecHash = sha256Json(spec);
    const changed = { ...spec, input: { ...spec.input, snapshot: { ...spec.input.snapshot, ...JSON.parse(addition) } } };
    assert.throws(() => assertSpec(changed, oldSpecHash), { code: "INPUT_HASH_MISMATCH" });
    changed.input.sha256 = sha256Json(changed.input.snapshot);
    assert.throws(() => assertSpec(changed, oldSpecHash), { code: "INPUT_HASH_MISMATCH" });
    assertSpec(changed, sha256Json(changed));
  }
});
void test("all 56 ordinary legacy fixture hashes remain compatible with the reviewed head", async () => {
  assert.equal(legacyHashes.baselineCommit, "a84465e014445b6145bc23786ea5db190cc8407f");
  assert.equal(legacyHashes.fixtures.length, 56);
  for (const fixture of legacyHashes.fixtures) {
    const schema = JSON.parse(await readFile(`docs/contracts/${fixture.file}`, "utf8"));
    const entry = schema[fixture.group][fixture.index];
    assert.equal(sha256Json(fixture.group === "examples" ? entry : entry.value), fixture.sha256,
      `${fixture.file} ${fixture.group}[${fixture.index}]`);
  }
});
void test("bytes/depth/node bounds precede recursive validators and reports omit input values", () => {
  assert.throws(() => parseBounded('"' + "x".repeat(65536) + '"', 65536), { code: "JSON_BYTES_LIMIT" });
  let deep = {}; for (let i = 0; i < 34; i++) deep = { nested: deep };
  assert.throws(() => boundedJson(deep), { code: "JSON_COMPLEXITY_LIMIT" });
  assert.throws(() => boundedJson(Array(6001).fill(0)), { code: "JSON_COMPLEXITY_LIMIT" });
  const secret = "agt_" + "x".repeat(43);
  const invalid = dataFixture({ [secret]: secret });
  assert.equal(JSON.stringify(validationReport(invalid, 1)).includes(secret), false);
  const lease = "lease_" + "x".repeat(43);
  assert.throws(() => options(["--origin", "http://127.0.0.1:3000", "--name", lease]), { code: "INVALID_OPTIONS" });
  assert.throws(() => registerRequest({ mode: "presence_only", agentName: lease, agentVersion: "0.3.0", os: "linux", supportedApiVersions: ["v1"], agentSecret: newSecret("agt") }), { code: "VALIDATION_FAILED" });
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`unknown${index}`, "redacted"]));
  const report = validationReport(dataFixture(many), 1);
  assert.equal(report.truncated, true); assert.equal(report.details.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 16384);
});
