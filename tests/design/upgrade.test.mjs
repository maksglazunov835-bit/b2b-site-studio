import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafeTestDatabaseUrl } from '../../scripts/db/test-config.mjs';
import { resetTestDatabase } from '../../scripts/db/test-reset.mjs';
import { runMigrations } from '../../scripts/db/migration-lib.mjs';
import {
  configureDatabase,
  closeDatabasePool,
  getDatabasePool,
} from '../../server/persistence/database.mjs';
import { createProject, saveDraft } from '../../server/persistence/service.mjs';
import { legacyJob } from '../execution/legacy-fixture.mjs';
void test('004 to 005 preserves projects, revisions, old jobs and migration checksums', async () => {
  const config = assertSafeTestDatabaseUrl();
  await closeDatabasePool();
  await resetTestDatabase();
  const root = path.join(os.tmpdir(), 'b2b-design-upgrade-');
  const dir = await mkdtemp(root);
  try {
    for (const name of [
      '001_initial_persistence.sql',
      '002_job_queue.sql',
      '003_agent_connections.sql',
      '004_validation_execution.sql',
    ])
      await copyFile(`db/migrations/${name}`, path.join(dir, name));
    await runMigrations({ databaseConfig: config, migrationsDir: dir });
    configureDatabase(config);
    const project = (
      await createProject(
        { displayName: 'Upgrade fixture', draft: {} },
        randomUUID(),
      )
    ).response.project;
    await legacyJob(project.id);
    await saveDraft(
      project.id,
      { expectedRevision: 1, draft: { niche: 'Saved revision two' } },
      randomUUID(),
    );
    await legacyJob(project.id, true);
    const pool = getDatabasePool();
    const snapshot = async () => {
      const data = {};
      for (const table of [
        'projects',
        'site_spec_revisions',
        'site_spec_readiness_checks',
        'project_events',
        'jobs',
        'job_events',
        'job_executions',
        'job_attempts',
        'job_results',
        'execution_operations',
        'agent_execution_grants',
      ])
        data[table] = (
          await pool.query(
            `SELECT to_jsonb(t) FROM ${table} t ORDER BY to_jsonb(t)::text`,
          )
        ).rows;
      return data;
    };
    const before = await snapshot();
    const old = (
      await pool.query('SELECT * FROM _schema_migrations ORDER BY name')
    ).rows;
    assert.deepEqual(
      (await runMigrations({ databaseConfig: config })).applied,
      ['005_design_proposals.sql'],
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM _schema_migrations WHERE name<>'005_design_proposals.sql' ORDER BY name",
        )
      ).rows,
      old,
    );
    assert.deepEqual(
      (await runMigrations({ databaseConfig: config })).applied,
      [],
    );
  } finally {
    await closeDatabasePool();
    assert.ok(dir.startsWith(root));
    await rm(dir, { recursive: true });
  }
});
