import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { validationTask } from "../../agent/validation-task.mjs";
import { validationReport } from "../../server/execution/contract.mjs";
import { dataFixture } from "./fixtures.mjs";
assertSafeTestDatabaseUrl();
void test("fixed worker validates data deterministically and terminates on deadline/cancellation", async () => {
  const spec = dataFixture();
  assert.deepEqual(await validationTask(spec, 1), validationReport(spec, 1));
  const controller = new AbortController(); const pending = validationTask(spec, 1, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: "VALIDATION_CANCELLED" });
  await assert.rejects(validationTask(spec, 1, { timeoutMs: 1 }), { code: "VALIDATION_TIMEOUT" });
  assert.equal((await validationTask(dataFixture({}), 1)).validationStatus, "invalid");
});
