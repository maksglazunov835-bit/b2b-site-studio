import { randomUUID } from 'node:crypto';
export const STAGES = [
  'bootstrap_import',
  'options',
  'preflight',
  'pairing_input',
  'manifest_validation',
  'registration',
  'first_heartbeat',
];
export const STARTUP_CODES = new Set([
  'TEST_DATABASE_URL_REQUIRED',
  'TEST_DATABASE_RESET_REFUSED',
  'RUNNER_INTERNAL_ERROR',
  'RUNNER_BOOTSTRAP_ERROR',
  'RUNNER_SPAWN_FAILED',
  'RUNNER_STOPPED',
  'STOP_UNCONFIRMED',
  'INVALID_OPTIONS',
  'LOCAL_ORIGIN_REQUIRED',
  'UNSUPPORTED_OS',
  'UNSAFE_RUNNER_ENVIRONMENT',
  'INVALID_PAIRING_INPUT',
  'INPUT_TIMEOUT',
  'INPUT_CANCELLED',
  'PAIRING_EXPIRED',
  'PAIRING_REVOKED',
  'PAIRING_CONSUMED',
  'UNAUTHORIZED_AGENT',
  'AGENT_REVOKED',
  'INCOMPATIBLE_PROTOCOL_VERSION',
  'PERSISTENCE_DISABLED',
  'VALIDATION_FAILED',
  'VALIDATOR_MISMATCH',
  'EXECUTION_SCOPE_MISMATCH',
  'INVALID_RESPONSE',
  'REQUEST_REJECTED',
  'PLATFORM_UNAVAILABLE',
  'NETWORK_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'REDIRECT_REFUSED',
  'RESPONSE_TOO_LARGE',
  'CODEX_NOT_AVAILABLE',
  'CODEX_UNSUPPORTED_VERSION',
  'CODEX_LOGIN_REQUIRED',
  'CODEX_AUTH_UNSUPPORTED',
  'CODEX_SAFE_PROFILE_UNVERIFIED',
  'CODEX_MODEL_NOT_AVAILABLE',
  'CODEX_MODEL_QUERY_FAILED',
  'CODEX_MODEL_CAPABILITY_MISMATCH',
  'CODEX_ISOLATION_UNVERIFIED',
  'INVALID_CODEX_RUNTIME',
  'LAB_SETUP_REQUIRED',
  'LAB_HOST_MOUNTS_PRESENT',
  'LAB_CONFIG_CHANGED',
  'CODEX_TIMEOUT',
  'STARTUP_TIMEOUT',
  'STARTUP_DIAGNOSTIC_INVALID',
  'STARTUP_OUTPUT_LIMIT',
  'TEST_PROVIDER_DISABLED',
  'CODEX_QUOTA',
  'CODEX_INVALID_OUTPUT',
  'CODEX_OUTPUT_LIMIT',
  'CODEX_PROCESS_FAILED',
  'INVOCATION_UNCERTAIN',
  'SMOKE_HISTORY_UNCERTAIN',
  'REAL_SMOKE_TERMINAL_FAILURE_NO_RETRY',
  'LIVE_SMOKE_NOT_AUTHORIZED',
]);
export function safeStartupCode(error, stage) {
  if (STARTUP_CODES.has(error?.code)) return error.code;
  return stage === 'bootstrap_import'
    ? 'RUNNER_BOOTSTRAP_ERROR'
    : 'RUNNER_INTERNAL_ERROR';
}
export function createStartup({
  runId = randomUUID(),
  startedAt = new Date().toISOString(),
  send = (value) => process.send?.(value),
} = {}) {
  let value = {
    type: 'B2B_RUNNER_STARTUP',
    runId,
    sequence: 0,
    startedAt,
    updatedAt: startedAt,
    currentStage: 'bootstrap_import',
    lastCompletedStage: null,
    errorCode: null,
    httpStatus: null,
    httpErrorCode: null,
    stopConfirmed: false,
  };
  const emit = () => {
    value = {
      ...value,
      sequence: value.sequence + 1,
      updatedAt: new Date().toISOString(),
    };
    if (value.sequence <= 24) send({ ...value });
  };
  emit();
  return {
    begin(stage) {
      if (!STAGES.includes(stage)) throw Error('Invalid internal stage');
      value.currentStage = stage;
      emit();
    },
    complete(stage) {
      if (value.currentStage !== stage) throw Error('Invalid internal stage');
      value.lastCompletedStage = stage;
      emit();
    },
    fail(error) {
      value.errorCode = safeStartupCode(error, value.currentStage);
      value.httpStatus =
        Number.isInteger(error?.httpStatus) &&
        error.httpStatus >= 100 &&
        error.httpStatus <= 599
          ? error.httpStatus
          : null;
      value.httpErrorCode = STARTUP_CODES.has(error?.httpErrorCode)
        ? error.httpErrorCode
        : null;
      emit();
    },
    stop(confirmed) {
      value.stopConfirmed =
        confirmed === true && value.errorCode !== 'STOP_UNCONFIRMED';
      emit();
    },
    snapshot() {
      return { ...value };
    },
  };
}
export function validStartup(value) {
  return (
    value &&
    Object.keys(value).sort().join() ===
      'currentStage,errorCode,httpErrorCode,httpStatus,lastCompletedStage,runId,sequence,startedAt,stopConfirmed,type,updatedAt' &&
    value.type === 'B2B_RUNNER_STARTUP' &&
    /^[a-f0-9-]{36}$/.test(value.runId) &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    value.sequence <= 24 &&
    STAGES.includes(value.currentStage) &&
    (value.lastCompletedStage === null ||
      STAGES.includes(value.lastCompletedStage)) &&
    [value.errorCode, value.httpErrorCode].every(
      (v) => v === null || STARTUP_CODES.has(v),
    ) &&
    (value.httpStatus === null ||
      (Number.isInteger(value.httpStatus) &&
        value.httpStatus >= 100 &&
        value.httpStatus <= 599)) &&
    typeof value.stopConfirmed === 'boolean' &&
    [value.startedAt, value.updatedAt].every(
      (v) =>
        typeof v === 'string' &&
        Number.isFinite(Date.parse(v)) &&
        new Date(v).toISOString() === v,
    )
  );
}
