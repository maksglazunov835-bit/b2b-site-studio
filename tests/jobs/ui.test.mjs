import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { chromium } from "playwright";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "../persistence/production-server.mjs";

assertSafeTestDatabaseUrl();
await prepareTestDatabase();
const server = await startProductionServer();
let browser;
const errors = [];
const expectedNetworkFailures = new Set();

try {
  await waitForHomepage(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on("requestfailed", (request) => {
    if (!expectedNetworkFailures.has(request)) errors.push(`Unexpected network failure: ${new URL(request.url()).pathname}`);
  });
  await page.goto(server.origin);
  await page.getByLabel("Название компании", { exact: true }).fill("Jobs UI fixture");
  await page.getByRole("button", { name: "Создать бриф", exact: true }).click();
  await page.getByText("Сохранено, revision 1", { exact: true }).waitFor();
  const projectId = new URL(page.url()).searchParams.get("project");
  const panel = page.getByRole("region", { name: "Задания", exact: true });
  const settled = () => page.waitForFunction(() => {
    const refresh = document.querySelector('button[aria-label="Обновить задания"]');
    return refresh && !refresh.disabled;
  });
  const create = panel.getByRole("button", { name: "Создать тестовое задание", exact: true });
  const niche = page.getByLabel("Ниша или направление", { exact: true });
  const base = `${server.origin}/api/v1/projects/${projectId}/jobs`;
  let arrived; let release;
  const arrivedPromise = new Promise((resolve) => { arrived = resolve; });
  const delayed = new Promise((resolve) => { release = resolve; });
  const writes = [];
  await page.route(`**/api/v1/projects/${projectId}/jobs`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const response = await route.fetch();
    if (writes.length === 1) {
      arrived();
      await delayed;
      expectedNetworkFailures.add(route.request());
      return route.abort("failed");
    }
    await route.fulfill({ response });
  });
  await create.click();
  await arrivedPromise;
  assert.equal(await create.isDisabled(), true);
  await create.evaluate((button) => { button.click(); button.click(); });
  await niche.fill("Typed while job request is pending");
  release();
  const retry = panel.getByRole("button", { name: "Повторить запрос задания", exact: true });
  await retry.waitFor();
  assert.equal(await create.isDisabled(), true);
  await retry.click();
  await panel.locator("li[data-job-id]").waitFor();
  await settled();
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(writes.length, 2);
  assert.equal(await niche.inputValue(), "Typed while job request is pending");
  const first = await (await fetch(base)).json();
  assert.equal(first.jobs.length, 1);
  const jobId = first.jobs[0].id;
  const pinned = first.jobs[0].siteSpec;
  assert.equal(pinned.revision, 1);
  assert.equal((await (await fetch(`${base}/${jobId}/events`)).json()).events.length, 1);
  await page.unroute(`**/api/v1/projects/${projectId}/jobs`);
  console.log("JOBS_UI_LOST_CREATE_DOUBLE_CLICK_AND_DIRTY_INPUT passed");

  await page.reload();
  await page.getByText("Сохранено, revision 1", { exact: true }).waitFor();
  const oldRow = panel.locator(`[data-job-id="${jobId}"]`);
  await oldRow.waitFor();
  await niche.fill("New brief, keep my input during list refresh");
  await panel.getByRole("button", { name: "Обновить задания" }).click();
  await settled();
  assert.equal(await niche.inputValue(), "New brief, keep my input during list refresh");
  assert.equal(await create.isDisabled(), true);
  await panel.getByText("Сначала сохраните бриф", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  await page.getByText("Сохранено, revision 2", { exact: true }).waitFor();
  await oldRow.getByText("Бриф обновлён: задание относится к версии 1", { exact: true }).waitFor();
  await oldRow.getByRole("button", { name: "Журнал", exact: true }).click();
  const journal = panel.getByRole("region", { name: "Журнал задания", exact: true });
  await journal.getByText("Исходная версия: 1 · Текущая: 2", { exact: true }).waitFor();
  assert.deepEqual((await (await fetch(`${base}/${jobId}`)).json()).job.siteSpec, pinned);
  await create.click();
  await page.waitForFunction(() => document.querySelectorAll('[data-job-id]').length === 2);
  await settled();
  const all = await (await fetch(base)).json();
  assert.deepEqual(all.jobs.map((j) => j.siteSpec.revision), [2, 1]);
  console.log("JOBS_UI_RELOAD_NEW_BRIEF_PINNING_AND_REFRESH passed");

  const cancels = [];
  await page.route(`**/api/v1/projects/${projectId}/jobs/${jobId}/cancel`, async (route) => {
    cancels.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const response = await route.fetch();
    if (cancels.length === 1) {
      expectedNetworkFailures.add(route.request());
      return route.abort("failed");
    }
    await route.fulfill({ response });
  });
  await oldRow.getByRole("button", { name: "Отменить задание", exact: true }).click();
  await retry.waitFor();
  await retry.click();
  await oldRow.getByText("Отменено до запуска", { exact: true }).waitFor();
  await settled();
  assert.deepEqual(cancels[0], cancels[1]);
  assert.equal(JSON.parse(cancels[1].body).expectedVersion, 1);
  await page.reload();
  await oldRow.getByText("Отменено до запуска", { exact: true }).waitFor();
  await oldRow.getByRole("button", { name: "Журнал", exact: true }).click();
  await journal.getByText(/2\. Задание отменено/).waitFor();
  const final = (await (await fetch(`${base}/${jobId}`)).json()).job;
  assert.equal(final.state, "cancelled");
  assert.equal(final.executionResult, "cancelled");
  assert.equal(final.acceptanceResult, null);
  assert.deepEqual(final.siteSpec, pinned);
  const events = (await (await fetch(`${base}/${jobId}/events`)).json()).events;
  assert.deepEqual(events.map((e) => e.sequence), [1, 2]);
  assert.equal(await niche.inputValue(), "New brief, keep my input during list refresh");
  console.log("JOBS_UI_LOST_CANCEL_REPLAY_AND_RELOAD passed");

  await mkdir(".test-results", { recursive: true });
  for (const { name, viewport } of [
    { name: "desktop", viewport: { width: 1440, height: 1000 } },
    { name: "mobile", viewport: { width: 390, height: 844 } }
  ]) {
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `.test-results/jobs-${name}.png`, fullPage: true });
    assert.ok((await stat(`.test-results/jobs-${name}.png`)).size < 5 * 1024 * 1024);
  }

  // Only this deliberately held request may be aborted by project navigation.
  const other = await (await fetch(`${server.origin}/api/v1/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "jobs-ui-other" },
    body: JSON.stringify({ displayName: "Jobs UI project B", draft: { companyName: "Jobs UI project B" } })
  })).json();
  let loading; let finish; let completed;
  const loadingPromise = new Promise((resolve) => { loading = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const complete = new Promise((resolve) => { completed = resolve; });
  await page.route(`**/api/v1/projects/${projectId}/jobs`, async (route) => {
    const response = await route.fetch();
    expectedNetworkFailures.add(route.request());
    loading();
    await hold;
    await route.fulfill({ response }).catch(() => undefined);
    completed();
  });
  await panel.getByRole("button", { name: "Обновить задания" }).click();
  await loadingPromise;
  await page.evaluate((id) => {
    history.replaceState(null, "", `/?project=${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, other.project.id);
  await page.getByText("Сохранено, revision 1", { exact: true }).waitFor();
  await panel.getByText("Заданий пока нет", { exact: true }).waitFor();
  finish();
  await complete;
  await settled();
  assert.equal(await panel.locator("li[data-job-id]").count(), 0);
  assert.equal(await page.getByLabel("Название компании", { exact: true }).inputValue(), "Jobs UI project B");
  console.log("JOBS_UI_STALE_LOAD_CANCELLED passed");
  assert.deepEqual(errors, []);
  console.log("JOBS_UI_DESKTOP_MOBILE_CONSOLE passed");
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
