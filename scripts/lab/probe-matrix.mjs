const windowsChecks = [
  'sandboxOfflineUser',
  'inputRead',
  'outputWrite',
  'inputWriteDenied',
  'siblingReadDenied',
  'siblingWriteDenied',
  'junctionReadDenied',
  'alternateReadDenied',
  'loopbackBlocked',
  'ipv6Blocked',
  'inheritedSecretAbsent',
];

// A diagnostic pass is not permission to invoke a model or use other tool surfaces.
export function windowsProbePassed({
  exitCode,
  checks,
  positiveControls,
  connections,
  outsideUnchanged,
}) {
  return (
    exitCode === 0 &&
    checks !== null &&
    typeof checks === 'object' &&
    !Array.isArray(checks) &&
    Object.keys(checks).length === windowsChecks.length &&
    windowsChecks.every(
      (key) => Object.hasOwn(checks, key) && checks[key] === true,
    ) &&
    positiveControls?.['127.0.0.1'] === true &&
    positiveControls?.['::1'] === true &&
    connections === 0 &&
    outsideUnchanged === true
  );
}
