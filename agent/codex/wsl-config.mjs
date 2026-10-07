import { createHash } from 'node:crypto';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
import {
  diagnostic,
  diagnosticError,
  validConfigDiagnostic,
} from './invocation-receipt.mjs';
import { LAB, LAB_DISABLED, labFilesystem } from './wsl-policy.mjs';

export function configFingerprint(config, requirements) {
  return sha256Json({ config, requirements });
}

export function configFailure(reasonId, phase, details = {}) {
  const config = {
    reasonId,
    phase,
    method: null,
    rpcCode: null,
    processExitCode: null,
    comparison: null,
    ...details,
  };
  if (!validConfigDiagnostic(config))
    throw Error('Invalid internal config diagnostic');
  return diagnosticError('LAB_CONFIG_CHANGED', {
    ...diagnostic(
      { code: 'LAB_CONFIG_CHANGED' },
      { source: 'sandbox', stage: 'preflight', category: 'config' },
    ),
    config,
  });
}

export function assertConfiguration(read, requirements, task, phase) {
  const config = read?.config;
  const deny = (reason) => {
    throw configFailure(reason, phase);
  };
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !requirements ||
    !Object.hasOwn(requirements, 'requirements') ||
    !Array.isArray(read.layers)
  )
    deny('RPC_INVALID_RESPONSE');
  if (
    read.layers.some(
      (l) =>
        l.name?.type !== 'sessionFlags' && Object.keys(l.config ?? {}).length,
    )
  )
    deny('INHERITED_CONFIG');
  if (config.sandbox_mode) deny('LEGACY_SANDBOX');
  if (config.default_permissions !== LAB.profile) deny('WRONG_PROFILE');
  const actual = config.permissions?.[LAB.profile]?.filesystem;
  const expected = labFilesystem(task);
  if (
    actual?.glob_scan_max_depth !== null ||
    Object.keys(actual ?? {}).length !== Object.keys(expected).length + 1 ||
    Object.entries(expected).some(([k, v]) => actual[k] !== v)
  )
    deny('FILESYSTEM_POLICY');
  if (config.approval_policy !== 'never') deny('APPROVAL_POLICY');
  if (config.web_search !== 'disabled') deny('WEB_POLICY');
  const flags = read.layers.find(
    (l) => l.name?.type === 'sessionFlags',
  )?.config;
  if (
    flags?.tools?.update_plan?.enabled !== false ||
    flags?.tools?.experimental_request_user_input?.enabled !== false
  )
    deny('TOOLS_POLICY');
  if (config.permissions?.[LAB.profile]?.network?.enabled !== false)
    deny('NETWORK_POLICY');
  if (Object.keys(config.mcp_servers ?? {}).length) deny('MCP_POLICY');
  if (
    LAB_DISABLED.some(
      (flag) =>
        config.features?.[flag] !== false &&
        config.features?.[flag]?.enabled !== false,
    )
  )
    deny('FEATURE_POLICY');
  if (
    requirements.requirements !== null &&
    Object.keys(requirements.requirements ?? {}).length
  )
    deny('MANAGED_REQUIREMENTS');
}

const fields = new Set([
  'approval_policy',
  'web_search',
  'sandbox_mode',
  'default_permissions',
  'permissions',
  'features',
  'mcp_servers',
  'tools',
  'requirements',
]);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function compareConfigurations(before, after) {
  const counts = { value_changed: 0, missing: 0, unexpected: 0 };
  const changedFields = new Set();
  let unknownCount = 0;
  const changed = (category, field) => {
    counts[category] = Math.min(10000, counts[category] + 1);
    if (fields.has(field)) changedFields.add(field);
    else unknownCount = Math.min(10000, unknownCount + 1);
  };
  const visit = (a, b, path = []) => {
    if (sha256Json(a) === sha256Json(b)) return;
    const field = path[0] === 'requirements' ? 'requirements' : path[1];
    if (object(a) && object(b)) {
      for (const key of Object.keys(a)) {
        if (!Object.hasOwn(b, key))
          changed('missing', path.length === 1 ? key : field);
        else visit(a[key], b[key], [...path, key]);
      }
      for (const key of Object.keys(b))
        if (!Object.hasOwn(a, key))
          changed('unexpected', path.length === 1 ? key : field);
    } else changed('value_changed', field);
  };
  visit(before, after);
  const raw = (v) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const beforeSha256 = sha256Json(before),
    afterSha256 = sha256Json(after);
  const beforeRawSha256 = raw(before),
    afterRawSha256 = raw(after);
  return {
    category:
      beforeSha256 === afterSha256
        ? beforeRawSha256 === afterRawSha256
          ? null
          : 'key_order_only'
        : counts.missing
          ? 'missing'
          : counts.unexpected
            ? 'unexpected'
            : 'value_changed',
    beforeSha256,
    afterSha256,
    beforeRawSha256,
    afterRawSha256,
    fields: [...changedFields].sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    unknownCount,
    counts,
  };
}

export function assertSameConfiguration(first, current) {
  if (
    first.receipt.accountType !== current.receipt.accountType ||
    current.receipt.accountType !== 'chatgpt'
  )
    throw configFailure('ACCOUNT_CHANGED', 'final_compare');
  const comparison = compareConfigurations(first.snapshot, current.snapshot);
  if (comparison.beforeSha256 !== comparison.afterSha256)
    throw configFailure('CONFIG_MISMATCH', 'final_compare', { comparison });
  return comparison;
}

// No provider capability is accepted here. Both callers stop at this boundary;
// only invoke's separate, explicit branch below it can spawn a generator.
export async function prepareInvocation({
  task,
  prompt,
  schema,
  first,
  probe,
  prepare,
  inspect,
}) {
  const inputInventory = await prepare(task, prompt, schema);
  await inspect('after_input');
  const current = await probe('after_input');
  const comparison = assertSameConfiguration(first, current);
  return {
    inputInventory,
    comparison,
    phase: 'final_compare',
    providerStarted: false,
    modelInvocations: 0,
  };
}
