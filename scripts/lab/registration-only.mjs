import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { assertSafeTestDatabaseUrl } from '../db/test-config.mjs';
import {
  startProductionServer,
  waitForHomepage,
  stopServer,
} from '../../tests/persistence/production-server.mjs';
import { ok, write } from '../../tests/execution/http-helpers.mjs';
import { startOfficialRunner } from './runner-process.mjs';
import { brief } from '../../tests/design/fixtures.mjs';
import { safeStartupCode } from '../../agent/startup-receipt.mjs';
async function main() {
  const config = assertSafeTestDatabaseUrl();
  if (
    process.platform !== 'win32' ||
    process.env.CI ||
    process.env.B2B_DESIGN_TEST_STUB
  )
    throw Error('LAB_SETUP_REQUIRED');
  await mkdir('.test-results', { recursive: true });
  const server = await startProductionServer({ agentIntervalSeconds: 1 });
  let runner, projectId, agentId, receipt;
  try {
    await waitForHomepage(server);
    projectId = (
      await ok(
        server.origin,
        '/projects',
        write({ displayName: 'WSL registration-only synthetic', draft: brief }),
      )
    ).project.id;
    const pairing = await ok(
      server.origin,
      '/agents/pairings',
      write({ mode: 'codex_design', projectId }),
    );
    runner = startOfficialRunner(server.origin, pairing.pairingSecret, {
      registrationOnly: true,
    });
    await runner.waitForHeartbeat();
    const agents = (await ok(server.origin, '/agents?limit=100')).agents.filter(
      (a) => a.projectId === projectId,
    );
    assert.equal(agents.length, 1);
    assert.ok(agents[0].lastSeenAt);
    agentId = agents[0].agentId;
    await ok(server.origin, `/agents/${agentId}/revoke`, write());
    receipt = await runner.finish();
    assert.equal(receipt.errorCode, 'AGENT_REVOKED');
    assert.equal(receipt.exitCode, 1);
    const client = new pg.Client(config);
    let counts;
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      counts = (
        await client.query(
          `SELECT
      (SELECT count(*)::int FROM agent_execution_grants WHERE project_id=$1 AND agent_id IS NOT NULL) AS registrations,
      (SELECT count(*)::int FROM job_executions WHERE project_id=$1) AS dispatches,
      (SELECT count(*)::int FROM job_attempts WHERE project_id=$1) AS attempts,
      (SELECT count(*)::int FROM design_invocations i JOIN jobs j ON j.id=i.job_id WHERE j.project_id=$1) AS invocations,
      (SELECT count(*)::int FROM job_results r JOIN jobs j ON j.id=r.job_id WHERE j.project_id=$1) AS results`,
          [projectId],
        )
      ).rows[0];
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    assert.deepEqual(counts, {
      registrations: 1,
      dispatches: 0,
      attempts: 0,
      invocations: 0,
      results: 0,
    });
    await writeFile(
      `.test-results/registration-only-${receipt.runId}.json`,
      JSON.stringify(
        {
          kind: 'actual-windows-wsl-registration-only',
          receipt,
          counts,
          heartbeatReceived: true,
          modelInvocations: 0,
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
    console.log(
      'ACTUAL_WSL_REGISTRATION_HEARTBEAT_REVOKE_STOP_ZERO_MODEL_CALLS',
    );
  } finally {
    try {
      if (runner) {
        if (
          runner.child.exitCode === null &&
          runner.child.signalCode === null
        ) {
          if (!agentId && projectId)
            agentId = (
              await ok(server.origin, '/agents?limit=100')
            ).agents.find((a) => a.projectId === projectId)?.agentId;
          if (agentId)
            await ok(server.origin, `/agents/${agentId}/revoke`, write());
          runner.stop();
        }
        try {
          receipt = await runner.finish();
        } finally {
          const diagnostic = runner.snapshot();
          await writeFile(
            `.test-results/startup-${diagnostic.runId}.json`,
            JSON.stringify(diagnostic, null, 2) + '\n',
            { flag: 'wx' },
          );
          console.log('RUNNER_STARTUP_RECEIPT', JSON.stringify(diagnostic));
        }
      }
    } finally {
      await stopServer(server);
    }
  }
}
main().catch((error) => {
  console.error(
    'REGISTRATION_ONLY_FAILED',
    safeStartupCode(error, 'registration'),
  );
  process.exitCode = 1;
});
