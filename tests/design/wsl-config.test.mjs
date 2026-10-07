import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import {
  configFingerprint,
  assertConfiguration,
  compareConfigurations,
  assertSameConfiguration,
  configFailure,
  prepareInvocation,
} from '../../agent/codex/wsl-config.mjs';
import { configProbe } from '../../agent/codex/wsl-runtime.mjs';
import { labBundle, callLab } from '../../agent/codex/wsl-bridge.mjs';
import {
  LAB,
  LAB_DISABLED,
  labFilesystem,
} from '../../agent/codex/wsl-policy.mjs';
import {
  validDiagnostic,
  diagnostic,
  diagnosticError,
  createInvocation,
  validInvocation,
} from '../../agent/codex/invocation-receipt.mjs';
import { preparationInput } from '../../agent/codex/wsl-preparation-input.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
assertSafeTestDatabaseUrl();
const task = `${LAB.root}/${'a'.repeat(32)}/task`;
const fixture = () => ({
  config: {
    default_permissions: LAB.profile,
    approval_policy: 'never',
    web_search: 'disabled',
    permissions: {
      [LAB.profile]: {
        filesystem: { ...labFilesystem(task), glob_scan_max_depth: null },
        network: { enabled: false },
      },
    },
    features: Object.fromEntries(LAB_DISABLED.map((f) => [f, false])),
    mcp_servers: {},
  },
  layers: [
    {
      name: { type: 'sessionFlags' },
      config: {
        tools: {
          update_plan: { enabled: false },
          experimental_request_user_input: { enabled: false },
        },
      },
    },
  ],
});
const snapshot = (config, requirements = { requirements: null }) => ({
  config,
  requirements,
});
const probeResult = (config) => ({
  receipt: { accountType: 'chatgpt' },
  snapshot: snapshot(config),
});
const reason = (id, phase) => (e) =>
  e.code === 'LAB_CONFIG_CHANGED' &&
  validDiagnostic(e.diagnostic) &&
  e.diagnostic.config.reasonId === id &&
  (!phase || e.diagnostic.config.phase === phase);

await test('full WSL configuration fingerprint ignores object key order', () => {
  assert.equal(
    configFingerprint(
      { network: { enabled: false, mode: 'deny' }, tools: [] },
      { requirements: null },
    ),
    configFingerprint(
      { tools: [], network: { mode: 'deny', enabled: false } },
      { requirements: null },
    ),
  );
});

await test('special own keys, missing/null, arrays and unknown values remain significant', () => {
  for (const field of ['__proto__', 'constructor', 'prototype']) {
    for (const wrap of [
      (v) => v,
      (v) => ({ nested: v }),
      (v) => ({ nested: [v] }),
    ]) {
      const a = wrap(JSON.parse(`{"${field}":{"marker":"before"},"a":1}`));
      const reordered = wrap(
        JSON.parse(`{"a":1,"${field}":{"marker":"before"}}`),
      );
      const b = wrap(JSON.parse(`{"${field}":{"marker":"after"},"a":1}`));
      assert.equal(
        configFingerprint(a, null),
        configFingerprint(reordered, null),
      );
      assert.notEqual(configFingerprint(a, null), configFingerprint(b, null));
      assert.notEqual(
        configFingerprint(a, null),
        configFingerprint(wrap({ a: 1 }), null),
      );
    }
  }
  assert.notEqual(
    configFingerprint({}, null),
    configFingerprint({ extra: null }, null),
  );
  assert.notEqual(
    configFingerprint({ a: [1, 2] }, null),
    configFingerprint({ a: [2, 1] }, null),
  );
  assert.notEqual(
    configFingerprint({ SECRET_KEY: 1 }, null),
    configFingerprint({ SECRET_KEY: 2 }, null),
  );
});

await test('every effective policy denial has an exact reason and phase', () => {
  const matrix = [
    [
      'INHERITED_CONFIG',
      (r) =>
        r.layers.push({
          name: { type: 'user' },
          config: { secret: 'DO_NOT_LOG' },
        }),
    ],
    ['LEGACY_SANDBOX', (r) => (r.config.sandbox_mode = 'danger-full-access')],
    ['WRONG_PROFILE', (r) => (r.config.default_permissions = 'untrusted')],
    [
      'FILESYSTEM_POLICY',
      (r) => (r.config.permissions[LAB.profile].filesystem.extra = 'read'),
    ],
    ['APPROVAL_POLICY', (r) => (r.config.approval_policy = 'on-request')],
    ['WEB_POLICY', (r) => (r.config.web_search = 'live')],
    [
      'TOOLS_POLICY',
      (r) => (r.layers[0].config.tools.update_plan.enabled = true),
    ],
    [
      'NETWORK_POLICY',
      (r) => (r.config.permissions[LAB.profile].network.enabled = true),
    ],
    [
      'MCP_POLICY',
      (r) => (r.config.mcp_servers.SECRET_URL = { secret: 'DO_NOT_LOG' }),
    ],
    ['FEATURE_POLICY', (r) => (r.config.features[LAB_DISABLED[0]] = true)],
    [
      'MANAGED_REQUIREMENTS',
      (_, q) => (q.requirements = { secret: 'DO_NOT_LOG' }),
    ],
  ];
  assert.doesNotThrow(() =>
    assertConfiguration(
      fixture(),
      { requirements: null },
      task,
      'first_config',
    ),
  );
  for (const [id, change] of matrix)
    for (const phase of ['first_config', 'after_input']) {
      const r = fixture(),
        q = { requirements: null };
      change(r, q);
      assert.throws(
        () => assertConfiguration(r, q, task, phase),
        reason(id, phase),
      );
    }
});

await test('comparison keeps unknown changes, emits only bounded allowlisted identifiers', () => {
  const pairs = [
    ['key_order_only', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['value_changed', { tools: [1, 2] }, { tools: [2, 1] }],
    ['missing', { SECRET_KEY: null }, {}],
    ['unexpected', {}, { SECRET_KEY: null }],
    [
      'value_changed',
      { SECRET_KEY: 'DO_NOT_LOG' },
      { SECRET_KEY: 'OTHER_SECRET' },
    ],
  ];
  for (const [category, a, b] of pairs) {
    const comparison = compareConfigurations(snapshot(a), snapshot(b));
    assert.equal(comparison.category, category);
    if (category === 'key_order_only')
      assert.doesNotThrow(() =>
        assertSameConfiguration(probeResult(a), probeResult(b)),
      );
    else
      assert.throws(
        () => assertSameConfiguration(probeResult(a), probeResult(b)),
        reason('CONFIG_MISMATCH', 'final_compare'),
      );
    const e = configFailure('CONFIG_MISMATCH', 'final_compare', { comparison });
    assert.equal(validDiagnostic(e.diagnostic), true);
    assert.doesNotMatch(
      JSON.stringify(e.diagnostic),
      /SECRET_KEY|DO_NOT_LOG|OTHER_SECRET/,
    );
    assert.ok(JSON.stringify(e.diagnostic).length < 1600);
  }
  for (const field of ['permissions', 'features', 'mcp_servers', 'tools']) {
    assert.throws(
      () =>
        assertSameConfiguration(
          probeResult({ [field]: false }),
          probeResult({ [field]: true }),
        ),
      reason('CONFIG_MISMATCH'),
    );
  }
  const a = probeResult({}),
    b = probeResult({});
  b.snapshot.requirements = { requirements: { network: true } };
  assert.throws(() => assertSameConfiguration(a, b), reason('CONFIG_MISMATCH'));
  b.receipt.accountType = 'apiKey';
  assert.throws(() => assertSameConfiguration(a, b), reason('ACCOUNT_CHANGED'));
});

function rpcProcess({ rpc, empty = false, exit = 0, malformed = false } = {}) {
  return async (_supervisor, args, options) => {
    assert.equal(args[1], 'app-server');
    assert.ok(!args.includes('exec') && args.includes('--strict-config'));
    let finish;
    const completed = new Promise((resolve) => {
      finish = resolve;
    });
    options.onStarted((line) => {
      const v = JSON.parse(line);
      if (!v.id || empty) return;
      const results = {
        initialize: {},
        'config/read': fixture(),
        'configRequirements/read': { requirements: null },
        'account/read': { account: { type: 'chatgpt', email: 'DO_NOT_LOG' } },
        'model/list': {
          data: [
            {
              model: LAB.model,
              supportedReasoningEfforts: [{ reasoningEffort: LAB.effort }],
            },
          ],
        },
      };
      const reply =
        v.method === rpc
          ? {
              id: v.id,
              error: {
                code: -32603,
                message: 'DO_NOT_LOG https://private.invalid',
              },
            }
          : { id: v.id, result: results[v.method] };
      options.onData(
        'stdout',
        Buffer.from(JSON.stringify(malformed ? { id: v.id } : reply) + '\n'),
      );
    }, finish);
    if (!empty) await completed;
    return { code: exit, reason: null };
  };
}
await test('real configProbe RPC/process paths produce distinct bounded receipts', async () => {
  const good = await configProbe(
    task,
    null,
    '',
    null,
    'first_config',
    rpcProcess(),
  );
  assert.equal(good.receipt.accountType, 'chatgpt');
  assert.ok(!JSON.stringify(good.receipt).includes('DO_NOT_LOG'));
  for (const method of [
    'initialize',
    'config/read',
    'configRequirements/read',
    'account/read',
    'model/list',
  ]) {
    await assert.rejects(
      configProbe(
        task,
        null,
        '',
        null,
        'after_input',
        rpcProcess({ rpc: method }),
      ),
      (e) => {
        assert.ok(reason('RPC_ERROR', 'after_input')(e));
        assert.equal(e.diagnostic.config.method, method);
        assert.equal(e.diagnostic.config.rpcCode, -32603);
        assert.doesNotMatch(JSON.stringify(e.diagnostic), /DO_NOT_LOG|https/);
        return true;
      },
    );
  }
  await assert.rejects(
    configProbe(
      task,
      null,
      '',
      null,
      'first_config',
      rpcProcess({ empty: true }),
    ),
    reason('DIAGNOSTIC_EMPTY'),
  );
  await assert.rejects(
    configProbe(
      task,
      null,
      '',
      null,
      'after_input',
      rpcProcess({ empty: true, exit: 2 }),
    ),
    reason('DIAGNOSTIC_PROCESS_FAILED'),
  );
  await assert.rejects(
    configProbe(
      task,
      null,
      '',
      null,
      'after_input',
      rpcProcess({ malformed: true }),
    ),
    reason('RPC_INVALID_RESPONSE'),
  );
});

await test('shared preparation and fixed diagnostic bundle cannot choose or reach provider spawn', async () => {
  const steps = [],
    input = preparationInput();
  const result = await prepareInvocation({
    task,
    ...input,
    first: probeResult({ a: 1, b: 2 }),
    prepare: async (t, p, s) => {
      assert.equal(t, task);
      assert.equal(p, input.prompt);
      assert.deepEqual(s, input.schema);
      steps.push('prepareInput');
      return ['input.txt', 'output', 'proposal.schema.json'];
    },
    inspect: async (phase) => {
      assert.equal(phase, 'after_input');
      steps.push('inspectLab');
    },
    probe: async (phase) => {
      assert.equal(phase, 'after_input');
      steps.push('second_configProbe');
      return probeResult({ b: 2, a: 1 });
    },
  });
  assert.deepEqual(steps, ['prepareInput', 'inspectLab', 'second_configProbe']);
  assert.equal(result.providerStarted, false);
  assert.equal(result.modelInvocations, 0);
  for (const extra of ['prompt', 'schema', 'model', 'command', 'path'])
    await assert.rejects(
      callLab({ operation: 'prepare-only', [extra]: 'malicious' }),
      { code: 'LAB_INPUT_REJECTED' },
    );
  const bundle = await labBundle();
  assert.ok(Buffer.byteLength(JSON.stringify(bundle)) < 262144);
  const runtime = await import(
    'data:text/javascript;base64,' +
      Buffer.from(bundle.source).toString('base64')
  );
  assert.equal(typeof runtime.runLab, 'function');
  const src = await readFile(
    new URL('../../agent/codex/wsl-runtime.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(
    src.indexOf("if (request.operation === 'prepare-only') return") <
      src.indexOf(
        'result = await supervise(supervisor, [LAB.binary, ...labExecArgs(task)]',
      ),
  );
  assert.ok(src.includes("if (request.operation !== 'invoke') fail"));
  const script = await readFile(
    new URL('../../scripts/lab/verify-pre-invocation.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    script,
    /operation: 'invoke'|live-smoke|DATABASE_URL|dispatch|claim|provider-start/,
  );
});

await test('config cause survives existing relay and cleanup receipt; legacy receipt stays valid', async () => {
  const error = configFailure('CONFIG_MISMATCH', 'final_compare', {
    comparison: compareConfigurations(
      snapshot({ secret: 1 }),
      snapshot({ secret: 2 }),
    ),
  });
  assert.deepEqual(
    diagnostic(diagnosticError(error.code, error.diagnostic)),
    error.diagnostic,
  );
  assert.equal(
    validDiagnostic(diagnostic({ code: 'LAB_CONFIG_CHANGED' })),
    true,
  );
  assert.equal(
    validDiagnostic({
      ...error.diagnostic,
      config: { ...error.diagnostic.config, reasonId: 'SECRET' },
    }),
    false,
  );
  const receipt = createInvocation({
    jobId: 'job_' + 'a'.repeat(32),
    attempt: 1,
    runtimeSha256: 'a'.repeat(64),
    inputSha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
    jobSpecSha256: 'd'.repeat(64),
  });
  receipt.failure(error);
  receipt.process({ confirmed: false, cleanupCode: 'STOP_UNCONFIRMED' });
  const value = receipt.finish({ code: 'STOP_UNCONFIRMED' });
  assert.equal(validInvocation(value), true);
  assert.deepEqual(value.primary, error.diagnostic);
  assert.equal(value.providerStarted, false);
  await mkdir('.test-results', { recursive: true });
  await writeFile(
    `.test-results/config-diagnostics-${process.platform}.json`,
    JSON.stringify(
      { synthetic: true, modelInvocations: 0, receipt: value },
      null,
      2,
    ) + '\n',
  );
});
