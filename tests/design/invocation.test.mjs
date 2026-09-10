import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  isolatedInvocation,
  recordedInvocation,
} from '../../agent/codex/adapter.mjs';
import {
  validInvocation,
  diagnostic,
  diagnosticError,
} from '../../agent/codex/invocation-receipt.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import { specFor } from './fixtures.mjs';
import { officialUsage } from './protocol-fixtures.mjs';
assertSafeTestDatabaseUrl();
const stub = fileURLToPath(new URL('./stub-cli.mjs', import.meta.url));
const cases = [];
void test(
  'real fixed synthetic CLI uses the production recorder/parser/lifecycle; receipts distinguish every failure',
  { timeout: 30000 },
  async () => {
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
      ['schema', 'CODEX_INVALID_OUTPUT', 'stderr', 'schema'],
      ['auth', 'CODEX_LOGIN_REQUIRED', 'stderr', 'auth'],
      ['quota', 'CODEX_QUOTA', 'stderr', 'quota'],
      ['malformed', 'CODEX_INVALID_OUTPUT', 'parser', 'protocol'],
      ['oversized', 'CODEX_OUTPUT_LIMIT', 'parser', 'protocol'],
      ['tool', 'CODEX_INVALID_OUTPUT', 'parser', 'protocol'],
      ['timeout', 'CODEX_TIMEOUT', 'transport', 'timeout'],
    ]) {
      const receipts = [],
        spec = specFor();
      let failed;
      try {
        const result = await isolatedInvocation(
          process.execPath,
          [stub, scenario],
          spec,
          1,
          {
            timeoutMs: scenario === 'timeout' ? 500 : 5000,
            onInvocation: (r) => receipts.push(r),
          },
        );
        assert.equal(result.proposal.concepts.length, 3);
      } catch (error) {
        failed = error;
      }
      assert.equal(failed?.code ?? null, code, scenario);
      assert.equal(receipts.length, 1);
      const r = receipts[0];
      assert.equal(validInvocation(r), true, scenario);
      assert.equal(r.jobId, spec.jobId);
      assert.equal(r.attempt, 1);
      assert.equal(r.confirmedStop, true, scenario);
      assert.equal(r.cleanupCode, null);
      assert.equal(r.primary?.source ?? null, source, scenario);
      assert.equal(r.primary?.category ?? null, category, scenario);
      assert.equal(r.primary?.httpStatus ?? null, null);
      assert.equal(r.providerStarted, true, scenario);
      assert.ok(r.exitCode !== null || r.signalCode !== null, scenario);
      if (scenario === 'exit2') assert.equal(r.exitCode, 2);
      if (scenario === 'success') {
        assert.equal(r.lastValidEvent, 'turn.completed');
        assert.equal(r.terminalSeen, true);
        assert.deepEqual(r.usage, officialUsage);
        assert.equal(r.exitCode, 0);
      }
      if (['provider-error', 'turn-failed'].includes(scenario)) {
        assert.equal(
          r.lastValidEvent,
          scenario === 'provider-error' ? 'error' : 'turn.failed',
        );
        assert.equal(r.terminalSeen, true);
        assert.ok(r.primary.byteLength > 0);
        assert.equal(r.primary.fingerprint.length, 64);
      }
      assert.doesNotMatch(
        JSON.stringify(r),
        /SYNTHETIC_SECRET|Authorization|Bearer|pair_|lease_|agt_|companyName|Stationery/,
      );
      cases.push({ scenario, receipt: r });
    }
  },
);
void test('cleanup failure dominates the outcome, never erases the earlier safe diagnostic', async () => {
  const receipts = [];
  await assert.rejects(
    recordedInvocation(
      specFor(),
      1,
      { onInvocation: (r) => receipts.push(r) },
      async (_parser, observer) => {
        observer.started();
        const primary = diagnostic(
          { code: 'CODEX_LOGIN_REQUIRED' },
          {
            source: 'provider_event',
            category: 'auth',
            text: 'authentication failed SYNTHETIC_SECRET_AUTH',
          },
        );
        observer.failure(diagnosticError('CODEX_LOGIN_REQUIRED', primary));
        const error = diagnosticError('STOP_UNCONFIRMED', primary);
        error.processResult = {
          confirmed: false,
          code: null,
          signalCode: null,
          cleanupCode: 'STOP_UNCONFIRMED',
        };
        throw error;
      },
    ),
    { code: 'STOP_UNCONFIRMED' },
  );
  const r = receipts[0];
  assert.equal(r.primary.primaryCode, 'CODEX_LOGIN_REQUIRED');
  assert.equal(r.primary.source, 'provider_event');
  assert.equal(r.cleanupCode, 'STOP_UNCONFIRMED');
  assert.equal(r.confirmedStop, false);
  assert.equal(r.exitCode, null);
  assert.equal(r.signalCode, null);
  assert.equal(validInvocation(r), true);
  assert.doesNotMatch(JSON.stringify(r), /SYNTHETIC_SECRET/);
  cases.push({ scenario: 'unconfirmed-cleanup', receipt: r });
  await mkdir('.test-results', { recursive: true });
  await writeFile(
    `.test-results/invocation-regressions-${process.platform}.json`,
    JSON.stringify({ synthetic: true, modelInvocations: 0, cases }, null, 2),
  );
});
