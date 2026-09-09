import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  rm,
  realpath,
  mkdir,
  writeFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedProcess } from '../../agent/codex/adapter.mjs';
import { outputParser } from '../../agent/codex/jsonl.mjs';
import { brief } from './fixtures.mjs';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
assertSafeTestDatabaseUrl();
async function live(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux')
      return !['Z', 'X'].includes(
        (await readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1][0],
      );
    return true;
  } catch (e) {
    if (['ESRCH', 'ENOENT'].includes(e.code)) return false;
    throw e;
  }
}
void test(
  `owned process-tree lifecycle on ${process.platform}; synthetic, zero model calls`,
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(
      path.join(await realpath(tmpdir()), 'b2b-tree-fixture-'),
    );
    const pids = [];
    const foreign = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { stdio: 'ignore' },
    );
    const evidence = [];
    try {
      let file = process.execPath,
        prefix = [
          fileURLToPath(new URL('./tree-fixture.mjs', import.meta.url)),
        ];
      if (process.platform === 'win32') {
        file = path.join(directory, 'native-fixture.exe');
        prefix = [];
        const compile = await boundedProcess(
          path.join(
            process.env.SystemRoot,
            'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
          ),
          [
            '/nologo',
            '/target:exe',
            `/out:${file}`,
            fileURLToPath(new URL('./NativeTreeFixture.cs', import.meta.url)),
          ],
          // Cold CI setup compiles both the supervisor and fixture; execution
          // timeout/cleanup assertions below retain their original bounds.
          { timeoutMs: 15000 },
        );
        assert.equal(compile.code, 0);
      }
      for (const pipes of ['closed', 'inherited']) {
        for (const scenario of ['abort', 'timeout', 'revoke', 'leader-exit']) {
          const marker = path.join(directory, `${pipes}-${scenario}.pid`);
          const controller = new AbortController();
          const started = Date.now();
          let ready = false;
          await assert.rejects(
            boundedProcess(
              file,
              [
                ...prefix,
                'leader',
                marker,
                pipes,
                scenario === 'leader-exit' ? 'yes' : 'no',
              ],
              {
                signal: controller.signal,
                timeoutMs: scenario === 'timeout' ? 1800 : 6000,
                onStdout: (c) => {
                  if (c.toString().includes('FIXTURE_READY')) {
                    ready = true;
                    if (['abort', 'revoke'].includes(scenario))
                      controller.abort(scenario);
                  }
                },
              },
            ).then((result) => {
              if (result.code !== 0)
                throw Object.assign(new Error(), {
                  code: 'CODEX_PROCESS_FAILED',
                });
            }),
            (e) =>
              e.code ===
              (scenario === 'timeout'
                ? 'CODEX_TIMEOUT'
                : scenario === 'leader-exit'
                  ? 'CODEX_PROCESS_FAILED'
                  : 'RUNNER_STOPPED'),
          );
          assert.ok(ready, 'fixture must actually create its descendant');
          assert.ok(
            Date.now() - started < 7000,
            'bounded cleanup including inherited pipes',
          );
          const pid = Number(await readFile(marker, 'utf8'));
          pids.push(pid);
          assert.equal(
            await live(pid),
            false,
            'no live owned descendant after acknowledgement',
          );
          assert.equal(
            await live(foreign.pid),
            true,
            'unrelated process untouched',
          );
          evidence.push({ pipes, scenario, passed: true });
        }
      }
      const marker = path.join(directory, 'forbidden.pid');
      const parser = outputParser(brief);
      const started = Date.now();
      await assert.rejects(
        boundedProcess(
          process.execPath,
          [
            fileURLToPath(new URL('./tree-fixture.mjs', import.meta.url)),
            'leader',
            marker,
            'inherited',
            'forbidden',
          ],
          {
            timeoutMs: 10000,
            capture: false,
            onStdout: parser.stdout,
            onStderr: parser.stderr,
          },
        ),
        (e) => e.code === 'CODEX_INVALID_OUTPUT',
      );
      assert.ok(
        Date.now() - started < 4000,
        'forbidden event stops before timeout/final',
      );
      const pid = Number(await readFile(marker, 'utf8'));
      pids.push(pid);
      assert.equal(await live(pid), false);
      evidence.push({ scenario: 'early-stream-rejection', passed: true });
      await mkdir('.test-results', { recursive: true });
      await writeFile(
        `.test-results/process-tree-${process.platform}.json`,
        JSON.stringify({
          synthetic: true,
          modelCalls: 0,
          nativeWindowsFixture: process.platform === 'win32',
          cases: evidence,
        }),
      );
    } finally {
      for (const marker of await readdir(directory))
        if (marker.endsWith('.pid'))
          pids.push(
            Number(await readFile(path.join(directory, marker), 'utf8')),
          );
      for (const pid of pids) if (await live(pid)) process.kill(pid, 'SIGKILL');
      const stopped = new Promise((resolve) => foreign.once('exit', resolve));
      foreign.kill();
      await stopped;
      if ((await realpath(directory)) === directory)
        await rm(directory, { recursive: true });
    }
  },
);
