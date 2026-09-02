# MVP Roadmap

## 1. Architecture And Contracts

Definition of done:

- Product requirements are documented.
- Control-plane architecture is documented.
- SiteSpec schema exists with a valid regional wholesale example.
- Local agent job schema exists with safe examples.
- Agent API contract documents lifecycle, lease, heartbeat, logs, artifacts, approvals, retry, and cancellation.
- JSON Schema and examples are locally validated.

## 2. PostgreSQL And Project/SiteSpec Persistence

Definition of done:

- PostgreSQL schema stores workspaces, projects, SiteSpec versions, sites, regions, and audit timestamps.
- API can create, update, fetch, and version SiteSpec.
- Invalid SiteSpec writes are rejected.
- Tests cover valid and invalid SiteSpec payloads.

## 3. Server Queue And Event Journal

Definition of done:

- Jobs can be created from server-side orchestration code.
- Queue states follow `draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`.
- Events and logs are stored with job attempt IDs.
- Lease expiration returns jobs to a safe retry path.

## 4. Server To Local Agent Test Loop

Definition of done:

- Local Windows agent registers and passes health check.
- Agent claims a safe sandbox job.
- Agent heartbeats while running.
- Agent uploads a small artifact and final report.
- Server displays job progress and result.

## 5. Safe Codex Execution And Profiles

Definition of done:

- Agent runs Codex only inside allowlisted workspaces.
- Every job uses a branch or worktree.
- Execution profiles `fast`, `standard`, `deep`, and `review` map through configuration.
- No business logic stores one hard-coded model name.
- User text cannot become a shell command.

## 6. Catalog Wizard And CSV/XLSX Import

Definition of done:

- User uploads CSV/XLSX.
- UI supports column mapping.
- Preview shows parsed categories, products, variants, prices, stock, photos, and minimum order.
- Error report identifies invalid rows and missing required fields.
- Valid import updates SiteSpec/catalog state.

## 7. Page Structure Generator

Definition of done:

- App generates a page plan from SiteSpec.
- Required pages and generated page types are visible to the user.
- Category, product, and region pages are planned separately.
- Empty or thin pages are marked draft/noindex.

## 8. SEO Plan And Technical Checks

Definition of done:

- SEO plan covers Yandex-first metadata and Google-compatible technical rules.
- URL, Title, Description, H1, canonical, robots, sitemap, breadcrumbs, schema.org, internal links, and duplicates are checked.
- Thin regional pages are blocked from indexing.
- SEO validation report is visible in the UI.

## 9. Design References And Variant Selection

Definition of done:

- System creates 3-5 executable HTML/CSS design-reference prototypes.
- Each prototype has a screenshot.
- User can choose one variant.
- Design tokens and component rules are saved to SiteSpec.
- External image-generation provider remains optional and replaceable.

## 10. WordPress Base Theme/Runtime Plugin And First Site

Definition of done:

- WordPress base theme or runtime plugin can render pages from structured data.
- First staging site includes home, catalog, category, product, contacts, delivery/payment, and FAQ pages.
- SEO metadata, sitemap, robots, breadcrumbs, and forms are present.
- Smoke tests pass on staging.

## 11. Regional Cloning With Inheritance And Overrides

Definition of done:

- Shared network data is inherited by default.
- Region/site overrides work for contacts, delivery, offers, content, SEO, and indexability.
- Pages without real regional facts are noindex or draft.
- Regional clone report shows what changed per region.

## 12. Telegram Forms

Definition of done:

- Forms save lead data in backend storage.
- Telegram notification works through server-side secret storage.
- Notification includes site, page, region, product/context, and source.
- Frontend does not expose Telegram tokens.

## 13. Publication, Staging, Smoke Tests, And Rollback

Definition of done:

- Publication requires approval.
- Staging publish runs before production.
- Smoke tests verify key pages, forms, robots, sitemap, canonical, and availability.
- Rollback package or previous revision is retained.
- Production publish is blocked on failed smoke tests.

## 14. Monitoring, SEO Audit, And Network Updates

Definition of done:

- App can check broken links, missing metadata, duplicate titles, sitemap health, and form health.
- Catalog updates can regenerate selected pages.
- New regions and products can be added without rebuilding the whole network manually.
- Audit results are stored and visible.

## 15. Second Workspace/User After MVP Stabilization

Definition of done:

- Permission model is defined after the single-workspace flow is stable.
- Second workspace can isolate projects, agents, SiteSpecs, jobs, and artifacts.
- User roles are minimal and tested.
- Existing MVP workflows continue to pass after workspace isolation is added.
