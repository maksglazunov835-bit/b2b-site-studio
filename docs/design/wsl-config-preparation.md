# WSL configuration comparison and model-free preparation

Follow-up to PR #15 review 5438670044, 2026-10-07. This pass authorizes
**zero generator invocations**. `pr15-live-smoke-02` remains consumed;
neither a successful diagnostic nor an empty/reset test database refunds it.
No third reservation, dispatch, claim, start, permit or model request was made.

## Reproduction and correction

The permanent key-order test first failed using the old
`SHA256(JSON.stringify({config, requirements}))` formula. Its two hashes were
`f22ad2695a9d26b726c1d4ec2cdde81050b611491967b829478d74daf4c6cacc`
and `f4075b9379c04e25f822d9542295bd6d62309c88d78950679c89305e0506a4df`.
Only object insertion order differed.

`wsl-config.mjs` now imports the existing persistence `sha256Json`, which is
also delivered unchanged in the fixed WSL bundle. No second canonicalization
algorithm was introduced. Full config and requirements are compared, including
unknown keys, own `__proto__`, `constructor` and `prototype`. Arrays remain
ordered; missing and null remain different. Historical hashes are not repaired.

The real paired readings below reproduced the old rejection predicate within
each single task context: unequal raw hashes, equal canonical hashes, zero
changed/missing/unexpected values. New run IDs intentionally produce different
path-dependent hashes and must not be compared with each other.

## Actual Windows-to-WSL evidence

Final runtime bundle SHA-256:
`02ce83df785e8bb42d442f30d94547461de2b79d2d024b3ea289cb4c91210ccf`.
Three consecutive complete preparations finished at 07:25:12, 07:25:19 and
07:25:25 UTC. All returned `key_order_only`, `providerStarted=false`,
`modelInvocations=0`, phase `final_compare`, with confirmed cleanup.

| Pass | Canonical hash, identical before/after | Raw hash before | Raw hash after |
| --- | --- | --- | --- |
| 1 | `58b054fbef0db1d6be08acafc0fa38c1b596ae634740a0bde2d3caa623a95891` | `255986ca9886531fa9155eb2849a984cc2aaded11a6d271301555bf387d16bc2` | `db287da37220c8f1d53d5b9b8a7a94b3fc931a333d62b2b89ddca79a68fb0e00` |
| 2 | `e98a0ffcd33a33b2f4654ebbb5fefbeb8a9d7e26f9ae1b4eb6fcc0a9faf02bfc` | `ff9c0b25629d6cd2194cc09d654ee718b16b2ad4f5df390657aae3765f11f0c1` | `84787deedb2f121c469440fd52ef991c822b819f551991539e544cce014589ed` |
| 3 | `6c865ac9878c9768c52d481736e872ac2055f58fc3f7e37e563363eaf7549a8c` | `fafd6c4d4eec46f2ae4152b00fabda28e33368111347d5cdceb0b9e9fea7265a` | `68f6a3913c78df91d76fddd5edc95dafde4e0f6401d2d45e690076b358741211` |

Existing Codex 0.153.4, Node 24.19.0, kernel, binary hashes, account type
`chatgpt`, and official `gpt-6-astra` / `ultra` catalog selection were rechecked.
This proves catalog availability, not inference or independent acceptance.
No login, installation, DNS, model, effort or global WSL configuration change.
Only the existing explicit per-boot lab mount preparation was used.

Each pass checked all 19 existing command canary assertions and all four
reachable network positive controls, with zero forbidden connections. Separate
filesystem backend checks confirmed input/output and denied reads/writes to
input, sibling, symlink and synthetic credential. Its historical
`outsideWriteDenied=false, outsideUnchanged=true` observation is preserved,
not misreported as a denial response. External network evidence remains a
different namespace, no external interfaces and no routes, not an external
listener test. Managed requirements, mounts and permission gates were not weakened.

Local full receipt: `.test-results/pre-invocation-5bbb909c-9c24-4779-9f45-595d6a6b6062.json`.
An earlier development check failed closed when diagnostic refactoring removed
the transient OS-error classification needed by the filesystem canary. This was
corrected without weakening assertions; raw filesystem errors remain in trusted
memory only. The earlier receipt is retained. A prior three-pass diagnostic
also succeeded before final formatting; neither sequence invoked a model.

## Shared boundary and safe diagnostics

Both actual invoke and the separate `prepare-only` operation execute the same
canaries, first config probe, input preparation, lab inspection, second probe
and canonical comparison. The diagnostic uses the same prompt builder, a fixed
six-field synthetic brief and the current wire schema. It returns before the
explicit invoke-only provider branch. Request-selected prompt, schema, paths,
commands and model parameters are rejected for this operation.

The existing bounded diagnostic receipt has an optional allowlisted `config`
object. Old receipts remain valid. Reasons distinguish inherited config, legacy
sandbox, profile, filesystem, approval, web, tools, network, MCP, features,
managed requirements, RPC errors/malformed responses, empty/failed diagnostic
process, account change and final mismatch. Phases are `first_config`,
`after_input`, `final_compare`. RPC data is restricted to known method names and
numeric codes. Comparison carries hashes, allowlisted top-level field names,
bounded counts and `key_order_only` / `value_changed` / `missing` / `unexpected`.
Unknown names, values, auth replies, raw configs, paths and URLs are not saved.
Primary diagnostics survive the existing relay and remain separate from cleanup.

Model-free operator command (uses no database or budget):

```powershell
node scripts/lab/verify-pre-invocation.mjs --confirm-model-free
```

## History and limits

Before any reset, both historical databases were read in repeatable-read,
read-only transactions. The failed jobs remain failed, and 12 archived originals
plus all 15 second-smoke files were hashed without rewriting them. Tests use
only the separate disposable `b2b_site_studio_protocol_test` target.

- First historical database: `05d622971703faf03d51d0fc528db53602ea91c255281a065d7c754628a7a0ca`.
- Second historical database: `411bdde3e78a698e8f0b2fe837a0825860cfcbcf1a546c235126ffed36377302`.
- Dev fingerprint: `4be5f5d741f30e0fa6e5bba63aa2316719785bddce295c886afe2ba97bd4fc67`.

The prior failed smoke recorded only `LAB_CONFIG_CHANGED` before provider start.
Its precise historical predicate remains unknown. Today's same-context paired
readings prove that the unstable comparison can reproduce that failure, not
that no other predicate failed historically. No real design generation succeeded
in this follow-up. Any further inference needs separate owner authorization.

New tests run in protected `design-regressions`, native Windows CI and the Linux
full gate. CI artifacts include bounded config diagnostic receipts plus the
existing synthetic desktop/mobile screenshots, never real Codex credentials.

Local verification: `npm ci`, protected migration/status (six applied, unchanged
checksums), 49 native design regressions, `npm run lint`, and all 20 `ci:full`
steps passed. The full gate includes `npm run ci`, contracts, lint/build,
database/HTTP/process/UI/access/shutdown checks. All 56 ordinary legacy fixture
hashes remain compatible. The before/after read-only history fingerprints and
all preserved file hashes match; `DEV_DATABASE_UNCHANGED` is confirmed.

`npm ci` reported 30 existing advisories (including three critical); no dependency
versions or audit fixes were applied in this scoped task. Unrestricted working
tree `git diff --check` reports pre-existing whitespace in the owner's excluded
`reports/change-report.md`; it was not edited. The implementation diff is clean.
