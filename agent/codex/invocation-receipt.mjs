import { createHash, randomUUID } from 'node:crypto';
import { RunnerError } from '../runner-error.mjs';

export const INVOCATION_TYPE = 'B2B_CODEX_INVOCATION';
const sources = new Set([
  'cli_exit',
  'provider_event',
  'stderr',
  'parser',
  'transport',
  'sandbox',
]);
const stages = new Set([
  'preflight',
  'input',
  'provider_start',
  'stream',
  'parser',
  'process_exit',
  'cleanup',
  'complete',
]);
const categories = new Set([
  'unclassified',
  'protocol',
  'config',
  'auth',
  'quota',
  'schema',
  'timeout',
  'cancelled',
  'isolation',
]);
const codes = new Set([
  'CODEX_PROCESS_FAILED',
  'CODEX_INVALID_OUTPUT',
  'CODEX_OUTPUT_LIMIT',
  'CODEX_SAFE_PROFILE_UNVERIFIED',
  'CODEX_LOGIN_REQUIRED',
  'CODEX_QUOTA',
  'CODEX_TIMEOUT',
  'CODEX_NOT_AVAILABLE',
  'CODEX_UNSUPPORTED_VERSION',
  'CODEX_MODEL_NOT_AVAILABLE',
  'CODEX_MODEL_QUERY_FAILED',
  'CODEX_MODEL_CAPABILITY_MISMATCH',
  'CODEX_ISOLATION_UNVERIFIED',
  'LAB_SETUP_REQUIRED',
  'LAB_HOST_MOUNTS_PRESENT',
  'LAB_CONFIG_CHANGED',
  'LAB_PROBE_INCOMPLETE',
  'LAB_PROBE_FAILED',
  'LAB_INPUT_REJECTED',
  'RUNNER_STOPPED',
  'STOP_UNCONFIRMED',
  'INVALID_ASSIGNMENT',
]);
const eventTypes = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
  'turn.failed',
  'turn.completed',
]);
export const USAGE_KEYS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const exact = (v, keys) =>
  object(v) && Object.keys(v).sort(compare).join() === [...keys].sort(compare).join();
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const iso = (v) =>
  typeof v === 'string' &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const signal = (v) =>
  v === null || (typeof v === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(v));
export const validUsage = (v) =>
  exact(v, USAGE_KEYS) && USAGE_KEYS.every((k) => integer(v[k]));

export function diagnostic(
  error,
  {
    source = 'transport',
    stage = 'stream',
    category = 'unclassified',
    text,
  } = {},
) {
  if (validDiagnostic(error?.diagnostic)) return { ...error.diagnostic };
  const value =
    typeof text === 'string'
      ? text
      : typeof error?.message === 'string'
        ? error.message
        : '';
  // Only a bounded fingerprint of unknown data leaves the process, never its text.
  const sample = Buffer.from(value.slice(0, 4096)).subarray(0, 4096);
  return {
    source: sources.has(source) ? source : 'transport',
    stage: stages.has(stage) ? stage : 'stream',
    primaryCode: codes.has(error?.code) ? error.code : 'CODEX_PROCESS_FAILED',
    category: categories.has(category) ? category : 'unclassified',
    httpStatus: null,
    byteLength: Buffer.byteLength(value),
    fingerprintBytes: sample.length,
    fingerprint: value
      ? createHash('sha256').update(sample).digest('hex')
      : null,
  };
}
export function validDiagnostic(v) {
  return (
    exact(v, [
      'source',
      'stage',
      'primaryCode',
      'category',
      'httpStatus',
      'byteLength',
      'fingerprintBytes',
      'fingerprint',
    ]) &&
    sources.has(v.source) &&
    stages.has(v.stage) &&
    codes.has(v.primaryCode) &&
    categories.has(v.category) &&
    (v.httpStatus === null ||
      (Number.isInteger(v.httpStatus) &&
        v.httpStatus >= 100 &&
        v.httpStatus <= 599)) &&
    integer(v.byteLength) &&
    integer(v.fingerprintBytes) &&
    v.fingerprintBytes <= 4096 &&
    v.fingerprintBytes <= v.byteLength &&
    (v.fingerprint === null ? v.byteLength === 0 : hash(v.fingerprint))
  );
}
export function diagnosticError(code, details) {
  const error = new RunnerError(
    codes.has(code) ? code : 'CODEX_PROCESS_FAILED',
  );
  error.diagnostic = validDiagnostic(details)
    ? { ...details }
    : diagnostic(error);
  return error;
}
export function validProcessResult(v) {
  return (
    object(v) &&
    Object.keys(v).every((k) =>
      [
        'started',
        'code',
        'signalCode',
        'confirmed',
        'reason',
        'diagnostic',
        'cleanupCode',
      ].includes(k),
    ) &&
    (v.started === undefined || typeof v.started === 'boolean') &&
    (v.code === undefined ||
      v.code === null ||
      (Number.isInteger(v.code) && v.code >= 0 && v.code <= 4294967295)) &&
    (v.signalCode === undefined || signal(v.signalCode)) &&
    (v.confirmed === undefined || typeof v.confirmed === 'boolean') &&
    (v.reason === undefined ||
      [
        null,
        'TIMEOUT',
        'STOP',
        'RELAY_LOST',
        'PARENT_LOST',
        'CONTROL_LIMIT',
        'CONTROL_INVALID',
        'OUTPUT_LIMIT',
        'DESCENDANTS',
      ].includes(v.reason)) &&
    (v.diagnostic === undefined ||
      v.diagnostic === null ||
      validDiagnostic(v.diagnostic)) &&
    (v.cleanupCode === undefined ||
      [null, 'STOP_UNCONFIRMED'].includes(v.cleanupCode))
  );
}
export function createInvocation({
  runId = randomUUID(),
  jobId,
  attempt,
  runtimeSha256,
  inputSha256,
  schemaSha256,
  jobSpecSha256,
}) {
  const at = new Date().toISOString();
  const value = {
    type: INVOCATION_TYPE,
    version: '1.0.0',
    runId,
    jobId,
    attempt,
    runtimeSha256,
    inputSha256,
    schemaSha256,
    jobSpecSha256,
    stage: 'preflight',
    primary: null,
    errorCode: null,
    exitCode: null,
    signalCode: null,
    lastValidEvent: null,
    eventCount: 0,
    terminalSeen: false,
    usage: null,
    providerStarted: false,
    confirmedStop: null,
    cleanupCode: null,
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
  };
  if (!validInvocation(value)) throw new RunnerError('INVALID_ASSIGNMENT');
  const touch = () => {
    value.updatedAt = new Date().toISOString();
  };
  const fail = (error, options) => {
    value.primary ??= diagnostic(error, {
      ...options,
      stage: options?.stage ?? value.stage,
    });
    touch();
  };
  return {
    stage(stage) {
      if (!stages.has(stage)) throw Error('Invalid internal invocation stage');
      value.stage = stage;
      touch();
    },
    failure: fail,
    event(type) {
      if (!eventTypes.has(type) || value.eventCount >= 100)
        throw new RunnerError('CODEX_OUTPUT_LIMIT');
      value.stage = 'stream';
      value.lastValidEvent = type;
      value.eventCount++;
      touch();
    },
    terminal() {
      value.terminalSeen = true;
      touch();
    },
    usage(usage) {
      if (!validUsage(usage)) throw new RunnerError('CODEX_INVALID_OUTPUT');
      value.usage = { ...usage };
      touch();
    },
    started() {
      value.providerStarted = true;
      value.stage = 'provider_start';
      touch();
    },
    process(result) {
      if (result?.started === true) {
        value.providerStarted = true;
        if (value.stage === 'input') value.stage = 'provider_start';
      }
      if (Number.isInteger(result?.code)) value.exitCode = result.code;
      if (signal(result?.signalCode) && result.signalCode !== undefined)
        value.signalCode = result.signalCode;
      if (typeof result?.confirmed === 'boolean')
        value.confirmedStop = result.confirmed;
      if (validDiagnostic(result?.diagnostic))
        value.primary ??= { ...result.diagnostic };
      if (
        result?.confirmed === false ||
        result?.cleanupCode === 'STOP_UNCONFIRMED'
      )
        value.cleanupCode = 'STOP_UNCONFIRMED';
      if (result?.reason === 'TIMEOUT')
        fail(
          { code: 'CODEX_TIMEOUT' },
          { source: 'transport', category: 'timeout' },
        );
      else if (result?.reason && !value.primary)
        fail(
          { code: 'RUNNER_STOPPED' },
          { source: 'transport', category: 'cancelled' },
        );
      touch();
    },
    finish(error) {
      if (value.finishedAt) return this.snapshot();
      if (error) fail(error);
      if (error?.code === 'STOP_UNCONFIRMED') {
        value.cleanupCode = 'STOP_UNCONFIRMED';
        value.confirmedStop = false;
      }
      value.errorCode = value.cleanupCode ?? value.primary?.primaryCode ?? null;
      value.stage = value.cleanupCode
        ? 'cleanup'
        : (value.primary?.stage ?? 'complete');
      value.finishedAt = new Date().toISOString();
      touch();
      return this.snapshot();
    },
    snapshot() {
      return structuredClone(value);
    },
  };
}
export function validInvocation(v) {
  return (
    exact(v, [
      'type',
      'version',
      'runId',
      'jobId',
      'attempt',
      'runtimeSha256',
      'inputSha256',
      'schemaSha256',
      'jobSpecSha256',
      'stage',
      'primary',
      'errorCode',
      'exitCode',
      'signalCode',
      'lastValidEvent',
      'eventCount',
      'terminalSeen',
      'usage',
      'providerStarted',
      'confirmedStop',
      'cleanupCode',
      'startedAt',
      'updatedAt',
      'finishedAt',
    ]) &&
    v.type === INVOCATION_TYPE &&
    v.version === '1.0.0' &&
    /^[a-f0-9-]{36}$/.test(v.runId) &&
    /^job_[a-f0-9]{32}$/.test(v.jobId) &&
    v.attempt === 1 &&
    [v.runtimeSha256, v.inputSha256, v.schemaSha256, v.jobSpecSha256].every(
      hash,
    ) &&
    stages.has(v.stage) &&
    (v.primary === null || validDiagnostic(v.primary)) &&
    (v.errorCode === null || codes.has(v.errorCode)) &&
    (v.exitCode === null ||
      (Number.isInteger(v.exitCode) &&
        v.exitCode >= -2147483648 &&
        v.exitCode <= 4294967295)) &&
    signal(v.signalCode) &&
    (v.lastValidEvent === null || eventTypes.has(v.lastValidEvent)) &&
    integer(v.eventCount) &&
    v.eventCount <= 100 &&
    typeof v.terminalSeen === 'boolean' &&
    (v.usage === null || validUsage(v.usage)) &&
    typeof v.providerStarted === 'boolean' &&
    (v.confirmedStop === null || typeof v.confirmedStop === 'boolean') &&
    [null, 'STOP_UNCONFIRMED'].includes(v.cleanupCode) &&
    iso(v.startedAt) &&
    iso(v.updatedAt) &&
    (v.finishedAt === null || iso(v.finishedAt)) &&
    Buffer.byteLength(JSON.stringify(v)) <= 4096
  );
}
