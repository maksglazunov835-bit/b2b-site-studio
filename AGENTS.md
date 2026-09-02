# Project Workflow Rules

## Product Intent

- B2B Site Studio helps a user create one WordPress site or a network of SEO sites for wholesale businesses with minimal manual actions.
- The first MVP target is a wholesale catalog scenario with categories, products, product variations, regional pages, SEO metadata, forms, and WordPress publication.
- The current web interface is only the operator/control-plane surface. Do not treat dashboard mock data as company facts or production analytics.
- The product source of truth for generated sites is a structured SiteSpec. AI-generated work must read from SiteSpec, job specs, and approved user input, not from ad hoc chat text.

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
- User-visible instructions, user chat text, and uploaded content must not be turned directly into shell commands. Convert work into structured job specs with allowlisted paths, typed inputs, and predefined validation commands.
- Mask secrets in logs and reports. Keep logs and artifacts bounded in size.

## Local Agent Safety Rules

- Run Codex jobs only inside allowlisted folders and preferably in a dedicated branch or worktree.
- A local agent must accept jobs only from the configured API, use a token from an environment variable or protected local storage, and report heartbeat/lease status while running.
- Irreversible actions in local-agent jobs require an approval state before execution.

## Final Reports

- For implementation tasks, report changed files, assumptions, validation results, architectural risks, `git diff --stat`, branch/commit information, and whether deployment or merge was intentionally skipped.
