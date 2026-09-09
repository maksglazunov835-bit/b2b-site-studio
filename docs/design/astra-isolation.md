# Astra and Isolation Verification, 2026-09-09

Scope: existing PR #15, owner [comment 5601101683](https://github.com/maksglazunov835-bit/b2b-site-studio/pull/15#issuecomment-5601101683)
and [Issue #14 clarification](https://github.com/maksglazunov835-bit/b2b-site-studio/issues/14#issuecomment-5601126345).
Issue #16 remains the next quality milestone, not implemented here.

## Model Evidence

- Developer session: latest local `turn_context` at `2026-09-09T11:49:51.944Z`,
  model `gpt-6-astra`, effort `ultra`. Only these metadata fields were inspected;
  no model switch was necessary or claimed.
- Official installed client: `codex-cli 0.153.4`, executable SHA-256
  `e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75`.
  Existing Authenticode evidence: Valid, OpenAI OpCo, LLC.
- Actual stdio app-server `initialize -> account/read(refreshToken:false) -> model/list`,
  checked at `2026-09-09T11:54:21.569Z`: ChatGPT account type; one catalog page;
  exact visible model `gpt-6-astra`; supported efforts `low, medium, high, xhigh, max, ultra`;
  text/image input. Highest advertised effort is **ultra**, not a guessed `max`.
- `model/list` supports pagination. The committed reader bounds pages, bytes, cursors and time,
  requires ChatGPT, and rejects missing/ambiguous Astra, unknown efforts and catalog failures.
  No account email, ID, token, raw stderr or config is retained.
- New jobs pin Astra/ultra in 1.4.1, adapter 1.1.0 and runtime DTO. An installation that no longer
  advertises that exact capability is rejected, not silently downgraded. No fallback, API-key
  billing, proxy, credits purchase, auth-file read/copy or login/config modification occurred.
- This proves catalog availability, **not an inference request or quota availability**.
  Report 1.1.0 separates requested/catalog-resolved model from `observedModel: null`.
  A model's own text never serves as identity evidence. The CI source is `test_fixture`, not Codex.

## System Boundary: Failed, Not Verified

The fixed candidate in `agent/codex/permission-profile.mjs` uses installed documented syntax:

```toml
default_permissions = "b2b-design-json"
approval_policy = "never"
permissions.b2b-design-json.filesystem = { ":root" = "deny", ":minimal" = "read", ":workspace_roots" = { "." = "read", "output" = "write" } }
permissions.b2b-design-json.network.enabled = false
windows.sandbox = "elevated"
windows.sandbox_private_desktop = true
```

The same profile builder is used by the candidate exec argv and the official app-server
`command/exec` canary, explicitly selecting `permissionProfile: b2b-design-json`.
No inference thread/turn is created. Only a fixed Node probe reads synthetic task/sibling markers,
tries writes and accesses an owned TCP sentinel. It never reads real documents, credentials,
repo content or a database. Temporary junctions are removed before the owned directory.
The trusted client retains its normal login resolution; model-directed processes are the
boundary under test. Environment allowlisting removes platform/DB/GitHub/API variables.

Actual final probe matrix (official command exit 0; diagnostic exit 1):

| Check | Observed |
| --- | --- |
| Tool process under dedicated `CodexSandboxOffline` user | Yes |
| Read own input / write own output | Both allowed |
| Overwrite read-only input / outside marker | Both denied; marker unchanged |
| Read sibling marker outside task | **Allowed: failure** |
| Read outside marker through junction / alternate path | **Allowed: failure** |
| IPv4 / IPv6 loopback connection to sentinel | **Both allowed: failure; 2 connections** |
| Platform credential environment names in child | Absent |

Config/read confirms the named root-deny/network-disabled/elevated profile. It also reports
the user's inherited legacy `sandbox_mode= danger-full-access`; we did not enable or modify it.
The probe explicitly selects the named profile, and write denials/dedicated user show restricted
execution, but inherited config is another reason this is not proof of identical exec isolation.
The future exec argv ignores user config/rules. No full-access invocation or bypass was used.
The app-server rejects custom `outputBytesCap` with Windows sandbox; parent capture remains
bounded to 128 KiB and 15 seconds, with a 6-second command timeout. These are not model calls.

Firewall profiles were enabled, the firewall service running, and existing Codex offline
outbound block rules enabled. No firewall/ACL/user changes were made. These observations do
not repair the failed canaries. External/private-network targets, credential-denial fixtures
under a verified root and a real exec model/tool boundary have **not** passed; local failure
already blocks inference. Empty cwd, read-only flags and process Job Objects are insufficient.

Current gate: **CODEX_ISOLATION_UNVERIFIED**, enforced in preflight, normal registration and
the official adapter. Historical CODEX_SAFE_PROFILE_UNVERIFIED remains a recognized old code.
No environment switch or request body can turn the normal provider into `ready`.

## Reproduction (No Model Calls)

```powershell
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
node scripts/codex-model-diagnostic.mjs "$codex"
node scripts/codex-isolation-diagnostic.mjs "$codex"
npm run design:preflight -- --codex-bin "$codex"
```

The isolation diagnostic is an explicit operator command, not startup behavior or public CI.
It runs a fixed synthetic command only, no user text is interpolated into a shell.
Public CI uses bounded named synthetic CLI fixtures and the complete protected `ci:full`.
The real version/catalog/isolation probes need no database. Full tests require the separate
safe TEST target as documented in the persistence guide.

## Real Smoke Versus CI

- Actual provider invocations for this work: **0**. Real smoke is **blocked** before spawn.
- Three real Astra concepts, server persistence and real-result reload: **not demonstrated**.
- Separate stub gates exercise process, parser, cancellation/revoke, one-call budget,
  validation, storage/reload and six safe desktop/mobile screenshots. They never become
  claims that real Codex is connected or that design quality was independently accepted.
- The previous process-tree/stream parser repairs remain unchanged. No retry of a model
  invocation is allowed after uncertainty; only exact bounded terminal receipts can replay.
- Old 1.4.0 Luna schema and report provenance remain unchanged. Migration 006 extends failure
  codes only; permanent upgrade and pure contract tests cover historical preservation.

## One Proposed Owner Action

Approval was requested for an isolated WSL2 Ubuntu environment, not yet installed. The machine
currently has only Docker Desktop's WSL distribution. The proposed boundary disables Windows
drive automount and Windows interop, installs the official Linux Codex in the isolated system,
uses its supported ChatGPT login without copying auth files, and uses Linux namespace sandboxing
with only synthetic input/output mounts and denied model-directed networking. It must pass
same-profile file/network/secret canaries and version/model checks before a real call.

This requires owner approval and potentially UAC; no infrastructure, system-wide access rules,
services or user configuration were changed. It is a proposed testable boundary, **not a
promise that installing WSL alone fixes isolation**. Without approval or verified canaries,
keep real invocation blocked. After verification the previously authorized synthetic smoke
still permits at most one official Astra model invocation, never a silent repeat.

## Sources

- [Official app-server: model/list, account/read and command/exec](https://learn.chatgpt.com/docs/app-server)
- [Official permission profiles and trusted-client versus sandboxed-command networking](https://learn.chatgpt.com/docs/permissions)
- [Official Windows elevated/offline-user sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)
- [Official sandboxing and Linux namespaces](https://learn.chatgpt.com/docs/sandboxing)
- [Astra model reference](https://developers.openai.com/api/docs/models/gpt-6-astra)

Installed help and generated local protocol schema were checked before diagnostics. The API
model page is not a billing or transport change; the actual CLI catalog determines the effort.

## Subsequent authorized lab investigation

The 2026-09-09 follow-up is recorded in [wsl-lab.md](wsl-lab.md). It compares
Windows configuration sources and installs the one owner-authorized WSL lab.
The original results above remain historical evidence; live execution is still
blocked and the WSL investigation is not a successful model smoke.
