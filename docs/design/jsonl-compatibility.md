# Pinned JSONL compatibility and exact parser diagnostics

This is model-free work for review 5439874390. No official generation, live
smoke, new budget or authorization is involved. All three failed histories,
including consumed smoke-03/job_c347055b4c1a47ceb6e696828c88e6c5, are immutable.

## Sources and fixture provenance

Pinned official source, not current unversioned documentation:

- [exec_events.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/exec_events.rs)
- [actual JSONL producer](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/event_processor_with_jsonl_output.rs)
- [producer tests](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/event_processor_with_jsonl_output_tests.rs)
- [caller and lagged-event formatter](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/exec/src/lib.rs)

The first three downloaded source SHA256 values are recorded in
`tests/design/upstream-jsonl-fixtures.mjs`. The warning shape/text is transcribed
from `runtime_warning_emits_a_non_fatal_error_item`. Config/deprecation use
the producer's summary plus optional parenthesized details. Reroute uses its
fixed prefix/from/to/reason formatter; lost-event text uses
`lagged_event_warning_message` with synthetic skipped=2. Auth/quota/unknown
messages and design output are explicitly synthetic test inputs, not captured
live responses. Tests run offline and do not fetch or invoke Codex. Rust/cargo
is not installed on the local Windows host; the actual Rust emitter was read,
not compiled or executed. No toolchain installation was attempted.

## Compatibility matrix

All JSONL envelopes have `type`. Item envelopes have `item` with `id,type`.
Names below are pinned wire names; unknown fields are never ignored.

| Event/item | Producer structure and order | Local handling/policy |
| --- | --- | --- |
| thread.started | thread_id:string; print_config_summary emits first | One bounded nonempty ID, initial -> thread. |
| turn.started | No payload fields; TurnStarted notification | thread -> turn, one turn only. |
| item.completed / error | id,type,message:string; collect_warning, ConfigWarning, DeprecationNotice, ModelRerouted | Recognize before the generic turn gate, including startup/pre-turn; classify then stop. No notice becomes success or a tool permission. |
| error | message:string; Error notification adds optional details into message; serialization fallback also emits this | Recognize before/during turn, record provider error and stop. Producer may continue to turn.failed; this profile does not. |
| turn.failed | error:{message:string}; failed turn, explicit error then previous error then fixed fallback | Recognize in turn, terminal failure, never a proposal. |
| item.completed / reasoning | id,type,text:string; summary joined with newline, empty summaries filtered | Discard text, retain only bounded ID for duplicate checks. Only before final answer. |
| item.completed / agent_message | id,type,text:string; producer sets final_message | Exactly one strict JSON DesignProposal; no prose, multiple responses or relaxed schema. |
| turn.completed | usage with input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens | Only after valid proposal; all five counters required safe nonnegative integers. No usage defaults added by parser. |
| item.started / reasoning or agent_message | map_started_item returns None | Not emitted by this producer; reject order, not a blanket ignored notification. |
| item.updated / reasoning or agent_message | No mapping in producer | Reject order. |
| item.started/completed / command_execution | command,aggregated_output,exit_code:null/integer,status:in_progress/completed/failed/declined | Recognized type, FORBIDDEN_ACTION before accepting any payload. No command is executed by the parser. |
| item.started/completed / file_change | changes:[{path,kind:add/delete/update}],status:in_progress/completed/failed | Deliberate FORBIDDEN_ACTION. Actual producer maps ItemStarted as well as completion; do not rely only on enum comments. |
| item.started/completed / mcp_tool_call | server,tool,arguments,result:null or {content,structured_content,optional _meta},error:null or {message},status | Deliberate FORBIDDEN_ACTION, even when failed or content appears benign. |
| item.started/completed / collab_tool_call | tool:spawn_agent/send_input/wait/close_agent,sender_thread_id,receiver_thread_ids,prompt:null/string,agents_states,status | Deliberate FORBIDDEN_ACTION. Producer maps resume to wait, drops unsupported tools/interrupted notifications. |
| item.started/completed / web_search | id,query,action (WebSearchAction, fallback other) | Deliberate FORBIDDEN_ACTION; no URLs consumed. |
| item.started/updated/completed / todo_list | items:[{text,completed:boolean}]; starts on plan, updates, completes before terminal | Deliberate FORBIDDEN_ACTION for this JSON-only profile, not a new planning tool. |
| other item/event/fields | Not in pinned enum or allowed envelope | UNKNOWN_ITEM_TYPE / UNKNOWN_EVENT_TYPE / UNEXPECTED_FIELDS. Values/names never enter receipts. |

The producer reconciles unfinished mapped tools at turn completion before the
terminal event; this never makes forbidden tools acceptable. Hook, model
verification, turn diff and unknown server notifications emit no JSONL here.
Token usage notifications update producer state, not standalone JSONL events.
Interrupted turns initiate shutdown without a terminal success event; local
EOF/exit checks still refuse an incomplete result. ID mapping in the producer
does not justify duplicate or out-of-order events in our single-turn profile.

## Notice policy, separate from protocol validity

The producer maps four notification origins to the SAME error-item shape,
losing their typed origin. `CodexStatus::Running` is not a safety decision for
this application. No new noncritical error-item continuation is allowlisted:
there is no sufficiently specific, proven-safe message in the inspected test.
In particular, `invalid global instructions` stops as NOTICE_CONFIG.

| Content classification | Stable reasonId | Existing failure code |
| --- | --- | --- |
| critical/unknown/ignored/invalid config or instructions | NOTICE_CONFIG | CODEX_SAFE_PROFILE_UNVERIFIED |
| authentication | NOTICE_AUTH | CODEX_LOGIN_REQUIRED |
| quota | NOTICE_QUOTA | CODEX_QUOTA |
| producer's model reroute prefix | MODEL_REROUTED | CODEX_MODEL_CAPABILITY_MISMATCH |
| lagged/lost/dropped events | EVENTS_LOST | CODEX_PROCESS_FAILED |
| other warning/deprecation | NOTICE_UNKNOWN | CODEX_PROCESS_FAILED |
| invalid output schema diagnostic | OUTPUT_SCHEMA | CODEX_INVALID_OUTPUT |

All rows stop, including unknown or blank error-item text. Nothing permits a
fallback. The existing exact stderr stdin banner and blank stderr lines alone
remain ignorable; that exception is NOT reused for item/error messages.

## Diagnostic semantics

The existing bounded `primary` receipt gains optional `parser` metadata:
stream, state-before, 1-based per-stream lineNumber, reasonId, known eventType,
known itemType, bounded unknownFieldCount and byteScope. Unknown enums become
`unknown`, absent/unparseable enums are null; arbitrary names/values never leave
the parser. Legacy primary receipts remain valid and are not rewritten.

- `complete_line`: byteLength is the UTF-8 JSONL/text content of exactly one
  line, excluding LF and its optional preceding CR. Fingerprint is SHA256 of
  its first min(length,4096) bytes; fingerprintBytes states that bound. It is
  intentionally NOT a hash of the whole message beyond 4096 bytes.
- `partial_line`: fatal UTF-8 uses the exact prefix through its first invalid
  byte (or incomplete prefix at EOF). A byte/stream limit uses the prefix at
  the first exceeding byte. Unterminated EOF uses the buffered prefix, even if
  it happens to parse as JSON. No prefix is presented as a complete event.
  Stderr is not JSONL: a no-newline EOF still classifies auth/quota/config or
  unknown diagnostics, while retaining partial_line rather than claiming a
  complete framed message. A partial benign banner is not enough to continue.
- `stream_end`: no bytes/hash, next line number; missing terminal success is
  INCOMPLETE_STREAM. Actual abnormal process exit retains its separate cause.
- Line count overflow has the first rejected complete normalized line and
  LINE_COUNT_LIMIT. Limits remain 20,000 stdout/4,096 stderr content bytes,
  100/32 lines and 131,072 raw bytes per stream. Framing is incremental/bounded.
- For malformed/partial lines no type is guessed from substrings. Forbidden
  recognized tools fail before consuming their payload; this is not approval
  of every field of a forbidden body. Unknown-field counts only describe
  envelopes inspected before refusal.
- A parser failure is sticky. Its line-scoped cause survives STOP_UNCONFIRMED;
  cleanup does not replace the primary diagnostic or imply model success.

No raw message/stdout/stderr/reasoning/prompt, identity, path, credential or
unknown field name is saved. Observer exceptions also fingerprint the current
line, not the exception's potentially secret message.

## Reproduction and history boundary

Before this change, the upstream warning after thread.started gave generic
CODEX_INVALID_OUTPUT. Its diagnostic lengths were 104 (line including LF),
161 (coalesced with thread.started), and 1 (last newline alone). After the
change, the same event gives NOTICE_CONFIG / CODEX_SAFE_PROFILE_UNVERIFIED
and the same 103-byte normalized line fingerprint for all chunk splits and CRLF.

This proves a parser defect, NOT the cause of smoke-03. Its historical 258
bytes describe an old transport chunk, not an established rejected-event size.
The original report's stronger description of 258 bytes as a message size is
superseded by this clarification; immutable original receipts/reports remain.
The actual rejected event/content is unknown and must not be reconstructed by
guessing hashes. Exactly one official generator start was observed then; no
successful inference/usage/result was confirmed. Its budget stays consumed.

Permanent offline tests cover all notice categories before thread/turn and in
turn, malformed/unknown/forbidden inputs, exact chunk-invariant UTF-8/CRLF
diagnostics, partial cases, five-counter usage and a full synthetic success.
The existing supervisor/relay/shared bridge/Runner IPC chain exercises the
same cases on Linux and native Windows, including loss of stop confirmation.
They are included in protected design-regressions and ci:full, not a live test.
