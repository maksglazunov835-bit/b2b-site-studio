import assert from "node:assert/strict";
import pg from "pg";
import { startProductionServer, waitForHomepage, stopServer } from "../../tests/persistence/production-server.mjs";
import { assertSafeTestDatabaseUrl } from "../db/test-config.mjs";

import { runMigrations } from "../db/migration-lib.mjs";
import { resetTestDatabase } from "../db/test-reset.mjs";

async function jsonRequest(origin, path, init) {
  const response = await fetch(`${origin}${path}`, init);
  const body = await response.json();
  return { response, body };
}

const draft = {
  companyName: "HTTP Persistence Test",
  niche: "Initial HTTP fixture niche",
  salesRegion: "HTTP fixture region",
  businessType: "services",
  siteType: "multipage",
  networkType: "regions"
};

async function smokeWithDatabase(databaseUrl) {
  const server = await startProductionServer({ databaseUrl });
  try {
    const homepage = await waitForHomepage(server);
    assert.equal(homepage.status, 200);

    const health = await jsonRequest(server.origin, "/api/v1/health/database");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.database, "available");

    const created = await jsonRequest(server.origin, "/api/v1/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-create-project"
      },
      body: JSON.stringify({ displayName: draft.companyName, draft })
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.siteSpec.revision, 1);
    const projectId = created.body.project.id;
    const revisionOneSha = created.body.siteSpec.sha256;

    const createReplay = await jsonRequest(server.origin, "/api/v1/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-create-project"
      },
      body: JSON.stringify({ displayName: draft.companyName, draft })
    });
    assert.equal(createReplay.response.status, 201);
    assert.equal(createReplay.response.headers.get("idempotency-replayed"), "true");
    assert.equal(createReplay.body.project.id, projectId);

    const createIdempotencyConflict = await jsonRequest(server.origin, "/api/v1/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-create-project"
      },
      body: JSON.stringify({ displayName: "Different HTTP payload", draft })
    });
    assert.equal(createIdempotencyConflict.response.status, 409);
    assert.equal(createIdempotencyConflict.body.error.code, "IDEMPOTENCY_CONFLICT");

    const projectList = await jsonRequest(server.origin, "/api/v1/projects");
    assert.equal(projectList.response.status, 200);
    assert.equal(projectList.body.projects.some((project) => project.id === projectId), true);

    const project = await jsonRequest(server.origin, `/api/v1/projects/${projectId}`);
    assert.equal(project.response.status, 200);
    assert.equal(project.body.siteSpec.revision, 1);

    const saved = await jsonRequest(server.origin, `/api/v1/projects/${projectId}/site-spec`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-save-revision-two"
      },
      body: JSON.stringify({
        expectedRevision: 1,
        draft: { ...draft, niche: "Updated HTTP fixture niche" }
      })
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.siteSpec.revision, 2);

    const renamed = await jsonRequest(server.origin, `/api/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Renamed HTTP Persistence Test",
        expectedVersion: saved.body.project.version
      })
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.project.displayName, "Renamed HTTP Persistence Test");

    const current = await jsonRequest(server.origin, `/api/v1/projects/${projectId}/site-spec`);
    assert.equal(current.response.status, 200);
    assert.equal(current.body.siteSpec.revision, 2);
    assert.equal(current.body.siteSpec.editableDraft.niche, "Updated HTTP fixture niche");

    const history = await jsonRequest(
      server.origin,
      `/api/v1/projects/${projectId}/site-spec/revisions/1`
    );
    assert.equal(history.response.status, 200);
    assert.equal(history.body.siteSpec.revision, 1);
    assert.equal(history.body.siteSpec.sha256, revisionOneSha);
    assert.equal(history.body.siteSpec.editableDraft.niche, draft.niche);

    const revisions = await jsonRequest(
      server.origin,
      `/api/v1/projects/${projectId}/site-spec/revisions`
    );
    assert.deepEqual(
      revisions.body.revisions.map((revision) => revision.revision),
      [2, 1]
    );

    const conflict = await jsonRequest(server.origin, `/api/v1/projects/${projectId}/site-spec`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-stale-save"
      },
      body: JSON.stringify({ expectedRevision: 1, draft })
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.error.code, "REVISION_CONFLICT");
    assert.equal(conflict.body.error.details.currentRevision, 2);

    const serverOwned = await jsonRequest(server.origin, `/api/v1/projects/${projectId}/site-spec`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "http-server-owned-field"
      },
      body: JSON.stringify({ expectedRevision: 2, draft: { ...draft, revision: 99 } })
    });
    assert.equal(serverOwned.response.status, 422);
    assert.equal(serverOwned.body.error.code, "SERVER_OWNED_FIELD");

    const afterConflict = await jsonRequest(server.origin, `/api/v1/projects/${projectId}/site-spec`);
    assert.equal(afterConflict.body.siteSpec.revision, 2);

    const invalidJson = await jsonRequest(server.origin, "/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "invalid-json" },
      body: "{"
    });
    assert.equal(invalidJson.response.status, 400);
    assert.equal(invalidJson.body.error.code, "INVALID_JSON");

    const oversized = await jsonRequest(server.origin, "/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "oversized-json" },
      body: JSON.stringify({ displayName: "x".repeat(70_000), draft })
    });
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.body.error.code, "PAYLOAD_TOO_LARGE");

    const invalidProjectId = await jsonRequest(server.origin, "/api/v1/projects/not-a-uuid");
    assert.equal(invalidProjectId.response.status, 422);
    assert.equal(invalidProjectId.body.error.code, "VALIDATION_FAILED");
  } finally {
    await stopServer(server);
  }
}

async function smokeWithoutDatabase() {
  const server = await startProductionServer({ databaseUrl: null });
  try {
    const homepage = await waitForHomepage(server);
    assert.equal(homepage.status, 200);
    const health = await jsonRequest(server.origin, "/api/v1/health/database");
    assert.equal(health.response.status, 503);
    assert.equal(health.body.error.code, "DATABASE_UNAVAILABLE");
  } finally {
    await stopServer(server);
  }
}

async function smokeDisabled(databaseConfig) {
  const client = new pg.Client(databaseConfig);
  await client.connect();
  try {
    const before = await client.query("SELECT count(*)::int AS count FROM projects");
    for (const launch of [{ mode: null }, { mode: "local", host: "0.0.0.0" }]) {
      const server = await startProductionServer(launch);
      try {
        await waitForHomepage(server);
        for (const headers of [{}, { Host: "localhost", "X-Forwarded-Host": "127.0.0.1", "X-Forwarded-For": "127.0.0.1", "X-Forwarded-Proto": "http" }]) {
          const read = await jsonRequest(server.origin, "/api/v1/projects", { headers });
          assert.equal(read.response.status, 403);
          assert.equal(read.body.error.code, "PERSISTENCE_DISABLED");
          const write = await jsonRequest(server.origin, "/api/v1/projects", {
            method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": "blocked-create" },
            body: JSON.stringify({ displayName: "Blocked", draft })
          });
          assert.equal(write.response.status, 403);
        }
      } finally { await stopServer(server); }
    }
    assert.deepEqual((await client.query("SELECT count(*)::int AS count FROM projects")).rows, before.rows);
  } finally { await client.end(); }
  console.log("PUBLIC_ACCESS_GATE passed (working DB, spoofed headers, no writes)");
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseConfig = assertSafeTestDatabaseUrl(databaseUrl);
await resetTestDatabase({ databaseUrl });
await runMigrations({ databaseConfig });
await smokeWithDatabase(databaseUrl);
await smokeWithoutDatabase();
await smokeDisabled(databaseConfig);
console.log("BUILT_SERVER_SHUTDOWN passed");
console.log("PERSISTENCE_HTTP_SMOKE passed");
