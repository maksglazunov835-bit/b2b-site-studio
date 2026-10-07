import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import { prepareTestDatabase } from '../persistence/helpers.mjs';
import { closeDatabasePool } from '../../server/persistence/database.mjs';
import {
  startProductionServer,
  waitForHomepage,
  stopServer,
} from '../persistence/production-server.mjs';
import { api, ok, write } from '../execution/http-helpers.mjs';
import { ADAPTER } from '../../server/design/contract.mjs';
import { newSecret } from '../../server/agents/requests.mjs';
import { brief, runtime, officialRuntime } from './fixtures.mjs';
assertSafeTestDatabaseUrl();
await prepareTestDatabase();
await closeDatabasePool();
const server = await startProductionServer({ agentIntervalSeconds: 1 });
let publicServer;
try {
  await waitForHomepage(server);
  const project = (
    await ok(
      server.origin,
      '/projects',
      write({ displayName: 'Official WSL DTO contract fixture', draft: brief }),
    )
  ).project;
  const other = (
    await ok(
      server.origin,
      '/projects',
      write({ displayName: 'Other project', draft: brief }),
    )
  ).project;
  const pair = await ok(
    server.origin,
    '/agents/pairings',
    write({ mode: 'codex_design', projectId: project.id }),
  );
  const credential = newSecret('agt');
  const dto = () => ({
    mode: 'codex_design',
    adapter: ADAPTER,
    runtime: officialRuntime(),
    agentName: 'Synthetic official WSL DTO',
    agentVersion: '0.4.0',
    os: 'windows',
    supportedApiVersions: ['v1'],
    agentSecret: credential,
  });
  const rejected = async (body, secret = pair.pairingSecret) => {
    const r = await api(server.origin, '/agents/register', write(body, secret));
    assert.ok(r.status >= 400);
    assert.equal(
      (await ok(server.origin, '/agents?limit=100')).agents.length,
      0,
    );
    return r;
  };
  await rejected(dto(), null);
  await rejected(dto(), newSecret('pair'));
  for (const change of [
    (v) => delete v.runtime.admission,
    (v) => (v.runtime.admission.transport = 'native'),
    (v) => (v.runtime.policySha256 = '0'.repeat(64)),
    (v) => (v.adapter = { ...ADAPTER, sha256: '0'.repeat(64) }),
    (v) => (v.runtime.model = 'other'),
    (v) => (v.runtime.effort = 'low'),
    (v) =>
      (v.runtime.admission.checkedAt = new Date(
        Date.now() - 61000,
      ).toISOString()),
    (v) => (v.runtime = runtime),
    (v) => (v.os = 'linux'),
  ]) {
    const bad = dto();
    change(bad);
    await rejected(bad);
  }
  const presence = await ok(server.origin, '/agents/pairings', write());
  assert.equal(
    (await rejected(dto(), presence.pairingSecret)).body.error.code,
    'EXECUTION_SCOPE_MISMATCH',
  );
  const revoked = await ok(
    server.origin,
    '/agents/pairings',
    write({ mode: 'codex_design', projectId: project.id }),
  );
  await ok(
    server.origin,
    `/agents/pairings/${revoked.pairingId}/cancel`,
    write(),
  );
  assert.equal(
    (await rejected(dto(), revoked.pairingSecret)).body.error.code,
    'PAIRING_REVOKED',
  );
  const body = dto(),
    key = randomUUID();
  const replies = await Promise.all([
    api(
      server.origin,
      '/agents/register',
      write(body, pair.pairingSecret, key),
    ),
    api(
      server.origin,
      '/agents/register',
      write(body, pair.pairingSecret, key),
    ),
  ]);
  assert.ok(replies.every((r) => r.status === 201));
  assert.deepEqual(replies[0].body, replies[1].body);
  const agent = replies[0].body;
  assert.equal(agent.executionEnabled, true);
  assert.equal(agent.projectId, project.id);
  assert.equal((await ok(server.origin, '/agents?limit=100')).agents.length, 1);
  await ok(
    server.origin,
    `/agents/${agent.agentId}/health`,
    write({ selectedApiVersion: 'v1' }, credential),
  );
  const job = (
    await ok(
      server.origin,
      `/projects/${project.id}/jobs`,
      write({ type: 'design_proposal', expectedRevision: 1 }),
    )
  ).job;
  const otherJob = (
    await ok(
      server.origin,
      `/projects/${other.id}/jobs`,
      write({ type: 'design_proposal', expectedRevision: 1 }),
    )
  ).job;
  const wrong = await api(
    server.origin,
    `/projects/${other.id}/jobs/${otherJob.id}/dispatch`,
    write({ agentId: agent.agentId, expectedVersion: 1 }),
  );
  assert.equal(wrong.body.error.code, 'EXECUTION_NOT_GRANTED');
  // No Runner here: this tests actual operator dispatch/contract, never claim/start.
  await ok(
    server.origin,
    `/projects/${project.id}/jobs/${job.id}/dispatch`,
    write({ agentId: agent.agentId, expectedVersion: 1 }),
  );
  assert.equal(
    (
      await ok(
        server.origin,
        `/projects/${project.id}/jobs/${job.id}/execution`,
      )
    ).attempts.length,
    0,
  );
  await ok(server.origin, `/agents/${agent.agentId}/revoke`, write());
  assert.equal(
    (
      await api(
        server.origin,
        `/agents/${agent.agentId}/health`,
        write({ selectedApiVersion: 'v1' }, credential),
      )
    ).body.error.code,
    'AGENT_REVOKED',
  );
  assert.equal(
    (
      await api(
        server.origin,
        '/agents/register',
        write(body, pair.pairingSecret, key),
      )
    ).body.error.code,
    'AGENT_REVOKED',
  );
  publicServer = await startProductionServer({ mode: null });
  await waitForHomepage(publicServer);
  for (const headers of [
    {},
    {
      Host: 'localhost',
      'X-Forwarded-For': '127.0.0.1',
      'X-Forwarded-Host': 'localhost',
    },
  ]) {
    const init = write(dto(), pair.pairingSecret);
    Object.assign(init.headers, headers);
    const r = await api(publicServer.origin, '/agents/register', init);
    assert.equal(r.body.error.code, 'PERSISTENCE_DISABLED');
  }
  console.log(
    'OFFICIAL_WSL_HTTP_SCOPED_REGISTRATION_REPLAY_DISPATCH_DENIALS_PUBLIC_GATE_ZERO_MODEL_CALLS passed',
  );
} finally {
  if (publicServer) await stopServer(publicServer);
  await stopServer(server);
}
