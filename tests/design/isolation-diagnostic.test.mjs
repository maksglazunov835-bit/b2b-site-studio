import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsProbePassed } from '../../scripts/lab/probe-matrix.mjs';

const complete = () => ({
  exitCode: 0,
  positiveControls: { '127.0.0.1': true, '::1': true },
  connections: 0,
  outsideUnchanged: true,
  checks: {
    sandboxOfflineUser: true,
    inputRead: true,
    outputWrite: true,
    inputWriteDenied: true,
    siblingReadDenied: true,
    siblingWriteDenied: true,
    junctionReadDenied: true,
    alternateReadDenied: true,
    loopbackBlocked: true,
    ipv6Blocked: true,
    inheritedSecretAbsent: true,
  },
});
await test('diagnostic requires reachable positive-control listeners, not an offline service', () => {
  assert.equal(windowsProbePassed(complete()), true);
  for (const host of ['127.0.0.1', '::1']) {
    const receipt = complete();
    receipt.positiveControls[host] = false;
    assert.equal(windowsProbePassed(receipt), false);
  }
  assert.equal(
    windowsProbePassed({ ...complete(), positiveControls: undefined }),
    false,
  );
});
await test('zero exit, absent or renamed assertions cannot substitute for a complete matrix', () => {
  for (const checks of [
    null,
    {},
    [],
    { ...complete().checks, unexpected: true },
  ])
    assert.equal(windowsProbePassed({ ...complete(), checks }), false);
  const receipt = complete();
  delete receipt.checks.inputRead;
  receipt.checks.other = true;
  assert.equal(windowsProbePassed(receipt), false);
});
await test('any failed check, connection, mutation or abnormal exit blocks diagnostic approval', () => {
  for (const key of Object.keys(complete().checks)) {
    const receipt = complete();
    receipt.checks[key] = false;
    assert.equal(windowsProbePassed(receipt), false);
  }
  for (const change of [
    { exitCode: null },
    { exitCode: 1 },
    { connections: 1 },
    { outsideUnchanged: false },
  ])
    assert.equal(windowsProbePassed({ ...complete(), ...change }), false);
});
