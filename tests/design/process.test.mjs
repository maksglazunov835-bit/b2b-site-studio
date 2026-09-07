import assert from 'node:assert/strict';
import { prepareTestDatabase } from '../persistence/helpers.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import {
  startProductionServer,
  waitForHomepage,
  stopServer,
} from '../persistence/production-server.mjs';
import { ok, api, write, lossProxy } from '../execution/http-helpers.mjs';
import { until, stopRunner, finishRunner } from '../agents/process-helpers.mjs';
import { startDesignRunner } from './helpers.mjs';
import { brief, runtime } from './fixtures.mjs';
import { ADAPTER } from '../../server/design/contract.mjs';
import { newSecret } from '../../server/agents/requests.mjs';
import { closeDatabasePool } from '../../server/persistence/database.mjs';
assertSafeTestDatabaseUrl();
await prepareTestDatabase();
await closeDatabasePool();
const server = await startProductionServer({
  designStub: true,
  agentIntervalSeconds: 1,
});
const runners = [],
  proxies = [],
  secrets = [];
let publicServer, normalServer;
try {
  await waitForHomepage(server);
  for (const scenario of [
    'result-retry',
    'lost-start',
    'lost-claim',
    'cancel',
    'revoke',
    'stop-unconfirmed',
  ]) {
    const project = (
      await ok(
        server.origin,
        '/projects',
        write({
          displayName: 'Design transport fixture',
          draft: {
            ...brief,
            niche:
              scenario === 'stop-unconfirmed'
                ? 'fixture-stop-unconfirmed'
                : ['cancel', 'revoke'].includes(scenario)
                  ? 'fixture-timeout'
                  : brief.niche,
          },
        }),
      )
    ).project;
    const base = `/projects/${project.id}/jobs`;
    const job = (
      await ok(
        server.origin,
        base,
        write({ type: 'design_proposal', expectedRevision: 1 }),
      )
    ).job;
    const pair = await ok(
      server.origin,
      '/agents/pairings',
      write({ mode: 'codex_design', projectId: project.id }),
    );
    secrets.push(pair.pairingSecret);
    const proxy = await lossProxy(server.origin, {
      drop:
        scenario === 'result-retry'
          ? ['result']
          : scenario === 'lost-start'
            ? ['start']
            : scenario === 'lost-claim'
              ? ['claim']
              : [],
    });
    proxies.push(proxy);
    const runner = startDesignRunner(proxy.origin, pair.pairingSecret);
    runners.push(runner);
    await until(() => {
      assert.equal(runner.child.exitCode, null, runner.output());
      return runner.output().includes('RUNNER_HEARTBEAT_ACK');
    });
    const agent = (await ok(server.origin, '/agents')).agents.find(
      (a) => a.projectId === project.id,
    );
    const target = `${base}/${job.id}`;
    await ok(
      server.origin,
      `${target}/dispatch`,
      write({ agentId: agent.agentId, expectedVersion: 1 }),
    );
    if (scenario === 'result-retry') {
      await until(() => {
        assert.equal(runner.child.exitCode, null, runner.output());
        return runner.output().includes('RUNNER_DESIGN_RESULT_CONFIRMED');
      });
      const result = await ok(server.origin, `${target}/execution`);
      assert.equal(result.report.provider, 'test_stub');
      assert.equal(result.report.proposal.concepts.length, 3);
      assert.equal(result.attempts.length, 1);
      assert.equal(new Set(proxy.fingerprints.get('result')).size, 1);
      assert.equal(proxy.fingerprints.get('result').length, 2);
      assert.equal(proxy.fingerprints.get('start').length, 1);
      assert.equal(runner.output().split('TEST_CLI_INVOCATION').length - 1, 1);
      const events = await ok(server.origin, `${target}/events`);
      assert.equal(
        events.events.filter((e) => e.type === 'job_succeeded').length,
        1,
      );
      await stopRunner(runner);
    } else if (scenario === 'lost-start') {
      await finishRunner(runner, 1);
      assert.match(runner.output(), /INVOCATION_UNCERTAIN/);
      assert.doesNotMatch(runner.output(), /TEST_CLI_INVOCATION/);
      await until(
        async () => (await ok(server.origin, target)).job.state === 'failed',
        13000,
      );
      assert.equal(
        (await ok(server.origin, `${target}/execution`)).attempts.length,
        1,
      );
    } else if (scenario === 'lost-claim') {
      await until(
        async () => (await ok(server.origin, target)).job.state === 'failed',
        15000,
      );
      assert.doesNotMatch(runner.output(), /TEST_CLI_INVOCATION/);
      await stopRunner(runner);
    } else {
      await until(() => runner.output().includes('TEST_CLI_INVOCATION'));
      if (['cancel', 'stop-unconfirmed'].includes(scenario)) {
        await ok(
          server.origin,
          `${target}/cancel`,
          write({
            expectedVersion: (await ok(server.origin, target)).job.version,
          }),
        );
        if (scenario === 'stop-unconfirmed') {
          await finishRunner(runner, 1);
          assert.match(runner.output(), /STOP_UNCONFIRMED/);
          assert.doesNotMatch(runner.output(), /RUNNER_VALIDATION_CANCEL_ACK/);
          assert.equal((await ok(server.origin, target)).job.state, 'failed');
          assert.equal(
            (await ok(server.origin, `${target}/execution`)).attempts[0]
              .failure_code,
            'STOP_UNCONFIRMED',
          );
        } else {
          await until(() =>
            runner.output().includes('RUNNER_VALIDATION_CANCEL_ACK'),
          );
          assert.equal(
            (await ok(server.origin, target)).job.state,
            'cancelled',
          );
          await stopRunner(runner);
        }
      } else {
        await ok(server.origin, `/agents/${agent.agentId}/revoke`, write());
        await finishRunner(runner, 1);
        assert.match(runner.output(), /AGENT_REVOKED/);
      }
      assert.equal(
        (await ok(server.origin, `${target}/execution`)).report,
        null,
      );
      assert.equal(runner.output().split('TEST_CLI_INVOCATION').length - 1, 1);
    }
    console.log(
      `DESIGN_BUILT_HTTP_CHILD_${scenario.toUpperCase().replaceAll('-', '_')} passed`,
    );
  }
  publicServer = await startProductionServer({ mode: null });
  await waitForHomepage(publicServer);
  for (const target of ['/agents', '/agents/pairings', '/projects']) {
    for (const headers of [
      {},
      {
        Host: 'localhost',
        'X-Forwarded-Host': '127.0.0.1',
        'X-Forwarded-For': '127.0.0.1',
      },
    ]) {
      const init = target === '/agents/pairings' ? write() : {};
      const result = await api(publicServer.origin, target, {
        ...init,
        headers: { ...init.headers, ...headers },
      });
      assert.equal(result.body.error.code, 'PERSISTENCE_DISABLED');
    }
  }
  normalServer = await startProductionServer();
  await waitForHomepage(normalServer);
  const p = (
    await ok(
      normalServer.origin,
      '/projects',
      write({ displayName: 'Normal fixture', draft: brief }),
    )
  ).project;
  const pair = await ok(
    normalServer.origin,
    '/agents/pairings',
    write({ mode: 'codex_design', projectId: p.id }),
  );
  const response = await api(
    normalServer.origin,
    '/agents/register',
    write(
      {
        mode: 'codex_design',
        adapter: ADAPTER,
        runtime,
        agentName: 'Not allowed',
        agentVersion: '0.4.0',
        os: 'linux',
        supportedApiVersions: ['v1'],
        agentSecret: newSecret('agt'),
      },
      pair.pairingSecret,
    ),
  );
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  console.log(
    'DESIGN_DEFAULT_DENY_FORGED_HOST_TEST_PROVIDER_DISABLED_IN_NORMAL_MODE passed',
  );
  for (const secret of [...secrets, ...proxies.flatMap((p) => p.secrets)])
    for (const text of [server.output(), ...runners.map((r) => r.output())])
      assert.equal(text.includes(secret), false);
} finally {
  for (const p of proxies) p.release();
  for (const r of runners) await stopRunner(r);
  for (const p of proxies) await p.close();
  if (normalServer) await stopServer(normalServer);
  if (publicServer) await stopServer(publicServer);
  await stopServer(server);
}
