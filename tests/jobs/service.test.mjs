import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { prepareTestDatabase, editableDraft } from "../persistence/helpers.mjs";
import { closeDatabasePool, getDatabasePool, withTransaction } from "../../server/persistence/database.mjs";
import { createProject, saveDraft, patchProject, getProject, getSiteSpecRevision } from "../../server/persistence/service.mjs";
import { DEFAULT_WORKSPACE_ID, insertProject, insertRevision, updateProjectCurrentRevision } from "../../server/persistence/repository.mjs";
import { buildDraftSiteSpec } from "../../server/persistence/site-spec.mjs";
import { jobs, createJobService } from "../../server/jobs/service.mjs";

assertSafeTestDatabaseUrl();
before(prepareTestDatabase);
after(closeDatabasePool);
const createInput = (expectedRevision = 1) => ({ type: "site_spec_validation", expectedRevision });
const project = async () => (await createProject({ displayName: "Queue test fixture", draft: editableDraft() }, randomUUID())).response;
const fail = (promise, code) => assert.rejects(promise, { code });
const query = (sql, values) => getDatabasePool().query(sql, values);

async function counts() {
  return (await query(`SELECT (SELECT count(*) FROM jobs)::int AS jobs,
    (SELECT count(*) FROM job_events)::int AS events,
    (SELECT count(*) FROM api_idempotency_records)::int AS idempotency`)).rows[0];
}

void test("job pins a real draft revision/hash and stays immutable after a new brief", async () => {
  const initial = await project();
  const id = initial.project.id;
  const created = await jobs.create(id, createInput(), randomUUID());
  const job = created.response.job;
  assert.match(job.id, /^job_[a-f0-9]{32}$/);
  assert.equal(job.siteSpec.sha256, initial.siteSpec.sha256);
  assert.equal(job.siteSpec.revision, 1);
  assert.equal(job.templateVersion, "site_spec_validation@1");
  assert.equal(job.dispatchable, false);
  assert.equal(job.reason, "EXECUTOR_NOT_CONFIGURED");
  assert.equal(job.executionResult, null);
  assert.equal(job.acceptanceResult, null);
  assert.deepEqual(job.requestSnapshot.input, job.siteSpec);
  assert.equal(Object.hasOwn(job.requestSnapshot, "repository"), false);
  const events = (await jobs.events(id, job.id)).events;
  assert.deepEqual(events.map((e) => [e.sequence, e.type, e.fromState, e.toState]), [[1, "job_queued", null, "queued"]]);
  const before = (await query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows;
  await saveDraft(id, { expectedRevision: 1, draft: editableDraft({ niche: "New brief" }) }, randomUUID());
  assert.deepEqual((await query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows, before);
  const current = (await jobs.get(id, job.id)).job;
  assert.equal(current.currentRevision, 2);
  assert.equal(current.isInputStale, true);
  assert.deepEqual(current.siteSpec, job.siteSpec);
  assert.deepEqual((await getSiteSpecRevision(id, 1)).siteSpec.value, initial.siteSpec.value);
  const next = await jobs.create(id, createInput(2), randomUUID());
  assert.equal(next.response.job.siteSpec.revision, 2);
});

void test("parallel same-key creates produce one job/event; replay precedes revision precondition", async () => {
  const { project: p } = await project();
  const key = randomUUID();
  const before = await counts();
  const results = await Promise.all([jobs.create(p.id, createInput(), key), jobs.create(p.id, createInput(), key)]);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.deepEqual(results[0].response, results[1].response);
  const after = await counts();
  assert.equal(after.jobs - before.jobs, 1);
  assert.equal(after.events - before.events, 1);
  assert.equal(after.idempotency - before.idempotency, 1);
  await saveDraft(p.id, { expectedRevision: 1, draft: editableDraft({ niche: "Later" }) }, randomUUID());
  assert.deepEqual((await jobs.create(p.id, createInput(), key)).response, results[0].response);
  await fail(jobs.create(p.id, createInput(2), key), "IDEMPOTENCY_CONFLICT");
  await fail(jobs.create(p.id, createInput(), randomUUID()), "REVISION_CONFLICT");
  const separate = await jobs.create(p.id, createInput(2), randomUUID());
  assert.notEqual(separate.response.job.id, results[0].response.job.id);
});

void test("cancel replay, no-op, version conflict and parallel cancellation keep one terminal event", async () => {
  const { project: p } = await project();
  const created = await jobs.create(p.id, createInput(), randomUUID());
  const id = created.response.job.id;
  const key = randomUUID();
  const results = await Promise.all([jobs.cancel(p.id, id, { expectedVersion: 1 }, key), jobs.cancel(p.id, id, { expectedVersion: 1 }, key)]);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.deepEqual(results[0].response, results[1].response);
  assert.equal(results[0].response.job.state, "cancelled");
  assert.equal(results[0].response.job.executionResult, "cancelled");
  assert.equal(results[0].response.job.acceptanceResult, null);
  assert.equal(results[0].response.job.version, 2);
  assert.equal((await jobs.cancel(p.id, id, { expectedVersion: 2 }, randomUUID())).response.noOp, true);
  await fail(jobs.cancel(p.id, id, { expectedVersion: 1 }, randomUUID()), "JOB_VERSION_CONFLICT");
  await fail(jobs.cancel(p.id, id, { expectedVersion: 2 }, key), "IDEMPOTENCY_CONFLICT");
  assert.equal((await jobs.events(p.id, id)).events.length, 2);
  const other = (await jobs.create(p.id, createInput(), randomUUID())).response.job;
  const competing = await Promise.allSettled([1, 2].map(() => jobs.cancel(p.id, other.id, { expectedVersion: 1 }, randomUUID())));
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(competing.find((r) => r.status === "rejected").reason.code, "JOB_VERSION_CONFLICT");
  assert.equal((await jobs.events(p.id, other.id)).events.length, 2);
});

void test("strict DTOs, missing project/revision, archived project, and corrupted input reject without partial jobs", async () => {
  const { project: p } = await project();
  const before = await counts();
  for (const input of [null, {}, { ...createInput(), state: "running" }, { ...createInput(), workspaceId: randomUUID() },
    { ...createInput(), shell: "unsafe" }, { ...createInput(), sha256: "a" }, { ...createInput(), repository: {} },
    { ...createInput(), acceptance: "accepted" }, { ...createInput(), result: "succeeded" },
    { ...createInput(), expectedRevision: 1.5 }, { ...createInput(), expectedRevision: "1" }]) {
    await fail(jobs.create(p.id, input, randomUUID()), "VALIDATION_FAILED");
  }
  await fail(jobs.create(p.id, { ...createInput(), type: "run_codex" }, randomUUID()), "UNSUPPORTED_JOB_TYPE");
  await fail(jobs.create(p.id, createInput(), ""), "VALIDATION_FAILED");
  await fail(jobs.create(randomUUID(), createInput(), randomUUID()), "PROJECT_NOT_FOUND");
  assert.deepEqual(await counts(), before);
  const job = (await jobs.create(p.id, createInput(), randomUUID())).response.job;
  await fail(jobs.cancel(p.id, job.id, { expectedVersion: 1, state: "cancelled" }, randomUUID()), "VALIDATION_FAILED");
  await patchProject(p.id, { expectedVersion: p.version, status: "archived" });
  await fail(jobs.create(p.id, createInput(), randomUUID()), "PROJECT_ARCHIVED");
  assert.equal((await jobs.cancel(p.id, job.id, { expectedVersion: 1 }, randomUUID())).response.job.state, "cancelled");

  const brokenId = randomUUID();
  await insertProject(getDatabasePool(), { id: brokenId, workspaceId: DEFAULT_WORKSPACE_ID, displayName: "Missing revision fixture", slug: `missing-${brokenId}` });
  await updateProjectCurrentRevision(getDatabasePool(), DEFAULT_WORKSPACE_ID, brokenId, 1);
  await fail(jobs.create(brokenId, createInput(), randomUUID()), "REVISION_NOT_FOUND");
  const built = buildDraftSiteSpec({ projectId: brokenId, revision: 1, draft: editableDraft() });
  await insertRevision(getDatabasePool(), { id: randomUUID(), workspaceId: DEFAULT_WORKSPACE_ID, projectId: brokenId,
    revision: 1, schemaVersion: built.siteSpec.schemaVersion, documentStage: "draft", siteSpec: built.siteSpec,
    canonicalSha256: "0".repeat(64), editableSha256: built.editableSha256, idempotencyKey: randomUUID(), actorType: "user", source: "test_fixture" });
  await fail(jobs.create(brokenId, createInput(), randomUUID()), "SITE_SPEC_INTEGRITY_ERROR");
});

void test("event insertion failure rolls back create and cancel including idempotency", async () => {
  const { project: p } = await project();
  const existing = (await jobs.create(p.id, createInput(), randomUUID())).response.job;
  await query(`CREATE FUNCTION fail_job_event_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected event failure'; END; $$`);
  await query("CREATE TRIGGER fail_job_event_test BEFORE INSERT ON job_events FOR EACH ROW EXECUTE FUNCTION fail_job_event_test()");
  const before = await counts();
  const key = randomUUID();
  try {
    await assert.rejects(jobs.create(p.id, createInput(), key));
    assert.deepEqual(await counts(), before);
    await assert.rejects(jobs.cancel(p.id, existing.id, { expectedVersion: 1 }, randomUUID()));
    assert.deepEqual((await jobs.get(p.id, existing.id)).job, existing);
    assert.deepEqual(await counts(), before);
  } finally {
    await query("DROP TRIGGER fail_job_event_test ON job_events");
    await query("DROP FUNCTION fail_job_event_test()");
  }
  assert.equal((await jobs.create(p.id, createInput(), key)).replayed, false);
});

void test("DB enforces composite input FKs, source immutability, append-only events and journal completeness", async () => {
  const { project: p } = await project();
  const job = (await jobs.create(p.id, createInput(), randomUUID())).response.job;
  for (const sql of ["UPDATE jobs SET input_sha256=repeat('0',64) WHERE id=$1", "UPDATE jobs SET request_snapshot='{}'::jsonb WHERE id=$1",
    "DELETE FROM jobs WHERE id=$1", "UPDATE job_events SET payload='{}'::jsonb WHERE job_id=$1", "DELETE FROM job_events WHERE job_id=$1"]) {
    await assert.rejects(query(sql, [job.id]), { code: "55000" });
  }
  await assert.rejects(query("UPDATE jobs SET state='cancelled',version=2,cancelled_at=clock_timestamp() WHERE id=$1", [job.id]), { code: "23514" });
  await assert.rejects(withTransaction(async (client) => {
    await client.query("UPDATE jobs SET state='cancelled',version=2,cancelled_at=clock_timestamp() WHERE id=$1", [job.id]);
    await client.query(`INSERT INTO job_events(job_id,sequence,event_type,from_state,to_state,payload)
      VALUES($1,2,'job_cancelled',NULL,'cancelled','{}')`, [job.id]);
  }), { code: "23514" });
  const newId = `job_${randomUUID().replaceAll("-", "")}`;
  const copy = `INSERT INTO jobs (id,workspace_id,project_id,site_spec_revision_id,input_revision,input_schema_version,input_sha256,type,template_version,request_snapshot)
    SELECT $2,workspace_id,project_id,site_spec_revision_id,input_revision,input_schema_version,input_sha256,type,template_version,request_snapshot FROM jobs WHERE id=$1`;
  await assert.rejects(query(copy, [job.id, newId]), { code: "23514" });
  await assert.rejects(query(copy.replace("input_sha256,type,template_version,request_snapshot FROM", "repeat('0',64),type,template_version,request_snapshot FROM"), [job.id, newId]), { code: "23503" });
  const other = await project();
  await assert.rejects(query(copy.replace("$2,workspace_id,project_id,site_spec_revision_id", "$2,workspace_id,$3::uuid,site_spec_revision_id"), [job.id, newId, other.project.id]), { code: "23503" });
  assert.equal((await jobs.get(p.id, job.id)).job.state, "queued");
});

void test("project/workspace isolation applies to detail, lists, events, cancel and replay", async () => {
  const a = await project(); const b = await project();
  const key = randomUUID();
  const job = (await jobs.create(a.project.id, createInput(), key)).response.job;
  assert.deepEqual((await jobs.list(b.project.id)).jobs, []);
  for (const action of [() => jobs.get(b.project.id, job.id), () => jobs.events(b.project.id, job.id), () => jobs.cancel(b.project.id, job.id, { expectedVersion: 1 }, key)]) {
    await fail(action(), "JOB_NOT_FOUND");
  }
  const separateScope = await jobs.create(b.project.id, createInput(), key);
  assert.notEqual(separateScope.response.job.id, job.id);
  assert.equal(separateScope.replayed, false);
  const workspaceId = randomUUID(); const foreignId = randomUUID();
  await query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Workspace test fixture')", [workspaceId, `test-${workspaceId}`]);
  await withTransaction(async (client) => {
    await insertProject(client, { id: foreignId, workspaceId, displayName: "Foreign project", slug: `test-${foreignId}` });
    const built = buildDraftSiteSpec({ projectId: foreignId, revision: 1, draft: editableDraft() });
    await insertRevision(client, { id: randomUUID(), workspaceId, projectId: foreignId, revision: 1,
      schemaVersion: built.siteSpec.schemaVersion, documentStage: "draft", siteSpec: built.siteSpec,
      canonicalSha256: built.canonicalSha256, editableSha256: built.editableSha256,
      idempotencyKey: randomUUID(), actorType: "user", source: "test_fixture" });
    await updateProjectCurrentRevision(client, workspaceId, foreignId, 1);
  });
  const foreign = createJobService(workspaceId);
  const foreignJob = (await foreign.create(foreignId, createInput(), key)).response.job;
  assert.notEqual(foreignJob.id, job.id);
  await fail(jobs.create(foreignId, createInput(), key), "PROJECT_NOT_FOUND");
  await fail(jobs.list(foreignId), "PROJECT_NOT_FOUND");
  await fail(jobs.get(foreignId, foreignJob.id), "JOB_NOT_FOUND");
  await fail(jobs.events(foreignId, foreignJob.id), "JOB_NOT_FOUND");
  await fail(jobs.cancel(foreignId, foreignJob.id, { expectedVersion: 1 }, key), "JOB_NOT_FOUND");
  assert.equal((await foreign.events(foreignId, foreignJob.id)).events.length, 1);
  assert.deepEqual((await foreign.create(foreignId, createInput(), key)).response.job, foreignJob);
});

void test("bounded keyset pagination keeps jobs unique and events ordered with scope-bound cursors", async () => {
  const { project: p } = await project();
  const created = [];
  for (let i = 0; i < 7; i++) created.push((await jobs.create(p.id, createInput(), randomUUID())).response.job);
  let page = await jobs.list(p.id, new URLSearchParams({ limit: "2" }));
  const cursor = page.nextCursor;
  const seen = [...page.jobs];
  const newest = (await jobs.create(p.id, createInput(), randomUUID())).response.job;
  while (page.nextCursor) {
    page = await jobs.list(p.id, new URLSearchParams({ limit: "2", cursor: page.nextCursor }));
    seen.push(...page.jobs);
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen.map((j) => j.id)).size, 7);
  assert.equal(seen.some((j) => j.id === newest.id), false);
  const id = created[0].id;
  await jobs.cancel(p.id, id, { expectedVersion: 1 }, randomUUID());
  const first = await jobs.events(p.id, id, new URLSearchParams({ limit: "1" }));
  const second = await jobs.events(p.id, id, new URLSearchParams({ limit: "1", cursor: first.nextCursor }));
  assert.deepEqual([...first.events, ...second.events].map((e) => e.sequence), [1, 2]);
  assert.equal(second.nextCursor, null);
  const other = await project();
  await fail(jobs.list(other.project.id, new URLSearchParams({ cursor })), "INVALID_CURSOR");
  await fail(jobs.events(p.id, created[1].id, new URLSearchParams({ cursor: first.nextCursor })), "INVALID_CURSOR");
  for (const invalid of ["!", "e30", cursor + "=", Buffer.from(JSON.stringify({ kind: "jobs", v: 1, workspaceId: DEFAULT_WORKSPACE_ID, projectId: p.id, id, at: "2026-02-31T00:00:00.000000Z" })).toString("base64url")]) {
    await fail(jobs.list(p.id, new URLSearchParams({ cursor: invalid })), "INVALID_CURSOR");
  }
  for (const params of ["limit=0", "limit=101", "limit=1&limit=2", "state=queued", "limit=1.5"]) await fail(jobs.list(p.id, new URLSearchParams(params)), "VALIDATION_FAILED");
  assert.equal((await getProject(p.id)).siteSpec.revision, 1);
});
