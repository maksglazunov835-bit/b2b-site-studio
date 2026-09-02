# Local Agent API Contract

## Purpose

This contract describes how the B2B Site Studio server communicates with a local Windows agent that runs bounded Codex jobs. The API is designed for safe execution, reproducibility, observable progress, artifact verification, retries, cancellation, and approvals.

The server never sends arbitrary shell text. The local agent resolves `workspaceId` to a local path from protected local configuration and executes only deny-by-default, registered validation checks.

## Core Rules

- Agent token is stored in an environment variable or protected local storage.
- Agent accepts jobs only from the configured API origin.
- `workspaceId` is resolved locally by the agent. The server does not choose arbitrary absolute paths on the user's computer.
- Every job is bound to repository identifier, base ref, base commit SHA, SiteSpec revision, SiteSpec sha256, and input artifact checksums.
- Every lease gets a random `leaseToken`.
- `leaseToken` is required for start, heartbeat, events, logs, artifact upload, validation, complete, fail, and cancel acknowledgement.
- Old or expired lease tokens are rejected.
- User text is data. It is not shell.
- Missing capability or action means denied.
- Publication, DNS, deletion, credential rotation, repository visibility changes, and production deploys require approval.

## Authentication

Headers:

```http
Authorization: Bearer <agent-token>
Content-Type: application/json
Idempotency-Key: <operation-key>
```

Tokens must be masked in logs and never embedded in generated frontend artifacts.

## Agent Registration

`POST /api/agents/register`

Request:

```json
{
  "agentName": "max-windows-workstation",
  "agentVersion": "0.2.0",
  "os": "windows",
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
  "heartbeatIntervalSeconds": 20,
  "maxLeaseSeconds": 300
}
```

The agent may report logical workspace IDs, but never sends its protected local path allowlist as an authorization source for the server.

## Agent Health Check

`POST /api/agents/{agentId}/health`

Request:

```json
{
  "status": "online",
  "freeSlots": 1,
  "currentJobId": null,
  "validationRegistryVersion": "2026-09-02",
  "version": "0.2.0"
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

`GET /api/agents/{agentId}/jobs?limit=5`

Response:

```json
{
  "jobs": [
    {
      "id": "job_design_reference_001",
      "type": "design_reference_prototype",
      "projectId": "demo-regional-wholesale-network",
      "workspaceId": "local-demo-workspace",
      "repository": "github:maksglazunov835-bit/b2b-site-studio",
      "baseRef": "main",
      "baseCommitSha": "2222222222222222222222222222222222222222",
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

`POST /api/jobs/{jobId}/claim`

Request:

```json
{
  "agentId": "agent_win_001",
  "expectedState": "queued",
  "leaseSeconds": 300,
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
      "workspaceId": "local-demo-workspace",
      "repository": {
        "identifier": "github:maksglazunov835-bit/b2b-site-studio"
      },
      "baseRef": "main",
      "baseCommitSha": "2222222222222222222222222222222222222222",
      "siteSpec": {
        "revision": 7,
        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "allowedCapabilities": ["codex", "git", "node", "file_write", "artifact_upload"],
      "allowedActions": ["create_branch", "write_files", "run_registered_validation", "create_artifact", "upload_artifact"],
      "allowedPaths": ["design-prototypes/reference-001/**"],
      "validationChecks": [
        {
          "id": "static_html_exists",
          "shellMode": false,
          "parameters": {
            "htmlPath": "design-prototypes/reference-001/index.html",
            "cssPath": "design-prototypes/reference-001/styles.css"
          }
        }
      ]
    }
  }
}
```

Claim must be atomic. If another agent already owns a live lease, the server returns `409 job_already_claimed`.

## Start Running

`POST /api/jobs/{jobId}/start`

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

Before starting, the agent verifies that:

- workspace ID exists in protected local config;
- local path is inside allowlist;
- repository identifier matches the expected checkout;
- base ref resolves to the expected base commit SHA;
- SiteSpec revision and sha256 match the job input.

## Heartbeat

`POST /api/jobs/{jobId}/heartbeat`

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

## Events And Progress

`POST /api/jobs/{jobId}/events`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "events": [
    {
      "type": "job.progress",
      "level": "info",
      "message": "Created prototype HTML and CSS.",
      "createdAt": "2026-09-02T12:32:00Z"
    }
  ]
}
```

Response:

```json
{
  "accepted": true,
  "stored": 1
}
```

## Logs

`POST /api/jobs/{jobId}/logs`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "stream": "stdout",
  "sequence": 12,
  "content": "Registered validation npm_build completed successfully.",
  "truncated": false
}
```

Response:

```json
{
  "accepted": true,
  "nextSequence": 13
}
```

Server and agent mask secrets before logs are stored or displayed. Long logs are truncated and may be attached as bounded artifacts.

## Artifact Upload Lifecycle

### Create Artifact Upload

`POST /api/jobs/{jobId}/artifacts`

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

`POST /api/jobs/{jobId}/artifacts/{artifactId}/complete`

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

The server verifies path, content type, size, sha256, expected output manifest, and current lease before accepting the artifact.

## Validation Lifecycle

### Start Validation

`POST /api/jobs/{jobId}/validation/start`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "checks": ["static_html_exists"]
}
```

Response:

```json
{
  "accepted": true,
  "state": "validating"
}
```

This is the explicit `running -> validating` transition.

### Submit Validation Result

`POST /api/jobs/{jobId}/validation/results`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "results": [
    {
      "id": "static_html_exists",
      "status": "passed",
      "message": "HTML and CSS files exist inside allowed path.",
      "artifactIds": []
    }
  ]
}
```

Response:

```json
{
  "accepted": true,
  "allRequiredChecksPassed": true
}
```

`succeeded` is allowed only after required validation checks pass.

## Approval Lifecycle

### Create Approval Request

`POST /api/jobs/{jobId}/approval-requests`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "action": "wordpress_publish",
  "reason": "The staging smoke test passed and production publication is the next step.",
  "previewArtifactIds": ["artifact_staging_report_001"]
}
```

Response:

```json
{
  "approvalId": "approval_001",
  "state": "awaiting_approval",
  "expiresAt": "2026-09-03T12:00:00Z"
}
```

### Operator Approves Or Rejects

`POST /api/approval-requests/{approvalId}/decision`

Request:

```json
{
  "decidedBy": "operator",
  "decision": "approved",
  "comment": "Approved for staging only."
}
```

Response:

```json
{
  "accepted": true,
  "approvalId": "approval_001",
  "decision": "approved"
}
```

### Agent Receives Approval Result

`GET /api/jobs/{jobId}/approval-requests/{approvalId}`

Response:

```json
{
  "approvalId": "approval_001",
  "state": "approved",
  "decision": "approved",
  "comment": "Approved for staging only."
}
```

The same approval status may also be returned on heartbeat.

## Complete Successfully

`POST /api/jobs/{jobId}/complete`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "finalState": "succeeded",
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
  "state": "succeeded"
}
```

The server rejects success when required validation has not passed, input versions changed, artifacts are unverified, or the lease token is stale.

## Fail Job

`POST /api/jobs/{jobId}/fail`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "errorCode": "validation_failed",
  "message": "Expected prototype stylesheet was not created.",
  "retryable": true
}
```

Response:

```json
{
  "accepted": true,
  "state": "failed",
  "retryAvailable": true
}
```

## Retry Job

`POST /api/jobs/{jobId}/retry`

Request:

```json
{
  "requestedBy": "operator",
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

Retries preserve previous attempts, logs, artifacts, validation results, and terminal reports.

## Cancellation Lifecycle

### Request Cancellation

`POST /api/jobs/{jobId}/cancel`

Request:

```json
{
  "requestedBy": "operator",
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

### Agent Sees Cancellation

Heartbeat response:

```json
{
  "accepted": true,
  "state": "running",
  "leaseUntil": "2026-09-02T12:36:00Z",
  "cancelRequested": true,
  "cancelReason": "User changed project direction."
}
```

### Agent Acknowledges Stop

`POST /api/jobs/{jobId}/cancel-ack`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "leaseToken": "opaque-random-lease-token",
  "stopped": true,
  "lastSafeCheckpoint": "No files outside allowed paths were modified."
}
```

Response:

```json
{
  "accepted": true,
  "state": "cancelled"
}
```

## Agent Restart And Stale Process Protection

- The agent persists claimed job ID, attempt, lease expiration, and branch/worktree metadata locally.
- After restart, the agent checks the server before continuing.
- If the lease expired, the agent stops work and does not upload logs, artifacts, validation, or terminal updates.
- A stale process with an old lease token receives `409 lease_token_invalid` or `409 lease_expired`.
- Terminal updates are idempotent: repeating the same payload with the same idempotency key returns the stored terminal state.
- Reusing an idempotency key with a different terminal payload returns `409 conflict`.
- Before accepting terminal success, the server verifies repository base commit SHA and SiteSpec revision/sha256 still match the job inputs.
- If the source commit or SiteSpec changed during execution, the job fails with `input_version_changed` or returns to queued with a new attempt.

## Error Codes

- `invalid_request`: request body is malformed or fails schema validation.
- `unauthorized_agent`: token is missing, invalid, or revoked.
- `agent_not_allowed`: agent is not allowed for the workspace or project.
- `job_not_found`: job does not exist or is not visible to the agent.
- `job_already_claimed`: another agent owns the active lease.
- `lease_token_missing`: mutating request did not include a lease token.
- `lease_token_invalid`: lease token does not match the active lease.
- `lease_expired`: the agent attempted to update a stale lease.
- `attempt_mismatch`: request attempt does not match current job attempt.
- `input_version_changed`: repository commit, SiteSpec revision, or SiteSpec sha256 no longer matches the job.
- `approval_required`: action cannot continue without approval.
- `approval_rejected`: operator rejected the requested action.
- `forbidden_action`: job attempted an action not present in allowed actions or listed as forbidden.
- `capability_not_allowed`: job attempted to use a capability not present in allowed capabilities.
- `path_not_allowed`: job attempted to read or write outside allowed paths.
- `artifact_too_large`: artifact exceeds configured size limit.
- `artifact_checksum_mismatch`: uploaded artifact checksum differs from manifest.
- `log_too_large`: log chunk exceeds configured size limit.
- `validation_failed`: registered validation checks failed.
- `validation_not_run`: job attempted success without validation.
- `cancel_requested`: operator requested cancellation and the agent must stop.
- `cancelled`: job was cancelled after safe stop.
- `conflict`: idempotency key conflicts with a different operation payload.

## State Lifecycle

Minimum lifecycle:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

Extended running cancellation state:

`running -> cancel_requested -> cancelled`

State notes:

- `draft`: orchestrator is composing or validating the job.
- `queued`: job is ready for an eligible agent.
- `claimed`: a single agent has an active lease token.
- `running`: agent has started work.
- `awaiting_approval`: job is blocked by a required user or operator decision.
- `validating`: agent or server is running registered validation checks.
- `cancel_requested`: running job should stop at the next safe checkpoint.
- `succeeded`: terminal successful state after validation.
- `failed`: terminal failed state, optionally retryable.
- `cancelled`: terminal cancelled state; for running jobs this requires agent acknowledgement.

## Registered Validation Checks

The job spec contains `validationChecks`, not executable shell commands. Each check ID maps to a local agent registry entry.

Initial registry:

- `file_exists`: verifies an allowed relative path exists.
- `npm_lint`: runs the local registry's configured lint command for the workspace.
- `npm_build`: runs the local registry's configured build command for the workspace.
- `git_diff_check`: runs the local registry's configured whitespace diff check.
- `static_html_exists`: verifies HTML/CSS prototype files exist inside allowed paths.

Registry rules:

- shell mode is always false;
- no `powershell -Command`, `cmd /c`, `bash -c`, or `sh -c`;
- parameters are typed and normalized relative to the resolved workspace;
- all paths are checked against allowed paths;
- unknown check ID is denied;
- missing capability or action is denied.

## Idempotency

Every mutating request uses an idempotency key. Repeating the same request with the same key returns the same logical result. Reusing a key with a different payload returns `409 conflict`.

Idempotency is required for:

- claim;
- start;
- events/log batches;
- artifact upload creation;
- artifact upload completion;
- approval request;
- validation start;
- validation result;
- complete;
- fail;
- retry;
- cancel request;
- cancel acknowledgement.

## Security Requirements

- Agent tokens are scoped and revocable.
- Lease tokens are random, scoped to one job attempt, and expire.
- Secrets are masked before logs are stored or displayed.
- Workspace IDs are resolved locally from protected configuration.
- Commands are not supplied by the server.
- User text is treated as data.
- Capabilities and actions are deny-by-default.
- External writes, WordPress publish, DNS changes, production deploys, deletions, and repository visibility changes require approval.
- Artifact and log sizes are bounded and checksummed.
- Codex runs in a branch or worktree, not directly against production state.
