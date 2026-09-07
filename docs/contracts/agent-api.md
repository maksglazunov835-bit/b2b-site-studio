# Local Agent API Contract

## Purpose

This contract describes how the B2B Site Studio server communicates with a local Windows agent that runs bounded Codex jobs. The API is versioned, lease-based, deny-by-default, and designed for reproducible execution, independently reviewable results, artifact verification, cancellation, and approvals.

The server never sends arbitrary shell text. The local agent resolves `workspaceId` to a local path from protected local configuration and executes only registered validation checks with typed parameters.

Network is disabled by default. When a job needs an external side effect, the JobSpec must include a typed `sandbox.networkAllowlist` entry for the exact purpose: `github_git`, `github_api`, `artifact_upload`, `wordpress_staging`, or `wordpress_production`. The agent must not derive arbitrary hosts from user text.

## Protocol Versions

The first supported API namespace is `/api/v1`.

Versioned inputs:

- Agent API version: `v1`.
- JobSpec version: `1.2.0`.
- Implemented data-only JobSpec: `1.3.0` / `data_validation` (separate schema, no fallback).
- SiteSpec schema version: `1.2.0`.
- Validation registry version: date-based registry ID, for example `2026-09-02`.

The agent reports supported versions during registration and claim. The server only returns jobs when all of these are compatible. If any version is unsupported, the server returns `409 incompatible_protocol_version` or `409 incompatible_schema_version`.

## Authentication

### Implemented Presence-Only Profile (MVP-03B)

The following **local presence** subset remains unchanged and is the default. MVP-03C adds the explicitly scoped data-only profile below; the later repository/Codex examples still describe future capabilities, not available routes. Neither profile relaxes schema 1.2 or its semantic checks.

The platform and Runner must be on the same trusted computer. All routes first pass the existing explicit-local, actual-loopback-listener gate. An ordinary public launch rejects even valid credentials. Host/forwarded headers never grant local access. This is not production authentication or protection from malicious processes in the same OS user session.

| Method | `/api/v1` path | Authority / purpose |
| --- | --- | --- |
| POST | `/agents/pairings` | Trusted local operator, empty JSON object; issue a 5-minute single-use pairing secret. |
| GET | `/agents/pairings/{pairingId}` | Local operator; safe status/expiry, never the secret. |
| POST | `/agents/pairings/{pairingId}/cancel` | Local operator, empty object; revoke an unused permission, repeated cancellation is a no-op. |
| GET | `/agents` | Local operator; bounded list with `limit` (default 20, max 100) and workspace-bound keyset `cursor`. |
| GET | `/agents/{agentId}` | Local operator; server-derived presence and nonsecret metadata. |
| POST | `/agents/{agentId}/revoke` | Local operator, empty object; irrevocable credential revocation, repeated revoke is a no-op. |
| POST | `/agents/register` | Pairing bearer plus Idempotency-Key; consume the permission and bind a separate Runner credential. |
| POST | `/agents/{agentId}/health` | Separate agent bearer; record a presence signal, not a job lease heartbeat. |

Current operator requests deliberately have **no Authorization bearer**: the existing trusted-local UI is not yet an authenticated human session. The operator wrapper rejects Authorization/Proxy-Authorization on both new operator routes and existing persistence/jobs routes, rather than treating agent tokens as operator authority. A malicious local process can omit headers; full human authentication/RBAC remains future work and this restriction must not be represented as such.

Pairing and agent secrets are independently generated from 32 random bytes, represented as purpose-prefixed base64url tokens (`pair_` / `agt_`). The browser holds the pairing secret only in transient component state and displays it once; close/expiry/consumption removes it. No secret is put in a URL, browser storage, DB JSON, journal or idempotency response. PostgreSQL stores only SHA-256 fingerprints. A lost pairing-issuance response cannot recover its plaintext: the operator explicitly issues another permission, with at most ten live unused permissions per workspace.

The foreground Runner receives the pairing secret through hidden stdin, generates its own agent secret in process memory, and sends the following strict registration fields (no paths, env, workspace, actor, logs or capability grants):

```text
mode: presence_only
agentName: 1..64 ASCII letters/digits/spaces/dot/underscore/hyphen, nonblank
agentVersion: bounded numeric semantic version
os: windows | linux | macos
supportedApiVersions: bounded unique array of protocol IDs including v1
agentSecret: independently generated secret, sent only in this registration body
```

Registration locks the workspace-scoped pairing row, checks server-clock expiry/revocation, creates one agent, consumes the permission and appends `registered` in one transaction. The pairing records hashed idempotency key and normalized request fingerprint (including the agent credential hash). Same pairing/key/payload/credential replays return the same nonsecret registration response only before pairing expiry and while the agent remains unrevoked. Another key or payload under a consumed pairing is rejected; no new credential is minted on replay. No raw registration body or secret response is persisted.

The 201 registration response contains `agentId`, `status: registered`, `mode: presence_only`, `selectedApiVersion: v1`, `heartbeatIntervalSeconds`, `executionEnabled: false`, `freeSlots: 0`, `currentJobId: null`, and `grantedCapabilities: []`. There is no executable lease or `maxLeaseSeconds`. A Runner validates the selected version and every response field before proceeding.

Health accepts only `{ "selectedApiVersion": "v1" }`. It validates exact workspace/agent ID, credential hash and revocation while holding the agent row lock, then updates last_seen using server time. Its 200 response contains the same non-execution profile, agentId/interval, `accepted: true` (receipt of presence only) and serverTime. Client-provided status/time/grants are rejected. Revocation takes the same lock and appends one event transactionally: a heartbeat linearized before revoke may succeed, but no later heartbeat can reactivate the device. Registration replay locks pairing then agent; health/revoke lock only agent, avoiding inverse lock order.

The server defaults to 20-second heartbeat intervals, configurable locally through `AGENT_HEARTBEAT_INTERVAL_SECONDS` within 1..30 seconds. A registered device starts offline until its first health signal. Online is derived from server time and last_seen younger than three intervals; at the boundary it is offline. Revoked always wins. There is no heartbeat-event stream, only bounded metadata events `paired`, `registered`, `pairing_revoked`, `agent_revoked` with empty payloads. No jobs or SiteSpecs change when a device connects.

The existing API envelope/no-store/body limit remains in force. Presence-specific machine-readable codes use the implemented persistence API's uppercase convention: `UNAUTHORIZED_AGENT`, `UNAUTHORIZED_OPERATOR`, `PAIRING_NOT_FOUND`, `PAIRING_EXPIRED`, `PAIRING_REVOKED`, `PAIRING_CONSUMED`, `PAIRING_LIMIT_REACHED`, `AGENT_NOT_FOUND`, `AGENT_REVOKED`, `INCOMPATIBLE_PROTOCOL_VERSION`, and `INVALID_PRESENCE_CONFIG`, plus existing validation/access/database/cursor codes. Incorrect credential/ID/workspace combinations receive a generic unauthorized result; expiry/revocation reasons are returned only after identifying the matching permission/credential. No request Authorization/body is logged.

See [local Runner setup and limits](../agents/README.md). Restart requires a new explicit pairing: OS credential storage, unattended reconnect, remote Timeweb transport, public login, execution, claim and lease remain outside this profile.

### Implemented Data Validation Profile (MVP-03C)

The independent [complete 1.3 schema](job-data-validation.schema.json) permits only `site_spec_validation` / `data_validation`. It binds jobId, projectId, server workspaceId, template version, validator identity, immutable revision ID/number/schema version/SHA-256 and exact JSON snapshot, fixed policy and structured result version. Workspace is an identity, not a folder. No repository IDs, commit SHAs, paths, arbitrary URLs, commands, modules or file writes are present. Unknown version/profile/fields fail closed; snapshot validity is the task's output, not an envelope prerequisite.

Operator pairing accepts `{ "mode": "data_validation", "projectId": "<saved project UUID>" }`. The empty `{}` request remains presence-only. Migration 004 adds a separate immutable `agent_execution_grants` record; the old immutable `agents.mode` is not updated. Only a new credential can bind that grant, once, to one active project and one operation. Registration in data mode includes the installed `validator` identity and must match the permission. Old credentials cannot claim; registration replay remains bounded by pairing expiry and revocation.

`validator: { id: site_spec_builtin, version: 1.0.0, sha256 }` is backed by the committed normalized-LF source manifest of schema, generated schema validator, semantic module, canonicalization/bounds/report/contract code and runtime validator helpers. The server build embeds it; the opted-in Runner hashes its actual installed files before registration. CI checks freshness, rather than trusting a client-supplied version promise. After intentionally changing a listed source, run `node scripts/contracts/generate-execution-manifest.mjs` and rerun all gates. An old grant/assignment cannot silently switch to a different validator.

Canonical JSON preserves every own JSON key, including `__proto__`, `constructor` and `prototype`, at every object/array depth. Key ordering is deterministic; special keys are not removed or interpreted as setters. The 56 ordinary legacy contract fixture hashes are pinned to reviewed commit `a84465e014445b6145bc23786ea5db190cc8407f` in `tests/execution/canonical-legacy-hashes.json`. An old document whose recorded digest omitted a special key is incompatible: new queue creation refuses it with `SITE_SPEC_INTEGRITY_ERROR`, and materialization refuses an inconsistent pinned input with `INPUT_HASH_MISMATCH`. Existing assignments also pass validator/input/spec-hash checks before use. Never rehash or rewrite historical revisions/jobs to hide this inconsistency. Operator review and a new explicitly saved valid revision/request are required; old history remains unchanged. The updated manifest intentionally requires new compatible grants/pairing; it does not upgrade existing grants.

| Method | `/api/v1` path | Authority and strict DTO |
| --- | --- | --- |
| POST | `/projects/{projectId}/jobs/{jobId}/dispatch` | Operator, `{agentId,expectedVersion}`, Idempotency-Key. Materialize only this request's pinned revision and assign only this device; never scan/start backlog. |
| GET | `/projects/{projectId}/jobs/{jobId}/execution` | Operator; nonsecret assignment identity, at most three attempts, bounded report/digest, `acceptanceResult:null`. |
| POST | `/agents/{agentId}/claim` | Scoped agent bearer, `{}`, Idempotency-Key. One assigned job/slot, full JobSpec/hash and transient random lease; otherwise bounded no-work response. |
| POST | `/agents/{agentId}/jobs/{jobId}/start` | Scoped bearer, `{attempt,leaseToken}`, Idempotency-Key. |
| POST | `/agents/{agentId}/jobs/{jobId}/heartbeat` | Scoped bearer, `{attempt,leaseToken,phase:"validating"}`. Separate from presence. |
| POST | `/agents/{agentId}/jobs/{jobId}/result` | Scoped bearer, `{attempt,leaseToken,report,resultDigest}`, Idempotency-Key. |
| POST | `/agents/{agentId}/jobs/{jobId}/fail` | Scoped bearer, `{attempt,leaseToken,code}`, Idempotency-Key; fixed failure-code enum only. |
| POST | `/agents/{agentId}/jobs/{jobId}/cancel-ack` | Scoped bearer, `{attempt,leaseToken}`, Idempotency-Key; only after real local stop. |

All eight routes retain the actual loopback/default-deny/no-store boundary, including a built production bundle. Agent and pairing bearers never authorize operator APIs. Every action locks the agent and current job/attempt, checking grant, workspace/project/device, active project, current validator, lease hash, latest attempt and server time. Assignment/event/idempotency and completion/result/event/ack each commit atomically. Claim serializes one slot; row locks and unique active-attempt indexes prevent concurrent assignment.

The lease contains 32 random bytes and exists in plaintext only in its claim reply and Runner memory. DB rows hold only a hash; claim has no saved plaintext replay. A repeated consumed claim key returns `CLAIM_REPLY_UNAVAILABLE`; the Runner waits for expiry, then a new claim can create attempt 2 or 3. No work starts before start acknowledgement. Start/result/fail/cancel-ack reuse identical payload/key on transport loss; same-key changed payload conflicts. All new writes and start replay require an unexpired lease and hard deadline. An expired unfinished attempt gains no write authority from a retry.

**Read-only terminal acknowledgement recovery.** The same result/fail/cancel-ack POST may replay an already committed immutable `execution_operations.response`, with the existing transport-only `replayed:true` marker, after lease/deadline expiry. Its window is server time `[attempt.finished_at, attempt.finished_at + 300000 ms)`, never extended by reads. It requires a currently valid unrevoked agent credential, active project and compatible project grant, exact workspace/project/job/device/latest-attempt/lease-token binding, matching terminal job/attempt state, operation kind, exact key hash and canonical full request hash (including result digest/body; lease plaintext is hashed before hashing the request). It performs no INSERT/UPDATE, sweep, revalidation, state transition or lease renewal. Missing receipt returns `TERMINAL_ACK_NOT_FOUND`, changed payload `IDEMPOTENCY_CONFLICT`, closed window `TERMINAL_ACK_EXPIRED`; revoked or foreign credentials/scope remain denied. Revoke shares the agent row lock, so no replay linearized after revoke succeeds. There is no public or operator bypass, new endpoint, historical repair or saved plaintext token.

Only after an uncertain terminal response does the Runner use this recovery path beyond its write lease, retaining the exact tuple in memory. At most ten total terminal requests fit within a 45-second client budget, each bounded by five seconds and remaining budget. This is shorter than the five-minute server receipt window. A recovered response must acknowledge the requested terminal state. If recovery cannot be confirmed, the Runner exits with `TERMINAL_ACK_UNCONFIRMED` (or the credential rejection); it does not invent success/failure, send a different terminal operation, or claim again. Operator result/history remains available after receipt expiry. Process restart loses the memory credential/token and cannot resume receipt recovery automatically.

Lease is 10 seconds, hard attempt deadline 30 seconds, maximum three attempts, one slot. Job heartbeat is every two seconds while checking; presence cannot extend it. Claim and operator job reads run a workspace/project-scoped sweep of at most 25 expired attempts in a transaction. Expiry fences the old attempt and requeues this side-effect-free type only; exhaustion fails. Cancel of an active job becomes `cancel_requested`, not cancelled. Runner aborts/joins its fixed worker before cancel-ack. Revoke forbids even acknowledgement; absent a prior valid ack, expiry produces `failed` / `STOP_UNCONFIRMED`. This is not exactly-once external execution and is not a policy for future deployment jobs.

Byte caps before transport parsing: snapshot 64 KiB, claim envelope 80 KiB, report 16 KiB, report POST including metadata/token 17 KiB; other execution requests 2 KiB. Iterative JSON depth 32 / 6000-node guards precede recursive schema/semantic work. Report includes report version, job/attempt, input revision/hash, JobSpec hash, validator identity, valid/invalid status, schema/semantic counts, at most 100 keyword/code/path details and truncation flag. Paths are limited and scrubbed; no source values, messages, raw stdout or whole brief are returned. HTTP size/JSON errors are sanitized `JSON_BYTES_LIMIT` (413), `INVALID_JSON_VALUE` (400); semantic/shape bounds use 422.

The only executor is a fixed bundled worker-thread module, 128 MiB old-generation / 16 MiB young-generation memory limits and a cancellable deadline. It imports its own checked validator implementation, never user code or paths, and never reads/writes website files. This is not a sandbox for arbitrary code. Server result handling independently reproduces the deterministic bounded report against the same pinned snapshot and compares its canonical digest, rejecting `REPORT_MISMATCH`. A successful validation task may report `validationStatus:invalid`; neither result changes SiteSpec/readiness/company facts or grants independent acceptance.

Stable execution codes include `EXECUTION_NOT_GRANTED`, `EXECUTION_SCOPE_MISMATCH`, `VALIDATOR_MISMATCH`, `ALREADY_DISPATCHED`, `UNSUPPORTED_EXECUTION_PROFILE`, `INVALID_EXECUTION_SPEC`, `INPUT_HASH_MISMATCH`, `SNAPSHOT_BINDING_MISMATCH`, `JSON_COMPLEXITY_LIMIT`, `CLAIM_REPLY_UNAVAILABLE`, `STALE_ATTEMPT`, `LEASE_EXPIRED`, `ATTEMPT_FINISHED`, `ATTEMPTS_EXHAUSTED`, `CANCEL_REQUESTED`, `REPORT_MISMATCH`, plus existing project/auth/version/idempotency errors. Stored failure reasons are an enum, never arbitrary exception text.

### Future Repository/Codex Executable Profile

Agent endpoints and human/operator endpoints use separate authentication.

Agent endpoints:

```http
Authorization: Bearer <agent-token>
Content-Type: application/json
Idempotency-Key: <operation-key>
```

Human/operator endpoints:

```http
Authorization: Bearer <human-session-or-operator-token>
Content-Type: application/json
Idempotency-Key: <operation-key>
```

Rules:

- Agent tokens are scoped to workspaces, revocable, and never authorize human approvals.
- Operator identity is derived from the authenticated human principal and RBAC session, not from request body fields.
- Bodies must not contain trusted `decidedBy`, `requestedBy`, or equivalent actor fields.
- Secrets are masked in logs and never embedded in generated frontend artifacts.

## Result Separation

Execution result is the local job terminal result:

- `succeeded`;
- `failed`;
- `cancelled`.

Independent acceptance result is the review decision:

- `accepted`;
- `changes_required`;
- `blocked`.

`succeeded` only means the executor finished and required execution checks passed. It is not proof that the task is ready to merge, deploy, or publish. Acceptance requires an independent reviewer checking the actual diff, changed files, tests, architecture, migration/configuration/security impact, and alignment with the source Issue or JobSpec. Implementation PRs additionally require current successful GitHub Actions CI; CI never replaces independent acceptance. The executor cannot accept its own work.

## State Lifecycle

Minimum lifecycle:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Cancellation lifecycle:

`running -> cancel_requested -> cancelled`

Review lifecycle:

`succeeded -> review_pending -> accepted | changes_required | blocked`

Merge, production deployment, WordPress publication, DNS changes, repository visibility changes, credential rotation, deletion, and other irreversible actions are forbidden until acceptance is `accepted` and the specific action has recorded human approval when required.

For ordinary in-scope PRs in this repository, the owner's 2026-09-06 standing permission is documented in [AGENTS.md](../../AGENTS.md#delegated-repository-merge). Only the independent reviewer/coordinator may perform guarded squash after exact head/base acceptance and current CI, then verify main push CI. This is not an agent capability, executor self-approval, auto-merge setting, or production permission. MVP-03A [queue requests](../jobs/README.md) do not implement the executable lifecycle/endpoints described below.

## Agent Registration

`POST /api/v1/agents/register`

Request:

```json
{
  "agentName": "max-windows-workstation",
  "agentVersion": "0.2.0",
  "os": "windows",
  "supportedApiVersions": ["v1"],
  "supportedJobSpecVersions": ["1.2.0"],
  "supportedSiteSpecVersions": ["1.2.0"],
  "capabilities": ["codex", "git", "node", "browser_screenshot", "artifact_upload"],
  "validationRegistryVersion": "2026-09-02",
  "workspaceIds": ["local-demo-workspace"]
}
```

Response:

```json
{
  "agentId": "agent_win_001",
  "status": "registered",
  "selectedApiVersion": "v1",
  "selectedJobSpecVersion": "1.2.0",
  "selectedSiteSpecVersion": "1.2.0",
  "heartbeatIntervalSeconds": 20,
  "maxLeaseSeconds": 300
}
```

The agent may report logical workspace IDs, but never sends its protected local path allowlist as an authorization source for the server.

## Agent Health Check

`POST /api/v1/agents/{agentId}/health`

Request:

```json
{
  "status": "online",
  "freeSlots": 1,
  "currentJobId": null,
  "agentVersion": "0.2.0",
  "selectedApiVersion": "v1",
  "supportedJobSpecVersions": ["1.2.0"],
  "validationRegistryVersion": "2026-09-02"
}
```

Response:

```json
{
  "accepted": true,
  "serverTime": "2026-09-02T12:30:00Z"
}
```

## Get Eligible Jobs

`GET /api/v1/agents/{agentId}/jobs?limit=5`

Response:

```json
{
  "jobs": [
    {
      "id": "job_design_reference_001",
      "jobSpecVersion": "1.2.0",
      "agentApiVersion": "v1",
      "type": "design_reference_prototype",
      "projectId": "demo-regional-wholesale-network",
      "workspaceId": "local-demo-workspace",
      "repository": "github:maksglazunov835-bit/b2b-site-studio",
      "baseRef": "main",
      "baseCommitSha": "2222222222222222222222222222222222222222",
      "siteSpecSchemaVersion": "1.2.0",
      "siteSpecRevision": 7,
      "siteSpecSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "modelProfile": "standard",
      "requiresApproval": false,
      "leaseSeconds": 300
    }
  ]
}
```

## Claim Job And Lease

`POST /api/v1/jobs/{jobId}/claim`

Request:

```json
{
  "agentId": "agent_win_001",
  "expectedState": "queued",
  "leaseSeconds": 300,
  "supportedApiVersions": ["v1"],
  "supportedJobSpecVersions": ["1.2.0"],
  "supportedSiteSpecVersions": ["1.2.0"],
  "supportedValidationRegistryVersion": "2026-09-02"
}
```

Response:

```json
{
  "job": {
    "id": "job_design_reference_001",
    "state": "claimed",
    "attempt": 1,
    "leaseToken": "opaque-random-lease-token",
    "leaseUntil": "2026-09-02T12:35:00Z",
    "spec": {
      "jobSpecVersion": "1.2.0",
      "agentApiVersion": "v1",
      "workspaceId": "local-demo-workspace",
      "repository": {
        "identifier": "github:maksglazunov835-bit/b2b-site-studio",
        "providerRepositoryId": "repo_123456789",
        "originUrl": "git@github.com:maksglazunov835-bit/b2b-site-studio.git"
      },
      "baseRef": "main",
      "baseCommitSha": "2222222222222222222222222222222222222222",
      "siteSpec": {
        "schemaVersion": "1.2.0",
        "revision": 7,
        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "sandbox": {
        "networkAccess": "allowlisted",
        "networkAllowlist": [
          {
            "purpose": "github_git",
            "host": "github.com",
            "binding": {
              "repositoryIdentifier": "github:maksglazunov835-bit/b2b-site-studio",
              "providerRepositoryId": "repo_123456789",
              "originUrl": "git@github.com:maksglazunov835-bit/b2b-site-studio.git",
              "targetBranch": "codex/job-design-reference-001"
            }
          },
          {
            "purpose": "github_api",
            "host": "api.github.com",
            "binding": {
              "repositoryIdentifier": "github:maksglazunov835-bit/b2b-site-studio",
              "providerRepositoryId": "repo_123456789",
              "originUrl": "git@github.com:maksglazunov835-bit/b2b-site-studio.git",
              "targetBranch": "codex/job-design-reference-001"
            }
          },
          {
            "purpose": "artifact_upload",
            "host": "artifact-storage.local",
            "binding": {
              "artifactTargetId": "artifact-store-demo"
            }
          }
        ]
      },
      "allowedCapabilities": ["codex", "git", "github_pr", "node", "file_write", "artifact_upload"],
      "allowedActions": ["create_branch", "write_files", "run_registered_validation", "create_artifact", "upload_artifact", "git_commit", "git_push_feature_branch", "create_or_update_pull_request"],
      "allowedPaths": ["design-prototypes/reference-001/**"]
    }
  }
}
```

Claim must be atomic. If another agent already owns a live lease, the server returns `409 job_already_claimed`.

## Start Running

`POST /api/v1/jobs/{jobId}/start`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "branchName": "codex/job-design-reference-001",
  "resolvedWorkspaceId": "local-demo-workspace"
}
```

Response:

```json
{
  "accepted": true,
  "state": "running"
}
```

Before starting, the agent verifies:

- workspace ID exists in protected local config;
- resolved path is inside the local allowlist;
- every requested path is normalized POSIX-relative before resolution;
- after resolution, realpath remains inside the workspace;
- symlink, junction, or reparse-point traversal cannot escape the workspace;
- repository identifier and origin match the expected checkout;
- base ref resolves to the expected base commit SHA;
- any GitHub, artifact, or WordPress network destination is present in `sandbox.networkAllowlist` and bound to the expected repository, target branch, artifact target, or WordPress target;
- SiteSpec `schemaVersion`, `revision`, and sha256 match the job input.

## Heartbeat

`POST /api/v1/jobs/{jobId}/heartbeat`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "progressPercent": 45,
  "message": "Prototype files created; preparing registered validation checks."
}
```

Response:

```json
{
  "accepted": true,
  "state": "running",
  "leaseUntil": "2026-09-02T12:36:00Z",
  "cancelRequested": false,
  "approval": null
}
```

Heartbeat is accepted only from the current lease owner, attempt, and lease token.

## Events And Logs

`POST /api/v1/jobs/{jobId}/events`

`POST /api/v1/jobs/{jobId}/logs`

Both endpoints require `agentId`, `attempt`, and `leaseToken`. Server and agent mask secrets before logs are stored or displayed. Long logs are truncated and may be attached as bounded artifacts.

Event timestamps use `date-time`, for example `2026-09-02T12:32:00Z`.

## Artifact Upload Lifecycle

### Create Artifact Upload

`POST /api/v1/jobs/{jobId}/artifacts`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "kind": "screenshot",
  "path": "design-prototypes/reference-001/screenshot.png",
  "contentType": "image/png",
  "expectedSizeBytes": 204800,
  "expectedSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}
```

Response:

```json
{
  "artifactId": "artifact_001",
  "uploadUrl": "https://artifact-storage.local/upload/artifact_001",
  "expiresInSeconds": 300,
  "maxSizeBytes": 4194304
}
```

### Complete Artifact Upload

`POST /api/v1/jobs/{jobId}/artifacts/{artifactId}/complete`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "sizeBytes": 204800,
  "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}
```

Response:

```json
{
  "accepted": true,
  "artifactId": "artifact_001",
  "verified": true
}
```

The server verifies path, content type, size, sha256, expected output manifest, job attempt, and current lease before accepting the artifact.

## Validation Lifecycle

`POST /api/v1/jobs/{jobId}/validation/start`

`POST /api/v1/jobs/{jobId}/validation/results`

Validation start is the explicit `running -> validating` transition. Validation checks are registry IDs, not command text. Every result is bound to the active `leaseToken`.

Example result:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "results": [
    {
      "id": "static_html_exists",
      "status": "passed",
      "required": true,
      "message": "HTML and CSS files exist inside allowed path.",
      "artifactIds": []
    }
  ]
}
```

`succeeded` is allowed only after all required execution checks pass and artifacts are verified.

## Approval Lifecycle

### Create Approval Request

`POST /api/v1/jobs/{jobId}/approval-requests`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "action": "wordpress_publish",
  "exactTarget": "wordpress-target-demo",
  "environment": "staging",
  "siteSpecSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "inputArtifactSha256": ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
  "previewArtifactIds": ["artifact_staging_report_001"],
  "reason": "The staging smoke test passed and WordPress publication is the next step."
}
```

Response:

```json
{
  "approvalId": "approval_001",
  "state": "awaiting_approval",
  "boundTo": {
    "jobId": "job_wordpress_publish_001",
    "attempt": 1,
    "exactAction": "wordpress_publish",
    "exactTarget": "wordpress-target-demo",
    "environment": "staging",
    "siteSpecSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "inputArtifactSha256": ["cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
    "previewArtifactIds": ["artifact_staging_report_001"],
    "expiresAt": "2026-09-03T12:00:00Z"
  }
}
```

When a job enters `awaiting_approval`, the agent must write a checkpoint, upload required preview artifacts, release the lease, and stop local execution. It must not keep a process alive while waiting for a human decision.

### Human Approves Or Rejects

`POST /api/v1/operator/approval-requests/{approvalId}/decision`

Request:

```json
{
  "decision": "approved",
  "comment": "Approved for staging only."
}
```

Response:

```json
{
  "accepted": true,
  "approvalId": "approval_001",
  "decision": "approved",
  "decisionPrincipalId": "operator_001",
  "decidedAt": "2026-09-02T13:00:00Z"
}
```

The server derives `decisionPrincipalId` from human authentication. The decision is one-time, auditable, expiry-bound, and cannot be made by the same agent/executor that requested or would perform the irreversible action.

### Continue After Approval

After approval, the server either:

- requeues a continuation job that must be claimed with a new `leaseToken`; or
- creates a separate irreversible-action job with its own JobSpec, approval binding, attempt, and lease.

The old awaiting-approval lease cannot be resumed.

Rejection deterministically moves the job to `failed` with `approval_rejected`, or to a safe non-terminal state when the orchestrator has a defined alternate path.

## Complete Successfully

`POST /api/v1/jobs/{jobId}/complete`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "executionResult": "succeeded",
  "summary": "Prototype created, artifacts uploaded, and validation passed.",
  "changedFiles": [
    "design-prototypes/reference-001/index.html",
    "design-prototypes/reference-001/styles.css"
  ],
  "validationResultIds": ["validation_static_html_exists_001"],
  "artifactIds": ["artifact_001"],
  "outputManifest": [
    {
      "path": "design-prototypes/reference-001/index.html",
      "kind": "file",
      "sizeBytes": 24576,
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  ]
}
```

Response:

```json
{
  "accepted": true,
  "state": "succeeded",
  "reviewState": "review_pending"
}
```

The server rejects success when required validation has not passed, input versions changed, artifacts are unverified, or the lease token is stale.

## Independent Review Decision

`POST /api/v1/operator/jobs/{jobId}/review-decision`

Request:

```json
{
  "acceptanceResult": "changes_required",
  "checkedDiffSha": "reviewed-diff-sha",
  "checkedValidationResultIds": ["validation_static_html_exists_001"],
  "comment": "Schema examples pass, but approval binding is incomplete."
}
```

Response:

```json
{
  "accepted": true,
  "reviewId": "job_review_001",
  "acceptanceResult": "changes_required",
  "reviewerPrincipalId": "operator_002",
  "reviewedAt": "2026-09-02T14:00:00Z"
}
```

The reviewer principal comes from human/operator authentication. The executor cannot review or accept the same job. If the result is `changes_required`, fixes remain in the same feature branch or PR and a full verification pass runs again.

## Fail Job

`POST /api/v1/jobs/{jobId}/fail`

Request includes `agentId`, `attempt`, `leaseToken`, `errorCode`, `message`, and `retryable`. Failure is an execution result, not an acceptance result.

## Retry Job

`POST /api/v1/operator/jobs/{jobId}/retry`

Request:

```json
{
  "reason": "Validation failed after missing stylesheet.",
  "reuseInputs": true
}
```

Response:

```json
{
  "newAttempt": 2,
  "state": "queued"
}
```

Retries preserve previous attempts, logs, artifacts, validation results, and terminal reports. The operator actor is derived from human auth.

## Cancellation Lifecycle

`POST /api/v1/operator/jobs/{jobId}/cancel`

Request:

```json
{
  "reason": "User changed project direction."
}
```

Response for queued or draft jobs:

```json
{
  "accepted": true,
  "state": "cancelled"
}
```

Response for running jobs:

```json
{
  "accepted": true,
  "state": "cancel_requested"
}
```

For a running job, the server must not mark terminal `cancelled` until the agent acknowledges that local execution has stopped.

Agent acknowledgement:

`POST /api/v1/jobs/{jobId}/cancel-ack`

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "stopped": true,
  "lastSafeCheckpoint": "No files outside allowed paths were modified."
}
```

## Safe GitHub Workflow

GitHub write actions are explicit allowlisted actions:

- `git_commit`;
- `git_push_feature_branch`;
- `create_or_update_pull_request`.

Rules:

- Agent verifies exact repository identifier, provider repository ID, and remote origin before any git write.
- Commits are allowed only in a dedicated branch or worktree.
- Push is allowed only to a feature branch with the `codex/` prefix.
- `git_push_feature_branch` requires an allowlisted `github_git` network destination bound to the same repository identifier, provider repository ID, origin URL, and target branch.
- `create_or_update_pull_request` requires an allowlisted `github_api` network destination bound to the same repository identifier, provider repository ID, origin URL, and target branch.
- Force-push is forbidden.
- Push to `main` is forbidden.
- Merge to `main` is forbidden until independent acceptance is `accepted`.
- The job result returns commit SHA, branch name, and PR URL when a GitHub PR action was allowed and performed.

## Registered Validation Checks

The job spec contains `validationChecks`, not executable shell commands. Each check ID maps to a local agent registry entry.

Initial registry:

- `file_exists`;
- `npm_lint`;
- `npm_build`;
- `git_diff_check`;
- `static_html_exists`.

Registry rules:

- shell mode is always false;
- no `powershell -Command`, `cmd /c`, `bash -c`, or `sh -c`;
- parameters are typed and normalized relative to the resolved workspace;
- all paths are checked against allowed paths after realpath containment;
- unknown check ID is denied;
- missing capability or action is denied;
- repository code and npm scripts are untrusted and run only inside sandbox limits.

Unallowlisted external network writes are forbidden even when user text includes a URL or host. The orchestrator must convert intent into typed destinations from protected configuration before the agent can use them.

## Sandbox And Path Isolation

The local agent must run Codex, Node, npm scripts, and repository code in a sandboxed low-privilege process with:

- allowlisted environment variables only;
- no production secrets;
- network disabled by default or explicitly allowlisted by typed destination;
- CPU, memory, time, file count, and file size limits;
- normalized POSIX-relative path inputs only;
- no backslash, colon, UNC, device path, Windows absolute path, control/NUL, or traversal segments;
- realpath containment after resolving symlinks, junctions, and reparse points;
- no writes outside allowed paths.

## WordPress Publication

`type: wordpress_publish` is valid only when the JobSpec includes:

- allowed action `wordpress_publish`;
- capability `wordpress_api`;
- `requiresApproval: true`;
- approval policy requiring `wordpress_publish`;
- exact approval binding to job ID, attempt, target, environment, SiteSpec hash, input hashes, preview artifacts, and expiry.

WordPress publication is still blocked until the SiteSpec is `publish_ready`, server-owned readiness gates pass, staging/smoke/rollback requirements are met, and independent review acceptance is `accepted`.

WordPress staging and production use separate typed network destinations. A staging job cannot silently use a production destination, and a production job cannot run without the production target and approval binding.

## Error Codes

- `invalid_request`: request body is malformed or fails schema validation.
- `unauthorized_agent`: token is missing, invalid, or revoked.
- `unauthorized_operator`: human/operator auth is missing, invalid, or lacks RBAC permission.
- `agent_not_allowed`: agent is not allowed for the workspace or project.
- `job_not_found`: job does not exist or is not visible to the caller.
- `job_already_claimed`: another agent owns the active lease.
- `lease_token_missing`: mutating agent request did not include a lease token.
- `lease_token_invalid`: lease token does not match the active lease.
- `lease_expired`: the agent attempted to update a stale lease.
- `attempt_mismatch`: request attempt does not match current job attempt.
- `input_version_changed`: repository commit, SiteSpec revision, or SiteSpec sha256 no longer matches the job.
- `incompatible_protocol_version`: requested Agent API version is unsupported.
- `incompatible_schema_version`: requested JobSpec or SiteSpec version is unsupported.
- `approval_required`: action cannot continue without approval.
- `approval_rejected`: operator rejected the requested action.
- `approval_expired`: approval was not decided before expiry.
- `self_approval_forbidden`: executor or agent attempted to approve its own action.
- `forbidden_action`: job attempted an action not present in allowed actions or listed as forbidden.
- `capability_not_allowed`: job attempted to use a capability not present in allowed capabilities.
- `path_not_allowed`: job attempted to read or write outside allowed paths.
- `artifact_too_large`: artifact exceeds configured size limit.
- `artifact_checksum_mismatch`: uploaded artifact checksum differs from manifest.
- `log_too_large`: log chunk exceeds configured size limit.
- `validation_failed`: registered validation checks failed.
- `validation_not_run`: job attempted success without validation.
- `review_changes_required`: independent review found required fixes.
- `review_blocked`: independent review cannot decide without external input.
- `cancel_requested`: operator requested cancellation and the agent must stop.
- `cancelled`: job was cancelled after safe stop.
- `conflict`: idempotency key conflicts with a different operation payload.

## Idempotency

Every mutating request uses an idempotency key. Repeating the same request with the same key returns the same logical result. Reusing a key with a different payload returns `409 conflict`.

Idempotency is required for claim, start, events/log batches, artifact upload creation, artifact upload completion, approval request, approval decision, validation start, validation result, complete, fail, retry, cancellation request, cancellation acknowledgement, and review decision.
