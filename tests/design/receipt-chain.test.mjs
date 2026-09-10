import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { clientEnvironment } from '../../agent/codex/adapter.mjs';
import { observeStartup } from '../../scripts/lab/runner-process.mjs';
import { validInvocation } from '../../agent/codex/invocation-receipt.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
assertSafeTestDatabaseUrl();
void test(
  'fixed synthetic process -> supervisor/relay -> bridge/parser -> Runner IPC -> bounded report',
  { timeout: 60000 },
  async () => {
    const cases = [];
    for (const [scenario, code, source, category] of [
      ['success', null, null, null],
      ['exit2', 'CODEX_PROCESS_FAILED', 'cli_exit', 'unclassified'],
      [
        'provider-error',
        'CODEX_PROCESS_FAILED',
        'provider_event',
        'unclassified',
      ],
      ['turn-failed', 'CODEX_PROCESS_FAILED', 'provider_event', 'unclassified'],
      ['config', 'CODEX_SAFE_PROFILE_UNVERIFIED', 'stderr', 'config'],
      ['auth', 'CODEX_LOGIN_REQUIRED', 'stderr', 'auth'],
      ['quota', 'CODEX_QUOTA', 'stderr', 'quota'],
      ['parser-exception', 'CODEX_PROCESS_FAILED', 'parser', 'unclassified'],
      ['malformed', 'CODEX_INVALID_OUTPUT', 'parser', 'protocol'],
      ['timeout', 'CODEX_TIMEOUT', 'transport', 'timeout'],
      ['stop-unconfirmed', 'STOP_UNCONFIRMED', 'stderr', 'auth'],
    ]) {
      const child = spawn(
        process.execPath,
        ['tests/design/receipt-runner.mjs', scenario],
        {
          env: clientEnvironment(),
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          windowsHide: true,
          shell: false,
        },
      );
      const monitor = observeStartup(child);
      child.stdin.end();
      if (scenario === 'stop-unconfirmed') await assert.rejects(monitor.finish(12000), {code:'STOP_UNCONFIRMED'});
      else await monitor.finish(12000);
      const startup = monitor.snapshot(), receipts = monitor.invocations();
      assert.equal(receipts.length, 1, scenario + ':' + startup.errorCode);
      const receipt = receipts[0];
      assert.equal(validInvocation(receipt), true);
      assert.equal(receipt.runId, startup.runId);
      assert.equal(receipt.errorCode, code, scenario);
      assert.equal(receipt.primary?.source ?? null, source, scenario);
      assert.equal(receipt.primary?.category ?? null, category, scenario);
      assert.equal(
        receipt.confirmedStop,
        scenario !== 'stop-unconfirmed',
        scenario,
      );
      assert.equal(
        receipt.cleanupCode,
        scenario === 'stop-unconfirmed' ? 'STOP_UNCONFIRMED' : null,
        scenario,
      );
      if (scenario !== 'stop-unconfirmed')
        assert.ok(
          receipt.exitCode !== null || receipt.signalCode !== null,
          scenario,
        );
      if (scenario === 'exit2') assert.equal(receipt.exitCode, 2);
      assert.equal(receipt.primary?.httpStatus ?? null, null);
      assert.doesNotMatch(
        JSON.stringify({ startup, receipt }),
        /SYNTHETIC_SECRET|Authorization|Bearer|pair_|lease_|agt_|Stationery/,
      );
      cases.push({ scenario, receipt });
    }
    await mkdir('.test-results', { recursive: true });
    await writeFile(
      `.test-results/receipt-chain-${process.platform}.json`,
      JSON.stringify(
        {
          synthetic: true,
          modelInvocations: 0,
          transport:
            process.platform === 'linux'
              ? 'Python subreaper -> Linux relay -> shared bridge -> Runner IPC'
              : 'Windows Job Object -> relay -> shared bridge -> Runner IPC',
          cases,
        },
        null,
        2,
      ),
    );
  },
);
