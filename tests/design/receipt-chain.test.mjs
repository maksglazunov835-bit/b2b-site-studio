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
  { timeout: 120000 },
  async () => {
    const cases = [];
    let warningDiagnostic;
    for (const [scenario, code, source, category, reason] of [
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
      ...['line', 'coalesced', 'split', 'bytewise', 'crlf'].map((mode) => [
        'notice-pre-' + mode,
        'CODEX_SAFE_PROFILE_UNVERIFIED',
        'provider_event',
        'config',
        'NOTICE_CONFIG',
      ]),
      [
        'notice-turn',
        'CODEX_SAFE_PROFILE_UNVERIFIED',
        'provider_event',
        'config',
        'NOTICE_CONFIG',
      ],
      [
        'notice-reroute',
        'CODEX_MODEL_CAPABILITY_MISMATCH',
        'provider_event',
        'config',
        'MODEL_REROUTED',
      ],
      [
        'notice-auth',
        'CODEX_LOGIN_REQUIRED',
        'provider_event',
        'auth',
        'NOTICE_AUTH',
      ],
      [
        'notice-quota',
        'CODEX_QUOTA',
        'provider_event',
        'quota',
        'NOTICE_QUOTA',
      ],
      [
        'notice-lost',
        'CODEX_PROCESS_FAILED',
        'provider_event',
        'protocol',
        'EVENTS_LOST',
      ],
      [
        'notice-unknown',
        'CODEX_PROCESS_FAILED',
        'provider_event',
        'unclassified',
        'NOTICE_UNKNOWN',
      ],
      [
        'unknown-event',
        'CODEX_INVALID_OUTPUT',
        'parser',
        'protocol',
        'UNKNOWN_EVENT_TYPE',
      ],
      [
        'forbidden-action',
        'CODEX_INVALID_OUTPUT',
        'parser',
        'protocol',
        'FORBIDDEN_ACTION',
      ],
      [
        'invalid-utf8',
        'CODEX_INVALID_OUTPUT',
        'parser',
        'protocol',
        'INVALID_UTF8',
      ],
      [
        'truncated',
        'CODEX_INVALID_OUTPUT',
        'parser',
        'protocol',
        'UNTERMINATED_LINE',
      ],
      [
        'notice-stop-unconfirmed',
        'STOP_UNCONFIRMED',
        'provider_event',
        'config',
        'NOTICE_CONFIG',
      ],
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
      const lostConfirmation = scenario.endsWith('stop-unconfirmed');
      if (lostConfirmation)
        await assert.rejects(monitor.finish(12000), {
          code: 'STOP_UNCONFIRMED',
        });
      else await monitor.finish(12000);
      const startup = monitor.snapshot(),
        receipts = monitor.invocations();
      assert.equal(receipts.length, 1, scenario + ':' + startup.errorCode);
      const receipt = receipts[0];
      assert.equal(validInvocation(receipt), true);
      assert.equal(receipt.runId, startup.runId);
      assert.equal(receipt.errorCode, code, scenario);
      assert.equal(receipt.primary?.source ?? null, source, scenario);
      assert.equal(receipt.primary?.category ?? null, category, scenario);
      if (reason)
        assert.equal(receipt.primary.parser.reasonId, reason, scenario);
      if (scenario.startsWith('notice-pre-')) {
        warningDiagnostic ??= receipt.primary;
        assert.deepEqual(receipt.primary, warningDiagnostic, scenario);
      }
      assert.equal(receipt.confirmedStop, !lostConfirmation, scenario);
      assert.equal(
        receipt.cleanupCode,
        lostConfirmation ? 'STOP_UNCONFIRMED' : null,
        scenario,
      );
      if (!lostConfirmation)
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
