import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
assertSafeTestDatabaseUrl();
const { selectAstra, queryModelCatalog } =
  await import('../../agent/codex/model-catalog.mjs');
const { preflight, clientEnvironment, execArguments } =
  await import('../../agent/codex/adapter.mjs');
const {
  materializeDesign,
  assertDesignSpec,
  assertDesignReport,
  modelEvidence,
  DESIGN_SETTINGS,
} = await import('../../server/design/contract.mjs');
const { runtime, brief, proposal } = await import('./fixtures.mjs');
const { buildDraftSiteSpec } =
  await import('../../server/persistence/site-spec.mjs');
const { sha256Json } =
  await import('../../server/persistence/canonical-json.mjs');
const row = {
  model: 'gpt-6-astra',
  hidden: false,
  supportedReasoningEfforts: [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ].map((reasoningEffort) => ({ reasoningEffort })),
  inputModalities: ['text', 'image'],
};

void test('Astra chooses highest advertised effort, denies missing/hidden/ambiguous/unknown capability without fallback', () => {
  assert.equal(selectAstra([row]).effort, 'ultra');
  assert.equal(
    selectAstra([
      { ...row, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    ]).effort,
    'high',
  );
  for (const rows of [
    [],
    [{ ...row, model: 'gpt-5.6-luna' }],
    [{ ...row, hidden: true }],
    [row, row],
    [{ ...row, supportedReasoningEfforts: [] }],
    [{ ...row, supportedReasoningEfforts: [{ reasoningEffort: 'future' }] }],
    [{ ...row, inputModalities: ['image'] }],
  ])
    assert.throws(() => selectAstra(rows));
});

void test('real synthetic model/list process: pagination, account separation, bounds and no identity in receipt', async () => {
  const fixture = fileURLToPath(
    new URL('./model-catalog-stub.mjs', import.meta.url),
  );
  const query = (mode) =>
    queryModelCatalog(process.execPath, clientEnvironment(), {
      timeoutMs: mode === 'timeout' ? 300 : 5000,
      spawnProcess: (_file, _args, options) =>
        spawn(process.execPath, [fixture, mode], options),
    });
  const receipt = await query('ok');
  assert.equal(receipt.pages, 2);
  assert.equal(receipt.effort, 'ultra');
  assert.equal(receipt.inferenceAccessVerified, false);
  assert.ok(!JSON.stringify(receipt).includes('SYNTHETIC_SECRET'));
  for (const mode of ['missing', 'api', 'cursor-loop', 'oversized', 'timeout'])
    await assert.rejects(query(mode));
});

void test('preflight pins verified catalog choice and blocks changed effort or failed isolation before any exec', async () => {
  const calls = [];
  const probe = async (_file, args) => {
    calls.push(args);
    return {
      code: 0,
      stderr: '',
      stdout:
        args[0] === '--version'
          ? 'codex-cli 0.153.4'
          : args[0] === 'exec'
            ? '--ignore-user-config --strict-config --ignore-rules --ephemeral --output-schema --sandbox'
            : 'ChatGPT',
    };
  };
  const good = await preflight(process.execPath, {
    probe,
    modelQuery: async () => selectAstra([row]),
  });
  assert.equal(good.status, 'CODEX_ISOLATION_UNVERIFIED');
  assert.equal(good.model, 'gpt-6-astra');
  assert.equal(good.effort, 'ultra');
  const bad = await preflight(process.execPath, {
    probe,
    modelQuery: async () => ({ ...selectAstra([row]), effort: 'high' }),
  });
  assert.equal(bad.status, 'CODEX_MODEL_CAPABILITY_MISMATCH');
  assert.ok(calls.every((a) => a[0] !== 'exec' || a[1] === '--help'));
  const args = execArguments('owned', 'owned/schema');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(args.includes('model_reasoning_effort="ultra"'));
  assert.ok(args.includes('permissions.b2b-design-json.network.enabled=false'));
  assert.ok(args.some((a) => a.includes('":root"="deny"')));
  assert.ok(!args.includes('--sandbox'));
  assert.ok(!args.some((a) => a.includes('danger-full-access')));
});

void test('new 1.4.1 cannot execute legacy Luna; requested/resolved/observed provenance is not model-authored', async () => {
  const projectId = randomUUID();
  const { siteSpec } = buildDraftSiteSpec({
    projectId,
    revision: 1,
    draft: brief,
  });
  const spec = materializeDesign(
    {
      id: `job_${randomUUID().replaceAll('-', '')}`,
      project_id: projectId,
      site_spec_revision_id: randomUUID(),
      input_revision: 1,
      input_sha256: sha256Json(siteSpec),
    },
    siteSpec,
    randomUUID(),
    runtime,
  ).spec;
  assert.equal(spec.jobSpecVersion, '1.4.1');
  assert.deepEqual(spec.settings, DESIGN_SETTINGS);
  const legacy = structuredClone(spec);
  legacy.jobSpecVersion = '1.4.0';
  legacy.adapter.version = '1.0.0';
  legacy.settings.model = legacy.runtime.model = 'gpt-5.6-luna';
  legacy.settings.effort = legacy.runtime.effort = 'medium';
  delete legacy.runtime.modelSelection;
  const oldSchema = JSON.parse(
    await readFile(
      new URL('../../docs/contracts/design-job.schema.json', import.meta.url),
    ),
  );
  assert.equal(new Ajv({ strict: true }).compile(oldSchema)(legacy), true);
  const before = JSON.stringify(legacy),
    hash = sha256Json(legacy);
  assert.throws(() => assertDesignSpec(legacy, hash));
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(sha256Json(legacy), hash);
  const report = {
    reportVersion: '1.1.0',
    jobId: spec.jobId,
    attempt: 1,
    inputSha256: spec.input.sha256,
    jobSpecSha256: sha256Json(spec),
    provider: runtime.provider,
    cliVersion: runtime.cliVersion,
    model: spec.settings.model,
    effort: spec.settings.effort,
    modelEvidence: modelEvidence(spec),
    providerInvocations: 1,
    proposal: proposal(),
    usage: null,
  };
  assertDesignReport(report, spec, 1);
  assert.equal(report.modelEvidence.observedModel, null);
  report.modelEvidence.observedModel = 'gpt-6-astra';
  assert.throws(() => assertDesignReport(report, spec, 1));
});
