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
  withTransaction,
} from '../../server/persistence/database.mjs';
import { createProject, saveDraft } from '../../server/persistence/service.mjs';
import { legacyJob } from '../execution/legacy-fixture.mjs';
import { fixture } from './helpers.mjs';
import { proposal } from './fixtures.mjs';
import {
  materializeDesign,
  assertDesignSpec,
} from '../../server/design/contract.mjs';
import { DEFAULT_WORKSPACE_ID } from '../../server/persistence/repository.mjs';
import { sha256Json } from '../../server/persistence/canonical-json.mjs';
import { transition } from '../../server/execution/transitions.mjs';
void test('004 to latest preserves projects, revisions, old jobs and migration checksums', async () => {
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
      ['005_design_proposals.sql', '006_astra_preflight_failures.sql'],
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM _schema_migrations WHERE name<'005_design_proposals.sql' ORDER BY name",
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

void test('005 to 006 preserves a synthetic legacy Luna result and its provenance on reload', async () => {
  const config = assertSafeTestDatabaseUrl();
  await closeDatabasePool();
  await resetTestDatabase();
  const root = path.join(os.tmpdir(), 'b2b-astra-upgrade-');
  const dir = await mkdtemp(root);
  try {
    for (const name of [
      '001_initial_persistence.sql',
      '002_job_queue.sql',
      '003_agent_connections.sql',
      '004_validation_execution.sql',
      '005_design_proposals.sql',
    ])
      await copyFile(`db/migrations/${name}`, path.join(dir, name));
    await runMigrations({ databaseConfig: config, migrationsDir: dir });
    configureDatabase(config);
    const f = await fixture({ dispatch: false });
    const pool = getDatabasePool();
    let oldSpec, oldReport;
    await withTransaction(async (client) => {
      const job = (
        await client.query('SELECT * FROM jobs WHERE id=$1', [f.jobId])
      ).rows[0];
      const snapshot = (
        await client.query(
          'SELECT canonical_site_spec FROM site_spec_revisions WHERE id=$1',
          [job.site_spec_revision_id],
        )
      ).rows[0].canonical_site_spec;
      const runtime = (
        await client.query(
          'SELECT runtime FROM design_agent_profiles p JOIN agent_execution_grants g USING(pairing_id) WHERE g.agent_id=$1',
          [f.agentId],
        )
      ).rows[0].runtime;
      oldSpec = structuredClone(
        materializeDesign(job, snapshot, DEFAULT_WORKSPACE_ID, runtime).spec,
      );
      oldSpec.jobSpecVersion = '1.4.0';
      oldSpec.adapter = {
        id: 'codex_design_exec',
        version: '1.0.0',
        sha256:
          'f22fd1049e2b6cac06b4dba15a08fe11425889cd9af249206e5260745085f392',
      };
      oldSpec.settings.model = oldSpec.runtime.model = 'gpt-5.6-luna';
      oldSpec.settings.effort = oldSpec.runtime.effort = 'medium';
      oldSpec.runtime.policySha256 = oldSpec.adapter.sha256;
      delete oldSpec.runtime.modelSelection;
      const specHash = sha256Json(oldSpec),
        now = f.clock();
      await client.query(
        `INSERT INTO job_executions(job_id,workspace_id,project_id,agent_id,job_spec,spec_sha256,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          f.jobId,
          DEFAULT_WORKSPACE_ID,
          f.projectId,
          f.agentId,
          oldSpec,
          specHash,
          now,
        ],
      );
      oldReport = {
        reportVersion: '1.0.0',
        jobId: f.jobId,
        attempt: 1,
        inputSha256: oldSpec.input.sha256,
        jobSpecSha256: specHash,
        provider: 'test_stub',
        cliVersion: 'test-cli-1',
        model: 'gpt-5.6-luna',
        effort: 'medium',
        providerInvocations: 1,
        proposal: proposal(),
        usage: null,
      };
      await client.query(
        `INSERT INTO job_attempts(job_id,attempt,workspace_id,project_id,agent_id,state,claim_key_sha256,lease_sha256,claimed_at,expires_at,deadline_at,finished_at)
        VALUES($1,1,$2,$3,$4,'succeeded',$5,$6,$7,$8,$9,$7)`,
        [
          f.jobId,
          DEFAULT_WORKSPACE_ID,
          f.projectId,
          f.agentId,
          sha256Json(randomUUID()),
          sha256Json(randomUUID()),
          now,
          new Date(+now + 10000),
          new Date(+now + 180000),
        ],
      );
      await client.query(
        'INSERT INTO design_invocations(job_id,attempt,consumed_at) VALUES($1,1,$2)',
        [f.jobId, now],
      );
      await client.query(
        'INSERT INTO job_results(job_id,attempt,result_digest,report,created_at) VALUES($1,1,$2,$3,$4)',
        [f.jobId, sha256Json(oldReport), oldReport, now],
      );
      for (const [state, event] of [
        ['claimed', 'job_claimed'],
        ['running', 'job_started'],
        ['validating', 'job_validating'],
        ['succeeded', 'job_succeeded'],
      ])
        await transition(client, job, state, event, now, { attempt: 1 });
    });
    const snapshot = async () => {
      const data = {};
      for (const table of [
        'projects',
        'site_spec_revisions',
        'jobs',
        'job_events',
        'job_executions',
        'job_attempts',
        'job_results',
        'design_invocations',
        'design_agent_profiles',
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
    const checksums = (
      await pool.query('SELECT * FROM _schema_migrations ORDER BY name')
    ).rows;
    assert.deepEqual(
      (await runMigrations({ databaseConfig: config })).applied,
      ['006_astra_preflight_failures.sql'],
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM _schema_migrations WHERE name<'006_astra_preflight_failures.sql' ORDER BY name",
        )
      ).rows,
      checksums,
    );
    assert.deepEqual(
      (await f.execution.detail(f.projectId, f.jobId)).report,
      oldReport,
    );
    assert.throws(
      () => assertDesignSpec(oldSpec, sha256Json(oldSpec)),
      (e) => e.code === 'INVALID_DESIGN_SPEC',
    );
    assert.deepEqual(await snapshot(), before);
  } finally {
    await closeDatabasePool();
    assert.ok(dir.startsWith(root));
    await rm(dir, { recursive: true });
  }
});
