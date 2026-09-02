# Local Agent API Contract

## Purpose

This contract describes how the B2B Site Studio server communicates with a local Windows agent that runs bounded Codex jobs. The API is designed for safe execution, observable progress, retries, and approvals.

The local agent must never convert user text directly into shell commands. Executable validation commands must be structured, system-defined argv arrays from the job spec.

## Authentication

The agent authenticates with a scoped token stored in an environment variable or protected local storage. Tokens must not be logged, committed, or sent to generated frontend code.

Headers:

```http
Authorization: Bearer <agent-token>
Content-Type: application/json
Idempotency-Key: <operation-key>
```

## Agent Registration

`POST /api/agents/register`

Request:

```json
{
  "agentName": "max-windows-workstation",
  "agentVersion": "0.1.0",
  "os": "windows",
  "capabilities": ["codex", "git", "node", "browser-screenshot"],
  "workspaceAllowlist": [
    "C:\\Users\\Public\\B2B Site Studio\\workspaces"
  ]
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

## Agent Health Check

`POST /api/agents/{agentId}/health`

Request:

```json
{
  "status": "online",
  "freeSlots": 1,
  "currentJobId": null,
  "version": "0.1.0"
}
```

Response:

```json
{
  "accepted": true,
  "serverTime": "2026-09-02T10:00:00Z"
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
  "leaseSeconds": 300
}
```

Response:

```json
{
  "job": {
    "id": "job_design_reference_001",
    "state": "claimed",
    "attempt": 1,
    "leaseUntil": "2026-09-02T10:05:00Z",
    "spec": {
      "type": "design_reference_prototype",
      "workspacePath": "C:\\Users\\Public\\B2B Site Studio\\workspaces\\demo-regional-wholesale-network",
      "allowedPaths": ["design-prototypes/reference-001/**"],
      "forbiddenActions": ["production_deploy", "wordpress_publish", "dns_change", "direct_shell_from_user_text"]
    }
  }
}
```

Claim must be atomic. If another agent already owns the lease, the server returns `409 job_already_claimed`.

## Start Running

`POST /api/jobs/{jobId}/start`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "branchName": "codex/job-design-reference-001"
}
```

Response:

```json
{
  "accepted": true,
  "state": "running"
}
```

## Heartbeat

`POST /api/jobs/{jobId}/heartbeat`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "progressPercent": 45,
  "message": "Prototype files created; preparing screenshot."
}
```

Response:

```json
{
  "accepted": true,
  "state": "running",
  "leaseUntil": "2026-09-02T10:06:00Z",
  "cancelRequested": false
}
```

Heartbeat is accepted only from the current lease owner and attempt.

## Events And Progress

`POST /api/jobs/{jobId}/events`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "events": [
    {
      "type": "job.progress",
      "level": "info",
      "message": "Created prototype HTML and CSS.",
      "createdAt": "2026-09-02T10:02:00Z"
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
  "stream": "stdout",
  "sequence": 12,
  "content": "npm run build completed successfully",
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

Server and agent must mask secrets before logs are displayed. Long logs are truncated and can be attached as artifacts with size limits.

## Artifact Upload

`POST /api/jobs/{jobId}/artifacts`

Request metadata:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "kind": "screenshot",
  "path": "design-prototypes/reference-001/screenshot.png",
  "contentType": "image/png",
  "sha256": "example-sha256-placeholder",
  "sizeBytes": 204800
}
```

Response:

```json
{
  "artifactId": "artifact_001",
  "uploadUrl": "https://storage.example.test/upload/artifact_001",
  "expiresInSeconds": 300
}
```

The upload URL is used by the agent to upload bytes. The server stores metadata, checksum, size, and visibility.

## Approval Request

`POST /api/jobs/{jobId}/approval-requests`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
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
  "expiresAt": "2026-09-03T10:00:00Z"
}
```

The job remains blocked until the user approves or rejects the action.

## Complete Successfully

`POST /api/jobs/{jobId}/complete`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
  "finalState": "succeeded",
  "summary": "Prototype created and validation passed.",
  "changedFiles": [
    "design-prototypes/reference-001/index.html",
    "design-prototypes/reference-001/styles.css"
  ],
  "validationResults": [
    {
      "name": "Check prototype files",
      "status": "passed"
    }
  ],
  "artifactIds": ["artifact_001"]
}
```

Response:

```json
{
  "accepted": true,
  "state": "succeeded"
}
```

## Fail Job

`POST /api/jobs/{jobId}/fail`

Request:

```json
{
  "agentId": "agent_win_001",
  "attempt": 1,
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

Retries must preserve previous attempts, logs, and artifacts.

## Cancel Job

`POST /api/jobs/{jobId}/cancel`

Request:

```json
{
  "requestedBy": "operator",
  "reason": "User changed project direction."
}
```

Response:

```json
{
  "accepted": true,
  "state": "cancelled"
}
```

If the job is running, the agent receives `cancelRequested: true` on heartbeat and stops at the next safe checkpoint.

## Error Codes

- `invalid_request`: request body is malformed or fails schema validation.
- `unauthorized_agent`: token is missing, invalid, or revoked.
- `agent_not_allowed`: agent is not allowed for the workspace or project.
- `job_not_found`: job does not exist or is not visible to the agent.
- `job_already_claimed`: another agent owns the active lease.
- `lease_expired`: the agent attempted to update a stale lease.
- `attempt_mismatch`: request attempt does not match current job attempt.
- `approval_required`: action cannot continue without approval.
- `forbidden_action`: job attempted an action listed in forbidden actions.
- `path_not_allowed`: job attempted to read or write outside allowed paths.
- `artifact_too_large`: artifact exceeds configured size limit.
- `log_too_large`: log chunk exceeds configured size limit.
- `validation_failed`: validation commands failed.
- `cancelled`: job was cancelled by operator or system.
- `conflict`: idempotency key conflicts with a different operation payload.

## State Lifecycle

Minimum lifecycle:

`draft -> queued -> claimed -> running -> awaiting_approval -> validating -> succeeded | failed | cancelled`

State notes:

- `draft`: orchestrator is still composing or validating the job.
- `queued`: job is ready for an eligible agent.
- `claimed`: a single agent has an active lease.
- `running`: agent has started work.
- `awaiting_approval`: job is blocked by a required user decision.
- `validating`: agent or server is running validation.
- `succeeded`: terminal successful state.
- `failed`: terminal failed state, optionally retryable.
- `cancelled`: terminal cancelled state.

## Idempotency

Every mutating request uses an idempotency key. Repeating the same request with the same key returns the same logical result. Reusing a key with a different payload returns `409 conflict`.

Idempotency is required for:

- claim;
- start;
- artifact metadata creation;
- approval request;
- complete;
- fail;
- retry;
- cancel.

## Security Requirements

- Agent tokens are scoped and revocable.
- Secrets are masked before logs are stored or displayed.
- Workspace paths are checked against an allowlist.
- Commands are structured argv arrays and system-defined.
- User text is treated as data.
- External writes, WordPress publish, DNS changes, production deploys, deletions, and repository visibility changes require approval.
- Artifact and log sizes are bounded.
- Codex runs in a branch or worktree, not directly against production state.
