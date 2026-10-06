import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refuse = () => {
  throw Object.assign(Error('SMOKE_HISTORY_UNCERTAIN'), {
    code: 'SMOKE_HISTORY_UNCERTAIN',
  });
};
export async function unusedReservation(root) {
  try {
    const original = await readFile(path.join(root, 'real-codex-attempt.json'));
    const evidence = await readFile(
      path.join(root, 'real-codex-prior-proof.json'),
    );
    const previous = await readFile(
      path.join(root, 'post-login-smoke-report.json'),
    );
    if ([original, evidence, previous].some((b) => b.length > 32768)) refuse();
    const reservation = JSON.parse(original),
      proof = JSON.parse(evidence),
      report = JSON.parse(previous);
    if (
      reservation.maximumCalls !== 1 ||
      proof.version !== 1 ||
      !proof.beforeTestReset ||
      proof.reservationSha256 !== digest(original) ||
      proof.previousReportSha256 !== digest(previous) ||
      proof.previousHead !== report.headSha ||
      proof.modelInvocations !== 0 ||
      report.smoke?.modelInvocations !== 0 ||
      report.smoke.dispatchReached !== false ||
      report.database?.projects?.length !== 1 ||
      sha256Json(proof.row) !== sha256Json(report.database.projects[0]) ||
      proof.row.state !== 'queued' ||
      proof.row.version !== 1 ||
      [
        'registered_agents',
        'dispatches',
        'attempts',
        'invocation_permits',
        'results',
      ].some((k) => proof.row[k] !== 0) ||
      JSON.stringify(proof.row.events) !== '["job_queued"]' ||
      !Number.isFinite(Date.parse(reservation.reservedAt)) ||
      !Number.isFinite(Date.parse(proof.capturedAt)) ||
      Date.parse(proof.capturedAt) < Date.parse(reservation.reservedAt)
    )
      refuse();
    return {
      reservationSha256: digest(original),
      priorProofSha256: digest(evidence),
      previousReportSha256: digest(previous),
    };
  } catch {
    refuse();
  }
}
export async function continueReservation(root, context) {
  const binding = await unusedReservation(root);
  if (
    !context ||
    !/^[a-f0-9-]{36}$/.test(context.projectId) ||
    !/^job_[a-f0-9]{32}$/.test(context.jobId)
  )
    refuse();
  const value = {
    version: 1,
    runId: randomUUID(),
    ...binding,
    ...context,
    continuedAt: new Date().toISOString(),
    maximumCalls: 1,
  };
  // These append-only markers are intentionally retained on all outcomes.
  // An absent row after DB reset is never consulted as evidence of no call.
  await writeFile(
    path.join(root, 'real-codex-continuation.json'),
    JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx' },
  );
  return value;
}
export async function consumeProviderStart(root, continuation) {
  const saved = JSON.parse(
    await readFile(path.join(root, 'real-codex-continuation.json'), 'utf8'),
  );
  if (sha256Json(saved) !== sha256Json(continuation)) refuse();
  await unusedReservation(root);
  await writeFile(
    path.join(root, 'real-codex-provider-start.json'),
    JSON.stringify(
      {
        runId: saved.runId,
        jobId: saved.jobId,
        reservationSha256: saved.reservationSha256,
        at: new Date().toISOString(),
        phase: 'before_dispatch',
        maximumCalls: 1,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
}

// This is a specific owner authorization, not a caller-selected spending limit.
export const SMOKE_AUTHORIZATION = Object.freeze({
  id: 'pr15-live-smoke-02',
  reviewedHead: '27ac6a2a0d280a1840cabdd57b66e538b97ad989',
  model: 'gpt-6-astra',
  effort: 'ultra',
  maximumCalls: 1,
});
const historicalFiles = [
  'real-codex-attempt.json',
  'real-codex-prior-proof.json',
  'post-login-smoke-report.json',
  'real-codex-continuation.json',
  'real-codex-provider-start.json',
  'real-codex-terminal-failure.json',
  'real-codex-post-smoke-database.json',
  'pre-invocation-preflight.json',
  'startup-24f44a61-8545-4465-8c27-13316010e109.json',
  'actual-smoke-failed-reload.json',
  'actual-smoke-failed-desktop.png',
  'actual-smoke-failed-mobile.png',
];
export async function preservedConsumedHistory(root) {
  try {
    const archive = path.join(root, 'consumed-archive-ce270a0');
    const bytes = await readFile(path.join(archive, 'manifest.json'));
    if (bytes.length > 16384) refuse();
    const history = JSON.parse(bytes);
    if (
      history.budget !== 'consumed-no-retry' ||
      history.state?.state !== 'failed' ||
      history.state.attempts !== 1 ||
      history.state.permits !== 1 ||
      history.state.results !== 0 ||
      !Array.isArray(history.files) ||
      history.files.length !== historicalFiles.length ||
      history.files
        .map((f) => f.file)
        .sort()
        .join() !== [...historicalFiles].sort().join()
    )
      refuse();
    for (const entry of history.files) {
      if (
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 1 ||
        entry.bytes > 2000000
      )
        refuse();
      for (const directory of [root, archive]) {
        const file = await readFile(path.join(directory, entry.file));
        if (file.length !== entry.bytes || digest(file) !== entry.sha256)
          refuse();
      }
    }
    return {
      archiveManifestSha256: digest(bytes),
      reservationSha256: history.files.find(
        (f) => f.file === 'real-codex-attempt.json',
      ).sha256,
    };
  } catch {
    refuse();
  }
}
export function authorizationDirectory(root) {
  return path.join(root, SMOKE_AUTHORIZATION.id);
}
function validBinding(value) {
  return (
    value &&
    Object.keys(value).sort().join() ===
      'jobId,projectId,revision,siteSpecSha256' &&
    /^[a-f0-9-]{36}$/.test(value.projectId) &&
    /^job_[a-f0-9]{32}$/.test(value.jobId) &&
    value.revision === 1 &&
    /^[a-f0-9]{64}$/.test(value.siteSpecSha256)
  );
}
async function readReceipt(directory, name) {
  const bytes = await readFile(path.join(directory, name));
  if (bytes.length > 16384) refuse();
  return JSON.parse(bytes);
}
export async function writeSmokeEvidence(directory, name, value) {
  if (!/^[a-z0-9-]{1,120}\.json$/.test(name)) refuse();
  const data = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(data) > 65536) refuse();
  await writeFile(path.join(directory, name), data, { flag: 'wx' });
}
export async function reserveAuthorization(root, authorizationId, context) {
  if (
    authorizationId !== SMOKE_AUTHORIZATION.id ||
    !context ||
    Object.keys(context).sort().join() !==
      'headSha,inputSha256,manifestSha256' ||
    !/^[a-f0-9]{40}$/.test(context.headSha) ||
    !/^[a-f0-9]{64}$/.test(context.inputSha256) ||
    !/^[a-f0-9]{64}$/.test(context.manifestSha256)
  )
    refuse();
  const history = await preservedConsumedHistory(root);
  const directory = authorizationDirectory(root);
  // Exclusive mkdir also locks preparatory work and evidence names. Never remove
  // this directory on failure; partial creation is fail-closed, not a refund.
  await mkdir(directory);
  const value = {
    version: 1,
    ...SMOKE_AUTHORIZATION,
    ...context,
    ...history,
    runId: randomUUID(),
    reservedAt: new Date().toISOString(),
  };
  await writeSmokeEvidence(directory, 'reservation.json', value);
  return value;
}
export async function bindAuthorization(root, reservation, binding) {
  const directory = authorizationDirectory(root);
  if (
    !validBinding(binding) ||
    sha256Json(await readReceipt(directory, 'reservation.json')) !==
      sha256Json(reservation)
  )
    refuse();
  await preservedConsumedHistory(root);
  const value = {
    ...binding,
    authorizationId: SMOKE_AUTHORIZATION.id,
    runId: reservation.runId,
    inputSha256: reservation.inputSha256,
    reservationSha256: sha256Json(reservation),
  };
  await writeSmokeEvidence(directory, 'job-binding.json', value);
  return value;
}
export async function consumeAuthorization(root, reservation, binding) {
  const directory = authorizationDirectory(root);
  if (
    sha256Json(await readReceipt(directory, 'reservation.json')) !==
      sha256Json(reservation) ||
    sha256Json(await readReceipt(directory, 'job-binding.json')) !==
      sha256Json(binding) ||
    binding.reservationSha256 !== sha256Json(reservation)
  )
    refuse();
  await preservedConsumedHistory(root);
  const value = {
    authorizationId: SMOKE_AUTHORIZATION.id,
    runId: reservation.runId,
    jobId: binding.jobId,
    projectId: binding.projectId,
    inputSha256: reservation.inputSha256,
    headSha: reservation.headSha,
    siteSpecSha256: binding.siteSpecSha256,
    revision: binding.revision,
    manifestSha256: reservation.manifestSha256,
    phase: 'before_dispatch',
    state: 'consumed',
    maximumCalls: 1,
    at: new Date().toISOString(),
  };
  await writeSmokeEvidence(directory, 'provider-start.json', value);
  return value;
}
