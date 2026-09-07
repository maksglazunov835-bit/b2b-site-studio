import assert from "node:assert/strict";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "../persistence/production-server.mjs";
import { startRunner, until, stopRunner, finishRunner } from "../agents/process-helpers.mjs";
import { ok, write, httpFixture, lossProxy } from "./http-helpers.mjs";

assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer(); const runners = []; const proxies = []; const secrets = [];
try {
  await waitForHomepage(server);
  for (const scenario of ["lost-replies", "cancel", "revoke"]) {
    const fixture = await httpFixture(server.origin); secrets.push(fixture.pairing.pairingSecret);
    const proxy = await lossProxy(server.origin, { drop: scenario === "lost-replies" ? ["claim", "start", "result"] : [], holdResult: scenario !== "lost-replies" });
    proxies.push(proxy);
    const runner = startRunner(proxy.origin, fixture.pairing.pairingSecret, { mode: "data-validation", name: `Execution ${scenario}` });
    runners.push(runner);
    await until(() => {
      assert.equal(runner.child.exitCode, null, runner.output());
      return runner.output().includes("RUNNER_HEARTBEAT_ACK");
    });
    const agent = (await ok(server.origin, "/agents")).agents.find((item) => item.projectId === fixture.projectId);
    assert.equal(agent.mode, "data_validation"); assert.equal(agent.executionEnabled, true);
    const path = `${fixture.base}/${fixture.job.id}`;
    await ok(server.origin, `${path}/dispatch`, write({ agentId: agent.agentId, expectedVersion: 1 }));
    if (scenario === "lost-replies") {
      await until(() => {
        assert.equal(runner.child.exitCode, null, runner.output());
        return runner.output().includes("RUNNER_VALIDATION_RESULT_CONFIRMED");
      }, 25000);
      const detail = await ok(server.origin, `${path}/execution`);
      assert.deepEqual(detail.attempts.map((item) => item.state), ["expired", "succeeded"]);
      assert.equal(detail.report.validationStatus, "valid"); assert.equal(detail.report.attempt, 2);
      assert.equal(detail.acceptanceResult, null);
      assert.deepEqual([...proxy.dropped].sort((a, b) => a < b ? -1 : a > b ? 1 : 0), ["claim", "result", "start"]);
      for (const kind of ["start", "result"]) {
        assert.equal(proxy.fingerprints.get(kind).length, 2);
        assert.equal(proxy.fingerprints.get(kind)[0], proxy.fingerprints.get(kind)[1]);
      }
      assert.equal((await ok(server.origin, `${path}/events`)).events.filter((event) => event.type === "job_succeeded").length, 1);
      await stopRunner(runner);
      console.log("EXECUTION_REAL_PROCESS_LOST_CLAIM_START_RESULT_PINNED_REPORT_FENCED_RETRY_SIGTERM passed");
    } else {
      await proxy.waitHeld();
      const current = (await ok(server.origin, path)).job; assert.equal(current.state, "validating");
      if (scenario === "cancel") await ok(server.origin, `${path}/cancel`, write({ expectedVersion: current.version }));
      else await ok(server.origin, `/agents/${agent.agentId}/revoke`, write());
      assert.equal((await ok(server.origin, path)).job.state, "cancel_requested");
      proxy.release();
      if (scenario === "cancel") {
        await until(() => runner.output().includes("RUNNER_VALIDATION_CANCEL_ACK"));
        assert.equal((await ok(server.origin, path)).job.state, "cancelled");
        await stopRunner(runner, "SIGINT");
      } else {
        await finishRunner(runner, 1); assert.match(runner.output(), /AGENT_REVOKED/);
        await until(async () => (await ok(server.origin, path)).job.state === "failed", 12000);
        const detail = await ok(server.origin, `${path}/execution`);
        assert.equal(detail.attempts.at(-1).failure_code, "STOP_UNCONFIRMED");
      }
      assert.equal((await ok(server.origin, `${path}/execution`)).report, null);
      console.log(`EXECUTION_REAL_PROCESS_${scenario.toUpperCase()}_NO_FALSE_SUCCESS_CLEAN_EXIT passed`);
    }
  }
  for (const secret of [...secrets, ...proxies.flatMap((proxy) => proxy.secrets)]) {
    for (const output of [server.output(), ...runners.map((runner) => runner.output())]) assert.equal(output.includes(secret), false);
  }
  console.log("EXECUTION_REAL_HTTP_NO_SECRET_LOGS passed");
} finally {
  for (const proxy of proxies) proxy.release();
  for (const runner of runners) await stopRunner(runner);
  for (const proxy of proxies) await proxy.close();
  await stopServer(server);
}
