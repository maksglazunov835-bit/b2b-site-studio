import { randomUUID } from "node:crypto";
import { assertSafeTestDatabaseUrl } from "../../scripts/db/test-config.mjs";
import { withTransaction } from "../../server/persistence/database.mjs";
import { DEFAULT_WORKSPACE_ID, getCurrentRevisionForWorkspace } from "../../server/persistence/repository.mjs";
import { insertJob, insertEvent, cancelJobRow } from "../../server/jobs/repository.mjs";

// Seed the historical 002 shape without querying newer execution tables.
export async function legacyJob(projectId, cancelled = false) {
  assertSafeTestDatabaseUrl();
  return withTransaction(async (client) => {
    const revision = await getCurrentRevisionForWorkspace(client, DEFAULT_WORKSPACE_ID, projectId);
    const id = `job_${randomUUID().replaceAll("-", "")}`;
    await insertJob(client, DEFAULT_WORKSPACE_ID, projectId, id, revision, { type: "site_spec_validation", templateVersion: "site_spec_validation@1" });
    await insertEvent(client, DEFAULT_WORKSPACE_ID, projectId, id);
    if (cancelled) { await cancelJobRow(client, DEFAULT_WORKSPACE_ID, projectId, id); await insertEvent(client, DEFAULT_WORKSPACE_ID, projectId, id, true); }
    return id;
  });
}
