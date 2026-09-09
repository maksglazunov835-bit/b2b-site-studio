# WSL adapter follow-up to review 5158287241

Local Windows/WSL measurement, 2026-09-10 (Omsk). **Not independent acceptance.**
Real model invocations: **0**. The existing lab passes the pre-authentication
boundary checks; `account/read` returns no account, so inference is blocked by
`CODEX_LOGIN_REQUIRED`. No login code, token or login log has been collected.
GitHub CI remains test-CLI evidence, never real Codex generation.

## Implemented path

`agent/design-connect.mjs` filters the Windows environment, then the foreground
Runner selects `officialAdapter(..., {transport:'wsl'})`. The adapter validates
the pinned job and passes only the six-field bounded prompt, strict proposal
schema and fixed operation over stdin to System32 `wsl.exe`. It never opens the
platform API on another interface. No database, pairing/agent/lease token,
Windows profile or user file enters the lab.

`wsl-policy.mjs` owns distro, uid, HOME/CODEX_HOME, exact binary/runtime hashes,
environment, paths, permission entries, disabled features, model and limits.
`wsl-bridge.mjs` transfers only the fixed normalized runtime/subreaper modules
with a SHA-256 envelope; these files are included in the generated adapter
manifest. It does not transfer the repository or import model-selected modules.
`wsl-runtime.mjs` uses that same policy for diagnostics and official exec.
No user field may select a command, distro, user, executable, profile or path.

Versions/hashes are in `wsl-policy.mjs` and the measured
[receipt](wsl-adapter-receipt.json): Codex 0.153.4, Node 24.19.0, Ubuntu 24.04.4,
WSL kernel 6.6.114.1-microsoft-standard-WSL2, Python 3.12.3 and bundled bwrap.
The runtime checks the four executable hashes and their non-user-writable parent
chains. Node's extracted archive initially retained uid 1000; this follow-up made
only `/opt/b2b-lab/node-24.19.0` and `/opt/b2b-lab/codex-0.153.4` root-owned.
No packages, distro, VM, services, global settings or Windows ACLs were installed
or changed in this follow-up. The model has uid/gid 1000, no capabilities, no
sudo grant and NoNewPrivs. It cannot reach the setup helper.

Every preflight and invocation checks actual mountinfo, interop configuration,
socket absence, ownership, hash, realpaths and empty inherited configuration.
Cold start is tested after terminating **only B2B-Codex-Lab**. WSL recreates shared
mounts despite disabled automount; the adapter rejects `LAB_HOST_MOUNTS_PRESENT`
(a setup-required condition). Manual `transfer.mjs` prepares only that lab; the
adapter never calls it. Preparation is not permanent admission.

## Effective policy and missing stdout

The exact upstream [debug_sandbox.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/cli/src/debug_sandbox.rs)
selects ManagedRequirementsMode::Ignore for explicit profiles without
`--include-managed-config`. Installed help agrees. All new sandbox probes include
that flag. App-server and exec load managed requirements normally. Exec ignores
user config; diagnostics require that layer to be absent/empty, and refuse any
nonempty inherited layer or managed requirements instead of silently ignoring
them. A newly introduced managed requirement after login invalidates admission.

Typed config/read omits update-plan/request-input details and includes a null
filesystem `glob_scan_max_depth`; the adapter verifies the actual sessionFlags
layer for the former and the exact permission map including that null metadata.
Installed strict configuration requires `tools.update_plan.enabled=false` and
`tools.experimental_request_user_input.enabled=false`, not boolean tool objects.

The managed flag was **not** the cause of exit 0 with no probe JSON. The measured
stdio A/B reproducer shows Node child_process Unix pipes are socket-backed:
async console/stream writes disappear, while synchronous fs.writeSync delivers
the nonce and proves the process ran. With Python Popen real OS pipes, async
markers and ESM completion arrive. The network seccomp implementation in
[landlock.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/linux-sandbox/src/landlock.rs)
restricts socket operations; the particular failing internal Node syscall was
not traced, so no narrower syscall-cause claim is made. No sandbox was weakened.
The receipt records both cases. Missing nonce, JSON, any assertion or persisted
completion remains FAIL, regardless of exit code.

## Actions and network evidence

| Class | Effective treatment / distinct proof |
| --- | --- |
| Shell/unified exec | Disabled in strict CLI flags and effective features; the underlying Linux sandbox is nevertheless tested with fixed synthetic commands |
| Built-in apply_patch filesystem | Separate official exec-server filesystem RPC sandbox, same permission map; real input read/output write and denied sibling/symlink/credential reads, denied input mutation |
| Clock | Read-only server time; no filesystem/process/network authority |
| Plan/request-input | Disabled in verified sessionFlags layer |
| Browser/computer/apps/MCP/plugins, image/media, code-mode, subagents, skill search/install, workspace dependencies, web search | Disabled; MCP config empty; full list is LAB_DISABLED |
| Escalation/request-permissions | Never approvals, request-permissions feature disabled, no root/sudo or mount-helper access |
| Unknown JSONL action | Existing bounded parser aborts; it does not execute model output or expand capabilities |

Filesystem RPC uses the same official
[filesystem sandbox backend](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec-server/src/fs_sandbox.rs)
used by core filesystem actions. The outside-write syscall may succeed **inside
private tmpfs**, but the actual host marker remains unchanged. This is reported
as `outsideWriteDenied:false, outsideUnchanged:true`, not misrepresented as an
EROFS denial. Reads of the actual sibling/credential are denied; task input is
read-only. This does not claim every model-selected patch was exercised by a
model: no model ran. The separately checked backend and fixed invocation policy
are the pre-inference evidence, not an inference from command/exec alone.

Own listeners have four successful trusted-parent controls: Linux IPv4 loopback,
IPv6 loopback, private Linux interface and the Windows WSL virtual NIC. Model
commands reach none; zero hits. The Windows listener is synthetic on that NIC,
not the platform API and not 0.0.0.0. Model netns differs from parent, has only
loopback and no IPv4 route; no external interface means no external IPv6 route
to an external service either. No owned external listener was available: this
is structural namespace/interface/route evidence, **not** a live external-service
denial test. No network scan, real DB probe or firewall change was performed.
The trusted official client remains outside that model-tool netns and retains
ordinary OpenAI transport. Authenticated service access/quota is not yet proven.

## Lifecycle and limits

The fixed Python subreaper runs in a separate Linux session, with real pipes,
PDEATHSIG, descendant adoption and bounded TERM/freeze/KILL/reap. It confirms
the complete owned tree, including setsid children ignoring SIGTERM. Windows
relay loss/EOF, timeout, explicit cancellation and missing pulses are tested
through the real Windows-to-WSL path. Killing wsl.exe alone is not confirmation.
If the relay disappears, the bridge can inspect a private bounded stop checkpoint
and matching process start ticks; it never restarts the model to recover output.
Unconfirmed cleanup returns STOP_UNCONFIRMED and forbids success/cancel-ack.

Input prompt <=16 KiB, schema <=32 KiB, output <=128 KiB; JSONL has stricter
existing line/count limits. One official exec per adapter; 150-second process
limit within the existing 180-second job deadline. Heartbeat watchdog 2.5 seconds.
Stop receipts are scoped random IDs, <=1 KiB, retained 60 seconds, capped at 256;
phase recovery is limited to three minutes and requires reaped owner/supervisor.
No plaintext platform secrets or model reasoning/raw stderr are saved.

## Commands and human checkpoint

PowerShell, repository root; no model call:

```powershell
node scripts/lab/verify-adapter.mjs
# This is a cold-start diagnostic that stops only the lab, then prepares it.
# Day-to-day manual preparation + preflight instead:
node scripts/lab/transfer.mjs
npm run design:preflight -- --codex-wsl
```

Persistent client HOME is `/home/codexlab`, CODEX_HOME `/home/codexlab/.codex`.
The synthetic credential marker in that exact CODEX_HOME is denied to model
tools and removed afterwards; that directory is never a temporary run directory.
Installed `login --help` confirms the following **owner-interactive** command:

```powershell
wsl -d B2B-Codex-Lab -u codexlab --cd /home/codexlab --exec /usr/bin/env -i HOME=/home/codexlab CODEX_HOME=/home/codexlab/.codex PATH=/opt/b2b-lab/node-24.19.0/bin:/usr/bin:/bin LANG=C.UTF-8 /opt/b2b-lab/codex-0.153.4/bin/codex login --device-auth
```

Do not paste device codes or logs into chat. No auth.json copy/read by the adapter,
no API key or automatic account change. Login is not dispatch permission.
After login, repeat preparation/preflight: new account/model/config/requirements
and isolation evidence, exactly gpt-6-astra/ultra, no fallback. Updated policy
requirements stop the process pending investigation, not a blind reuse of receipt.

After successful post-login admission, the already-authorized one real smoke is:

```powershell
npm run db:test:migrate
npm run db:test:status
npm run build
node scripts/lab/transfer.mjs
node scripts/persistence/run-tests.mjs design-live-smoke --confirm-one-real-call
```

That opt-in mode is **never** in ci:full. It requires separate TEST_DATABASE_URL,
reads dev fingerprint only, does not reset/migrate dev, and runs built server plus
a separate environment-filtered Windows Runner, real WSL adapter, normal provider
checks, PostgreSQL result persistence and UI reload. The durable local one-call
reservation survives failure; do not delete it or silently retry. The driver stops
the Runner before reload, checks the saved result and captures six secret-free
screenshots. Until the owner logs in this full live driver is unexecuted, not a
claimed success. No real concepts, output hash or inferred provider success exists.

## Evidence, limits and cleanup

`wsl-adapter-receipt.json` is real local evidence with runtime bundle hash. CI
`wsl-protocol-linux.json` is synthetic native-Linux subreaper evidence, not WSL on
this computer. CI keeps all former persistence/jobs/agents/execution/design/UI
and native Windows checks; six design screenshots remain labelled test CLI.
DEV_DATABASE_UNCHANGED must pass independently. No dependencies or migrations
were added, and no applied migration or production lifecycle was changed.

Assumptions: trusted local operator/Windows Runner and reviewed runtime code;
not isolation from an administrator or malicious same-user Windows process.
Pinned runtime/kernel changes fail closed until reverified. Managed config is
conservatively required empty. Existing dependency audit findings remain outside
this task; no audit fix was run. Actual model/catalog availability after login,
authenticated transport, generation output and independent acceptance are pending.

No merge, main/production/Timeweb/DNS/WordPress/Docker/global WSL action was
performed. The foreign reports/change-report.md remains excluded. Workload ps
after probes contains no Node, Python, Codex or bwrap. Lab removal remains the
manual, name/path-verified [previous removal plan](wsl-lab.md#removal-plan-not-executed),
never automatic; do not operate on docker-desktop or call wsl --shutdown.
