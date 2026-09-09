# MVP-04A Design Proposals

## Status and live-call boundary

The queue, isolated adapter protocol, validation, storage, and preview are implemented.
The official live call is **blocked**, not demonstrated: `CODEX_SAFE_PROFILE_UNVERIFIED`.
CI uses an explicitly labelled child-process `test_stub`. Its screenshots are not model output.
No real inference was performed while implementing this issue (zero model invocations).
Independent functional acceptance still needs a separately evidenced safe official smoke.

The follow-up [2026-09-09 diagnostic matrix](profile-diagnostics.md) records actual
read-only config/managed-requirement observations and the remaining exec-specific gap.
It also documents the process-tree and incremental JSONL repairs from review 5135047530.

On 2026-09-07 the installed native Windows client was checked without reading auth.json:

- `codex-cli 0.153.4`; Authenticode Valid, OpenAI OpCo, LLC.
- Executable SHA-256: `e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75`.
- `codex login status`: ChatGPT login, no identity or token retained.
- `codex debug models --bundled`: `gpt-5.6-luna`, `medium` is supported.
- `codex exec --help`, `codex features list`, bundled model metadata and official config schema were inspected.
- The catalog still advertises `apply_patch_tool_type: freeform`; the `apply_patch_freeform` toggle is removed.
  No effective empty-tool manifest or supported complete disabling profile was verified.
  Turning off shell/unified_exec and ignoring user configuration alone is insufficient evidence.

The official [non-interactive documentation](https://developers.openai.com/codex/noninteractive/),
[CLI reference](https://developers.openai.com/codex/cli/reference/),
[configuration reference](https://developers.openai.com/codex/config-reference/),
[configuration schema](https://developers.openai.com/codex/config-schema.json), and
[authentication documentation](https://developers.openai.com/codex/auth/) were cross-checked with installed help.
Managed policy is never bypassed. Do not remove the false safety gate merely to make a smoke pass.
No login change, installation, auth-file copy, API-key fallback, proxy, or model request was attempted.

## Local commands

Node >=22.13 and the existing local PostgreSQL setup are required. `.env` is loaded by
the platform/database launchers; the environment takes precedence. Never source it into Runner.
Use the separate dev and test URLs from `docs/persistence/README.md`; tests never fall back to dev.

```powershell
npm ci
npm run db:up
npm run db:migrate
npm run build
$env:PORT = '3000'
npm run start:local
```

The first migration command above is an explicit operator local setup command, not a test step.
Implementation verification used only the disposable TEST target; no dev migrations were run.
In another terminal, select the already installed native executable, without scanning the disk:

```powershell
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
npm run design:preflight -- --codex-bin "$codex"
npm run agent:design -- --origin http://127.0.0.1:3000 --name "Local design Runner" --codex-bin "$codex"
```

Create/save a brief with business type, site type and niche. Explicitly issue a new
`codex_design` pairing for this project and enter its one-time code at the hidden stdin prompt.
The actual installed client currently connects with execution disabled and the safety-block reason.
It cannot be made ready by changing a request body or enabling the CI fixture in the normal launcher.
Ctrl+C stops the foreground Runner; there is no service, scheduled task, or background installation.

For Linux/macOS the corresponding operator path is `$(command -v codex)`, passed to the same
`--codex-bin` option. This implementation does not claim a verified safe live profile on those platforms.
The fixed native argv builder is `agent/codex/adapter.mjs:execArguments`; no actual exec command was run.

```text
npm run db:test:up
npm run db:test:migrate
npm run db:test:status
npm run test:design:contracts
npm run test:design
npm run test:design:process
npm run test:design:ui
npm run ci:full
```

The protected test launcher verifies TEST_DATABASE_URL before importing tests or touching SQL.
`B2B_DESIGN_TEST_STUB=1` is set only by test fixtures. Registration also requires a validated
disposable TEST target matching pg's actual connection parameters. Public API default-deny remains
unchanged even with this test flag. Normal mode refuses test provider registration/claim/dispatch.
The fixed fixture entrypoint lives under tests, is never selectable from a job or normal Runner CLI,
and receives no PostgreSQL or other platform credentials.

## Contracts and storage

- `design-job.schema.json` is a separate full data envelope, version 1.4.0, not a partial legacy
  repository/Codex JobSpec. It has no repository IDs, paths, shell commands or fictitious commit SHAs.
- `design-proposal.schema.json` defines exactly three concepts, fixed page/block IDs, tokens,
  local font presets, hex colors and single-column mobile rules. Page composition follows site type.
- The pinned saved SiteSpec is independently checked by unchanged schema/semantics and SHA-256.
  Only the six mapped editable fields reach model stdin. The mapped brief has its own hash.
- Server checks byte/depth/node limits, strict fields, all bindings, three unique layouts/IDs,
  page requirements, contrast >=4.5 and bounded design-only text. It does not call a model again.
  Preview company content is fixed, labelled, neutral placeholder text, not business facts.
- `adapter-manifest.json` is generated from fixed shipped source files, normalized for CRLF/LF.
  Run `node scripts/contracts/design-manifest.mjs --write` after changing those files;
  the committed gate and Runner independently detect stale installations. Do not edit hashes manually.
- Migration 005 extends typed checks on existing jobs/grants and adds immutable
  `design_agent_profiles` and `design_invocations`. The latter consumes the one-call permission
  in the same transaction as the start/event/ack. No old rows or migrations are rewritten.
- Shared jobs/events/executions/attempts/results/operation receipts stay the only execution history.
  Existing `validator_sha256` also binds the design adapter digest for the new typed grant only.
- Existing endpoints are extended, not duplicated: POST agents/pairings and agents/register;
  GET agents; POST agents/:agentId/health, projects/:projectId/jobs and jobs/:jobId/dispatch;
  agent claim/start/heartbeat/result/fail/cancel-ack; job detail/list/events/execution and cancellation.
  Operator and agent principals remain separate.

## Costs, expiry and cancellation

The design policy is one attempt, one external invocation permission, one active slot,
10-second renewable leases and an immutable 180-second hard deadline. Data validation stays
at three attempts and 30 seconds. No automatic retry of Codex is permitted.

Start acknowledgement is a one-time permission, never replayed as another spawn permit.
If the claim/start reply is lost, the job expires to `INVOCATION_UNCERTAIN` without requeueing.
A crash, lease loss, malformed output or quota failure cannot silently spend another request.
Exact completed result/fail/cancel acknowledgements alone may replay read-only for five minutes,
with current credentials and identical scope/key/body hash. Runner bounds recovery to 45 seconds.
A new generation always requires a new explicit operator job and consent.

Cancellation aborts owned processes before acknowledging. POSIX uses an owned process group;
Windows uses a native Job Object supervisor: assign-before-resume, no breakaway,
kill-on-close and ActiveProcesses==0 confirmation, never PID discovery or a user shell.
The helper requires the installed .NET Framework C# compiler; no installation is performed.
Revoke causes immediate refusal at the next heartbeat and local process cleanup; because a revoked
credential cannot acknowledge, the server records `STOP_UNCONFIRMED` after lease expiry.
Local process termination cannot guarantee that an upstream provider did not charge the request.
The live Windows Codex descendant behavior has not been validated because inference is blocked.

## Evidence and remaining limits

Database tests cover 004->005 preservation, pinned revision, duplicate/concurrent requests,
scope, single budget, event rollback, expiry/crash uncertainty, cancellation and scoped receipts.
Process tests use a real separate Node Runner and a real built HTTP server, with actual CLI
child processes for JSONL, faults, cancellation and output bounds. No mocked fetch substitutes
for transport. UI covers consent, lost dispatch, double click, dirty preservation, reload,
three concepts/pages, mobile/desktop and no unexpected console errors.

CI retains all earlier gates and uploads six bounded `design-*-desktop/mobile.png` screenshots
alongside existing evidence and a dev-fingerprint summary. They contain only synthetic fixtures.
Schema success is not design-quality approval, factual verification, publish readiness or acceptance.
No generated sites, files, images, WordPress, publication, public API, repository operations or
production actions are enabled. The brief/model strings never become argv or shell text.

Known environment risk: npm ci reports 12 existing dependency vulnerabilities (1 low, 3 moderate,
8 high). No dependencies were added and no audit fix was run. Authentication/quota suitability
for a future public multi-user service is not established by a local ChatGPT login.
