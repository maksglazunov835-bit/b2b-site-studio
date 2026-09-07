# Local Runner: Presence And Opt-In Data Validation

The default MVP-03B foreground connection remains presence-only: registration, heartbeat, offline after stopping and exit on revoke, with zero slots and no job rights. MVP-03C additionally permits opt-in built-in SiteSpec validation for one project and explicitly selected jobs. No mode executes Codex, Git, shell commands or WordPress, reads user folders, exposes a listener, installs a service/task or enables autostart. Online never means generation-ready.

The canonical [Agent API presence profile](../contracts/agent-api.md#implemented-presence-only-profile-mvp-03b) describes DTOs, scope, statuses, hashes and transactions. Migration `003_agent_connections.sql` adds `agents`, `agent_pairings`, and append-only `agent_events`; 001/002 are unchanged. Foreign keys bind workspace/agent/pairing consistently. Identity and consumed pairing fingerprints cannot be rewritten, and revoked agents cannot be restored.

## Local Launch (PowerShell Or POSIX)

Prerequisites: Node 22.13+ (Node 24 in CI), npm, and the [separate local PostgreSQL configuration](../persistence/README.md). Preserve an existing `.env` and dev database/volume. Only the platform and migration commands load `.env`; the Runner never does. The following local operator setup applies migrations to the operator's intended persistent dev DB, **not a test command**:

```text
npm ci
npm run db:up
npm run db:migrate
npm run db:status
npm run build
npm run start:local
```

Open `http://127.0.0.1:3000`. Expand **Local Runner** in the existing overview and explicitly issue a connection permission. In another terminal in the repository root run:

```text
npm run agent:connect -- --origin http://127.0.0.1:3000 --name My-Runner
```

For **data validation**, first save a brief and choose **Проверка SiteSpec этого проекта** in the new-connection selector, then issue a new permission. Start a separate foreground terminal with:

```text
npm run agent:connect -- --origin http://127.0.0.1:3000 --name My-Validator --mode data-validation
```

After registration, create a queue request, choose this compatible Runner in **Runner для проверки** and explicitly click **Выполнить проверку** for that request. Unsaved brief changes block dispatch until saved. Inspect the pinned revision, attempts, journal and persisted report; reload does not lose results. Old jobs do not adopt later brief revisions. Cancel waits for Runner acknowledgement, never invents a completed stop. Without the new CLI option and matching project permission, the old zero-execution mode is retained; mismatched registration is rejected.

This mode uses the separate full 1.3 data profile, not a partial 1.2 repository job. It verifies actual installed validator checksums, snapshot/JobSpec hashes, scope and bounds, then calls a fixed memory/time-bounded worker thread. The server independently verifies its report. `succeeded` with `validationStatus:invalid` means validation finished and found data errors. No facts, readiness, independent acceptance, website files or production state are changed. See the [exact API/lease contract](../contracts/agent-api.md#implemented-data-validation-profile-mvp-03c).

Paste the one-time code at the hidden stdin prompt and press Enter. Do not put secrets in command arguments, environment exports, shell history, reports or URLs. The eye control reveals the transient code for manual transfer. The platform and Runner may use another matching, explicit loopback port. The Runner name accepts ASCII letters/digits/spaces/dot/underscore/hyphen, up to 64 characters. Quoted names with spaces work in either shell.

The terminal prints only bounded nonsecret status lines: registered agent ID and heartbeat acknowledgements. Stop with Ctrl+C. SIGTERM also initiates graceful cancellation. The UI polls server-derived status every five seconds while expanded; at the default heartbeat interval a stopped process becomes offline after 60 seconds, visible on the next refresh. Revoke explicitly to invalidate access. Restarting the Runner always requires new pairing because its independent credential exists only in that process's memory. Closing the UI clears the displayed code and polling timers, but an unused permission may remain valid until cancelled or its five-minute expiry.

`agent/connect.mjs` is the foreground launcher. It spawns only the fixed Node `agent/session.mjs` entrypoint with an allowlisted environment, not a shell. Database URLs, GitHub/production/Codex tokens, NODE_OPTIONS and proxy settings are not forwarded. Windows automatically injects some login/system metadata even into an explicit environment; session startup removes those keys and rejects unexpected variables before reading the code or connecting. Both processes exit after revocation/stop; the fixed private IPC `STOP` message exists only for launcher shutdown, not for accepting work.

## Transport And Trust Boundaries

- Only explicit `http://127.0.0.1:PORT` or `http://[::1]:PORT` origins are allowed. External hosts, localhost DNS aliases, alternate numeric IP encodings, credentials, path/query/fragment, missing/invalid ports and redirects are rejected. No server-supplied URL is followed.
- The core Node HTTP transport opens only outbound registration and health requests, one at a time, with a five-second total timeout, 4 KiB outgoing body and 16 KiB response cap. JSON content type, status, exact response fields and the non-execution profile are checked. It does not use proxy environment settings.
- Registration retries reuse one key, payload and memory credential for at most five attempts inside a five-minute client budget; server-clock permission expiry remains authoritative. Backoff is bounded at ten seconds. Invalid/expired/revoked/consumed/incompatible credentials terminate the process; they never trigger new pairing automatically.
- Successful health uses the server-selected interval (1..30 seconds, default 20); temporary failures retry with bounded backoff and terminate after five consecutive failures. Signal/parent disconnect cancels active HTTP and timers; stdin input is bounded to 128 bytes/60 seconds and never echoed.
- Credentials have distinct purposes: pairing authorizes registration only; agent credential authorizes only that agent's presence. Operator routes reject bearers but still rely on a trusted local UI boundary, not public accounts/RBAC. A malicious process sharing the OS user's access can imitate that UI without a bearer. Do not expose this listener via public tunnels/proxies or Timeweb.
- There is no durable credential storage, offline reconnect service or general-purpose executor. Data mode alone adds fixed claim/start/heartbeat/result/fail/cancel-ack paths, 80 KiB claim responses and 17 KiB report requests; other transport limits stay unchanged. It holds one lease, expires in 10 seconds without renewal and has a hard 30-second deadline / at most three attempts. Lost claim waits for expiry without storing plaintext for replay; start retries require a live lease. No user-supplied module, command or path is executed. History retention and authenticated multi-user access remain future work.
- An uncertain result/fail/cancel-ack response retains its exact operation/key/body in memory. The Runner can recover its already committed acknowledgement even after lease/deadline expiry (ten requests maximum, 45-second budget, five-second request timeout). The server permits only a scoped read of that immutable acknowledgement for five minutes after completion, never another write or lease extension. `RUNNER_TERMINAL_ACK_RECOVERED` confirms the stored terminal state; exhausted/refused recovery exits with `TERMINAL_ACK_UNCONFIRMED` or the credential error, without a new execution or fabricated outcome. Revocation always denies. Restart cannot recover lost memory secrets; inspect the persisted platform result/history instead.
- Validator-manifest changes require a compatible newly paired data-mode Runner; old grants are not elevated or rewritten. Historical snapshots with incompatible special-key hashes fail explicitly without rewriting old revisions/jobs. Ordinary legacy fixture digests remain unchanged; see the canonical JSON compatibility gate in `tests/execution/contracts.test.mjs`.

## Verification And CI Evidence

Configure the separate `TEST_DATABASE_URL` from the persistence guide; no fallback to `DATABASE_URL` is permitted. Tests preflight before SQL, never migrate/reset dev and read-only fingerprint all known dev tables. CI uses separate PostgreSQL containers and a dev sentinel on 001. The upgrade fixture seeds 001+002 with revisions plus queued/cancelled jobs on TEST, applies 003 and verifies every old row and checksum.

```text
npm run db:test:up
npm run db:test:migrate
npm run db:test:status
npx --no-install playwright install chromium
npm run test:agents
npm run build
npm run test:agents:http
npm run test:agents:process
npm run test:agents:ui
npm run contracts:execution
npm run test:execution
npm run test:execution:http
npm run test:execution:process
npm run test:execution:ui
npm run ci:full
```

The protected full gate preserves all 12 persistence and 9 jobs tests, contract fixtures, old HTTP/UI/access/shutdown checks and adds agent database/upgrade/transport, built-server HTTP, real child-process and Playwright tests. Service tests inject a server-owned clock; real transport tests use a bounded one-second interval on the actual built server, real sockets, several heartbeats, and offline after stopping. A loopback loss injector drops the first committed registration reply; retry must return the same stored agent. Linux CI sends real SIGINT/SIGTERM; Windows uses a test-only relay to the same signal handlers because TerminateProcess is not POSIX signal delivery.

Read-only CI uploads nine explicitly named files for seven days: safe `ci-summary.json` and persistence/jobs/presence Runner/completed validation desktop/mobile PNGs. They are taken only after consumed pairing clears from the DOM, use synthetic device/brief data and are each below 5 MiB. No stdout, DB dumps, environment or tokens are artifacts. Tests check raw secrets are absent from DB/idempotency/event data, Runner/server logs, browser storage/URL/DOM at screenshot time. Execution tests also run a real child process against the built server with lost claim/start/result replies and cancel/revoke races; worker termination and old presence behavior remain required. Screenshots and temporary test configuration are ignored by git. Independent acceptance/merge remains the coordinator's responsibility, never the executor's.
