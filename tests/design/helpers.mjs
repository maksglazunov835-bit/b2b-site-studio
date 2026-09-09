import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createProject } from '../../server/persistence/service.mjs';
import { jobs } from '../../server/jobs/service.mjs';
import { createAgentService } from '../../server/agents/service.mjs';
import { createExecutionService } from '../../server/execution/service.mjs';
import { newSecret } from '../../server/agents/requests.mjs';
import { ADAPTER, modelEvidence } from '../../server/design/contract.mjs';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import { runnerEnvironment } from '../../agent/environment.mjs';
import { runtime, brief, proposal } from './fixtures.mjs';
export async function fixture({
  projectId,
  dispatch = true,
  profile = runtime,
} = {}) {
  assertSafeTestDatabaseUrl();
  process.env.B2B_DESIGN_TEST_STUB = '1';
  const time = { now: Date.now() };
  const clock = () => new Date(time.now);
  const agents = createAgentService({ clock, intervalSeconds: 1 }),
    execution = createExecutionService({ clock });
  projectId ??= (
    await createProject(
      { displayName: 'Design fixture', draft: brief },
      randomUUID(),
    )
  ).response.project.id;
  const job = (
    await jobs.create(
      projectId,
      { type: 'design_proposal', expectedRevision: 1 },
      randomUUID(),
    )
  ).response.job;
  const pairing = await agents.pair({ mode: 'codex_design', projectId });
  const credential = newSecret('agt');
  const registration = (
    await agents.register(
      pairing.pairingSecret,
      {
        mode: 'codex_design',
        adapter: ADAPTER,
        runtime: profile,
        agentName: 'Design fixture',
        agentVersion: '0.4.0',
        os: 'linux',
        supportedApiVersions: ['v1'],
        agentSecret: credential,
      },
      randomUUID(),
    )
  ).response;
  const agentId = registration.agentId;
  if (dispatch)
    await execution.dispatch(
      projectId,
      job.id,
      { agentId, expectedVersion: 1 },
      randomUUID(),
    );
  return {
    time,
    clock,
    projectId,
    jobId: job.id,
    agents,
    execution,
    agentId,
    credential,
    registration,
    claim: (key = randomUUID()) =>
      execution.claim(agentId, credential, {}, key),
    action: (a, kind, extra = {}, key = randomUUID()) =>
      execution.action(
        agentId,
        job.id,
        credential,
        kind,
        { attempt: a.attempt, leaseToken: a.leaseToken, ...extra },
        key,
      ),
  };
}
export function report(a) {
  const s = a.jobSpec;
  return {
    reportVersion: '1.1.0',
    jobId: s.jobId,
    attempt: 1,
    inputSha256: s.input.sha256,
    jobSpecSha256: a.jobSpecSha256,
    provider: runtime.provider,
    cliVersion: runtime.cliVersion,
    model: s.settings.model,
    effort: s.settings.effort,
    modelEvidence: modelEvidence(s),
    providerInvocations: 1,
    proposal: proposal(s.input.brief),
    usage: null,
  };
}
export const result = (f, a, key = randomUUID()) => {
  const r = report(a);
  return f.action(a, 'result', { report: r, resultDigest: sha256Json(r) }, key);
};
export async function running(f) {
  const a = (await f.claim()).assignment;
  await f.action(a, 'start');
  await f.action(a, 'heartbeat', { phase: 'validating' });
  return a;
}
export function startDesignRunner(origin, secret) {
  assertSafeTestDatabaseUrl();
  const child = spawn(
    process.execPath,
    [
      'tests/design/stub-runner.mjs',
      '--origin',
      origin,
      '--name',
      'CI design Runner',
    ],
    {
      env: runnerEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
  let output = '';
  const capture = (chunk) => {
    output = (output + chunk).slice(-16384);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.stdin.on('error', () => {});
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(secret + '\n');
  return { child, exited, output: () => output, launcher: false };
}
