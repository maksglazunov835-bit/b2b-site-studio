# Contract Validation

The SiteSpec and local-agent JobSpec schemas keep their executable fixtures in the schema files:

- `examples` are positive JSON Schema fixtures and positive semantic fixtures.
- `x-semanticPositiveExamples` are named JSON Schema-positive and semantic-positive fixtures for focused cross-field behavior.
- `x-negativeExamples` are JSON Schema-negative fixtures.
- `x-semanticNegativeExamples` are JSON Schema-valid fixtures that must fail semantic validation with a stable `expectedCode`.

The validator is committed under `scripts/contracts` and runs without network access, secrets, shell execution, or dynamic package discovery. It uses explicit dev dependencies only: `ajv` and `ajv-formats`.

## Commands

```bash
npm run contracts:validate
npm run test:contracts
npm run ci
```

`contracts:validate` compiles both Draft 2020-12 schemas and checks every positive and negative JSON Schema fixture. Each schema-negative fixture must include stable `expectedError` metadata.

`test:contracts` first confirms every semantic fixture is JSON Schema-valid, then checks that positive fixtures pass and negative fixtures fail with their declared stable semantic code.

Concrete output and validation paths are matched against `allowedPaths` by the committed validator. Matching supports POSIX `*` and `**` without invoking a shell or the operating system's glob implementation. Concrete paths still reject glob tokens, absolute paths, traversal, backslashes, colons, control bytes, and paths outside the allowlist.

Telegram routing resolves in this order: exact `siteId` + `regionId`, site-level `siteId` + `regionId: null`, then project-level `siteId: null` + `regionId: null`. Region-only routes are invalid. An approved form may provide `scope`; when scope is omitted, every declared site is a site-level context. A project-scoped form uses only project-level fallback.

## Stable Semantic Codes

SiteSpec semantic codes:

- `DUPLICATE_ID`
- `MISSING_CATEGORY_PARENT`
- `CATEGORY_PATH_MISMATCH`
- `CATEGORY_CYCLE`
- `MISSING_REGION_REFERENCE`
- `MISSING_CATEGORY_REFERENCE`
- `MISSING_PRODUCT_REFERENCE`
- `MISSING_VARIANT_REFERENCE`
- `VARIANT_PRODUCT_MISMATCH`
- `MISSING_ASSET_REFERENCE`
- `MISSING_DESIGN_VARIANT`
- `INVALID_DESIGN_SELECTION`
- `TELEGRAM_DESTINATION_INVALID`
- `TELEGRAM_ROUTE_INVALID`
- `MISSING_TELEGRAM_ROUTE`
- `WORDPRESS_TARGET_MISMATCH`
- `TARGET_ENVIRONMENT_MISMATCH`
- `READINESS_OWNER_INVALID`
- `READINESS_REQUIRED_CHECK_FAILED`
- `VARIANT_COMMERCIAL_NOT_PUBLISHABLE`
- `COMMERCIAL_PROVENANCE_INVALID`
- `REGULATED_REVIEW_GATE_MISSING`

JobSpec semantic codes:

- `ACTION_CAPABILITY_MISMATCH`
- `GITHUB_PUSH_BINDING_MISMATCH`
- `GITHUB_PR_BINDING_MISMATCH`
- `ARTIFACT_DESTINATION_MISSING`
- `WORDPRESS_DESTINATION_MISMATCH`
- `INVALID_GIT_REF`
- `GIT_WORKFLOW_RETURNS_MISMATCH`
- `NETWORK_ALLOWLIST_MISMATCH`
- `NETWORK_OPERATION_MISMATCH`
- `UNALLOWLISTED_NETWORK_DESTINATION`
- `REPOSITORY_BINDING_MISMATCH`
- `FORBIDDEN_ACTION_CONFLICT`
- `VALIDATION_CHECK_INVALID`
- `OUTPUT_PATH_NOT_ALLOWED`
- `VALIDATION_PATH_NOT_ALLOWED`
