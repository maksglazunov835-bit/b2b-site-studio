# MVP Control Plane Architecture

## Goal

Define the first stable architecture for the flow:

`B2B Site Studio -> server orchestrator -> queue -> local Windows agent -> Codex -> validation -> artifacts/results -> platform -> WordPress publication`.

This document is a contract for future implementation. It does not introduce a database, API server, queue, or live Codex runner in the current repository state.

## Components

### Web Interface

The web interface is the operator-facing control plane. It collects project data, shows status, displays validation results, previews artifacts, and asks for approvals before irreversible actions.

Responsibilities:

- collect and edit SiteSpec;
- save incomplete SiteSpec drafts and resume later without fake data;
- upload references and catalog files;
- display import previews and validation errors;
- show job state, logs, screenshots, artifacts, and final results;
- request approvals for publishing, deletion, DNS, production deploy, and other irreversible operations.

### Server API And Orchestrator

The server API owns project state and decides which jobs should exist. The orchestrator converts user goals and SiteSpec changes into small structured jobs.

Responsibilities:

- validate SiteSpec and job specs;
- run separate readiness checks for `draft`, `generation_ready`, and `publish_ready`;
- split large goals into small jobs with dependencies;
- store state transitions and events;
- pin each job to repository identifier, base ref, base commit SHA, SiteSpec revision, SiteSpec sha256, and input artifact checksums;
- enforce idempotency keys;
- enforce approvals;
- expose agent API endpoints;
- never send raw user text or arbitrary validation commands as executable shell.

### PostgreSQL Source Of Truth

PostgreSQL is the source of truth for MVP state.

Core tables planned for MVP:

- `workspaces`;
- `projects`;
- `site_specs`;
- `site_spec_revisions`;
- `sites`;
- `regions`;
- `site_region_overrides`;
- `facts`;
- `catalog_imports`;
- `catalog_items`;
- `catalog_variants`;
- `jobs`;
- `job_attempts`;
- `job_events`;
- `job_logs`;
- `artifacts`;
- `approvals`;
- `wordpress_targets`;
- `leads`.

Files and large artifacts should be stored in object storage or a filesystem-backed artifact store, with metadata and checksums in PostgreSQL. SiteSpec stores only structured asset references such as asset/artifact ID, role, filename, content type, size, and sha256; binary payloads stay outside SiteSpec.

SiteSpec revisions are immutable once used by a job. If a user changes the brief while a job is running, the new SiteSpec revision receives a new sha256 and existing jobs cannot report success against the old input unless their job spec explicitly allowed that stale base.

### SiteSpec Stages And Readiness

The architecture uses one draft-friendly SiteSpec schema with explicit stages:

- `draft`: can be incomplete and can omit contacts, regions, sites, products, variants, selected design, domain, and verified facts.
- `generation_ready`: has enough structure to generate plans, designs, pages, or implementation tasks, and must pass generation readiness checks.
- `publish_ready`: has all publish-critical facts, contacts, domains, WordPress target, selected design, rollback plan, and indexability decisions, and must pass publish readiness checks.

Readiness checks are stored as structured results. They are not a substitute for facts and must not be satisfied with placeholder contact data, placeholder addresses, or invented company claims.

### MVP Queue With Lease And Heartbeat

The MVP queue can be implemented in PostgreSQL before introducing a separate queue service.

Job states:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Queue behavior:

- A job starts as `draft` while being composed.
- A ready job moves to `queued`.
- One agent claims a job atomically and receives a lease with a random lease token.
- Claimed jobs move to `running` when execution begins.
- The agent sends heartbeat while running.
- If a lease expires, the job can return to `queued` or move to `failed` depending on retry policy.
- Jobs requiring irreversible actions move to `awaiting_approval`.
- After execution, registered validation checks run and the job moves to `validating`.
- A running job moves to `cancel_requested` before terminal cancellation; it becomes `cancelled` only after agent acknowledgement.
- Terminal states are `succeeded`, `failed`, and `cancelled`.

Lease rules:

- each claim assigns `claimedBy`, `leaseUntil`, `attempt`, and a random `leaseToken`;
- start, heartbeat, events, logs, artifacts, validation, complete, fail, and cancel acknowledgement require the active lease token;
- heartbeat extends `leaseUntil` only for the active lease token;
- stale leases are recoverable;
- stale processes cannot upload artifacts or terminal state after the lease token expires;
- idempotency key prevents duplicate side effects;
- terminal jobs cannot be claimed again;
- repeated terminal updates with the same idempotency key return the stored result;
- retries must create a new attempt record while preserving previous logs and artifacts.

### Local Windows Agent

The local agent runs on a trusted user machine and executes bounded Codex jobs.

Responsibilities:

- register with the configured API;
- poll or long-poll for eligible jobs;
- claim a job and renew the lease;
- resolve `workspaceId` to a local path from protected local configuration;
- create a dedicated branch or worktree;
- run Codex only inside allowlisted directories;
- execute only local registered validation checks requested by ID with typed parameters;
- upload logs, events, screenshots, diffs, reports, and artifacts;
- stop when cancelled or when approval is required.

Safety requirements:

- token comes from an environment variable or protected local storage;
- agent only talks to the configured API origin;
- the server cannot choose arbitrary absolute paths on the user's computer;
- resolved workspace path must be inside an allowlist;
- capabilities and actions are deny-by-default;
- raw user text is data, not a shell command;
- `powershell -Command`, `cmd /c`, `bash -c`, `sh -c`, and arbitrary executables are not accepted from job specs;
- secrets are masked in logs;
- logs and artifacts have size limits;
- publication and other irreversible operations require approval.

### Codex Execution

Codex is invoked by the local agent for implementation, validation, review, or artifact generation.

Rules:

- run in a dedicated branch or worktree;
- use allowed paths, allowed capabilities, allowed actions, and forbidden actions from the job spec;
- map execution profiles through configuration, not hard-coded model names in business logic;
- produce a final report with changed files, checks, assumptions, and risks;
- never merge to main or deploy unless a job explicitly allows it and approval is present.

### Registered Validation Checks

The server sends validation check IDs, not command text.

Initial local registry:

- `file_exists`;
- `npm_lint`;
- `npm_build`;
- `git_diff_check`;
- `static_html_exists`.

Registry entries are local agent code/configuration. Every check runs with shell mode false, typed parameters, normalized relative paths, and workspace allowlist checks. Unknown checks and missing capabilities are denied.

### Logs, Events, And Artifacts

Events are structured and stored for status display and auditing.

Event examples:

- `job.created`;
- `job.claimed`;
- `job.started`;
- `job.heartbeat`;
- `job.progress`;
- `job.awaiting_approval`;
- `job.validation_started`;
- `job.validation_result`;
- `job.cancel_requested`;
- `job.cancel_acknowledged`;
- `job.succeeded`;
- `job.failed`;
- `job.cancelled`;
- `artifact.uploaded`.

Log rules:

- mask tokens, keys, passwords, cookies, and Authorization headers;
- truncate long output;
- store raw large logs as artifacts when needed;
- keep user-facing summaries separate from raw execution logs.

Artifact examples:

- generated files;
- screenshots;
- diffs;
- validation reports;
- import error reports;
- design prototypes;
- WordPress export packages.

Artifact upload is two-phase: the agent creates an upload record, uploads bytes, then completes upload with size and sha256. The server checks the manifest, path, content type, size, checksum, job attempt, and lease token before accepting it.

### Approvals

Approvals are first-class state, not chat conventions.

Actions requiring approval:

- production deploy;
- WordPress publish;
- DNS change;
- deletion;
- credential rotation;
- repository visibility change;
- payment or external account changes;
- destructive database migrations.

Approval records must include requester, action, target, reason, preview, created time, expiration, status, approver, and decision time.

Approval flow:

- agent or server creates an approval request and the job enters `awaiting_approval`;
- user/operator approves or rejects the request;
- agent receives the decision through heartbeat or approval lookup;
- rejected approval blocks the action and normally fails or returns the job to a safe state;
- approved action is still limited by allowed capabilities/actions and current lease.

### WordPress Site Factory

The WordPress site factory is a future module, separate from the MVP control-plane foundation.

Responsibilities in a later milestone:

- create or connect WordPress instances;
- install/update platform theme or runtime plugin;
- create pages, categories, products, media, menus, SEO metadata, sitemap, robots, redirects, and forms;
- run staging smoke tests;
- publish to production after approval;
- support rollback.

## Trust Boundaries

Boundary 1: Browser to server API.

- Browser is not trusted to enforce permissions.
- API validates all SiteSpec, job, and approval mutations.

Boundary 2: Server API to local agent.

- Agent authenticates with a scoped token.
- Agent receives jobs by `workspaceId` and resolves the local path itself.
- API must not trust agent logs as proof of success without validation results.
- Lease token and attempt must match before the server accepts progress, logs, artifacts, validation, or terminal states.

Boundary 3: Local agent to Codex/workspace.

- Codex works inside allowed paths.
- Job spec constrains file access through allowed paths, allowed capabilities, allowed actions, and forbidden actions.
- Raw user text is never executed as shell.
- Server-supplied absolute paths and server-supplied shell commands are not trusted.

Boundary 4: Platform to WordPress.

- Publishing requires approval.
- WordPress credentials are stored server-side or in protected agent storage.
- Generated frontend code must not contain secrets.

## Data Flow

1. User creates project in the web interface.
2. Server validates and stores SiteSpec in PostgreSQL.
3. User imports catalog or updates brief data.
4. Orchestrator creates draft jobs from SiteSpec changes.
5. Ready jobs move to queued.
6. Local agent claims a job and receives a lease token.
7. Agent resolves `workspaceId` locally and verifies repository/base commit/SiteSpec hash.
8. Agent prepares branch/worktree in an allowlisted workspace.
9. Agent runs Codex with structured instructions and constraints.
10. Agent streams events, progress, and masked logs with the current lease token.
11. Agent creates artifact uploads, uploads bytes, and completes each artifact with size and sha256.
12. Agent starts validation and runs registered validation checks.
13. Server accepts success only after required validation passes and input versions still match.
14. User reviews previews and approves irreversible actions if needed.
15. WordPress publication jobs run only after approval.

## Execution Profiles

Profiles are configuration objects. Business logic stores profile names, not hard-coded model identifiers.

- `fast`: text, data shaping, safe small edits, schema examples, and lightweight validation.
- `standard`: normal UI/API implementation and routine integration work.
- `deep`: architecture, migrations, security-sensitive design, and complex refactoring.
- `review`: independent review, test verification, and risk analysis.

Each profile maps to an available model, reasoning effort, timeout, validation depth, and review requirements through deployment configuration.

## Double-Execution Protection

- Every job has an idempotency key.
- Claim is atomic.
- Lease ownership and lease token are checked before accepting heartbeat, logs, artifacts, validation, or terminal updates.
- Terminal updates are idempotent.
- Repository base commit SHA, SiteSpec revision, SiteSpec sha256, and input artifact checksums are checked before terminal success.
- Retried jobs preserve previous attempts and use a new attempt number.
- External side effects require both idempotency key and approval when irreversible.

## Cancellation And Retry

Cancellation:

- server marks queued/draft jobs as `cancelled` immediately when safe;
- server marks running jobs as `cancel_requested`;
- agent sees cancellation through heartbeat, stops at the next safe checkpoint, and sends cancel acknowledgement with the active lease token;
- running jobs become terminal `cancelled` only after agent acknowledgement;
- if the lease expires before acknowledgement, the stale process is fenced off and the attempt moves to a retryable failure or stale-lease recovery path, not terminal `cancelled`;
- partial artifacts remain attached to the cancelled attempt.

Retry:

- failed jobs can be retried only when retry policy allows it;
- retry creates a new attempt and may reuse safe cached inputs;
- jobs with possible external side effects require explicit review before retry.

## MVP Non-Goals

- no production WordPress automation before approvals and smoke tests exist;
- no direct shell execution from user text;
- no unbounded background autonomous work;
- no multi-workspace permission system before the first single-workspace flow is stable;
- no dependency on one fixed model name.
