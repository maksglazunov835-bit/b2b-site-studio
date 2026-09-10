// Opt-in only, through the protected test runner; no SQL reset or dev writes.
import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
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
import { assertProposal } from '../../server/design/contract.mjs';
import { startOfficialRunner } from './runner-process.mjs';
import {
  continueReservation,
  consumeProviderStart,
  unusedReservation,
} from './smoke-budget.mjs';
import { safeStartupCode } from '../../agent/startup-receipt.mjs';
async function main() {
  assertSafeTestDatabaseUrl();
  if (
    process.argv[2] !== '--confirm-one-real-call' ||
    process.argv[3] !== '--continue-unused-reservation' ||
    process.argv.length !== 4 ||
    process.platform !== 'win32' ||
    process.env.CI ||
    process.env.B2B_DESIGN_TEST_STUB
  )
    throw Object.assign(Error(), { code: 'LIVE_SMOKE_NOT_AUTHORIZED' });
  const preflight = await officialAdapter(null, { transport: 'wsl' });
  if (preflight.runtime.status !== 'ready')
    throw Object.assign(Error(), {
      code: preflight.diagnostics?.status ?? preflight.runtime.status,
    });
  await mkdir('.test-results', { recursive: true });
  await unusedReservation('.test-results');
  const draft = {
    companyName: 'Synthetic stationery catalog',
    niche: 'Stationery',
    salesRegion: '',
    businessType: 'wholesale',
    siteType: 'catalog',
    networkType: 'single',
  };
  const server = await startProductionServer({ agentIntervalSeconds: 1 });
  let runner, browser, agentId;
  try {
    await waitForHomepage(server);
    const project = (
      await ok(
        server.origin,
        '/projects',
        write({ displayName: 'Opt-in synthetic Codex smoke', draft }),
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
    const continuation = await continueReservation('.test-results', {
      projectId: project.id,
      jobId: job.id,
    });
    await consumeProviderStart('.test-results', continuation);
    await ok(
      server.origin,
      `${base}/${job.id}/dispatch`,
      write({ agentId, expectedVersion: 1 }),
    );
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
        await writeFile(
          '.test-results/real-codex-terminal-failure.json',
          JSON.stringify(
            {
              jobId: job.id,
              state: current.state,
              errorCode: safeStartupCode({ code }, 'preflight'),
              attempts: execution.attempts.length,
              at: new Date().toISOString(),
            },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        );
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
    // Stop the foreground Runner before reload; a reload cannot perform inference.
    await ok(server.origin, `/agents/${agentId}/revoke`, write());
    const stopped = await runner.finish();
    assert.equal(stopped.exitCode, 1);
    agentId = null;
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
        const file = `.test-results/real-design-${i + 1}-${name}.png`;
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
    };
    await writeFile(
      '.test-results/real-codex-receipt.json',
      JSON.stringify(receipt, null, 2) + '\n',
    );
    console.log('REAL_CODEX_SMOKE_SAVED_ONE_INVOCATION');
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
            await writeFile(
              `.test-results/invocation-${invocation.runId}-${invocation.jobId}-attempt-${invocation.attempt}.json`,
              JSON.stringify(invocation, null, 2) + '\n',
              { flag: 'wx' },
            );
          await writeFile(
            `.test-results/startup-${receipt.runId}.json`,
            JSON.stringify(receipt, null, 2) + '\n',
            { flag: 'wx' },
          );
          console.log('RUNNER_STARTUP_RECEIPT', JSON.stringify(receipt));
        }
      }
    } finally {
      await stopServer(server);
    }
  }
}
main().catch((error) => {
  console.error('LIVE_SMOKE_FAILED', safeStartupCode(error, 'registration'));
  process.exitCode = 1;
});
