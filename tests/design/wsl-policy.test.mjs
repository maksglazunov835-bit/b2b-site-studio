import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import {
  LAB,
  LAB_CHECKS,
  labConfig,
  labEnvironment,
  labExecArgs,
  labSandboxArgs,
  labFilesystemContext,
  completeCanary,
} from '../../agent/codex/wsl-policy.mjs';
import { labBundle, callLab } from '../../agent/codex/wsl-bridge.mjs';
import { supervise } from '../../agent/codex/wsl-runtime.mjs';
assertSafeTestDatabaseUrl();
const task = `${LAB.root}/${'a'.repeat(32)}/task`;

await test('fixed WSL policy: managed diagnostics, matching explicit paths, no platform env/model fallback', () => {
  const args = labExecArgs(task),
    sandbox = labSandboxArgs(task, [LAB.node, '-e', '']);
  assert.ok(sandbox.includes('--include-managed-config'));
  for (const value of labConfig(task))
    assert.ok(args.includes(value) && sandbox.includes(value));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-astra');
  assert.ok(args.includes('model_reasoning_effort="ultra"'));
  assert.ok(args.includes('tools.update_plan.enabled=false'));
  assert.ok(
    args.includes('tools.experimental_request_user_input.enabled=false'),
  );
  assert.equal(labFilesystemContext(task).permissions.type, 'managed');
  assert.equal(labFilesystemContext(task).permissions.network, 'restricted');
  assert.equal(labEnvironment().CODEX_HOME, `${LAB.home}/.codex`);
  assert.deepEqual(Object.keys(labEnvironment()).sort(), [
    'CODEX_HOME',
    'HOME',
    'LANG',
    'PATH',
  ]);
  for (const invalid of [
    '/mnt/c',
    '/tmp',
    '../escape',
    task + '/../escape',
    'C:\\Users',
    '',
  ])
    assert.throws(() => labExecArgs(invalid));
  assert.ok(
    !args.some((a) => /danger-full-access|api.key|ignore.managed/i.test(a)),
  );
});
await test('nonce AND completion AND every exact check are required; empty exit-zero response is not admission', () => {
  const receipt = {
    nonce: 'abc',
    completed: true,
    checks: Object.fromEntries(LAB_CHECKS.map((k) => [k, true])),
  };
  assert.equal(completeCanary(receipt, 'abc'), true);
  assert.equal(completeCanary(receipt, 'different'), false);
  for (const key of LAB_CHECKS)
    assert.equal(
      completeCanary(
        { ...receipt, checks: { ...receipt.checks, [key]: false } },
        'abc',
      ),
      false,
    );
  for (const invalid of [
    null,
    {},
    { exitCode: 0 },
    { ...receipt, completed: false },
    { ...receipt, checks: { ...receipt.checks, unexpected: true } },
  ])
    assert.equal(completeCanary(invalid, 'abc'), false);
});
await test('bridge carries only committed normalized runtime; fault injection cannot target invocation', async () => {
  const b = await labBundle();
  assert.equal(
    b.sha256,
    createHash('sha256')
      .update(b.source + b.supervisor)
      .digest('hex'),
  );
  assert.ok(!b.source.includes('\r\n'));
  await assert.rejects(
    callLab({ operation: 'invoke' }, { diagnosticFault: 'relay-kill' }),
    { code: 'LAB_SETUP_REQUIRED' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    callLab({ operation: 'invoke' }, { signal: controller.signal }),
    { code: 'RUNNER_STOPPED' },
  );
});
if (process.platform === 'linux')
  await test(
    'Linux subreaper protocol: actual synthetic processes, no WSL/Codex claim',
    { timeout: 20000 },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'b2b-wsl-protocol-'));
      const source = await readFile(
        new URL('../../agent/codex/wsl-supervisor.py', import.meta.url),
        'utf8',
      );
      const evidence = [];
      try {
        for (const mode of ['complete', 'orphan', 'abort', 'timeout']) {
          const controller = new AbortController();
          let timer;
          const code =
            mode === 'complete'
              ? 'console.log("FIXTURE_COMPLETE")'
              : `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>process.stdout.write(c.pid+'\\n',()=>{${mode === 'orphan' ? 'process.exit(0)' : ''}}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
          try {
            const result = await supervise(
              source,
              [process.execPath, '-e', code],
              {
                cwd: directory,
                signal: controller.signal,
                timeoutMs: mode === 'timeout' ? 500 : 3000,
                onStarted: () => {
                  if (mode === 'abort')
                    timer = setTimeout(() => controller.abort(), 300);
                },
              },
            );
            assert.equal(result.confirmed, true);
            if (mode === 'complete')
              assert.equal(result.stdout.trim(), 'FIXTURE_COMPLETE');
            else {
              const pid = Number(result.stdout.trim());
              assert.ok(Number.isInteger(pid) && pid > 1);
              await assert.rejects(readFile(`/proc/${pid}/stat`), {
                code: 'ENOENT',
              });
              assert.ok(result.reason);
            }
            evidence.push({ mode, confirmed: true });
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        }
        await mkdir('.test-results', { recursive: true });
        await writeFile(
          '.test-results/wsl-protocol-linux.json',
          JSON.stringify(
            {
              nativeLinuxProtocol: true,
              actualWsl: false,
              modelInvocations: 0,
              cases: evidence,
            },
            null,
            2,
          ),
        );
      } finally {
        await rm(directory, { recursive: true });
      }
    },
  );
