# Persistence Data Model

## Source of truth

`site_spec_revisions.canonical_site_spec` is the sole canonical business document. PostgreSQL JSONB stores each complete SiteSpec snapshot. Project metadata, readiness rows, hashes, and events are indexes or audit evidence; they are not a second editable product model.

Canonical serialization recursively sorts object keys, preserves array order, normalizes negative zero, rejects non-JSON values, serializes as UTF-8 JSON, and hashes the resulting bytes with SHA-256. A second SHA-256 covers the normalized editable draft only, allowing a no-op save to return the current revision without inserting another snapshot.

## Tables

### `workspaces`

UUID primary key, unique slug, display name, and timestamps. Migration `001_initial_persistence.sql` inserts one stable `default` bootstrap workspace for the single-user MVP.

### `projects`

UUID primary key and restricted workspace foreign key. `(workspace_id, slug)` is unique. Status is `active` or `archived`; archive time must agree with status. `current_revision` points logically to the latest snapshot, while `optimistic_version` protects rename/archive metadata. Projects are never physically deleted through the API.

### `site_spec_revisions`

UUID primary key and restricted project foreign key. `(project_id, revision)` is unique and revisions are positive, monotonic integers. Each row stores schema version, document stage, canonical JSONB, canonical/editable SHA-256 hashes, namespaced idempotency key, non-secret actor/source metadata, and creation time. A database trigger rejects every `UPDATE` and `DELETE`.

### `site_spec_readiness_checks`

The composite primary key is `(revision_id, gate, check_id)`. Rows mirror the server-owned generation/publish checks embedded in that revision, including evaluator version and checked time. A database trigger makes them immutable.

### `project_events`

Identity primary key plus workspace/project foreign keys. The append-only journal records project creation, revision creation, no-op saves, optimistic conflicts, idempotency conflicts, rename, and archive. Payloads contain bounded metadata and hashes, never request bodies or secrets. A trigger rejects `UPDATE` and `DELETE`.

### `api_idempotency_records`

UUID primary key and workspace foreign key. `(workspace_id, operation, idempotency_key)` is unique. The row stores the canonical request hash and original successful response. A transaction-scoped advisory lock serializes the same workspace/operation/key before lookup or insert.

### `_schema_migrations`

Migration filename primary key, SHA-256 checksum, and application time. The runner holds a session advisory lock, checks every already-applied checksum, and executes each pending migration in a separate transaction.

## Revision transaction

1. Lock the idempotency scope and replay an identical prior request when present.
2. Lock the workspace-scoped project row with `SELECT ... FOR UPDATE`.
3. Compare mandatory `expectedRevision` to `projects.current_revision`.
4. Build server-owned readiness and canonical draft, then run JSON Schema and semantic validation.
5. Compare the editable hash; append a no-op event and return current state when unchanged.
6. Insert the new immutable revision and readiness rows, advance the project pointer, append an event, and store the idempotent response in one transaction.

A stale revision returns `409 REVISION_CONFLICT` with the current revision and commits only an audit event. The server never silently overwrites newer data. Reusing an idempotency key with a different canonical request hash returns `409 IDEMPOTENCY_CONFLICT`.

## Safety boundaries

All application reads and writes are scoped to the bootstrap workspace, and user-controlled values use PostgreSQL parameters. One lifecycle shared with the built HTTP server stops intake, drains requests for at most four seconds, closes the lazy pool, and ends the process (eight-second failure deadline). After shutdown starts, a new pool cannot be created. The source launcher and bundled API share process-local runtime state.

Current project reads join `projects.current_revision` to its immutable revision in one SQL statement. Its statement snapshot binds metadata, hash and body to the same committed state during concurrent saves. Two separate READ COMMITTED queries would not have this guarantee.

Saving requires a non-null object `draft`. Missing/null/array drafts are rejected before writes. An explicit `{}` replaces all six editable fields with empty/null values: an intentional clear, not a patch or missing-input fallback. An already empty draft is a no-op. Project display name is not implicitly renamed.

`DATABASE_URL` stores local projects; tests/reset only use the separately validated `TEST_DATABASE_URL`. Preflight rejects connection-string overrides and PG* environment variables before SQL. Test gates compare all persistence-table contents in the dev database before/after using read-only snapshots. Concurrent legitimate dev edits during tests deliberately fail this strict preservation check.

The API denies access by default even with a valid database. Explicit local mode also requires the actual HTTP listener to bind a numeric loopback address; HTTP headers cannot enable it. Do not expose the local listener through a tunnel or reverse proxy. No account, multi-user or untrusted-local-user authorization is claimed.

This model is intentionally single-workspace and unauthenticated. Authentication, tenant selection, job/review tables, normalized catalog data, assets, and publication targets belong to later milestones.
