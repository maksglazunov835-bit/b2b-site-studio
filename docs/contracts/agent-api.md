# Local Agent API Contract

## Purpose

This contract describes how the B2B Site Studio server communicates with a local Windows agent that runs bounded Codex jobs. The API is versioned, lease-based, deny-by-default, and designed for reproducible execution, independently reviewable results, artifact verification, cancellation, and approvals.

The server never sends arbitrary shell text. The local agent resolves `workspaceId` to a local path from protected local configuration and executes only registered validation checks with typed parameters.

## Protocol Versions

The first supported API namespace is `/api/v1`.

Versioned inputs:

- Agent API version: `v1`.
- JobSpec version: `1.2.0`.
- SiteSpec schema version: `1.2.0`.
- Validation registry version: date-based registry ID, for example `2026-09-02`.

The agent reports supported versions during registration and claim. The server only returns jobs when all of these are compatible. If any version is unsupported, the server returns `409 incompatible_protocol_version` or `409 incompatible_schema_version`.

## Authentication

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

`succeeded` only means the executor finished and required execution checks passed. It is not proof that the task is ready to merge, deploy, or publish. Acceptance requires an independent reviewer or CI gate that checks the actual diff, changed files, tests, architecture, migration/configuration/security impact, and alignment with the source Issue or JobSpec. The executor cannot accept its own work.

## State Lifecycle

Minimum lifecycle:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Cancellation lifecycle:

`running -> cancel_requested -> cancelled`

Review lifecycle:

`succeeded -> review_pending -> accepted | changes_required | blocked`

Merge, production deployment, WordPress publication, DNS changes, repository visibility changes, credential rotation, deletion, and other irreversible actions are forbidden until acceptance is `accepted` and the specific action has recorded human approval when required.

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
      "allowedCapabilities": ["codex", "git", "node", "file_write", "artifact_upload"],
      "allowedActions": ["create_branch", "write_files", "run_registered_validation", "create_artifact", "upload_artifact"],
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
  "uploadUrl": "https://storage.example.test/upload/artifact_001",
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
- Push is allowed only to a feature branch, normally with the `codex/` prefix.
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

## Sandbox And Path Isolation

The local agent must run Codex, Node, npm scripts, and repository code in a sandboxed low-privilege process with:

- allowlisted environment variables only;
- no production secrets;
- network disabled by default or explicitly allowlisted;
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
