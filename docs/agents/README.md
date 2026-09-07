# Local Runner: Presence Only

MVP-03B connects a real foreground Node process to the local platform. It registers, sends presence signals, becomes offline after stopping, and terminates when access is revoked. It does not execute SiteSpec validation, Codex, Git, shell commands or WordPress; it does not read user folders, expose a listener, install a service/task, or enable autostart. Existing jobs stay pinned and `dispatchable: false` / `EXECUTOR_NOT_CONFIGURED`. Online never means generation-ready.

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

Paste the one-time code at the hidden stdin prompt and press Enter. Do not put secrets in command arguments, environment exports, shell history, reports or URLs. The eye control reveals the transient code for manual transfer. The platform and Runner may use another matching, explicit loopback port. The Runner name accepts ASCII letters/digits/spaces/dot/underscore/hyphen, up to 64 characters. Quoted names with spaces work in either shell.

The terminal prints only bounded nonsecret status lines: registered agent ID and heartbeat acknowledgements. Stop with Ctrl+C. SIGTERM also initiates graceful cancellation. The UI polls server-derived status every five seconds while expanded; at the default heartbeat interval a stopped process becomes offline after 60 seconds, visible on the next refresh. Revoke explicitly to invalidate access. Restarting the Runner always requires new pairing because its independent credential exists only in that process's memory. Closing the UI clears the displayed code and polling timers, but an unused permission may remain valid until cancelled or its five-minute expiry.

`agent/connect.mjs` is the foreground launcher. It spawns only the fixed Node `agent/session.mjs` entrypoint with an allowlisted environment, not a shell. Database URLs, GitHub/production/Codex tokens, NODE_OPTIONS and proxy settings are not forwarded. Windows automatically injects some login/system metadata even into an explicit environment; session startup removes those keys and rejects unexpected variables before reading the code or connecting. Both processes exit after revocation/stop; the fixed private IPC `STOP` message exists only for launcher shutdown, not for accepting work.

## Transport And Trust Boundaries

- Only explicit `http://127.0.0.1:PORT` or `http://[::1]:PORT` origins are allowed. External hosts, localhost DNS aliases, alternate numeric IP encodings, credentials, path/query/fragment, missing/invalid ports and redirects are rejected. No server-supplied URL is followed.
- The core Node HTTP transport opens only outbound registration and health requests, one at a time, with a five-second total timeout, 4 KiB outgoing body and 16 KiB response cap. JSON content type, status, exact response fields and the non-execution profile are checked. It does not use proxy environment settings.
- Registration retries reuse one key, payload and memory credential for at most five attempts inside a five-minute client budget; server-clock permission expiry remains authoritative. Backoff is bounded at ten seconds. Invalid/expired/revoked/consumed/incompatible credentials terminate the process; they never trigger new pairing automatically.
- Successful health uses the server-selected interval (1..30 seconds, default 20); temporary failures retry with bounded backoff and terminate after five consecutive failures. Signal/parent disconnect cancels active HTTP and timers; stdin input is bounded to 128 bytes/60 seconds and never echoed.
- Credentials have distinct purposes: pairing authorizes registration only; agent credential authorizes only that agent's presence. Operator routes reject bearers but still rely on a trusted local UI boundary, not public accounts/RBAC. A malicious process sharing the OS user's access can imitate that UI without a bearer. Do not expose this listener via public tunnels/proxies or Timeweb.
- There is no durable credential storage, offline reconnect service, job worker, lease or executor. Agent history/expired permission records are retained; retention/cleanup policy and authenticated multi-user access belong to later milestones.

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
npm run ci:full
```

The protected full gate preserves all 12 persistence and 9 jobs tests, contract fixtures, old HTTP/UI/access/shutdown checks and adds agent database/upgrade/transport, built-server HTTP, real child-process and Playwright tests. Service tests inject a server-owned clock; real transport tests use a bounded one-second interval on the actual built server, real sockets, several heartbeats, and offline after stopping. A loopback loss injector drops the first committed registration reply; retry must return the same stored agent. Linux CI sends real SIGINT/SIGTERM; Windows uses a test-only relay to the same signal handlers because TerminateProcess is not POSIX signal delivery.

Read-only CI uploads seven explicitly named files for seven days: safe `ci-summary.json`, persistence/jobs desktop/mobile PNGs, and Runner desktop/mobile PNGs. Runner screenshots are taken only after consumed pairing clears from the DOM, use synthetic device/brief data, and are each below 5 MiB. No stdout, DB dumps, environment or tokens are artifacts. Tests check raw secrets are absent from DB/idempotency/event data, Runner/server logs, browser storage/URL/DOM at screenshot time. Screenshots and temporary test configuration are ignored by git. Independent acceptance/merge remains the coordinator's responsibility, never the executor's.
