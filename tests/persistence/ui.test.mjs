import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { resetTestDatabase } from "../../scripts/db/test-reset.mjs";
import { runMigrations } from "../../scripts/db/migration-lib.mjs";
import { startProductionServer, waitForHomepage, stopServer } from "./production-server.mjs";

const databaseConfig = assertSafeTestDatabaseUrl();
await resetTestDatabase();
await runMigrations({ databaseConfig });
const server = await startProductionServer();
let browser;
const errors = [];
const expectedNetworkFailures = new Set();
const fixture = { companyName: "UI regression", niche: "Initial", salesRegion: "Test region", businessType: "services", siteType: "catalog", networkType: "single" };

async function saved(page, revision) {
  await page.getByText(`Сохранено, revision ${revision}`, { exact: true }).waitFor();
}

function collectErrors(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && response.status() !== 409 && !response.url().endsWith("/favicon.ico")) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  page.on("requestfailed", (request) => {
    if (!expectedNetworkFailures.has(request)) errors.push(`Unexpected network failure: ${new URL(request.url()).pathname}`);
  });
}

try {
  await waitForHomepage(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  collectErrors(page);
  await page.goto(server.origin);
  await page.getByLabel("Название компании", { exact: true }).fill(fixture.companyName);
  const create = page.getByRole("button", { name: "Создать бриф", exact: true });
  let writes = 0;
  const operations = [];
  await page.route("**/api/v1/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    writes++;
    operations.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const response = await route.fetch();
    if (writes === 1) {
      expectedNetworkFailures.add(route.request());
      return route.abort("failed");
    }
    await route.fulfill({ response });
  });
  await create.click();
  await page.getByText("Ответ не получен. Повторите сохранение для проверки результата.", { exact: true }).waitFor();
  await create.click();
  await saved(page, 1);
  assert.deepEqual(operations[0], operations[1]);
  const id = new URL(page.url()).searchParams.get("project");
  const projects = await (await fetch(`${server.origin}/api/v1/projects`)).json();
  assert.equal(projects.projects.filter((project) => project.displayName === fixture.companyName).length, 1);
  console.log("UI_LOST_POST_RETRY passed (same key/payload, one project)");

  const niche = page.getByLabel("Ниша или направление", { exact: true });
  await niche.fill("Saved after delay");
  let release;
  const delay = new Promise((resolve) => { release = resolve; });
  let saveCount = 0;
  await page.route(`**/api/v1/projects/${id}/site-spec`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saveCount++;
    await delay;
    await route.fulfill({ response: await route.fetch() });
  });
  const save = page.getByRole("button", { name: "Сохранить черновик", exact: true });
  await save.click();
  assert.equal(await niche.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  // Native clicks on disabled controls must not create a second request.
  await save.evaluate((button) => { button.click(); button.click(); });
  await page.keyboard.type("must not overwrite");
  assert.equal(await niche.inputValue(), "Saved after delay");
  assert.equal(await page.locator("fieldset button").first().isDisabled(), true);
  release();
  await saved(page, 2);
  assert.equal(saveCount, 1);
  await page.unroute(`**/api/v1/projects/${id}/site-spec`);
  await page.reload();
  await saved(page, 2);
  assert.equal(await niche.inputValue(), "Saved after delay");
  console.log("UI_DELAY_AND_DOUBLE_CLICK passed");

  const newer = await fetch(`${server.origin}/api/v1/projects/${id}/site-spec`, {
    method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": "ui-concurrent-writer" },
    body: JSON.stringify({ expectedRevision: 2, draft: { ...fixture, niche: "Other writer" } })
  });
  assert.equal(newer.status, 200);
  await niche.fill("Local conflict");
  await save.click();
  await page.getByText("Конфликт: на сервере revision 3", { exact: true }).waitFor();
  assert.equal(await niche.inputValue(), "Local conflict");
  await page.getByRole("button", { name: "Загрузить актуальную revision" }).click();
  await saved(page, 3);
  assert.equal(await niche.inputValue(), "Other writer");
  await niche.fill("After conflict");
  await save.click();
  await saved(page, 4);
  assert.equal(await page.getByLabel("Важные ограничения").isDisabled(), true);
  console.log("UI_LOAD_CONFLICT_RESAVE passed");

  const retryWrites = [];
  await page.route(`**/api/v1/projects/${id}/site-spec`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    retryWrites.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    const response = await route.fetch();
    if (retryWrites.length === 1) {
      expectedNetworkFailures.add(route.request());
      return route.abort("failed");
    }
    await route.fulfill({ response });
  });
  await niche.fill("Retry committed PUT");
  await save.click();
  await page.getByText("Ответ не получен. Повторите сохранение для проверки результата.", { exact: true }).waitFor();
  await save.click();
  await saved(page, 5);
  assert.deepEqual(retryWrites[0], retryWrites[1]);
  assert.equal(JSON.parse(retryWrites[1].body).expectedRevision, 4);
  await page.unroute(`**/api/v1/projects/${id}/site-spec`);
  console.log("UI_LOST_PUT_RETRY passed (same key/payload/expectedRevision)");

  const changedWrites = [];
  await page.route(`**/api/v1/projects/${id}/site-spec`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    changedWrites.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
    if (changedWrites.length === 1) {
      expectedNetworkFailures.add(route.request());
      return route.abort("failed");
    }
    await route.fulfill({ response: await route.fetch() });
  });
  await niche.fill("Failed before SQL");
  await save.click();
  await page.getByText("Ответ не получен. Повторите сохранение для проверки результата.", { exact: true }).waitFor();
  await niche.fill("New payload after failure");
  await save.click();
  await saved(page, 6);
  assert.notEqual(changedWrites[0].key, changedWrites[1].key);
  assert.notEqual(changedWrites[0].body, changedWrites[1].body);
  await page.unroute(`**/api/v1/projects/${id}/site-spec`);
  console.log("UI_CHANGED_PAYLOAD_NEW_KEY passed");

  // A delayed load for A must never overwrite the later navigation to B.
  const otherResponse = await fetch(`${server.origin}/api/v1/projects`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "ui-other-project" },
    body: JSON.stringify({ displayName: "UI project B", draft: { ...fixture, companyName: "UI project B" } })
  });
  const other = await otherResponse.json();
  let started;
  let finishOld;
  let oldFinished;
  const completedOld = new Promise((resolve) => { oldFinished = resolve; });
  const oldStarted = new Promise((resolve) => { started = resolve; });
  const oldDelay = new Promise((resolve) => { finishOld = resolve; });
  await page.route(`**/api/v1/projects/${id}/site-spec`, async (route) => {
    const response = await route.fetch();
    expectedNetworkFailures.add(route.request());
    started();
    await oldDelay;
    await route.fulfill({ response }).catch(() => undefined);
    oldFinished();
  });
  await page.evaluate((projectId) => {
    history.replaceState(null, "", `/?project=${projectId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, id);
  await oldStarted;
  await page.evaluate((projectId) => {
    history.replaceState(null, "", `/?project=${projectId}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, other.project.id);
  await saved(page, 1);
  finishOld();
  await completedOld;
  await page.waitForFunction(() => document.querySelector("input")?.value === "UI project B");
  assert.equal(await page.getByLabel("Название компании", { exact: true }).inputValue(), "UI project B");
  console.log("UI_STALE_LOAD_CANCELLED passed");

  await mkdir(".test-results", { recursive: true });
  for (const { name, viewport } of [
    { name: "desktop", viewport: { width: 1440, height: 1000 } },
    { name: "mobile", viewport: { width: 390, height: 844 } }
  ]) {
    await page.setViewportSize(viewport);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `.test-results/persistence-${name}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("UI_DESKTOP_MOBILE_CONSOLE passed");
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
