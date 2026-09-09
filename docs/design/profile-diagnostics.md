# Official Runtime Diagnostics, 2026-09-09

Review: PR #15 / 5135047530. This is a read-only diagnostic, not a model smoke.
Actual model calls for both the original implementation and this repair: **0**.

## Reproduction

```powershell
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
Get-AuthenticodeSignature $codex | Select-Object Status
node scripts/codex-profile-diagnostic.mjs "$codex"
```

The committed probe runs only version/help/features/login status, offline protocol
schema generation, and the official stdio `initialize`, `config/read` and
`configRequirements/read` methods. It never sends `thread/start`, `turn/start`,
prompt-input, MCP calls or `exec` inference. Temporary schemas are removed.
Configuration replies stay in bounded process memory; only selected policy fields,
boolean feature values and requirement-key names are emitted. No raw config layers,
stderr, identity, managed instructions, paths or authentication content is retained.
The user's configuration is neither edited nor copied; auth.json is not read by us.

## Observed Identity

- Official native Windows executable: `codex-cli 0.153.4`.
- SHA-256: `e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75`.
- Authenticode: Valid, OpenAI OpCo, LLC; existing login status: ChatGPT.
- Fixed proposed model/effort remain `gpt-5.6-luna` / `medium`.
- Unknown versions remain unsupported; no manual flag can unlock `ready`.

## Verification Matrix

| Setting or boundary | Official source | Actual check | Result |
| --- | --- | --- | --- |
| Read-only sandbox / no escalation | [CLI reference](https://developers.openai.com/codex/cli/reference/) | Installed exec help; read-only app-server config/read with fixed overrides | `sandbox_mode=read-only`, `approval_policy=never` confirmed for diagnostic app-server, not an exec tool inventory |
| Web search | [Configuration reference](https://developers.openai.com/codex/config-reference/) | config/read | `web_search=disabled` |
| Shell and unified exec | Same configuration reference | Installed features list and config/read | Both supported and false |
| Apps/browser/computer/hooks/plugins/images and other adapter feature toggles | Same configuration reference | All 23 exact switches in execArguments checked in features list and config/read | All supported/stable; all 23 false in diagnostic instance |
| Managed requirements | [App Server](https://developers.openai.com/codex/app-server/) | configRequirements/read, no writes | `requirements=null` for this instance; not a guarantee for future policy/runtime changes |
| Ignore user config/rules; strict config | Installed exec help and CLI reference | Flag availability | Present. App-server does not expose exec's ignore-user-config flag; its config receipt cannot certify identical exec layering |
| Extra tools versus built-ins | Generated 0.153.4 ThreadStartParams plus App Server documentation | Offline schema, including experimental fields | `dynamicTools` exists; no explicit builtinTools/allowedTools/toolChoice field in that request. An empty extra-tool list is NOT proof that built-ins are disabled |
| Effective built-in tools in exec | CLI reference / config schema / installed help and offline schema | Look for an effective per-invocation inventory or fully enforceable empty-tool policy | Not established. Catalog apply_patch metadata does NOT prove that tool is active in a specific invocation |
| Reasoning versus execution events | [Non-interactive protocol](https://developers.openai.com/codex/noninteractive/) | Strict synthetic JSONL fixtures, real child streaming | Reasoning notifications discarded; executable and unknown events stop the owned process. This is detection, NOT pre-inference isolation |

The full list of requested feature names and observed booleans is reproducible from
the probe; it is also the fixed argv list in the adapter. No model is needed to run it.

## Decision and One Alternative

**Still blocked: CODEX_SAFE_PROFILE_UNVERIFIED.** We now have actual non-secret
configuration receipts, not just a catalog/help inference. However the inspected
interfaces do not establish an empty built-in tool set with identical exec config
and managed-policy application before inference. This is an evidence gap, not a
claim that every possible official Codex release can never support such a profile.
The live safety gate stays false. No genuine proposals, output hash or live reload
evidence are claimed. Native fixture cancellation is not an actual Codex smoke.

One minimal official alternative for reviewer/owner decision is the public
**Responses API** with an empty tool list, `tool_choice: "none"`, strict structured
JSON output and `store: false`; use the same brief mapping, one-invocation budget,
validation/storage and preview. Official sources: [tool choice](https://developers.openai.com/api/docs/guides/function-calling#tool-choice)
and [structured output](https://developers.openai.com/api/docs/guides/structured-outputs).
This avoids a local agent tool runtime but changes the authentication and billing
boundary: it needs separately authorized API credentials, quota/spend controls,
network permission and selection of a model actually available to that API account.
Existing ChatGPT login is not silently reused as an API credential. The currently
chosen CLI model is not assumed to be an available public API identifier.
No alternative provider, API call, credential setup or second integration has been
implemented. This is a proposal requiring explicit approval, not a fallback.

## Process and Protocol Repair

Windows: the trusted bundled C# source is compiled by the installed .NET Framework
compiler into an owned temporary native executable, not PowerShell or shell text.
CreateProcess starts suspended; the child is assigned to a Job Object before ResumeThread.
Breakaway is not enabled. Kill-on-job-close and ActiveProcesses==0 provide the tree
boundary independent of leader exit or inherited pipes. Stop uncertainty is fatal.
The helper carries no job tokens/configuration secrets; model text remains stdin data.
Missing compiler/job support fails closed. This adds no npm dependency or installation.

Linux: own detached process group, TERM then unconditional escalation while members
remain; /proc distinguishes non-running zombies from live members. Leader close never
cancels escalation. Drain and cleanup are bounded independently. The scope is the owned
process group, not a sandbox against malicious code deliberately escaping that group;
live execution of arbitrary code remains forbidden. macOS is conservative about groups
that cannot be proven empty and is not covered by the Linux/Windows CI matrix.

JSONL is decoded incrementally with fatal UTF-8 checks, total-byte/line/count limits,
ordered lifecycle/reasoning/final states, exactly one final result, and immediate
rejection of forbidden events. Only bounded structured proposal and token counts
survive. Known stdin-read diagnostic is distinct from critical ignored configuration,
auth/quota and unknown errors. No raw stderr or reasoning is a report field.

The protected `design-regressions` mode runs native Windows/POSIX fixtures plus
streaming tests, including a live TERM-ignoring descendant, early leader exit,
closed/inherited stdio, abort/timeout/revoke and early forbidden-event termination.
An unrelated sentinel process must remain alive. CI runs this inside the full Linux
gate and separately on Windows with a native C# descendant fixture; neither invokes
a model. Existing HTTP cancel/revoke/STOP_UNCONFIRMED and one-call tests remain active.
