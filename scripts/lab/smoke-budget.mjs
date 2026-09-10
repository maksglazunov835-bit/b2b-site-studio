import { readFile, writeFile } from 'node:fs/promises';
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
