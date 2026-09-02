# PostgreSQL Persistence

This milestone persists the first brief screen as immutable draft SiteSpec revisions. It deliberately does not include authentication, jobs, Codex execution, catalog import, WordPress publication, DNS, or production deployment.

## Local setup

1. Copy `.env.example` to the ignored `.env` file.
2. Replace both local credential placeholders and keep the database name explicitly test-only for reset commands.
3. Start PostgreSQL with `npm run db:up`.
4. Apply and inspect migrations with `npm run db:migrate` and `npm run db:status`.
5. Stop the local service with `npm run db:down`. Add `-- -v` only when the local named volume should intentionally be removed.

`DATABASE_URL` is read lazily. The homepage and production build work without it; database API calls then return `503 DATABASE_UNAVAILABLE`. Connection URLs and passwords are never printed by database commands.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:up` | Start the separate local PostgreSQL compose service and wait for health. |
| `npm run db:down` | Stop the local service while retaining its named volume. |
| `npm run db:migrate` | Apply ordered, checksummed migrations under an advisory lock. |
| `npm run db:status` | Report applied, pending, or checksum-mismatched migrations. |
| `npm run db:test:reset` | Reset only a loopback database whose name explicitly contains `test`. |
| `npm run test:persistence` | Run migration and repository/service tests against PostgreSQL. |
| `npm run test:persistence:http` | Smoke-test the built production server and route handlers. |
| `npm run ci:full` | Run migrations, status, persistence tests, contracts, lint, build, and production HTTP smoke. |

## API v1

The API currently uses one bootstrap workspace and has no public authentication. Do not expose it as an open production API before the authentication milestone.

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

Stable codes are `DATABASE_UNAVAILABLE`, `INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `VALIDATION_FAILED`, `PROJECT_NOT_FOUND`, `PROJECT_ARCHIVED`, `REVISION_NOT_FOUND`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SERVER_OWNED_FIELD`, `UNSUPPORTED_STAGE_TRANSITION`, and `INTERNAL_ERROR`.

## Editable draft contract

Clients may send only `companyName`, `niche`, `salesRegion`, `businessType`, `siteType`, and `networkType`. The server assigns `projectId`, `schemaVersion`, `revision`, `documentStage`, and `readiness`. Only `draft` stage is supported. Attempts to send server-owned fields or promote a document are rejected.

The server maps existing UI values as follows:

- `services` to `b2b_services`;
- `seo-network` to `seo_network`;
- `domains` to `separate_domains`;
- network mode to its canonical strategy.

Empty information remains absent, empty, or `null`. The mapper never invents contacts, domains, products, prices, stock, addresses, or company facts. A user-supplied niche is retained as an unverified, non-publishable fact with `user_input` provenance.

## Verification

Use an explicitly local test database and run `npm ci`, then `npm run ci:full`. The HTTP smoke requires an existing production build; `ci:full` creates it before starting `server/production.mjs` on an isolated test port. Tests do not require external services or production secrets.
