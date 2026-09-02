# B2B Site Studio Product Requirements

## Purpose

B2B Site Studio is a control plane for creating one WordPress site or a network of SEO-oriented WordPress sites for wholesale businesses. The product must guide a user from a business brief to a generated, checked, publishable site without requiring the user to understand technical implementation details.

The first MVP scenario is a regional wholesale catalog for Russia: several categories, tens of products, product variations, region-specific landing pages, SEO metadata, forms, and a WordPress publication path.

## Primary Users

- Business owner or marketer: creates a project, uploads catalog data, chooses design direction, approves publication.
- Operator: reviews imported data, fixes mapping errors, checks generated artifacts, runs safe tasks through Codex.
- Local technical agent: executes bounded Codex jobs in an allowlisted workspace and returns logs, artifacts, and validation results.

## End-To-End User Journey

1. Create a project.
   - User enters company name, business type, target audience, geography, and fixed facts.
   - The app stores unknown or unverified details as missing data, not as AI-written facts.
   - User can save an incomplete draft, close the app, and continue later without entering fake phone, email, address, regions, products, variants, domains, or verified facts.
   - Draft SiteSpec validation is intentionally permissive; readiness gates decide when the same SiteSpec can move to `generation_ready` or `publish_ready`.

2. Choose site model.
   - Single site.
   - Network by regions.
   - Network by niches.
   - Separate domains or subdomains.

3. Define information inheritance.
   - User chooses what is shared across the network and what can be overridden per site or region.
   - Shared information can include brand, catalog, design tokens, core contacts, legal facts, and base delivery/payment terms.
   - Regional information can include phone, address, delivery conditions, region-specific offer, stock notes, SEO text, and indexed page eligibility.
   - Overrides replace only explicitly supplied fields. Missing override fields inherit shared values and must not erase them.

4. Import catalog data.
   - User uploads CSV or XLSX.
   - App maps columns to categories, products, variants, prices, stock, SKU, photos, minimum order quantity, and attributes.
   - App shows a preview and an error report before saving.
   - Invalid rows remain visible and must not silently disappear.
   - Imported files, product photos, variant photos, documents, logos, and design references are stored as assets/artifacts and referenced by IDs, checksums, content type, filename, and size. Binary data is not stored inside SiteSpec.

5. Build the page plan.
   - User chooses required pages.
   - App generates a sitemap plan for home, catalog, categories, products, regions, service pages, delivery, payment, contacts, FAQ, and legal pages.
   - App identifies pages that should not be indexed because they are empty, duplicate, thin, or missing regional facts.

6. Build the SEO plan.
   - App prioritizes Yandex while keeping Google-compatible technical SEO.
   - App plans URL, Title, Description, H1, canonical, robots, sitemap, breadcrumbs, schema.org markup, internal linking, duplicate control, and redirect needs.
   - Regional uniqueness must come from facts: regional delivery, contacts, assortment, stock, terms, and offers. Meaningless paraphrasing is not acceptable.

7. Upload references and choose design direction.
   - User uploads a design reference or describes a direction.
   - For MVP, the app can create 3-5 executable HTML/CSS design-reference prototypes with screenshots.
   - User chooses one design variant.
   - App stores design tokens and component rules for later generation.
   - External image-generation providers must remain replaceable adapters and are not required for MVP.

8. Generate work packages.
   - The server orchestrator splits large goals into small Codex jobs.
   - Every job contains dependencies, allowed paths, allowed capabilities, allowed actions, forbidden actions, acceptance criteria, expected output manifest, model profile, reasoning effort, and registered validation checks.
   - Every job is pinned to repository identifier, base ref, base commit SHA, SiteSpec revision, SiteSpec sha256, and input artifact checksums.
   - Codex jobs run in a separate branch or worktree.

9. Review previews and validation.
   - User sees progress, logs, errors, screenshots, generated files, and validation results.
   - Failed tasks can be retried idempotently.
   - Destructive or irreversible actions require explicit approval.

10. Publish to WordPress.
    - The product publishes real WordPress sites, not only static mockups.
    - Publication may target staging first.
    - Smoke tests must verify site availability, forms, important pages, sitemap, robots, and rollback readiness.

11. Maintain the network.
    - User can update catalog data, regenerate selected pages, run SEO audit, find broken links, add new regions, add new products, and roll back failed changes.

## Common And Regional Information

The system must separate shared facts from local overrides.

Common network data:

- brand name, logo, colors, typography, tone;
- verified company facts;
- base catalog and product attributes;
- shared photos and documents;
- default phone, email, messengers, legal details;
- default delivery and payment terms;
- base design tokens and component rules;
- global SEO rules and URL templates.

Regional or site-level overrides:

- local phone or tracking number;
- local address or pickup point;
- delivery cost, timing, and coverage;
- local offer, minimum order, and pricing policy;
- included/excluded categories or products;
- regional stock per product or variant;
- regional SEO title, description, H1, content blocks, canonical behavior;
- actual domain, subdomain, or directory path;
- indexability flag.

If a regional page has no real regional value, it should be generated as draft or noindex, not published as an indexed thin page.

## SiteSpec Stages

The product uses one draft-friendly SiteSpec schema with explicit document stages:

- `draft`: user can save partial work. Confirmed facts can be empty; contacts, regions, sites, catalog, categories, products, variants, selected design, and domain can be missing.
- `generation_ready`: enough structure exists to generate plans, prototypes, pages, or implementation tasks, but missing publish facts are allowed. This stage must pass generation readiness checks.
- `publish_ready`: all publish-critical facts, contacts, domains, WordPress target, approval requirements, selected design, rollback plan, and indexability decisions must pass publish readiness checks.

Generation readiness is not allowed to fabricate missing data. Publish readiness is stricter and blocks publication when contact, legal, domain, regional, SEO, or rollback facts are missing.

## Structured Facts And Provenance

Facts are not plain strings. Each fact stores:

- stable key;
- value, which can be `null` while unknown;
- status: `unknown`, `supplied`, `imported`, or `verified`;
- provenance: source type, source ID, asset ID when relevant, and notes;
- verification date when applicable;
- publication permission.

AI can use supplied/imported facts for draft generation only when the job allows it, but it cannot convert `unknown` to `verified`. Verification requires an explicit import, operator review, or other trusted process. `unknown` facts must remain unpublished.

## Catalog Requirements

The catalog must support:

- categories and subcategories;
- product cards;
- variants such as taste, packaging, strength, size, color, material, or SKU;
- product-level and variant-level photos by asset ID;
- price, old price, currency, stock state, minimum order quantity, and wholesale pack size;
- variant-specific SKU, price override, stock, minimum party, packaging, photos, and publication status;
- import source tracking;
- row-level validation errors;
- filters based on real attributes;
- category landing content and internal links.

## Page Requirements

The MVP page plan must support:

- home page;
- catalog index;
- category and subcategory pages;
- product pages;
- regional landing pages;
- delivery and payment pages;
- about page;
- contacts;
- FAQ;
- policy/legal pages when required;
- sitemap and robots outputs.

## SEO Requirements

SEO work must include:

- Yandex-first keyword and regional planning;
- Google-compatible metadata and technical structure;
- URL templates;
- Title, Description, H1, canonical, robots directives;
- XML sitemap;
- breadcrumbs;
- schema.org structured data;
- duplicate detection;
- internal linking rules;
- noindex rules for thin or duplicate regional pages;
- SEO audit after publication.

## Design Requirements

For MVP, design references are executable prototypes:

- 3-5 HTML/CSS variants;
- screenshot per variant;
- user selection of one variant;
- stored design tokens: colors, typography, spacing, radii, buttons, cards, forms, catalog components;
- component rules for generated WordPress theme/plugin work.

## Telegram And Lead Handling

Forms must:

- collect lead data;
- send a notification to Telegram;
- save the lead result in platform storage;
- preserve enough metadata to identify site, page, region, product, and source;
- avoid exposing Telegram tokens to generated frontend code.

## WordPress Requirements

WordPress publication must eventually include:

- real WordPress runtime;
- base theme or runtime plugin controlled by the platform;
- page, category, product, and region creation;
- SEO metadata writing;
- media upload;
- menu and internal link generation;
- staging, smoke tests, production publish, and rollback.

The WordPress site factory is a separate module after the control plane, job queue, local agent, and SiteSpec contract are stable.

## MVP Scope

Included in MVP:

- product architecture and contracts;
- SiteSpec schema and examples;
- server-side persistence design using PostgreSQL;
- job schema and local-agent API contract;
- MVP queue design with lease and heartbeat;
- local Windows agent safety contract;
- project and SiteSpec saving;
- catalog import flow design and later implementation;
- page and SEO planning;
- HTML/CSS design-reference prototypes;
- initial WordPress base theme/runtime plugin path;
- staging and smoke-test publication flow.

Excluded from first MVP:

- full CRM;
- ERP or warehouse synchronization beyond import;
- billing;
- multi-workspace administration before the first workflow is stable;
- external image-generation provider as a hard dependency;
- automatic DNS mutation without explicit approval;
- unbounded autonomous production changes.

## Success Criteria

- A user can create a project and store a valid SiteSpec.
- A user can save and resume an incomplete draft SiteSpec without fake required data.
- `generation_ready` and `publish_ready` are reached only through explicit readiness checks.
- Facts keep status, provenance, verification metadata, and publication permission.
- Uploaded files are represented by asset/artifact references with checksums and sizes, not embedded binary data.
- A catalog import can be previewed, mapped, validated, and saved.
- The system can split work into bounded Codex jobs.
- A local Windows agent can resolve `workspaceId`, claim with lease token, run, heartbeat, validate through registered checks, and return verified artifacts for safe jobs.
- The product can generate and compare design-reference prototypes.
- The publication path produces a real WordPress site on staging before production.
- The system prevents unapproved irreversible actions and avoids invented company facts.
