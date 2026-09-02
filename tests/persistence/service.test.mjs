import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";

import {
  closeDatabasePool,
  getDatabasePool
} from "../../server/persistence/database.mjs";
import {
  createProject,
  getProject,
  getSiteSpecRevision,
  listProjects,
  patchProject,
  saveDraft
} from "../../server/persistence/service.mjs";
import {
  DEFAULT_WORKSPACE_ID,
  countProjectRevisions,
  getProjectForWorkspace,
  listProjectEvents,
  listProjectsForWorkspace
} from "../../server/persistence/repository.mjs";
import { validateCanonicalSiteSpec } from "../../server/persistence/site-spec.mjs";
import { editableDraft, prepareTestDatabase } from "./helpers.mjs";

let projectId;
let currentDraft;

before(async () => {
  await prepareTestDatabase();
});

after(async () => {
  await closeDatabasePool();
});

void test("project creation, immutable revisions, no-op, concurrency, and idempotency", async () => {
  const initialDraft = editableDraft();
  const createInput = { displayName: initialDraft.companyName, draft: initialDraft };
  const created = await createProject(createInput, "create-lifecycle-project");
  assert.equal(created.responseStatus, 201);
  assert.equal(created.replayed, false);
  assert.equal(created.response.siteSpec.revision, 1);
  assert.equal(created.response.siteSpec.value.documentStage, "draft");
  assert.equal(created.response.siteSpec.value.readiness.ownedBy, "server");
  assert.equal(created.response.siteSpec.value.readiness.generation.status, "not_ready");
  projectId = created.response.project.id;

  const createReplay = await createProject(createInput, "create-lifecycle-project");
  assert.equal(createReplay.replayed, true);
  assert.deepEqual(createReplay.response, created.response);
  await assert.rejects(
    createProject({ ...createInput, displayName: "Changed replay payload" }, "create-lifecycle-project"),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT"
  );

  const revisionOne = structuredClone(created.response.siteSpec.value);
  const revisionTwoDraft = editableDraft({ niche: "Updated test fixture niche" });
  const revisionTwo = await saveDraft(
    projectId,
    { expectedRevision: 1, draft: revisionTwoDraft },
    "save-revision-two"
  );
  assert.equal(revisionTwo.response.siteSpec.revision, 2);
  assert.equal(revisionTwo.response.siteSpec.noOp, false);

  const noOp = await saveDraft(
    projectId,
    { expectedRevision: 2, draft: revisionTwoDraft },
    "save-no-op"
  );
  assert.equal(noOp.response.siteSpec.revision, 2);
  assert.equal(noOp.response.siteSpec.noOp, true);
  assert.equal(await countProjectRevisions(getDatabasePool(), DEFAULT_WORKSPACE_ID, projectId), 2);

  currentDraft = editableDraft({ niche: "Updated test fixture niche", salesRegion: "Second test region" });
  const revisionThreeRequest = { expectedRevision: 2, draft: currentDraft };
  const revisionThree = await saveDraft(projectId, revisionThreeRequest, "save-idempotent-revision-three");
  const revisionThreeReplay = await saveDraft(projectId, revisionThreeRequest, "save-idempotent-revision-three");
  assert.equal(revisionThree.response.siteSpec.revision, 3);
  assert.equal(revisionThreeReplay.replayed, true);
  assert.deepEqual(revisionThreeReplay.response, revisionThree.response);

  await assert.rejects(
    saveDraft(
      projectId,
      { expectedRevision: 2, draft: { ...currentDraft, niche: "Different payload" } },
      "save-idempotent-revision-three"
    ),
    (error) => error?.code === "IDEMPOTENCY_CONFLICT"
  );
  await assert.rejects(
    saveDraft(projectId, { expectedRevision: 2, draft: currentDraft }, "stale-expected-revision"),
    (error) => error?.code === "REVISION_CONFLICT" && error.details.currentRevision === 3
  );

  const historical = await getSiteSpecRevision(projectId, 1);
  assert.deepEqual(historical.siteSpec.value, revisionOne);
  assert.equal(historical.siteSpec.editableDraft.niche, initialDraft.niche);
  assert.equal((await getProject(projectId)).siteSpec.revision, 3);
  assert.equal((await listProjects()).projects.some((project) => project.id === projectId), true);

  const foreignWorkspace = randomUUID();
  assert.equal(await getProjectForWorkspace(getDatabasePool(), foreignWorkspace, projectId), null);
  assert.deepEqual(await listProjectsForWorkspace(getDatabasePool(), foreignWorkspace), []);

  const events = await listProjectEvents(getDatabasePool(), DEFAULT_WORKSPACE_ID, projectId);
  assert.ok(events.some((event) => event.eventType === "project_created"));
  assert.ok(events.some((event) => event.eventType === "draft_save_noop"));
  assert.ok(events.some((event) => event.eventType === "draft_save_conflict"));
  assert.ok(events.some((event) => event.eventType === "idempotency_conflict"));

  await assert.rejects(
    getDatabasePool().query(
      "UPDATE site_spec_revisions SET source = $1 WHERE project_id = $2 AND revision = $3",
      ["forbidden-test-update", projectId, 1]
    ),
    (error) => error?.code === "55000"
  );
  await assert.rejects(
    getDatabasePool().query(
      "DELETE FROM site_spec_revisions WHERE project_id = $1 AND revision = $2",
      [projectId, 1]
    ),
    (error) => error?.code === "55000"
  );
});

void test("invalid editable input and server-owned SiteSpec fields are rejected", async () => {
  await assert.rejects(
    createProject(
      { displayName: "Invalid test project", draft: editableDraft({ siteType: "unknown" }) },
      "invalid-site-type"
    ),
    (error) => error?.code === "VALIDATION_FAILED"
  );
  for (const { field, value } of [
    { field: "projectId", value: randomUUID() },
    { field: "schemaVersion", value: "999.0.0" },
    { field: "revision", value: 99 },
    { field: "readiness", value: { generation: { status: "passed" } } }
  ]) {
    await assert.rejects(
      saveDraft(
        projectId,
        { expectedRevision: 3, draft: { ...currentDraft, [field]: value } },
        `client-server-owned-${field}`
      ),
      (error) => error?.code === "SERVER_OWNED_FIELD"
    );
  }
  await assert.rejects(
    saveDraft(
      projectId,
      { expectedRevision: 3, documentStage: "generation_ready", draft: currentDraft },
      "client-stage"
    ),
    (error) => error?.code === "UNSUPPORTED_STAGE_TRANSITION"
  );
  assert.throws(
    () => validateCanonicalSiteSpec({ schemaVersion: "1.2.0" }),
    (error) => error?.code === "VALIDATION_FAILED" && error.details.validation === "schema"
  );
});

void test("project metadata uses optimistic locking and archive is non-destructive", async () => {
  const beforePatch = await getProject(projectId);
  const patched = await patchProject(projectId, {
    displayName: "Renamed persistence test project",
    expectedVersion: beforePatch.project.version
  });
  assert.equal(patched.response.project.displayName, "Renamed persistence test project");

  await assert.rejects(
    patchProject(projectId, { status: "archived", expectedVersion: beforePatch.project.version }),
    (error) => error?.code === "REVISION_CONFLICT"
  );
  const archived = await patchProject(projectId, {
    status: "archived",
    expectedVersion: patched.response.project.version
  });
  assert.equal(archived.response.project.status, "archived");
  assert.ok(archived.response.project.archivedAt);
  assert.equal((await getSiteSpecRevision(projectId, 1)).siteSpec.revision, 1);
  await assert.rejects(
    saveDraft(projectId, { expectedRevision: 3, draft: currentDraft }, "archived-save"),
    (error) => error?.code === "PROJECT_ARCHIVED"
  );
});

void test("missing DATABASE_URL produces a controlled error without eager connection", async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  await closeDatabasePool();
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(listProjects(), (error) => error?.code === "DATABASE_UNAVAILABLE");
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});
