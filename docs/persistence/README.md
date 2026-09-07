# PostgreSQL Persistence

This milestone persists the first brief screen as immutable draft SiteSpec revisions. The subsequent [MVP-03A queue](../jobs/README.md) adds revision-pinned requests and an append-only journal, without execution. Authentication, Codex execution, catalog import, WordPress publication, DNS, and production deployment remain outside this implementation.

## Local setup

Prerequisites: Node 22.13+ (CI uses Node 24), npm, Docker Desktop/Engine. Run from the repository root. From a clean PowerShell shell use `Copy-Item .env.example .env`, or POSIX `cp .env.example .env`, **only if `.env` does not already exist**. Replace the four credential placeholders and keep each URL consistent with its compose credentials. Percent-encode reserved characters in URL credentials.

`DATABASE_URL` belongs to persistent local projects (port 55432). `TEST_DATABASE_URL` belongs to a mandatory separate disposable database (port 55433). No fallback exists between them. The test service has separate credentials and tmpfs data; dev keeps the existing named volume.

For existing installations retain the current `POSTGRES_DB`, credentials, port and `DATABASE_URL`, including the legacy `b2b_site_studio_test` name if that is where local projects live. Add the separate test service/URL instead of renaming or resetting existing data. Initialization variables do not rename a database in an existing volume. Do not remove that volume.

These commands work from a clean PowerShell or POSIX shell without manual exports:

```text
npm ci
npm run db:up
npm run db:migrate
npm run db:status
npm run build
npm run start:local
```

Open `http://127.0.0.1:3000`. Stop with Ctrl+C. `start:local` forces the real listener to loopback and explicitly opts into persistence. `PORT` may select another port. `npm run dev` remains a UI-development server with persistence disabled; use the built local launcher for database work.

The common `scripts/local-env.mjs` loader reads the ignored root `.env` for DB CLI, test gates and `start:local`. Existing environment variables, including CI values, take priority; an explicitly empty test URL is not replaced. Build and the ordinary production launcher do not import this loader. Never prefix secrets with `VITE_` or `NEXT_PUBLIC_`.

Ordinary `npm start` denies persistence by default, even with a working database. All persistence routes return `403 PERSISTENCE_DISABLED`, while the homepage remains available. Both explicit local mode and an actual loopback-bound HTTP listener are required. Host/forwarded headers and `NODE_ENV` cannot grant access. An allowed local API without a DB returns `503 DATABASE_UNAVAILABLE`. Do not expose the local listener through a tunnel/proxy: this is a local-only boundary, not authentication. Connection URLs/passwords are not printed by DB commands.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:up` | Start the separate local PostgreSQL compose service and wait for health. |
| `npm run db:test:up` | Start the separate disposable test service. |
| `npm run db:down` | Stop the local service while retaining its named volume. |
| `npm run db:migrate` | Apply ordered, checksummed migrations under an advisory lock. |
| `npm run db:status` | Report applied, pending, or checksum-mismatched migrations. |
| `npm run db:test:migrate` / `npm run db:test:status` | Apply/inspect migrations on the validated test connection. |
| `npm run db:test:reset` | Destructively reset only validated `TEST_DATABASE_URL`, never dev. |
| `npm run test:persistence` | Run migration and repository/service tests against PostgreSQL. |
| `npm run test:persistence:http` | Smoke-test the built production server and route handlers. |
| `npm run test:persistence:ui` | Built-server Chromium races, retry, conflict, desktop/mobile and console tests. |
| `npm run test:jobs` / `test:jobs:http` / `test:jobs:ui` | Queue database/001-upgrade, built-server HTTP and Playwright scenarios through the same protected runner. |
| `npm run test:agents` / `test:agents:http` / `test:agents:process` / `test:agents:ui` | Presence-only pairing, upgrade, transport, real foreground process and UI checks on TEST. See [Runner setup](../agents/README.md). |
| `npm run test:execution` / `test:execution:http` / `test:execution:process` / `test:execution:ui` | Scoped data-only execution, upgrade 001-003 to 004, lease/retry/fencing, independent report verification and real Runner/UI on TEST. |
| `npm run ci:full` | Preflight, test migrations/status, persistence/jobs/agents/execution, contracts, lint/build, all HTTP/process/security/shutdown/UI suites and dev fingerprint. |

## API v1

The API uses one bootstrap workspace and is disabled outside explicit local mode. Public authentication belongs to a future milestone.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| `GET` | `/api/v1/health/database` | Report PostgreSQL availability. |
| `GET` | `/api/v1/projects` | List projects in the bootstrap workspace. |
| `POST` | `/api/v1/projects` | Create a project and immutable draft revision 1. Requires `Idempotency-Key`. |
| `GET` | `/api/v1/projects/{projectId}` | Fetch project metadata and current revision. |
| `PATCH` | `/api/v1/projects/{projectId}` | Rename or archive with `expectedVersion`; never physically delete. |
| `GET` | `/api/v1/projects/{projectId}/site-spec` | Fetch the current immutable SiteSpec snapshot. |
| `PUT` | `/api/v1/projects/{projectId}/site-spec` | Save a draft with `expectedRevision`. Requires `Idempotency-Key`. |
| `GET` | `/api/v1/projects/{projectId}/site-spec/revisions` | List revision metadata newest first. |
| `GET` | `/api/v1/projects/{projectId}/site-spec/revisions/{revision}` | Fetch one historical immutable snapshot. |

JSON writes require `Content-Type: application/json` and are limited to 64 KiB. The common error shape is:

```json
{
  "error": {
    "code": "STABLE_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
```

Stable codes are `PERSISTENCE_DISABLED`, `DATABASE_UNAVAILABLE`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `VALIDATION_FAILED`, `PROJECT_NOT_FOUND`, `PROJECT_ARCHIVED`, `REVISION_NOT_FOUND`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SERVER_OWNED_FIELD`, `UNSUPPORTED_STAGE_TRANSITION`, and `INTERNAL_ERROR`.

## Editable draft contract

Clients may send only `companyName`, `niche`, `salesRegion`, `businessType`, `siteType`, and `networkType`. The server assigns `projectId`, `schemaVersion`, `revision`, `documentStage`, and `readiness`. Only `draft` stage is supported. Attempts to send server-owned fields or promote a document are rejected.

PUT requires an object `draft`. Missing/null/array drafts return `422 VALIDATION_FAILED` without a revision. An explicit `{}` intentionally clears the six editable fields; it is not a partial patch. Clearing an already empty draft is a no-op. Create may omit `draft` to initialize an empty document.

While loading/creating/saving, all editable controls are disabled and a synchronous operation guard rejects repeat clicks. A network-uncertain write retains its exact key, payload and expected revision for retry; changed payloads get a new key. This retry state is page-session scoped, not durable across closing the tab. Loads are abortable and sequence-checked. Unpersisted fields, including important constraints, are disabled rather than silently discarded.

The server maps existing UI values as follows:

- `services` to `b2b_services`;
- `seo-network` to `seo_network`;
- `domains` to `separate_domains`;
- network mode to its canonical strategy.

Empty information remains absent, empty, or `null`. The mapper never invents contacts, domains, products, prices, stock, addresses, or company facts. A user-supplied niche is retained as an unverified, non-publishable fact with `user_input` provenance.

## Verification

In another clean shell, after configuring both URLs:

```text
npm run db:test:up
npm run db:test:migrate
npm run db:test:status
npx --no-install playwright install chromium
npm run ci:full
```

On Linux install Chromium OS dependencies with `npx --no-install playwright install --with-deps chromium`. Browser installation downloads dependencies; the test scenarios themselves use only loopback and do not require production secrets. Standalone HTTP/UI tests require `npm run build` first. UI screenshots are written to ignored `.test-results/`.

Every test entrypoint rejects missing/ambiguous configuration before connecting, migrating or cleaning. Only `postgres:`/`postgresql:` URLs with credentials, numeric loopback (or normalized localhost), explicit test database name and valid port are supported. All query parameters, fragments, remote/socket targets and PG* environment overrides are rejected. Known dev/test targets may not coincide, including loopback aliases. Validation inspects pg's actual connection parameters without connecting. Rejected URLs must never be tested by attempting a reset.

Each gate takes read-only fingerprints of all persistence tables in `DATABASE_URL` before/after and fails on change (`DEV_DATABASE_CHANGED`). Do not edit dev projects concurrently with this strict check. If dev is absent it reports `DEV_DATABASE_NOT_CONFIGURED`; CI always provisions a second service, explicitly seeds a dev sentinel before testing with `tests/persistence/seed-dev-sentinel.mjs`, and requires `DEV_DATABASE_UNCHANGED`. Sentinel setup accepts only a disposable `_dev_fixture` database, adds a project and never resets any DB.

Security and shutdown smoke tests launch the real production bundle with `NODE_ENV=production`, isolated local credentials and an ephemeral port. Public/default and wildcard-bind modes must deny reads/writes even with a working DB and forged headers. Linux CI sends real SIGTERM after a DB request and requires clean exit within seven seconds. Windows cannot deliver POSIX SIGTERM, so its test-only IPC relay invokes the same registered handler; SIGKILL is used only to clean up a failed shutdown assertion.
