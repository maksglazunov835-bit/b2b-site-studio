import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "playwright";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "../persistence/production-server.mjs";
import { startRunner, until, stopRunner } from "../agents/process-helpers.mjs";
import { ok, lossProxy } from "./http-helpers.mjs";

assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer(); const runners = []; const proxies = []; const secrets = [];
let browser;
try {
  await waitForHomepage(server); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; const expectedFailures = new Set();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  page.on("requestfailed", (request) => { if (!expectedFailures.has(request)) errors.push(`Unexpected failure: ${new URL(request.url()).pathname}`); });
  await page.goto(server.origin);
  await page.getByLabel("Название компании", { exact: true }).fill("Validation UI fixture");
  await page.getByRole("button", { name: "Создать бриф", exact: true }).click();
  await page.getByText("Сохранено, revision 1", { exact: true }).waitFor();
  const projectId = new URL(page.url()).searchParams.get("project"); const base = `/projects/${projectId}/jobs`;
  const panel = page.getByRole("region", { name: "Задания", exact: true });
  const connections = page.getByRole("region", { name: "Локальный Runner", exact: true });
  const niche = page.getByLabel("Ниша или направление", { exact: true });
  const refresh = panel.getByRole("button", { name: "Обновить задания", exact: true });
  await connections.getByRole("button", { name: "Открыть подключения" }).click();
  await connections.getByLabel("Режим нового подключения").selectOption("data_validation");
  const jobIds = [];
  for (const scenario of ["result", "cancel"]) {
    await connections.getByRole("button", { name: "Разрешить подключение", exact: true }).click();
    const secretInput = connections.getByLabel("Временный код Runner", { exact: true }); await secretInput.waitFor();
    const secret = await secretInput.inputValue(); secrets.push(secret);
    const proxy = await lossProxy(server.origin, { holdResult: scenario === "cancel" }); proxies.push(proxy);
    const runner = startRunner(proxy.origin, secret, { mode: "data-validation", name: `UI validator ${scenario}` }); runners.push(runner);
    await until(() => { assert.equal(runner.child.exitCode, null, runner.output()); return runner.output().includes("RUNNER_HEARTBEAT_ACK"); });
    await page.waitForFunction(() => !document.querySelector('[data-sensitive-pairing]'));
    const agent = (await ok(server.origin, "/agents")).agents.find((item) => item.agentName === `UI validator ${scenario}`);
    await panel.getByRole("button", { name: "Создать тестовое задание", exact: true }).click();
    await until(async () => (await ok(server.origin, base)).jobs.length === jobIds.length + 1);
    const job = (await ok(server.origin, base)).jobs[0]; jobIds.push(job.id);
    const row = panel.locator(`[data-job-id="${job.id}"]`); await row.waitFor();
    await refresh.click(); await panel.getByLabel("Runner для проверки").selectOption(agent.agentId);
    const dispatch = row.getByRole("button", { name: "Выполнить проверку", exact: true });
    if (scenario === "result") {
      // Dispatch may commit and even complete while the UI has not received its acknowledgement.
      const writes = []; let release; let arrive;
      const held = new Promise((resolve) => { release = resolve; }); const arrived = new Promise((resolve) => { arrive = resolve; });
      await page.route(`**/api/v1${base}/${job.id}/dispatch`, async (route) => {
        writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
        const response = await route.fetch();
        if (writes.length === 1) { arrive(); await held; expectedFailures.add(route.request()); await route.abort("failed"); }
        else await route.fulfill({ response });
      });
      await dispatch.click(); await arrived;
      assert.equal(await dispatch.isDisabled(), true);
      await dispatch.evaluate((button) => { button.click(); button.click(); });
      await niche.fill("Unsaved input survives dispatch, polling and result"); release();
      await panel.getByRole("button", { name: "Повторить запрос задания", exact: true }).click();
      await row.getByText("Проверка выполнена", { exact: true }).waitFor({ timeout: 15000 });
      await panel.getByLabel("Результат проверки", { exact: true }).waitFor();
      assert.deepEqual(writes[0], writes[1]); assert.equal(writes.length, 2);
      assert.equal(await niche.inputValue(), "Unsaved input survives dispatch, polling and result");
      await page.unroute(`**/api/v1${base}/${job.id}/dispatch`);
      await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
      await page.getByText("Сохранено, revision 2", { exact: true }).waitFor();
      await page.reload();
      await row.waitFor(); await row.getByRole("button", { name: "Журнал", exact: true }).click();
      await panel.getByLabel("Результат проверки", { exact: true }).waitFor();
      await panel.getByText("Исходная версия: 1 · Текущая: 2", { exact: true }).waitFor();
      const detail = await ok(server.origin, `${base}/${job.id}/execution`);
      assert.equal(detail.report.inputRevision, 1); assert.equal(detail.report.validationStatus, "valid");
      assert.equal(detail.attempts.length, 1); assert.equal(detail.acceptanceResult, null);
      await connections.getByRole("button", { name: "Открыть подключения" }).click();
      await connections.getByLabel("Режим нового подключения").selectOption("data_validation");
      console.log("EXECUTION_UI_REAL_EXECUTE_LOST_DISPATCH_DOUBLE_CLICK_DIRTY_REPORT_RELOAD_PINNING passed");
    } else {
      await dispatch.click();
      await until(async () => (await ok(server.origin, `${base}/${job.id}`)).job.state === "validating");
      await row.getByText("Проверяется структура SiteSpec", { exact: true }).waitFor();
      await niche.fill("Unsaved input survives cancellation");
      await row.getByRole("button", { name: "Отменить задание", exact: true }).click();
      await row.getByText("Ожидается подтверждение остановки", { exact: true }).waitFor();
      proxy.release();
      await row.getByText("Отменено", { exact: true }).waitFor({ timeout: 15000 });
      assert.equal((await ok(server.origin, `${base}/${job.id}/execution`)).report, null);
      assert.equal(await niche.inputValue(), "Unsaved input survives cancellation");
      console.log("EXECUTION_UI_CANCEL_REQUEST_ACK_NO_FALSE_RESULT_DIRTY_PRESERVED passed");
    }
    await stopRunner(runner);
  }
  await panel.locator(`[data-job-id="${jobIds[0]}"]`).getByRole("button", { name: "Журнал", exact: true }).click();
  await panel.getByLabel("Результат проверки", { exact: true }).waitFor();
  await mkdir(".test-results", { recursive: true });
  for (const { name, viewport } of [{ name: "desktop", viewport: { width: 1440, height: 1000 } }, { name: "mobile", viewport: { width: 390, height: 844 } }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator("[data-sensitive-pairing]").count(), 0);
    const persisted = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage));
    for (const secret of [...secrets, ...proxies.flatMap((proxy) => proxy.secrets)]) {
      assert.equal((await page.content()).includes(secret), false); assert.equal(persisted.includes(secret), false);
      assert.equal(page.url().includes(secret), false);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `.test-results/execution-${name}.png`, fullPage: true });
    assert.ok((await stat(`.test-results/execution-${name}.png`)).size < 5 * 1024 * 1024);
  }
  assert.deepEqual(errors, []);
  console.log("EXECUTION_UI_DESKTOP_MOBILE_COMPLETED_REPORT_JOURNAL_NO_SECRET_CONSOLE passed");
} finally {
  for (const proxy of proxies) proxy.release();
  for (const runner of runners) await stopRunner(runner);
  for (const proxy of proxies) await proxy.close();
  if (browser) await browser.close(); await stopServer(server);
}
