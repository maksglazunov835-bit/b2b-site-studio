import assert from "node:assert/strict";
import { mkdir,stat } from "node:fs/promises";
import { chromium } from "playwright";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase } from "../persistence/helpers.mjs";
import { startProductionServer,waitForHomepage,stopServer } from "../persistence/production-server.mjs";
import { startRunner,until,finishRunner,stopRunner } from "./process-helpers.mjs";

assertSafeTestDatabaseUrl(); await prepareTestDatabase();
const server = await startProductionServer({ agentIntervalSeconds:1 });
let browser; let runner;
const errors = []; const expectedFailures = new Set();
try {
  await waitForHomepage(server);
  browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:1440,height:1000 } });
  await page.clock.install();
  page.on("pageerror",(error) => errors.push(error.message));
  page.on("console",(message) => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.on("requestfailed",(request) => { if (!expectedFailures.has(request)) errors.push(`Unexpected failure: ${new URL(request.url()).pathname}`); });
  page.on("response",(response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto(server.origin);
  await page.getByLabel("Название компании",{ exact:true }).fill("Runner UI fixture");
  await page.getByRole("button",{ name:"Создать бриф",exact:true }).click();
  await page.getByText("Сохранено, revision 1",{ exact:true }).waitFor();
  const projectId = new URL(page.url()).searchParams.get("project");
  await page.getByRole("button",{ name:"Создать тестовое задание",exact:true }).click();
  await page.locator("li[data-job-id]").waitFor();
  await page.waitForLoadState("networkidle");
  const jobsBefore = await (await fetch(`${server.origin}/api/v1/projects/${projectId}/jobs`)).json();
  const niche = page.getByLabel("Ниша или направление",{ exact:true });
  await niche.fill("Unsaved brief must survive Runner actions");
  const panel = page.getByRole("region",{ name:"Локальный Runner",exact:true });
  await panel.getByRole("button",{ name:"Открыть подключения" }).click();
  const issue = panel.getByRole("button",{ name:"Разрешить подключение",exact:true });
  let pairs = 0; let arrive; let release;
  const arrival = new Promise((resolve) => { arrive = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/v1/agents/pairings",async (route) => {
    pairs++;
    const response = await route.fetch(); arrive(); await hold;
    await route.fulfill({ response });
  });
  await issue.click(); await arrival;
  assert.equal(await issue.isDisabled(),true);
  await issue.evaluate((button) => { button.click(); button.click(); }); release();
  const input = panel.getByLabel("Временный код Runner",{ exact:true });
  await input.waitFor(); assert.equal(pairs,1);
  const secret = await input.inputValue();
  assert.equal(await input.getAttribute("type"),"password");
  assert.equal((await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).includes(secret),false);
  assert.equal(page.url().includes(secret),false);
  await page.unroute("**/api/v1/agents/pairings");
  runner = startRunner(server.origin,secret,{ name:"Visible Runner fixture" });
  await until(() => runner.output().includes("RUNNER_HEARTBEAT_ACK"));
  await panel.getByText("На связи",{ exact:true }).waitFor({ timeout:15000 });
  await page.waitForFunction(() => !document.querySelector('[data-sensitive-pairing]'));
  assert.equal(await niche.inputValue(),"Unsaved brief must survive Runner actions");
  assert.deepEqual(await (await fetch(`${server.origin}/api/v1/projects/${projectId}/jobs`)).json(),jobsBefore);
  assert.equal((await (await fetch(`${server.origin}/api/v1/projects/${projectId}/site-spec`)).json()).siteSpec.revision,1);
  const agentId = await panel.locator("li[data-agent-id]").getAttribute("data-agent-id");
  await mkdir(".test-results",{ recursive:true });
  for (const { name,viewport } of [{ name:"desktop",viewport:{ width:1440,height:1000 } },{ name:"mobile",viewport:{ width:390,height:844 } }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.locator("[data-sensitive-pairing]").count(),0);
    assert.equal((await page.content()).includes(secret),false);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path:`.test-results/runner-${name}.png`,fullPage:true });
    assert.ok((await stat(`.test-results/runner-${name}.png`)).size < 5 * 1024 * 1024);
  }
  console.log("RUNNER_UI_REAL_CONNECTION_DIRTY_BRIEF_QUEUE_UNCHANGED_SECRET_FREE_SCREENSHOTS passed");
  let revokeCount = 0;
  await page.route(`**/api/v1/agents/${agentId}/revoke`,async (route) => {
    revokeCount++; const response = await route.fetch();
    if (revokeCount === 1) { expectedFailures.add(route.request()); await route.abort("failed"); }
    else await route.fulfill({ response });
  });
  await panel.getByRole("button",{ name:"Отозвать доступ",exact:true }).click();
  await finishRunner(runner,1);
  await panel.getByText("Доступ отозван",{ exact:true }).waitFor({ timeout:15000 });
  assert.equal(await niche.inputValue(),"Unsaved brief must survive Runner actions");
  assert.equal((await page.content()).includes(secret),false);
  assert.equal(runner.output().includes(secret),false);
  console.log("RUNNER_UI_LOST_REVOKE_RESPONSE_PROCESS_STOPPED passed");

  await issue.click(); await input.waitFor();
  await panel.getByRole("button",{ name:"Отменить разрешение",exact:true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-sensitive-pairing]'));
  await issue.click(); await input.waitFor();
  await page.clock.fastForward(300001);
  await page.waitForFunction(() => !document.querySelector('[data-sensitive-pairing]'));
  await page.waitForLoadState("networkidle");
  await panel.getByRole("button",{ name:"Закрыть подключения" }).click();
  assert.equal(await page.locator("[data-sensitive-pairing]").count(),0);
  let pollsAfterClose = 0;
  page.on("request",(request) => { if (new URL(request.url()).pathname === "/api/v1/agents") pollsAfterClose++; });
  await page.clock.fastForward(20000);
  assert.equal(pollsAfterClose,0);
  assert.deepEqual(errors,[]);
  console.log("RUNNER_UI_CANCEL_EXPIRY_CLOSE_POLL_CLEANUP_CONSOLE passed");
} finally {
  if (runner) await stopRunner(runner);
  if (browser) await browser.close();
  await stopServer(server);
}
