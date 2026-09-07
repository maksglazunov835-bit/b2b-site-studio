# Revision-Pinned Job Queue And Data Validation

Creation stores a **queue request**, not an executable JobSpec. The only type is `site_spec_validation`, using template `site_spec_validation@1`. Without explicit per-job operator dispatch it returns `dispatchable:false`, `reason:EXECUTOR_NOT_CONFIGURED`, `acceptanceResult:null`. Merely connecting an agent never runs the backlog.

MVP-03C adds a separate complete [1.3 data-only JobSpec](../contracts/job-data-validation.schema.json), described in the [implemented API profile](../contracts/agent-api.md#implemented-data-validation-profile-mvp-03c). The legacy repository [1.2 schema](../contracts/job.schema.json) and its gate are unchanged. The new profile has no fake repository/path values. Only fixed built-in JSON validation is executable; shell, Codex, WordPress, GitHub and site-file access remain unavailable.

## API And DTOs

All routes reuse the existing default-deny persistence boundary. They work only in explicit loopback-bound local mode. Workspace comes from trusted server context, project from the route, not client body or headers. Responses are `no-store`; errors use the existing sanitized envelope, JSON content-type and 64 KiB body limit.

| Method | Path (prefix `/api/v1/projects/{projectId}`) | Request/result |
| --- | --- | --- |
| POST | `/jobs` | `{ "type": "site_spec_validation", "expectedRevision": 2 }`, required `Idempotency-Key`; 201 `{ job }`. |
| GET | `/jobs` | Optional `limit`, `cursor`; `{ jobs, nextCursor }`. |
| GET | `/jobs/{jobId}` | `{ job }` with pinned input, current revision and `isInputStale` from one joined SQL snapshot. |
| GET | `/jobs/{jobId}/events` | Optional `limit`, `cursor`; `{ events, nextCursor }`, ascending sequence. |
| POST | `/jobs/{jobId}/cancel` | `{ "expectedVersion": 1 }`, required `Idempotency-Key`; 200 `{ job, noOp }`. |
| POST | `/jobs/{jobId}/dispatch` | `{ "agentId": "<scoped device>", "expectedVersion": 1 }`, Idempotency-Key; complete pinned data spec and assignment. |
| GET | `/jobs/{jobId}/execution` | Bounded persisted report, assignment and at most three attempts, no lease or credential hashes. |

Ajv validators in `server/jobs/requests.mjs` allow exactly those write fields, with positive PostgreSQL-range integers. Unknown fields, including workspace/actor/hash/state/result/acceptance/repository/path/shell, are rejected. Job IDs use `job_` plus 32 lowercase hexadecimal UUID characters, compatible with the future agent ID namespace. IDs are opaque, not authorization.

Limits default to 20 and cannot exceed 100. Jobs sort by immutable `(created_at DESC, id DESC)`, preserving PostgreSQL microseconds in cursors; events sort by sequence. Versioned base64url cursors are length-bounded, strictly validated and bound to workspace/project/list kind (and job for events). Cursors are not credentials or signed authorization. Pagination is a keyset view, not a multi-request database snapshot: newer jobs appear on refresh, not in later pages of an older traversal.

New stable errors: `JOB_NOT_FOUND` (404), `JOB_VERSION_CONFLICT` (409), `INVALID_JOB_TRANSITION` (409), `UNSUPPORTED_JOB_TYPE` (422), `INVALID_CURSOR` (422), `SITE_SPEC_INTEGRITY_ERROR` (409). Existing validation, project, revision, idempotency and access errors are reused. Foreign project/workspace jobs return not found. There is no arbitrary state PATCH or append-event endpoint.

## Transactions And Data Invariants

Migration `002_job_queue.sql` adds `jobs`, `job_events`, scoped list indexes, composite foreign keys and immutable-source/journal triggers. Applied migration 001 is unchanged. The composite revision FK ties project, revision ID/number, schema version and hash to the same stored revision. Jobs cannot be deleted or have their source inputs changed; events cannot be updated/deleted. Request snapshots are limited to 4096 bytes, event payloads to 1024; source `local_ui` / actor type `operator` are server-owned local provenance, not an authenticated user identity.

Creation locks the idempotency scope first, then the project. A replay is returned before new-operation revision/archive preconditions. A new operation requires an active project and the exact locked current revision, and recalculates its canonical SHA-256. It never rebuilds an old SiteSpec with today's mapper. Job, initial `job_queued` event (sequence 1) and idempotency response commit together.

Cancellation locks the idempotency scope, then the job (never the project). An unassigned queued version 1 still cancels to version 2. Explicit dispatch adds a `job_dispatched` event/version while remaining queued; queued cancellation uses its current version. Active claimed/running/validating cancellation becomes `cancel_requested`; only a valid Runner stop acknowledgement makes it cancelled. Missing acknowledgement/revocation becomes failed `STOP_UNCONFIRMED` on expiry. Cancellation remains allowed after project archival. Repeated cancellation under current version is a recorded no-op; stale version conflicts. Deferred constraints prevent committed state without its journal.

Migration `004_validation_execution.sql` adds grants, immutable execution specs/results/operation acknowledgements and fenced attempts without modifying migrations 001-003 or historical rows. Allowed execution path is queued -> claimed -> running -> validating -> succeeded/failed. Result success means the check ran, not that data is valid: inspect `report.validationStatus` and bounded findings. Server independently recomputes the report; `acceptanceResult` is always null and no readiness/revision/fact changes. Expired attempts retry at most three times only for this side-effect-free JSON task. Tokens never enter the journal, spec, report or saved replay.

Keys are scoped to workspace/project/action (and target job for cancel). Identical concurrent requests create one job/event/response; another payload under that key conflicts. A fresh key deliberately represents another job. Replay responses are immutable, including old currentRevision metadata; clients GET current detail afterwards. These guarantees cover database record creation/cancellation, not exactly-once external execution. Transactions contain no network/UI waits.

## UI And Verification

The compact Jobs panel appears for an opened saved project. Creation requires a saved brief without pending/dirty/conflict/uncertain-save state and displays the revision being requested. An unsaved brief is never saved automatically. Job refresh does not modify brief state. Old jobs remain pinned after saving a new brief. The journal, cancellation and reload all use PostgreSQL.

Writes have a synchronous repeat-click guard and an exact retry tuple (URL, JSON payload, Idempotency-Key, expected revision/version). On a lost response the same logical request is retried. New payloads get new keys. Loads are sequence-checked and aborted on project unmount; brief edits do not abort job writes. Retry memory is page-session scoped, not durable across closing/reloading a tab; refresh the persisted list before deciding to create another job after that boundary.

Use the [local setup](../persistence/README.md) with separate `TEST_DATABASE_URL`; tests never substitute or migrate `DATABASE_URL`. Run:

```text
npm ci
npm run db:test:migrate
npm run db:test:status
npm run test:jobs
npm run test:jobs:http
npm run test:jobs:ui
npm run test:execution
npm run test:execution:http
npm run test:execution:process
npm run test:execution:ui
npm run ci:full
```

Build before standalone HTTP/UI tests (`npm run build`). The protected full runner includes the existing 12 persistence tests, unchanged contract fixtures/lint/build, old HTTP/access/shutdown/UI scenarios, and new database/upgrade/HTTP/Playwright job scenarios. The 001-to-002 fixture preserves old table rows, checksums and historical revisions; it uses only the disposable test target. CI seeds its separate disposable dev sentinel at 001, and a read-only full-table fingerprint proves `DEV_DATABASE_UNCHANGED`, including migration history and optional jobs tables. No test applies 002 to user dev data.

CI uses real PostgreSQL service containers and uploads nine allowlisted evidence files for seven days: `ci-summary.json`, persistence/jobs/presence Runner/completed execution desktop/mobile PNGs. No database data, stdout, environment or connection strings are included. Screenshots use synthetic data, clear transient pairing first and are each capped at 5 MiB. They remain ignored. Existing persistence/jobs/agents scenarios stay active beside execution upgrade, races, tamper, real-process loss injection and UI report/reload/cancel tests in `ci:full`. The executor reports execution only; independent acceptance and delegated merge follow [AGENTS.md](../../AGENTS.md#delegated-repository-merge).
