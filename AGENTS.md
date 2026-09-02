# Project Workflow Rules

## Product Intent

- B2B Site Studio helps a user create one WordPress site or a network of SEO sites for wholesale businesses with minimal manual actions.
- The first MVP target is a wholesale catalog scenario with categories, products, product variations, regional pages, SEO metadata, forms, and WordPress publication.
- The current web interface is only the operator/control-plane surface. Do not treat dashboard mock data as company facts or production analytics.
- The product source of truth for generated sites is a structured SiteSpec. AI-generated work must read from SiteSpec, job specs, and approved user input, not from ad hoc chat text.
- SiteSpec must support incomplete `draft` state without fake phone, email, address, regions, sites, products, variants, domain, selected design, or verified facts.
- `generation_ready` and `publish_ready` are explicit document stages with separate readiness checks. Do not use placeholder values to satisfy readiness.

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
- Include `git diff --stat` in the final report for implementation tasks.

## Deployment Rules

- Deploy and run the production build on the Timeweb server.
- Run the server deployment in a dedicated Docker container.
- Configure autodeploy so a push to GitHub can update the Timeweb server without manually copying files.
- Do not run a production deploy, publish to WordPress, change DNS, delete remote data, rotate secrets, or change repository visibility without explicit user confirmation for that action.

## Security And Data Rules

- Prefer SSH keys over passwords for server access.
- Do not ask the user for root passwords when key-based access is already available.
- Never commit tokens, private keys, `.env` files, production credentials, personal data dumps, or secret-bearing logs.
- Do not invent company facts: addresses, certificates, reviews, delivery terms, legal names, stock, prices, guarantees, or contact data must be supplied, imported, or explicitly marked as assumptions.
- Company facts must be structured with key/value, status, provenance, optional verification date, and publication permission. AI must not promote `unknown` facts to `verified`.
- Uploaded media and documents belong in artifact/asset storage and are referenced by `assetId` or `artifactId`; do not store binary payloads in SiteSpec.
- User-visible instructions, user chat text, and uploaded content must not be turned directly into shell commands. Convert work into structured job specs with allowlisted paths, typed inputs, and registered validation checks.
- Mask secrets in logs and reports. Keep logs and artifacts bounded in size.

## Local Agent Safety Rules

- Run Codex jobs only inside allowlisted folders and preferably in a dedicated branch or worktree.
- A local agent must accept jobs only from the configured API, use a token from an environment variable or protected local storage, and report heartbeat/lease status while running.
- Jobs use `workspaceId`; the local agent maps that ID to a local path from protected configuration. The server must not choose arbitrary absolute paths on the user's computer.
- Validation is deny-by-default through locally registered check IDs such as `file_exists`, `npm_lint`, `npm_build`, and `git_diff_check`; arbitrary shell, `powershell -Command`, `cmd /c`, `bash -c`, and `sh -c` are not valid job validation inputs.
- Missing `allowedCapabilities` or `allowedActions` entries mean the action is denied, even if it is not listed in `forbiddenActions`.
- Claimed jobs require a random lease token for start, heartbeat, logs, artifacts, validation, completion, failure, and cancellation acknowledgement.
- Irreversible actions in local-agent jobs require an approval state before execution.

## Final Reports

- For implementation tasks, report changed files, assumptions, validation results, architectural risks, `git diff --stat`, branch/commit information, and whether deployment or merge was intentionally skipped.
