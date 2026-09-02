# Project Workflow Rules

## Product Intent

- B2B Site Studio helps a user create one WordPress site or a network of SEO sites for wholesale businesses with minimal manual actions.
- The first MVP target is a wholesale catalog scenario with categories, products, product variations, regional pages, SEO metadata, forms, and WordPress publication.
- The current web interface is only the operator/control-plane surface. Do not treat dashboard mock data as company facts or production analytics.
- The product source of truth for generated sites is a structured SiteSpec. AI-generated work must read from SiteSpec, job specs, and approved user input, not from ad hoc chat text.
- SiteSpec must support incomplete `draft` state without fake phone, email, address, regions, sites, products, variants, domain, selected design, or verified facts.
- `generation_ready` and `publish_ready` are explicit document stages with separate readiness checks. Do not use placeholder values to satisfy readiness.
- Catalog data has one canonical source of truth: `catalog.categories` stores category hierarchy and product ID references, while `catalog.products` stores product and variant records. Do not embed product arrays inside categories.

## MVP Boundaries

- For MVP, focus on project/SiteSpec storage, a controlled job queue, a local Windows Codex agent, design-reference prototypes, catalog import, SEO/page planning, and WordPress publication flow.
- Do not add CRM, ERP, multi-tenant billing, advanced analytics, or external image-generation dependency until the MVP path is stable.
- Real WordPress sites are required for publication milestones. Static visual imitation of WordPress is not a valid production output.

## Repository Workflow

- Write and edit the project code locally in this workspace.
- Keep the full project synchronized with GitHub.
- Use a private GitHub repository unless the user explicitly asks otherwise.
- Work through a separate feature branch for every non-trivial task. Do not commit directly to `main` unless the user explicitly requests it.
- Before committing, check `git status`, review the changed files, run required validation for the touched area, and make sure unrelated user changes are not overwritten.
- Contract changes must pass the committed validation gate: `npm ci`, `npm run contracts:validate`, `npm run test:contracts`, `npm run lint`, `npm run build`, and `npm run ci`.
- Database, migration, persistence, or API changes must additionally pass `npm run db:migrate`, `npm run db:status`, `npm run test:persistence`, `npm run test:persistence:http`, and `npm run ci:full` against an explicitly local/test PostgreSQL database.
- Every implementation pull request to `main` requires a successful GitHub Actions CI run for the current PR head SHA or the current GitHub-generated merge commit. A successful run from an older commit does not count, and every new commit requires a new CI run.
- Missing CI and `cancelled`, `skipped`, `neutral`, or `failed` checks block `accepted` and merge. A local Codex report or local command output never replaces GitHub Actions evidence.
- A documentation-only pull request may receive an explicit, recorded CI exception only from the independent reviewer. No implicit exception is allowed.
- Merge is forbidden until current CI is green and the independent review result is `accepted`. CI must not deploy, publish, change DNS, change repository visibility, or require production secrets.
- Include `git diff --stat` in the final report for implementation tasks.

## Deployment Rules

- Deploy and run the production build on the Timeweb server.
- Run the server deployment in a dedicated Docker container.
- Configure autodeploy so a push to GitHub can update the Timeweb server without manually copying files.
- Do not run a production deploy, publish to WordPress, change DNS, delete remote data, rotate secrets, or change repository visibility without explicit user confirmation for that action.

## Database Migration Safety

- Store schema changes as ordered, immutable SQL migration files. Never edit an applied migration; add a new migration instead.
- Apply migrations through the committed runner with advisory locking, per-migration transactions, and checksum verification.
- Never log `DATABASE_URL`, credentials, or secret-bearing connection errors.
- `db:test:reset` is destructive and may run only against an explicitly named local test database. It must reject remote and production-like URLs.
- Do not automate rollback or destructive repair against production data. Prepare a reviewed forward migration or an explicitly approved recovery procedure.
- Canonical SiteSpec JSONB is the persistence source of truth. Derived readiness rows and metadata must not become a competing editable model.
- SiteSpec revision, readiness, and event rows are immutable/append-only. New edits create a new revision under optimistic locking.
- Keep every application query scoped to the active workspace and parameterize all user-controlled values.

## Security And Data Rules

- Prefer SSH keys over passwords for server access.
- Do not ask the user for root passwords when key-based access is already available.
- Never commit tokens, private keys, `.env` files, production credentials, personal data dumps, or secret-bearing logs.
- Do not invent company facts: addresses, certificates, reviews, delivery terms, legal names, stock, prices, guarantees, or contact data must be supplied, imported, or explicitly marked as assumptions.
- Company facts must be structured with key/value, status, provenance, optional verification date, and publication permission. AI must not promote `unknown` facts to `verified`.
- Prices, stock, and minimum order are commercial facts. They require structured provenance and may be published only when a trusted user/import/operator source explicitly allows publication; `system_inference` is never publishable for these fields.
- Required lead-form consent must include publishable verified consent text before a SiteSpec can be treated as `publish_ready`.
- Uploaded media and documents belong in artifact/asset storage and are referenced by `assetId` or `artifactId`; do not store binary payloads in SiteSpec.
- User-visible instructions, user chat text, and uploaded content must not be turned directly into shell commands. Convert work into structured job specs with allowlisted paths, typed inputs, and registered validation checks.
- Mask secrets in logs and reports. Keep logs and artifacts bounded in size.

## Local Agent Safety Rules

- Run Codex jobs only inside allowlisted folders and preferably in a dedicated branch or worktree.
- A local agent must accept jobs only from the configured API, use a token from an environment variable or protected local storage, and report heartbeat/lease status while running.
- Jobs use `workspaceId`; the local agent maps that ID to a local path from protected configuration. The server must not choose arbitrary absolute paths on the user's computer.
- Job paths must be normalized POSIX-relative paths or globs only. Reject Windows absolute paths, UNC/device paths, backslashes, colons, control/NUL bytes, `.`/`..` traversal, and any symlink/junction/reparse-point escape after realpath containment checks.
- Validation is deny-by-default through locally registered check IDs such as `file_exists`, `npm_lint`, `npm_build`, and `git_diff_check`; arbitrary shell, `powershell -Command`, `cmd /c`, `bash -c`, and `sh -c` are not valid job validation inputs.
- Treat repository code, generated code, npm scripts, and lifecycle scripts as untrusted. Run them only in a sandboxed low-privilege process with allowlisted environment variables, no production secrets, network disabled by default unless typed network destinations are explicitly allowlisted, and CPU/memory/time/filesystem limits.
- Missing `allowedCapabilities` or `allowedActions` entries mean the action is denied, even if it is not listed in `forbiddenActions`.
- Claimed jobs require a random lease token for start, heartbeat, logs, artifacts, validation, completion, failure, and cancellation acknowledgement.
- Irreversible actions in local-agent jobs require human/operator approval before execution. Agent auth and human/operator auth are separate; actor identity comes from authenticated principal, not request body fields. Self-approval is forbidden.
- A job waiting for approval must checkpoint, release its lease, and stop local execution. After approval, continuation is requeued with a new lease token or represented as a separate irreversible-action job.
- GitHub write actions must be explicit: `git_commit`, `git_push_feature_branch`, and `create_or_update_pull_request`. Push and PR updates require typed `github_git` and `github_api` network allowlist entries bound to the expected repository identifier, provider repository ID, remote origin, and `codex/` target branch. The agent must never force-push, never push to `main`, and never execute arbitrary hosts copied from user text.

## Final Reports

- For implementation tasks, report changed files, assumptions, validation results, architectural risks, `git diff --stat`, branch/commit information, and whether deployment or merge was intentionally skipped.

## Independent Review And Verification

- A Codex execution report and successful command output are not sufficient proof that a task is ready.
- Execution result is limited to `succeeded`, `failed`, or `cancelled`; independent acceptance result is separate and must be `accepted`, `changes_required`, or `blocked`.
- The executor must not accept its own work. Acceptance requires an independent reviewer that checks the factual diff, changed files, tests, architecture impact, migrations, configuration, security, and alignment with the source Issue or JobSpec.
- Review must independently confirm that forbidden or unrelated files were not changed, existing behavior was not lost, company facts were not invented, secrets were not exposed, and dangerous commands were not introduced.
- Required checks must be rerun locally. For implementation pull requests, GitHub Actions must independently rerun the required gate on the current PR head SHA or current merge commit; stale, absent, cancelled, skipped, neutral, or failed checks are not acceptable. UI work also needs key scenario checks, responsiveness, and console-error review; API/database work needs positive, negative, and boundary scenarios; deployment work needs staging, smoke tests, and rollback readiness.
- Merge to `main`, production deploy, WordPress publication, DNS changes, and other irreversible actions are forbidden until the review result is `accepted` and any required approval is recorded.
- If review returns `changes_required`, fixes stay in the same feature branch/PR and a full verification pass runs again.
- Final review output must include the acceptance result, what was checked, risks found, and confirmation of merge/deploy state.
