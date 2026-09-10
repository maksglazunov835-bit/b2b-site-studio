# Codex 0.153.4 Protocol And Invocation Diagnostics

## Scope And Budget

This correction is offline. Additional real model invocations: **0**. The previous
authorized attempt reached the official CLI and conservatively consumed the one-call
budget. Its job is failed (`CODEX_PROCESS_FAILED`), with one attempt, one invocation
permit and no result. Registration and the first heartbeat had completed. The actual
CLI exit, last event and provider cause were not retained then and remain **unknown**.
Neither of the protocol defects below proves the cause of that historical failure.
Do not run live smoke or reuse `--continue-unused-reservation` for this review.

Before any reset, the original safe evidence was copied exclusively into the ignored
`.test-results/consumed-archive-ce270a0/` directory with a hash manifest. The original
reservation, continuation, provider-start markers and failed database remain intact.
This pass uses a new disposable test database; a missing row after reset is never a
fresh model-call authorization. Historical events, revisions and migrations are unchanged.

## Pinned Protocol

The [official 0.153.4 Usage definition](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/exec_events.rs)
serializes five counters. The parser now requires all five as nonnegative safe integers:
`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
`reasoning_output_tokens`. Unknown counters, events and executable tool items still
fail closed. A failing test reproduced the former rejection of the full event before
the fix. The corrected test CLI emits the complete pinned event stream.

The existing result report retains its two-counter projection for compatibility.
All five numerical counters are separate receipt metadata. Reasoning text, item IDs,
thread IDs and raw diagnostics are discarded. UTF-8/chunk, ordering, duplicate terminal,
tool, line, byte and event-count limits remain active. Fixture scenarios are fixed
test-process arguments, never selected by brief fields or production JobSpec.

## Provider Wire Schema

The strict server schema and semantic checks are unchanged. A deterministic generated
wire projection uses explicit types, enums, required object properties, closed objects
and arrays. `const` becomes a typed singleton enum. Length, pattern, array-size and
uniqueness constraints remain server-owned, not provider keywords. Generation rejects
unknown source keywords, excessive depth/property/enum/string budgets and optional fields.

This conservative projection was checked against the
[documented structured-output subset](https://developers.openai.com/api/docs/guides/structured-outputs/).
This is a static compatibility check, not proof of provider acceptance. Ajv compilation
alone is not used as such proof. The test executable reads and compares the actual
`--output-schema` file. Server tests still reject unsafe strings and fewer than three
concepts even when the wire schema accepts their structure.

The [pinned exec implementation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/lib.rs)
loads the output schema and passes it to the turn-start request. It does not give this
project an offline guarantee of provider acceptance. No request was made to test that.
Regenerate both wire and runtime manifest only with:

```sh
node scripts/contracts/design-manifest.mjs --write
node scripts/contracts/design-manifest.mjs
```

## One Bounded Receipt

`B2B_CODEX_INVOCATION` version `1.0.0` is at most 4096 bytes. It correlates the startup
run ID with immutable job ID, attempt and runtime/input/wire-schema/job-spec SHA-256.
It records stage, timestamps, last valid event, terminal observation, usage counters,
actual child exit/signal (null if unknown), provider-start observation, confirmed stop
and a separate cleanup code. Only the first primary diagnostic is retained.

Sources are `cli_exit`, `provider_event`, `stderr`, `parser`, `transport`, `sandbox`.
Categories and error codes are allowlisted. Unknown text remains `unclassified`, with
byte length and a SHA-256 fingerprint of at most 4096 bytes; no raw text is saved.
HTTP status stays null unless actual typed evidence exists; a string mentioning 401
is not proof of an HTTP response. No secret, environment, auth response, prompt,
stack, URL or reasoning text is allowed in a receipt.

Examples (other correlation/hash/time fields omitted here):

| Synthetic failure | Primary source/code | Child exit | Cleanup |
| --- | --- | --- | --- |
| CLI exit 2 | cli_exit / CODEX_PROCESS_FAILED, unclassified | 2 | confirmed |
| Auth stderr | stderr / CODEX_LOGIN_REQUIRED, auth | measured, platform dependent | confirmed |
| Provider error | provider_event / CODEX_PROCESS_FAILED, unclassified | measured | confirmed |
| Malformed stream | parser / CODEX_INVALID_OUTPUT, protocol | measured | confirmed |
| Parser exception | parser / CODEX_PROCESS_FAILED, unclassified | measured | confirmed |
| Timeout | transport / CODEX_TIMEOUT, timeout | measured exit or signal | confirmed |
| Auth + lost stop confirmation | stderr / CODEX_LOGIN_REQUIRED, auth | null unless measured | STOP_UNCONFIRMED |

The last case externally remains STOP_UNCONFIRMED. It never becomes success, cancel
acknowledgement or permission for another invocation. A supervisor/relay exit is not
substituted for the official child's exit. Bounded exit/pipe draining retains late
diagnostics without hanging indefinitely. Reports do not mutate the failure API/history.

## Evidence And Reproduction

Run via the existing safe test runner with a separate TEST_DATABASE_URL:

```sh
node scripts/persistence/run-tests.mjs design-regressions
npm run ci:full
```

The fixed synthetic process matrix covers success, exit2, provider error/turn.failed,
config/schema/auth/quota, parser exception, malformed/oversized output, timeout/kill,
and lost cleanup confirmation. Linux runs the actual Python subreaper and Linux relay,
then the same bridge/parser/recorder and Runner IPC consumer used by the Windows adapter.
Native Windows uses the Job Object supervisor and the same bridge/IPC path. This is
not a fresh test of the user's WSL OS isolation or real official inference.

Safe `invocation-regressions-{linux,win32}.json` and `receipt-chain-{linux,win32}.json`
artifacts label their provider as synthetic and modelInvocations as zero. Existing
built-server/Runner tests check saved success/failure, retry and one invocation receipt;
the six desktop/mobile screenshots continue to come from explicitly synthetic output.
The local smoke consumer is wired to save a validated receipt exclusively, but it was
not run during this correction. Linux/Windows CI and independent acceptance are separate.
