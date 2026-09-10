import { LAB, LAB_CHECKS } from '../../agent/codex/wsl-policy.mjs';

const keys = 'checkedAt,configSha256,profile,transport';
export function validWslAdmission(value) {
  return (
    !!value &&
    Object.keys(value).sort().join() === keys &&
    value.transport === 'wsl2' &&
    value.profile === LAB.profile &&
    typeof value.checkedAt === 'string' &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    new Date(value.checkedAt).toISOString() === value.checkedAt &&
    typeof value.configSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.configSha256)
  );
}
// A scoped local-client assertion, NOT remote attestation or operator consent.
// The trusted Runner owns these measurements; the server still requires pairing.
export function measuredWslAdmission(receipt, now = Date.now()) {
  const fs = receipt?.canary?.filesystem;
  if (
    receipt?.status !== 'ready' ||
    receipt.accountType !== 'chatgpt' ||
    receipt.uid !== LAB.uid ||
    receipt.hostMountsAbsent !== true ||
    receipt.home !== LAB.home ||
    receipt.codexHome !== LAB.codexHome ||
    receipt.managedRequirements !== 'included' ||
    receipt.userConfig !== 'absent' ||
    Object.entries(LAB.hashes).some(([k, v]) => receipt.hashes?.[k] !== v) ||
    receipt.canary?.completed !== true ||
    !/^[a-f0-9]{32}$/.test(receipt.canary?.nonce) ||
    Object.keys(receipt.canary?.checks ?? {}).length !== LAB_CHECKS.length ||
    LAB_CHECKS.some((k) => receipt.canary.checks[k] !== true) ||
    receipt.canary.connections !== 0 ||
    receipt.canary.positiveControls?.length !== 4 ||
    receipt.canary.positiveControls.some((v) => v !== true) ||
    [
      'inputRead',
      'outputWrite',
      'inputDenied',
      'siblingDenied',
      'symlinkDenied',
      'credentialDenied',
      'outsideUnchanged',
    ].some((k) => fs?.[k] !== true)
  )
    throw Object.assign(Error('CODEX_ISOLATION_UNVERIFIED'), {
      code: 'CODEX_ISOLATION_UNVERIFIED',
    });
  const admission = {
    transport: 'wsl2',
    profile: LAB.profile,
    checkedAt: new Date(now).toISOString(),
    configSha256: receipt.configSha256,
  };
  if (!validWslAdmission(admission))
    throw Object.assign(Error('LAB_CONFIG_CHANGED'), {
      code: 'LAB_CONFIG_CHANGED',
    });
  return admission;
}
export function officialWslReady(runtime) {
  return (
    runtime?.provider === 'codex' &&
    runtime.status === 'ready' &&
    runtime.cliVersion === LAB.version &&
    validWslAdmission(runtime.admission)
  );
}
export function freshWslAdmission(runtime, now = Date.now()) {
  return (
    officialWslReady(runtime) &&
    now >= Date.parse(runtime.admission.checkedAt) &&
    now - Date.parse(runtime.admission.checkedAt) <= 60000
  );
}
