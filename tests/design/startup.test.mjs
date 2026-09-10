import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { main } from '../../agent/design-main.mjs';
import * as session from '../../agent/session.mjs';
import { createStartup, validStartup } from '../../agent/startup-receipt.mjs';
import { observeStartup } from '../../scripts/lab/runner-process.mjs';
import { ADAPTER } from '../../server/design/contract.mjs';
import { runtime } from './fixtures.mjs';
const secret = 'pair_' + 'S'.repeat(43);
async function execute(
  load,
  args = [
    '--codex-wsl',
    '--origin',
    'http://127.0.0.1:12345',
    '--registration-only',
  ],
  value = secret + '\n',
) {
  const receipts = [],
    input = new PassThrough();
  input.end(value);
  const exit = process.exitCode;
  try {
    await main({
      load,
      args,
      input,
      send: (r) => receipts.push(r),
      log: () => {},
    });
  } finally {
    process.exitCode = exit;
  }
  assert.ok(receipts.every(validStartup));
  assert.equal(JSON.stringify(receipts).includes(secret), false);
  assert.equal(JSON.stringify(receipts).includes('SECRET_MARKER'), false);
  return receipts.at(-1);
}
const adapter = {
  runtime,
  execute: () => {
    throw Error('MODEL_MUST_NOT_RUN');
  },
};
const modules =
  (overrides = {}, a = adapter) =>
  async () => [
    { officialAdapter: async () => a },
    { ...session, ...overrides },
  ];
void test('catchable import/options/preflight/pairing/manifest failures have safe stage receipts', async () => {
  const cases = [
    [
      () => import('./missing-SECRET_MARKER.mjs'),
      'bootstrap_import',
      'RUNNER_BOOTSTRAP_ERROR',
    ],
    [
      modules({
        options: () => {
          throw Object.assign(Error(secret), { code: 'INVALID_OPTIONS' });
        },
      }),
      'options',
      'INVALID_OPTIONS',
    ],
    [
      async () => [
        {
          officialAdapter: () => {
            throw Error('SECRET_MARKER');
          },
        },
        session,
      ],
      'preflight',
      'RUNNER_INTERNAL_ERROR',
    ],
    [
      modules(
        {},
        { ...adapter, runtime: { ...runtime, status: 'CODEX_LOGIN_REQUIRED' } },
      ),
      'preflight',
      'CODEX_LOGIN_REQUIRED',
    ],
    [
      modules({
        readSecret: () => {
          throw Object.assign(Error(secret), { code: 'INVALID_PAIRING_INPUT' });
        },
      }),
      'pairing_input',
      'INVALID_PAIRING_INPUT',
    ],
    [
      modules({
        runSession: (opts) =>
          session.runSession({
            ...opts,
            readDesignManifest: async () => ({ sha256: 'bad' }),
          }),
      }),
      'manifest_validation',
      'CODEX_UNSUPPORTED_VERSION',
    ],
  ];
  for (const [load, stage, code] of cases) {
    const r = await execute(load);
    assert.equal(r.currentStage, stage);
    assert.equal(r.errorCode, code);
    assert.equal(r.stopConfirmed, true);
  }
  const eof = await execute(modules(), undefined, '');
  assert.equal(eof.errorCode, 'INVALID_PAIRING_INPUT');
});
void test('real HTTP startup registration and first-heartbeat failures preserve status, never body/token', async () => {
  for (const stage of ['registration', 'first_heartbeat', 'success']) {
    let registrations = 0,
      health = 0,
      claims = 0;
    const id = 'agent_' + 'a'.repeat(32);
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      const register = req.url.endsWith('/register');
      if (register) registrations++;
      else if (req.url.endsWith('/health')) health++;
      else claims++;
      if (register && stage !== 'registration') {
        res.writeHead(201);
        res.end(
          JSON.stringify({
            mode: 'codex_design',
            selectedApiVersion: 'v1',
            executionEnabled: true,
            freeSlots: 1,
            currentJobId: null,
            grantedCapabilities: ['codex-design'],
            agentId: id,
            heartbeatIntervalSeconds: 1,
            projectId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
            adapter: ADAPTER,
            runtime,
            status: 'registered',
          }),
        );
      } else if (!register && stage === 'success' && health === 1) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            mode: 'codex_design',
            selectedApiVersion: 'v1',
            executionEnabled: true,
            freeSlots: 1,
            currentJobId: null,
            grantedCapabilities: ['codex-design'],
            agentId: id,
            heartbeatIntervalSeconds: 1,
            projectId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
            adapter: ADAPTER,
            runtime,
            accepted: true,
            serverTime: new Date().toISOString(),
          }),
        );
      } else {
        res.writeHead(register ? 422 : 401);
        res.end(
          JSON.stringify({
            error: {
              code: register ? 'VALIDATION_FAILED' : 'AGENT_REVOKED',
              message: secret,
              details: { secret: 'SECRET_MARKER' },
            },
          }),
        );
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await execute(modules(), [
        '--codex-wsl',
        '--origin',
        `http://127.0.0.1:${server.address().port}`,
        '--registration-only',
      ]);
      assert.equal(registrations, 1);
      assert.equal(claims, 0);
      assert.equal(
        r.currentStage,
        stage === 'registration' ? 'registration' : 'first_heartbeat',
      );
      assert.equal(r.httpStatus, stage === 'registration' ? 422 : 401);
      assert.equal(
        r.httpErrorCode,
        stage === 'registration' ? 'VALIDATION_FAILED' : 'AGENT_REVOKED',
      );
      if (stage === 'success') {
        assert.equal(health, 2);
        assert.equal(r.lastCompletedStage, 'first_heartbeat');
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  }
});
void test('actual entry catches early options exit; spawn failure and closed pipes are not tree confirmation', async () => {
  const child = spawn(process.execPath, ['agent/design-main.mjs'], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const monitor = observeStartup(child);
  child.stdin.end();
  const result = await monitor.finish();
  assert.equal(result.errorCode, 'INVALID_OPTIONS');
  assert.equal(result.exitCode, 1);
  await mkdir('.test-results',{recursive:true});
  await writeFile('.test-results/startup-regressions.json',JSON.stringify({synthetic:true,platform:process.platform,modelInvocations:0,receipt:result},null,2)+'\n');
  const absent = observeStartup(
    spawn('b2b-deliberately-missing-binary', [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    }),
  );
  assert.equal((await absent.finished).errorCode, 'RUNNER_SPAWN_FAILED');
});
void test('late IPC is drained after exit, bounded pipes and unknown messages cannot assert stop', async () => {
  const child = () =>
    Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      connected: false,
    });
  const a = child(),
    mon = observeStartup(a, { drainMs: 60 });
  const sender = createStartup({ send: (v) => a.emit('message', v) });
  a.emit('exit', 1, null);
  await delay(5);
  sender.fail({ code: 'VALIDATION_FAILED', message: secret });
  sender.stop(true);
  a.emit('close', 1, null);
  assert.equal((await mon.finished).errorCode, 'VALIDATION_FAILED');
  assert.equal(mon.snapshot().stopConfirmed, true);
  const b = child(),
    missing = observeStartup(b, { drainMs: 20 });
  b.emit('exit', 0, null);
  assert.equal((await missing.finished).stopConfirmed, false);
  const c = child(),
    invalid = observeStartup(c);
  c.emit('message', { secret });
  c.emit('close', 0, null);
  assert.equal(
    (await invalid.finished).errorCode,
    'STARTUP_DIAGNOSTIC_INVALID',
  );
  assert.equal(JSON.stringify(invalid.snapshot()).includes(secret), false);
  const d = child(),
    bounded = observeStartup(d, { drainMs: 10 });
  d.kill = () => false;
  const began = Date.now();
  await assert.rejects(bounded.finish(10), /STOP_UNCONFIRMED/);
  assert.ok(Date.now() - began < 1600);
  assert.equal(bounded.snapshot().stopConfirmed, false);
  const e = child(),
    overflow = observeStartup(e);
  e.stderr.write(Buffer.alloc(32769, 83));
  e.emit('close', 0, null);
  assert.equal((await overflow.finished).errorCode, 'STARTUP_OUTPUT_LIMIT');
});
