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
- upload references and catalog files;
- display import previews and validation errors;
- show job state, logs, screenshots, artifacts, and final results;
- request approvals for publishing, deletion, DNS, production deploy, and other irreversible operations.

### Server API And Orchestrator

The server API owns project state and decides which jobs should exist. The orchestrator converts user goals and SiteSpec changes into small structured jobs.

Responsibilities:

- validate SiteSpec and job specs;
- split large goals into small jobs with dependencies;
- store state transitions and events;
- enforce idempotency keys;
- enforce approvals;
- expose agent API endpoints;
- never send raw user text as executable shell commands.

### PostgreSQL Source Of Truth

PostgreSQL is the source of truth for MVP state.

Core tables planned for MVP:

- `workspaces`;
- `projects`;
- `site_specs`;
- `sites`;
- `regions`;
- `catalog_imports`;
- `catalog_items`;
- `jobs`;
- `job_events`;
- `job_logs`;
- `artifacts`;
- `approvals`;
- `wordpress_targets`;
- `leads`.

Files and large artifacts should be stored in object storage or a filesystem-backed artifact store, with metadata and checksums in PostgreSQL.

### MVP Queue With Lease And Heartbeat

The MVP queue can be implemented in PostgreSQL before introducing a separate queue service.

Job states:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Queue behavior:

- A job starts as `draft` while being composed.
- A ready job moves to `queued`.
- One agent claims a job atomically and receives a lease.
- Claimed jobs move to `running` when execution begins.
- The agent sends heartbeat while running.
- If a lease expires, the job can return to `queued` or move to `failed` depending on retry policy.
- Jobs requiring irreversible actions move to `awaiting_approval`.
- After execution, validation commands run and the job moves to `validating`.
- Terminal states are `succeeded`, `failed`, and `cancelled`.

Lease rules:

- each claim assigns `claimedBy`, `leaseUntil`, and `attempt`;
- heartbeat extends `leaseUntil`;
- stale leases are recoverable;
- idempotency key prevents duplicate side effects;
- terminal jobs cannot be claimed again;
- retries must create a new attempt record while preserving previous logs and artifacts.

### Local Windows Agent

The local agent runs on a trusted user machine and executes bounded Codex jobs.

Responsibilities:

- register with the configured API;
- poll or long-poll for eligible jobs;
- claim a job and renew the lease;
- create a dedicated branch or worktree;
- run Codex only inside allowlisted directories;
- execute only structured validation commands from the job spec;
- upload logs, events, screenshots, diffs, reports, and artifacts;
- stop when cancelled or when approval is required.

Safety requirements:

- token comes from an environment variable or protected local storage;
- agent only talks to the configured API origin;
- workspace path must be inside an allowlist;
- raw user text is data, not a shell command;
- secrets are masked in logs;
- logs and artifacts have size limits;
- publication and other irreversible operations require approval.

### Codex Execution

Codex is invoked by the local agent for implementation, validation, review, or artifact generation.

Rules:

- run in a dedicated branch or worktree;
- use allowed paths and forbidden actions from the job spec;
- map execution profiles through configuration, not hard-coded model names in business logic;
- produce a final report with changed files, checks, assumptions, and risks;
- never merge to main or deploy unless a job explicitly allows it and approval is present.

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
- Agent receives only jobs for allowlisted workspaces.
- API must not trust agent logs as proof of success without validation results.

Boundary 3: Local agent to Codex/workspace.

- Codex works inside allowed paths.
- Job spec constrains file access and forbidden actions.
- Raw user text is never executed as shell.

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
6. Local agent claims a job and receives a lease.
7. Agent prepares branch/worktree in an allowlisted workspace.
8. Agent runs Codex with structured instructions and constraints.
9. Agent streams events, progress, and masked logs.
10. Agent runs predefined validation commands.
11. Agent uploads artifacts and final report.
12. Server records result and updates project status.
13. User reviews previews and approves irreversible actions if needed.
14. WordPress publication jobs run only after approval.

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
- Lease ownership is checked before accepting heartbeat, logs, artifacts, or terminal updates.
- Terminal updates are idempotent.
- Retried jobs preserve previous attempts and use a new attempt number.
- External side effects require both idempotency key and approval when irreversible.

## Cancellation And Retry

Cancellation:

- server marks job as `cancelled` if it is not terminal;
- agent stops at the next safe checkpoint;
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
