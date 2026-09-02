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
- show independent review state and reviewer findings separately from execution status;
- request approvals for publishing, deletion, DNS, production deploy, and other irreversible operations.

### Server API And Orchestrator

The server API owns project state and decides which jobs should exist. The orchestrator converts user goals and SiteSpec changes into small structured jobs.

Responsibilities:

- validate SiteSpec and job specs;
- own and derive readiness checks for `draft`, `generation_ready`, and `publish_ready`;
- split large goals into small jobs with dependencies;
- store state transitions and events;
- store independent review decisions separately from execution results;
- pin each job to repository identifier, base ref, base commit SHA, SiteSpec revision, SiteSpec sha256, and input artifact checksums;
- bind networked job actions to typed allowlist destinations for GitHub, artifact storage, or WordPress targets;
- enforce idempotency keys;
- enforce approvals;
- expose agent API endpoints;
- negotiate Agent API, JobSpec, SiteSpec, and validation registry versions;
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
- `job_reviews`;
- `readiness_checks`;
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

Readiness checks are stored as structured server-owned derived results. They are not a substitute for facts and must not be satisfied with placeholder contact data, placeholder addresses, or invented company claims.

Rules:

- the browser may submit inputs, but cannot set a readiness gate to `passed`;
- a readiness gate cannot be `passed` while any required check is `missing` or `failed`;
- `publish_ready` requirements depend on `siteModel` and network mode;
- `generation_ready` requirements depend on `siteModel` and generated page types: landing, multipage, corporate, and single WordPress site jobs can be ready without catalog data when no catalog/category/product pages are generated;
- single-site projects do not require a fake region;
- catalog, SEO-network, and hybrid publication require publishable category/product data when those pages are generated;
- commercial price, stock, and minimum-order values require explicit provenance and publish permission; system inference cannot publish them;
- required lead-form consent requires publishable verified consent text;
- publication requires real usable contacts or an approved lead intake path;
- publication requires actual host/target, selected design, rollback plan, publishable facts, WordPress target, and required approvals.

Catalog data has one canonical shape: categories store hierarchy and product ID membership; products and variants live only in `catalog.products`. Semantic validation must confirm category paths, parent references, product references, asset references, selected design artifacts, Telegram routes, site/region references, and target host consistency.

### MVP Queue With Lease And Heartbeat

The MVP queue can be implemented in PostgreSQL before introducing a separate queue service.

Job states:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Execution terminal states are only `succeeded`, `failed`, and `cancelled`. Independent acceptance states are separate: `accepted`, `changes_required`, and `blocked`.

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
- Terminal `succeeded` moves the result to `review_pending`; it is not accepted until independent review passes.

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
- Codex, Node, npm scripts, and repository code run as untrusted code in a sandboxed low-privilege process;
- environment variables are allowlisted and production secrets are unavailable;
- network is disabled by default unless typed destinations explicitly allow it;
- CPU, memory, time, file count, and file size limits are enforced;
- only normalized POSIX-relative paths are accepted in contracts;
- backslash, colon, Windows absolute paths, UNC/device paths, control/NUL, and traversal segments are rejected;
- after resolving paths, realpath containment must hold and symlink/junction/reparse-point escape is rejected.

### Codex Execution

Codex is invoked by the local agent for implementation, validation, review, or artifact generation.

Rules:

- run in a dedicated branch or worktree;
- use allowed paths, allowed capabilities, allowed actions, and forbidden actions from the job spec;
- map execution profiles through configuration, not hard-coded model names in business logic;
- produce a final report with changed files, checks, assumptions, and risks;
- never merge to main or deploy unless a job explicitly allows it, required approval is present, and independent acceptance is `accepted`.

### Registered Validation Checks

The server sends validation check IDs, not command text.

Initial local registry:

- `file_exists`;
- `npm_lint`;
- `npm_build`;
- `git_diff_check`;
- `static_html_exists`.

Registry entries are local agent code/configuration. Every check runs with shell mode false, typed parameters, normalized relative paths, and workspace allowlist checks. Unknown checks and missing capabilities are denied.

`npm_lint` and `npm_build` are still treated as execution of untrusted repository code. They must run inside the sandbox, with allowlisted environment, no production secrets, network disabled by default, and resource limits.

### Independent Review Gate

Independent review is first-class architecture, not a chat convention.

Entities:

- `job_reviews`: reviewer principal, job ID, attempt, checked diff SHA, checked validation result IDs, acceptance result, comments, risks, and reviewed timestamp.
- `task_review` can aggregate multiple job reviews for a PR, milestone, or publication package.

Rules:

- Codex execution report and successful command output are supporting evidence only.
- An independent reviewer, or configured CI when available, checks the factual diff, changed files, tests, architecture impact, migrations, configuration, security, and source Issue/JobSpec alignment.
- The executor cannot accept its own work.
- `accepted` is required before merge, production deploy, WordPress publication, DNS changes, and other irreversible actions.
- `changes_required` keeps fixes in the same feature branch or PR and triggers a full recheck.
- `blocked` records the missing external input or dependency and keeps irreversible actions locked.

### Safe GitHub Workflow

GitHub writes are modeled as allowlisted actions:

- `git_commit`;
- `git_push_feature_branch`;
- `create_or_update_pull_request`.

Rules:

- agent verifies exact repository identifier, provider repository ID, and remote origin before any git write;
- commits happen only in a dedicated branch or worktree;
- push is only to a feature branch with the `codex/` prefix;
- force-push is forbidden;
- push to `main` is forbidden;
- merge is forbidden until independent acceptance is `accepted`;
- job results include commit SHA, branch name, and PR URL when those actions are performed.

GitHub push and PR jobs require `github_git` and `github_api` network allowlist entries. Each entry must match the repository identifier, provider repository ID, remote origin, and target `codex/` branch. Hosts are selected from typed destinations, not copied from user text.

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

Approval records must include requester principal, action, target, reason, preview, created time, expiration, status, approver principal, and decision time. Human/operator principals come from authentication and RBAC, not request body fields.

Approval flow:

- agent or server creates an approval request and the job enters `awaiting_approval`;
- agent checkpoints, uploads preview artifacts when required, releases the lease, and stops local execution;
- user/operator approves or rejects the request through a human-authenticated endpoint;
- actor is derived from authenticated principal, not request body;
- self-approval is forbidden;
- approval is bound to job ID, attempt, exact action, exact target, environment, SiteSpec hash, input artifact hashes, preview artifacts, and expiry;
- after approval, continuation is requeued with a new lease token or split into a separate irreversible-action job;
- rejected approval blocks the action and normally fails or returns the job to a safe state;
- approved action is still limited by allowed capabilities/actions, current input hashes, readiness, and independent acceptance.

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
- Browser cannot mark readiness as passed or set review acceptance.

Boundary 2: Server API to local agent.

- Agent authenticates with a scoped token.
- Agent receives jobs by `workspaceId` and resolves the local path itself.
- API must not trust agent logs as proof of success without validation results.
- API must not treat execution success as independent acceptance.
- Lease token and attempt must match before the server accepts progress, logs, artifacts, validation, or terminal states.
- API may authorize network only through typed destinations; unallowlisted external network writes are denied.

Boundary 3: Local agent to Codex/workspace.

- Codex works inside allowed paths.
- Job spec constrains file access through allowed paths, allowed capabilities, allowed actions, and forbidden actions.
- Raw user text is never executed as shell.
- Server-supplied absolute paths and server-supplied shell commands are not trusted.
- Repository scripts and generated code are untrusted and run only inside sandbox limits.

Boundary 4: Platform to WordPress.

- Publishing requires approval.
- WordPress credentials are stored server-side or in protected agent storage.
- Staging actions use staging targets and production actions use production targets from protected configuration.
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
13. Server accepts execution success only after required validation passes and input versions still match.
14. Independent reviewer, or configured CI when available, checks the diff, outputs, tests, and risks.
15. User reviews previews and approves irreversible actions if needed.
16. WordPress publication jobs run only after readiness, approval, and independent acceptance.

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
