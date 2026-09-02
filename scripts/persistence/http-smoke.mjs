import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";

import { runMigrations } from "../db/migration-lib.mjs";
import { resetTestDatabase } from "../db/test-reset.mjs";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Unable to allocate an HTTP smoke-test port.");
  return port;
}

function startProductionServer({ databaseUrl }) {
  const env = { ...process.env };
  if (databaseUrl) env.DATABASE_URL = databaseUrl;
  else delete env.DATABASE_URL;
  return availablePort().then((port) => {
    const child = spawn(process.execPath, ["server/production.mjs"], {
      env: { ...env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const capture = (chunk) => {
      output = `${output}${chunk}`.slice(-8_000);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    return { child, origin: `http://127.0.0.1:${port}`, output: () => output };
  });
}

async function waitForHomepage(server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Production server exited early.\n${server.output()}`);
    }
    try {
      const response = await fetch(server.origin);
      if (response.status === 200) return response;
    } catch {
      // Startup polling is intentionally quiet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Production server did not become ready.\n${server.output()}`);
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

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

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL must be set for HTTP persistence smoke tests");
await resetTestDatabase({ databaseUrl });
await runMigrations({ databaseUrl });
await smokeWithDatabase(databaseUrl);
await smokeWithoutDatabase();
console.log("PERSISTENCE_HTTP_SMOKE passed");
