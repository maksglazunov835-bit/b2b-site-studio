// Opt-in only, through the protected test runner; no SQL reset or dev writes.
import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
import { officialAdapter } from '../../agent/codex/adapter.mjs';
import { assertSafeTestDatabaseUrl } from '../db/test-config.mjs';
import {
  startProductionServer,
  waitForHomepage,
  stopServer,
} from '../../tests/persistence/production-server.mjs';
import { ok, write } from '../../tests/execution/http-helpers.mjs';
import { until } from '../../tests/agents/process-helpers.mjs';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
import {
  ADAPTER,
  assertProposal,
  designInput,
} from '../../server/design/contract.mjs';
import { startOfficialRunner } from './runner-process.mjs';
import {
  SMOKE_AUTHORIZATION,
  authorizationDirectory,
  reserveAuthorization,
  continueUnusedAuthorization,
  continuationDirectory,
  bindAuthorization,
  consumeAuthorization,
  writeSmokeEvidence,
} from './smoke-budget.mjs';
import { safeStartupCode } from '../../agent/startup-receipt.mjs';
import { holdPreparedLab } from './session.mjs';
const safeSmokeCode = (error, stage) =>
  [
    'LAB_SESSION_UNCONFIRMED',
    'LAB_SESSION_LOST',
    'LAB_SESSION_STOP_UNCONFIRMED',
    'LAB_SETUP_REQUIRED',
  ].includes(error?.message)
    ? error.message
    : safeStartupCode(error, stage);
async function main() {
  const database = assertSafeTestDatabaseUrl();
  if (
    process.argv[2] !== '--confirm-one-real-call' ||
    process.argv[3] !== '--authorization' ||
    process.argv[4] !== SMOKE_AUTHORIZATION.id ||
    !(
      process.argv.length === 5 ||
      (process.argv.length === 6 &&
        process.argv[5] === '--resume-preflight-only')
    ) ||
    database.database !== 'b2b_site_studio_live_smoke_02_test' ||
    process.platform !== 'win32' ||
    process.env.CI ||
    process.env.B2B_DESIGN_TEST_STUB
  )
    throw Object.assign(Error(), { code: 'LIVE_SMOKE_NOT_AUTHORIZED' });
  await mkdir('.test-results', { recursive: true });
  const draft = {
    companyName: 'Synthetic stationery catalog',
    niche: 'Stationery',
    salesRegion: '',
    businessType: 'wholesale',
    siteType: 'catalog',
    networkType: 'single',
  };
  // Fixed operator tooling, never job/model-selected commands. The server build
  // and Runner must come from this committed checkout and generated manifest.
  const git = (...args) =>
    execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  const headSha = git('rev-parse', 'HEAD');
  assert.equal(
    git('branch', '--show-current'),
    'codex/mvp-04a-codex-design-proposals',
  );
  assert.deepEqual(
    git('diff', '--name-only', 'HEAD')
      .split('\n')
      .filter((f) => f && f !== 'reports/change-report.md'),
    [],
  );
  execFileSync(process.execPath, ['scripts/contracts/design-manifest.mjs'], {
    windowsHide: true,
    stdio: 'pipe',
  });
  const context = {
    headSha,
    manifestSha256: ADAPTER.sha256,
    inputSha256: sha256Json(draft),
  };
  const continued =
    process.argv[5] === '--resume-preflight-only'
      ? await continueUnusedAuthorization(
          '.test-results',
          process.argv[4],
          context,
        )
      : null;
  const continuation = continued?.continuation;
  const reservation =
    continued?.reservation ??
    (await reserveAuthorization('.test-results', process.argv[4], context));
  const directory = continuation
    ? continuationDirectory('.test-results')
    : authorizationDirectory('.test-results');
  const evidence = (name, value) => writeSmokeEvidence(directory, name, value);
  let held,
    runner,
    browser,
    agentId,
    server,
    projectId,
    jobId,
    consumed = false;
  let stage = 'preflight';
  try {
    held = await holdPreparedLab();
    await evidence('lab-session.json', held.receipt);
    const preflight = await officialAdapter(null, { transport: 'wsl' });
    await evidence('preflight.json', {
      runtime: preflight.runtime,
      diagnostics: preflight.diagnostics,
      modelInvocations: 0,
    });
    if (preflight.runtime.status !== 'ready')
      throw Object.assign(Error(), {
        code: preflight.diagnostics?.status ?? preflight.runtime.status,
      });
    assert.equal(preflight.runtime.policySha256, ADAPTER.sha256);
    stage = 'platform';
    server = await startProductionServer({ agentIntervalSeconds: 1 });
    await waitForHomepage(server);
    const project = (
      await ok(
        server.origin,
        '/projects',
        write({ displayName: 'Opt-in synthetic Codex smoke', draft }),
      )
    ).project;
    projectId = project.id;
    const saved = await ok(server.origin, `/projects/${project.id}/site-spec`);
    assert.equal(
      sha256Json(designInput(saved.siteSpec.value)),
      reservation.inputSha256,
    );
    const base = `/projects/${project.id}/jobs`;
    const job = (
      await ok(
        server.origin,
        base,
        write({ type: 'design_proposal', expectedRevision: 1 }),
      )
    ).job;
    jobId = job.id;
    assert.equal(job.siteSpec.sha256, saved.siteSpec.sha256);
    assert.equal(job.siteSpec.revision, 1);
    const binding = await bindAuthorization(
      '.test-results',
      reservation,
      {
        projectId,
        jobId,
        revision: job.siteSpec.revision,
        siteSpecSha256: job.siteSpec.sha256,
      },
      continuation,
    );
    await evidence('project.json', {
      projectId,
      jobId,
      revision: 1,
      siteSpecSha256: job.siteSpec.sha256,
      inputSha256: reservation.inputSha256,
      headSha,
      manifestSha256: ADAPTER.sha256,
    });
    stage = 'registration';
    const pairing = await ok(
      server.origin,
      '/agents/pairings',
      write({ mode: 'codex_design', projectId: project.id }),
    );
    runner = startOfficialRunner(server.origin, pairing.pairingSecret);
    const child = runner.child;
    await runner.waitForHeartbeat();
    agentId = (await ok(server.origin, '/agents')).agents.find(
      (a) => a.projectId === project.id,
    ).agentId;
    stage = 'dispatch';
    held.assertActive();
    await consumeAuthorization(
      '.test-results',
      reservation,
      binding,
      continuation,
    );
    consumed = true;
    await ok(
      server.origin,
      `${base}/${job.id}/dispatch`,
      write({ agentId, expectedVersion: 1 }),
    );
    stage = 'execution';
    await until(async () => {
      const current = (await ok(server.origin, `${base}/${job.id}`)).job;
      if (['failed', 'cancelled'].includes(current.state)) {
        const execution = await ok(
          server.origin,
          `${base}/${job.id}/execution`,
        );
        const code =
          execution.attempts.at(-1)?.failure_code ??
          'REAL_SMOKE_TERMINAL_FAILURE_NO_RETRY';
        await evidence('terminal-failure.json', {
          jobId: job.id,
          state: current.state,
          errorCode: safeStartupCode({ code }, 'preflight'),
          attempts: execution.attempts.length,
          at: new Date().toISOString(),
        });
        throw Object.assign(Error(), { code });
      }
      assert.equal(
        child.exitCode,
        null,
        'Runner stopped with uncertain result; do not repeat invocation',
      );
      return current.state === 'succeeded';
    }, 185000);
    const result = await ok(server.origin, `${base}/${job.id}/execution`);
    assert.equal(result.report.provider, 'codex');
    assert.equal(result.report.providerInvocations, 1);
    assert.equal(result.report.model, 'gpt-6-astra');
    assert.equal(result.report.effort, 'ultra');
    assert.equal(result.attempts.length, 1);
    assertProposal(result.report.proposal, draft);
    await evidence('validated-result.json', result.report);
    stage = 'stop';
    // Stop the foreground Runner before reload; a reload cannot perform inference.
    await ok(server.origin, `/agents/${agentId}/revoke`, write());
    const stopped = await runner.finish();
    assert.equal(stopped.exitCode, 1);
    agentId = null;
    stage = 'reload';
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on('pageerror', () => errors.push('PAGE_ERROR'));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push('CONSOLE_ERROR');
    });
    await page.goto(`${server.origin}/?project=${project.id}`);
    await page.reload();
    const panel = page.getByRole('region', {
      name: 'Дизайн-концепции',
      exact: true,
    });
    await panel
      .locator(`[data-job-id="${job.id}"]`)
      .getByRole('button', { name: 'Журнал', exact: true })
      .click();
    await panel
      .getByRole('button', { name: 'Открыть три концепции', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Предпросмотр дизайна' });
    await dialog.waitFor();
    for (const { name, viewport } of [
      { name: 'desktop', viewport: { width: 1440, height: 1000 } },
      { name: 'mobile', viewport: { width: 390, height: 844 } },
    ]) {
      await page.setViewportSize(viewport);
      await dialog
        .getByRole('button', {
          name: name === 'desktop' ? 'Desktop' : 'Mobile',
          exact: true,
        })
        .click();
      for (let i = 0; i < 3; i++) {
        await dialog
          .getByRole('tablist', { name: 'Концепции', exact: true })
          .getByRole('tab')
          .nth(i)
          .click();
        for (const pageName of ['Каталог', 'Карточка товара', 'Главная'])
          await dialog
            .getByRole('tablist', { name: 'Страницы концепции' })
            .getByRole('tab', { name: pageName, exact: true })
            .click();
        assert.equal(
          (await page.content()).includes(pairing.pairingSecret),
          false,
        );
        assert.ok(
          await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
        );
        const file = path.join(directory, `real-design-${i + 1}-${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        assert.ok((await stat(file)).size < 2000000);
      }
    }
    assert.deepEqual(errors, []);
    const reloaded = await ok(server.origin, `${base}/${job.id}/execution`);
    assert.deepEqual(reloaded.report, result.report);
    assert.equal(reloaded.attempts.length, 1);
    const receipt = {
      kind: 'actual-platform-windows-runner-wsl-codex',
      completedAt: new Date().toISOString(),
      modelInvocations: 1,
      provider: 'codex',
      requestedModel: 'gpt-6-astra',
      effort: 'ultra',
      modelEvidence: result.report.modelEvidence,
      cliVersion: result.report.cliVersion,
      hashes: preflight.diagnostics.hashes,
      inputSha256: result.report.inputSha256,
      outputSha256: sha256Json(result.report.proposal),
      reportSha256: sha256Json(result.report),
      concepts: 3,
      reloadUnchanged: true,
      projectId: project.id,
      jobId: job.id,
      authorizationId: SMOKE_AUTHORIZATION.id,
      headSha,
      manifestSha256: ADAPTER.sha256,
    };
    await evidence('result.json', receipt);
    console.log('REAL_CODEX_SMOKE_SAVED_ONE_INVOCATION');
  } catch (error) {
    await evidence('failure.json', {
      authorizationId: SMOKE_AUTHORIZATION.id,
      headSha,
      stage,
      errorCode: safeSmokeCode(error, 'preflight'),
      consumed,
      projectId: projectId ?? null,
      jobId: jobId ?? null,
      at: new Date().toISOString(),
    });
    throw error;
  } finally {
    try {
      if (browser) await browser.close();
      if (
        runner &&
        runner.child.exitCode === null &&
        runner.child.signalCode === null
      ) {
        if (agentId)
          await ok(server.origin, `/agents/${agentId}/revoke`, write());
        runner.stop();
      }
      if (runner) {
        try {
          await runner.finish();
        } finally {
          const receipt = runner.snapshot();
          for (const invocation of runner.invocations())
            await evidence(`invocation-${invocation.runId}.json`, invocation);
          await evidence('startup.json', receipt);
          console.log('RUNNER_STARTUP_RECEIPT', JSON.stringify(receipt));
        }
      }
    } finally {
      try {
        if (server) await stopServer(server);
      } finally {
        if (held) await held.stop();
      }
    }
  }
}
main().catch((error) => {
  console.error('LIVE_SMOKE_FAILED', safeSmokeCode(error, 'registration'));
  process.exitCode = 1;
});
