# Additional owner-authorized smoke

The owner explicitly authorized `pr15-live-smoke-02` on 2026-10-07 after
review 5171129862 of head `27ac6a2a0d280a1840cabdd57b66e538b97ad989`.
This permits at most one additional generation invocation, not acceptance,
publication, or a reset of the previous consumed budget.

## Bounds

- Existing platform -> foreground Windows Runner -> B2B-Codex-Lab -> official
  Codex 0.153.4, `gpt-6-astra` / `ultra`, existing ChatGPT login only.
- Fresh adapter admission before registration and invocation. No changed
  isolation, alternative provider, API key, automatic model retry or new VM.
- Current-head Linux/Windows CI must pass before the opt-in command is run.
- Old failed database, original markers and all 12 archived files remain
  unchanged. Read-only database fingerprints are checked before and after;
  test reset gates use a different disposable target from both live histories.
- The live command accepts only `b2b_site_studio_live_smoke_02_test` through
  the protected runner. It never migrates or resets that database itself.

## Durable records

`scripts/lab/smoke-budget.mjs` accepts only the exact authorization ID. An
exclusive directory `.test-results/pr15-live-smoke-02` locks the entire run,
including preparation, across processes. A failed/partial reservation is
retained and cannot be silently reused. No missing SQL row grants a budget.

The append-only reservation binds the current head, adapter manifest, mapped
synthetic brief hash, reviewed head and previous archive hashes. The job
binding records a new project/job, pinned revision and SiteSpec hash. An
exclusive provider-start marker consumes the permit **before dispatch**.
This is a conservative local permission record, not proof of provider usage.
Unknown outcomes never refund it. A separate invocation receipt measures the
actual observed CLI lifecycle; unobserved fields remain unknown.

All JSON evidence is bounded and exclusively created in the new directory:
preflight, project binding, failure/terminal receipt, startup/invocation,
validated report and reload hashes. Successful UI verification produces six
safe desktop/mobile screenshots there. Existing reports are not overwritten.

## Opt-in command

Export the separate test target in the local shell (not the old failed
database or the user's dev database), migrate/status it via the safe runner,
and build the same committed checkout. After green CI and successful checks:

```text
node scripts/persistence/run-tests.mjs design-live-smoke --confirm-one-real-call --authorization pr15-live-smoke-02
```

This command is deliberately excluded from CI. It cannot use
`--continue-unused-reservation`, a caller-selected model/budget/authorization,
or a test stub. Do not run it again after a failure. A preflight failure
stops without dispatch or inference; do not weaken the failed boundary.

## Model-free verification

`tests/design/budget.test.mjs`, already included in Linux full CI and native
Windows regressions, tests concurrent real-process reservation, concurrent
consumption, repeated execution, changed bindings, unrecognized permits,
historical evidence integrity, append-only reports and no refund on failure.
Existing protocol, receipt, process-tree and strict output tests remain active.
These synthetic checks are not evidence of a successful real generation.
