import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRequest, newSecret } from '../../server/agents/requests.mjs';
import {
  ADAPTER,
  assertRuntime,
  runtimeExecutable,
} from '../../server/design/contract.mjs';
import { freshWslAdmission } from '../../server/design/admission.mjs';
import { runtime, officialRuntime } from './fixtures.mjs';
void test('official ready runtime reaches registration validation (synthetic, no model)', () => {
  const official = {
    ...runtime,
    provider: 'codex',
    cliVersion: '0.153.4',
    modelSelection: {
      ...runtime.modelSelection,
      source: 'official_model_list',
    },
    admission: {
      transport: 'wsl2',
      profile: 'b2b-design-json',
      checkedAt: new Date().toISOString(),
      configSha256: 'a'.repeat(64),
    },
  };
  assertRuntime(official);
  assert.doesNotThrow(() =>
    registerRequest({
      mode: 'codex_design',
      adapter: ADAPTER,
      runtime: official,
      agentName: 'Official WSL contract fixture',
      agentVersion: '0.4.0',
      os: 'windows',
      supportedApiVersions: ['v1'],
      agentSecret: newSecret('agt'),
    }),
  );
});
void test('native/unverified, stale, forged ready, wrong manifest/model/effort are not execution authority', () => {
  for (const change of [
    (r) => delete r.admission,
    (r) => (r.admission.transport = 'native'),
    (r) => (r.admission.profile = 'full-access'),
    (r) => (r.policySha256 = '0'.repeat(64)),
    (r) => (r.model = 'other'),
    (r) => (r.effort = 'low'),
    (r) => (r.cliVersion = '0.153.3'),
  ]) {
    const r = officialRuntime();
    change(r);
    assert.equal(runtimeExecutable(r), false);
  }
  const r = officialRuntime();
  assert.equal(freshWslAdmission(r), true);
  r.admission.checkedAt = new Date(Date.now() - 61000).toISOString();
  assert.equal(freshWslAdmission(r), false);
  r.admission.checkedAt = new Date(Date.now() + 10000).toISOString();
  assert.equal(freshWslAdmission(r), false);
  const unverified = {
    ...officialRuntime(),
    status: 'CODEX_ISOLATION_UNVERIFIED',
  };
  assert.equal(runtimeExecutable(unverified), false);
  assert.equal(runtimeExecutable(runtime), false);
  assert.equal(runtimeExecutable(runtime, { allowTest: true }), true);
});
