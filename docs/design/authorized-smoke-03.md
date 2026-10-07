# Owner authorization pr15-live-smoke-03

Owner comment 6033705747 follows review 5439241501 of head
`34b4ea0be3f45a75b031104e33097197b7083016`. It permits at most one additional
official generator start through platform -> foreground Runner -> existing
B2B-Codex-Lab -> Codex, requesting gpt-6-astra / ultra with the existing ChatGPT
login. No fallback, API key, credits, manual prompt, acceptance or publication.

The existing budget helper now recognizes exactly the separate IDs 02 and 03.
The old constant, directory, receipts and continuation behavior are preserved.
03 has its own exclusive directory/reservation and atomic before-dispatch
provider-start marker. Head, manifest, input hash and new job are bound together.
It also fingerprints all 15 files of consumed smoke-02 and checks that history
again before binding/consumption, in addition to the original 12-file archive.
No 03 continuation is supported. Repeated commands/messages and parallel starts
cannot create a second allowance. A failed or uncertain start is never refunded.

Perform builds and current-head Linux/Windows CI before preparing the lab.
Use only a fresh, explicitly separate `b2b_site_studio_live_smoke_03_test`
database through the protected runner. Never reset either historical smoke DB
or the persistent dev target. Capture their read-only fingerprints before tests.

After CI, apply the existing explicit per-boot lab helper. The smoke's bounded
unprivileged holder retains that prepared session. Before creating the project
or job, the smoke runs the fixed `prepare-only` operation through final_compare,
then current official adapter admission. The Runner and invocation retain their
own fresh hash/config/authorization/model/isolation checks. No new runtime,
model, permission or isolation policy is introduced by this authorization.

```powershell
node scripts/lab/transfer.mjs
node scripts/persistence/run-tests.mjs design-live-smoke --confirm-one-real-call --authorization pr15-live-smoke-03
```

These commands require the verified separate TEST_DATABASE_URL and green CI;
they are not routine diagnostics and must not be repeated after a failed attempt.
Outputs are append-only under `.test-results/pr15-live-smoke-03`. The synthetic
input remains the fixed six-field stationery B2B catalog brief. Success requires
strict server validation, provider=codex, three concepts, one attempt/invocation,
revocation and confirmed Runner stop, unchanged result after reload, clean
desktop/mobile console and six safe screenshots. Receipt fields distinguish
actual provider start, numerical usage and success from an invocation permit.
Account/model catalog selection alone does not establish successful inference.

On failure preserve the primary bounded diagnostic, phase and actual CLI/Runner
exit/signal separately from cleanup. Unknown values remain unknown. No new
inference is authorized to investigate a preliminary failure. Previous histories
and this attempt's evidence survive all outcomes. Stop only owned test processes;
do not change production, Docker, global WSL, applied migrations or user files.
