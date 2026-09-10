import assert from 'node:assert/strict';
import { mkdir, stat } from 'node:fs/promises';
import { chromium } from 'playwright';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import { prepareTestDatabase } from '../persistence/helpers.mjs';
import { closeDatabasePool } from '../../server/persistence/database.mjs';
import {
  startProductionServer,
  waitForHomepage,
  stopServer,
} from '../persistence/production-server.mjs';
import { ok, write } from '../execution/http-helpers.mjs';
import { until, stopRunner } from '../agents/process-helpers.mjs';
import { startDesignRunner } from './helpers.mjs';
import { brief } from './fixtures.mjs';
import { assertProposal } from '../../server/design/contract.mjs';
assertSafeTestDatabaseUrl();
await prepareTestDatabase();
await closeDatabasePool();
const server = await startProductionServer({
  designStub: true,
  agentIntervalSeconds: 1,
});
let browser, runner;
try {
  await waitForHomepage(server);
  browser = await chromium.launch({ headless: true });
  const project = (
    await ok(
      server.origin,
      '/projects',
      write({ displayName: 'Design UI fixture', draft: brief }),
    )
  ).project;
  const base = `/projects/${project.id}/jobs`;
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [],
    expected = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text());
  });
  page.on('response', (r) => {
    if (r.status() >= 400)
      errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
  });
  page.on('requestfailed', (r) => {
    if (!expected.has(r)) errors.push(`Failed ${new URL(r.url()).pathname}`);
  });
  await page.goto(`${server.origin}/?project=${project.id}`);
  await page.getByText('Сохранено, revision 1', { exact: true }).waitFor();
  const panel = page.getByRole('region', {
    name: 'Дизайн-концепции',
    exact: true,
  });
  const connections = page.getByRole('region', {
    name: 'Локальный Runner',
    exact: true,
  });
  await connections
    .getByRole('button', { name: 'Открыть подключения' })
    .click();
  await connections
    .getByLabel('Режим нового подключения')
    .selectOption('codex_design');
  await connections
    .getByRole('button', { name: 'Разрешить подключение', exact: true })
    .click();
  const input = connections.getByLabel('Временный код Runner', { exact: true });
  await input.waitFor();
  const secret = await input.inputValue();
  runner = startDesignRunner(server.origin, secret);
  await until(() => {
    assert.equal(runner.child.exitCode, null, runner.output());
    return runner.output().includes('RUNNER_HEARTBEAT_ACK');
  });
  await page.waitForFunction(
    () => !document.querySelector('[data-sensitive-pairing]'),
  );
  const agent = (await ok(server.origin, '/agents')).agents.find(
    (a) => a.projectId === project.id,
  );
  const create = panel.getByRole('button', {
    name: 'Создать заявку на дизайн',
    exact: true,
  });
  await create.click();
  await until(async () => (await ok(server.origin, base)).jobs.length === 1);
  const job = (await ok(server.origin, base)).jobs[0];
  const row = panel.locator(`[data-job-id="${job.id}"]`);
  await row.waitFor();
  await panel
    .getByRole('button', { name: 'Обновить задания', exact: true })
    .click();
  await panel.getByLabel('Runner для проверки').selectOption(agent.agentId);
  const dispatch = row.getByRole('button', {
    name: 'Получить три концепции',
    exact: true,
  });
  assert.equal(await dispatch.isDisabled(), true);
  await panel.getByRole('checkbox').check();
  const operations = [];
  let release, arrive;
  const held = new Promise((r) => {
    release = r;
  });
  const arrived = new Promise((r) => {
    arrive = r;
  });
  await page.route(`**/api/v1${base}/${job.id}/dispatch`, async (route) => {
    operations.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    const response = await route.fetch();
    if (operations.length === 1) {
      arrive();
      await held;
      expected.add(route.request());
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await dispatch.click();
  await arrived;
  assert.equal(await dispatch.isDisabled(), true);
  await dispatch.evaluate((button) => {
    button.click();
    button.click();
  });
  const niche = page.getByLabel('Ниша или направление', { exact: true });
  await niche.fill('Unsaved design input');
  release();
  await panel
    .getByRole('button', { name: 'Повторить запрос задания', exact: true })
    .click();
  await row
    .getByText('Концепции сохранены', { exact: true })
    .waitFor({ timeout: 15000 });
  assert.deepEqual(operations[0], operations[1]);
  assert.equal(operations.length, 2);
  assert.equal(await niche.inputValue(), 'Unsaved design input');
  await page.unroute(`**/api/v1${base}/${job.id}/dispatch`);
  await page
    .getByRole('button', { name: 'Сохранить черновик', exact: true })
    .click();
  await page.getByText('Сохранено, revision 2', { exact: true }).waitFor();
  await page.reload();
  await row.waitFor();
  await row.getByRole('button', { name: 'Журнал', exact: true }).click();
  await panel
    .getByText('Исходная версия: 1 · Текущая: 2', { exact: true })
    .waitFor();
  await panel
    .getByRole('button', { name: 'Открыть три концепции', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Предпросмотр дизайна' });
  await dialog.waitFor();
  await mkdir('.test-results', { recursive: true });
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
      for (const pageName of ['Каталог', 'Карточка товара', 'Главная']) {
        await dialog
          .getByRole('tablist', { name: 'Страницы концепции' })
          .getByRole('tab', { name: pageName, exact: true })
          .click();
        await dialog
          .locator(`[data-design-preview="concept-${i + 1}"]`)
          .waitFor();
      }
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      assert.ok(
        await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1),
      );
      assert.equal((await page.content()).includes(secret), false);
      assert.equal(
        (
          await page.evaluate(
            () => JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
          )
        ).includes(secret),
        false,
      );
      await dialog.screenshot({
        path: `.test-results/design-${i + 1}-${name}.png`,
      });
      assert.ok(
        (await stat(`.test-results/design-${i + 1}-${name}.png`)).size <
          5 * 1024 * 1024,
      );
    }
  }
  await dialog
    .getByRole('button', { name: 'Закрыть предпросмотр', exact: true })
    .click();
  // Renderer boundary fixture only: valid maximum-length text, no stored result mutation.
  await page.route(`**/api/v1${base}/${job.id}/execution`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.report.proposal.concepts.forEach((concept, index) => {
      concept.name = String(index) + 'W'.repeat(59);
      concept.rationale = 'R'.repeat(240);
    });
    assertProposal(data.report.proposal, brief);
    await route.fulfill({ response, json: data });
  });
  await row.getByRole('button', { name: 'Журнал', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Открыть три концепции', exact: true })
    .click();
  await dialog
    .getByRole('tab', { name: '0' + 'W'.repeat(59), exact: true })
    .waitFor();
  assert.ok(await dialog.evaluate((d) => d.scrollWidth <= d.clientWidth + 1));
  await page.unroute(`**/api/v1${base}/${job.id}/execution`);
  console.log('DESIGN_UI_MAXIMUM_LENGTH_TEXT_MOBILE_BOUNDARY passed');
  assert.equal(runner.output().split('TEST_CLI_INVOCATION').length - 1, 1);
  assert.equal((await ok(server.origin, base)).jobs.length, 1);
  assert.deepEqual(errors, []);
  const detail = await ok(server.origin, `${base}/${job.id}/execution`);
  assert.equal(detail.report.provider, 'test_stub');
  assert.equal(detail.attempts.length, 1);
  console.log(
    'DESIGN_UI_PAIR_CONSENT_LOST_DISPATCH_DIRTY_PINNING_RELOAD_THREE_CONCEPTS_PAGES_DESKTOP_MOBILE_ONE_STUB_CALL_NO_SECRETS passed',
  );
} finally {
  if (runner) await stopRunner(runner);
  if (browser) await browser.close();
  await stopServer(server);
}
