# WSL Runner admission: review 5167005370

Measured locally on Windows/WSL on 2026-09-10. Not independent acceptance.
Linux ChatGPT login is present. Official Codex 0.153.4 model/list resolves
gpt-6-astra / ultra. No login codes, tokens, identity or auth files are collected.

## Reproduced failure

Before the server fix, a schema-valid official ready runtime was rejected by
registerRequest with VALIDATION_FAILED. The initial unit reproduction failed.
After adding catchable startup diagnostics but keeping that server prohibition,
the **real design-main -> WSL preflight -> built-server** registration-only run
reproduced HTTP 422 / VALIDATION_FAILED at registration, after manifest_validation.
Run 118b8c61-e9e2-4e63-8fc5-7d2a9993dc4c, 14:50:40-14:50:50 UTC, stopped cleanly.
This proves the current integration blocker, not the uniquely established cause
of the earlier run whose child diagnostics were discarded.

After the scoped admission fix, real registration-only run
48329ca3-8368-46f5-84e1-0ed287ae9539 (14:52:16-14:52:26 UTC) registered once,
received its first heartbeat, was revoked, and exited with the expected
AGENT_REVOKED / HTTP 401 / exit 1 / signal null / stopConfirmed true.
Dispatches, attempts, invocation permits and results: all zero. Model calls: zero.

The final built-server/Runner manifest was retested at 15:07:02-15:07:12 UTC:
run 89a37ba4-0a9c-4625-aa09-c2fe52699028 passed the same real registration-only
cycle. Adapter SHA-256 7450494032fdadf96b678a24812f04a6479415eea0f345c23e8c6779e5179538.
See [safe receipts](wsl-registration-receipts.json), including the preserved
pre-reset proof and expected revoke/stop result. The expanded local full gate
passed all 20 steps; native Windows no-SQL regressions passed 22 tests.

## Trust boundary

The registration transaction still needs an unrevoked, unexpired, single-use
codex_design pairing for the exact active project/workspace, matching adapter
manifest and separate agent credential. Ready alone, wrong native transport,
old manifest/model/effort or an expired/future preflight cannot grant execution.
The shared runtime validation is used by registration, grantProfile, dispatch
and Runner reply validation. Both server and Runner must be rebuilt from the
same generated manifest. Changing the manifest does not upgrade old connections.

WSL admission carries only transport/profile identity, checkedAt and a config
digest. The manifest pins the exact runtime/binary policy. Registration requires
freshness <=60 seconds. The trusted local adapter constructs the receipt from
current account/model/config/filesystem/network checks and checks freshness again
after pairing input. Execution compares the assigned runtime binding and reruns
the actual WSL checks before its sole possible provider call. A saved admission
timestamp is not permanent OS admission. Older non-ready diagnostic profiles
remain visible with zero execution capability; the actual design entrypoint
rejects them before pairing. Public API default-deny remains unchanged.

This is not cryptographic remote attestation: a malicious same-user program or
trusted local operator controlling the pairing/runtime can forge local claims.
The platform is still a trusted loopback-bound local tool, not public multi-user
authentication. No browser ready boolean substitutes for pairing or per-job
operator dispatch. No new remote attestation service has been introduced.

## Startup evidence

design-main has built-in-only static imports and a catchable dynamic bootstrap.
Stages: bootstrap_import, options, preflight, pairing_input, manifest_validation,
registration, first_heartbeat. Unknown failures become RUNNER_INTERNAL_ERROR
(bootstrap failures RUNNER_BOOTSTRAP_ERROR), not fictitious INVALID_OPTIONS.
Allowlisted IPC carries a random runId, completed/current phase, code, safe HTTP
status/code and timestamps. The parent adds actual exit/signal codes.

At most 24 messages, 2 KiB each, 32 KiB discarded stdout/stderr, 60-second startup
wait, bounded exit/close drain and bounded cleanup. No raw stderr, stack, request
body, environment, authorization data or token enters a persisted receipt.
Pipe closure or leader exit alone never confirms the descendant tree stopped;
the final trusted Runner acknowledgement is also required. STOP_UNCONFIRMED
blocks success. Existing WSL subreaper/relay and Windows process-tree gates remain.

## Preserved model budget

The original .test-results/real-codex-attempt.json remains unchanged, SHA-256
a3abaa775da4806075383edd2acd62d9870f2ba722698c8bea8edcd95195c0b8.
Before any reset in this follow-up, a REPEATABLE READ READ ONLY snapshot confirmed
the original synthetic job was queued/version 1 with only job_queued and zero
registrations/dispatches/attempts/invocation permits/results. Its captured proof
binds the original reservation bytes and previous report by hashes; no absence
after reset is used to infer unused budget. The old attempt is never rewritten.

An explicitly requested continuation validates that proof, then exclusively
creates real-codex-continuation.json and real-codex-provider-start.json just before
dispatch. Both survive failure. Concurrent or repeated starts fail closed. Before
these markers, registration-only and preparatory failures consume no model call.
After dispatch/start uncertainty, no automatic recovery authorizes a new call.

## Commands

Use the protected separate TEST_DATABASE_URL and existing dev read-only
fingerprint. No Docker, production, global WSL or other distro changes:

```powershell
npm ci
npm run db:test:migrate
npm run db:test:status
npm run ci:full
node scripts/lab/transfer.mjs
node scripts/persistence/run-tests.mjs design-registration-only
```

Only after successful current-head CI and fresh admission, the previously
authorized single call may be continued explicitly (never repeat it blindly):

```powershell
node scripts/lab/transfer.mjs
node scripts/persistence/run-tests.mjs design-live-smoke --confirm-one-real-call --continue-unused-reservation
```

Registration-only is an actual foreground design-main process with the same
filtered environment/WSL adapter, not a replacement fake Runner. It never calls
claim. Full smoke remains platform -> Runner -> WSL Codex, result validation,
PostgreSQL persistence and reload, never standalone CLI inference.

## Validation and limits

Permanent tests cover official scoped HTTP registration/dispatch and denials,
import/options/preflight/pairing/manifest/registration/heartbeat failures,
late IPC, missing stop proof, output bounds, secret markers and exclusive budget
continuation/start. They run in ci:full; no-SQL cases also run on native Windows
CI. CI uses explicitly synthetic runtime/CLI fixtures, never a real model call.
Existing safe desktop/mobile screenshots remain CI artifacts.

DEV_DATABASE_UNCHANGED remains required. No dependencies, migrations or production
changes. No merge/accepted/auto-merge. Real smoke outcome is reported separately
after current-head CI, not inferred from these fixture tests or registration.
