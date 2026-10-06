# Explicit cold-start preparation (PR 15)

This is the owner's follow-up to review 5433068735, not permission for a
new budget, VM, service, production operation or automatic job setup.

## Boundary

`transfer.mjs` sends the committed `prepare-mounts.sh` and
`mount-preparation.mjs` to the existing lab. Root is used only for this explicit
operator action. It verifies Ubuntu 24.04, distro identity, an idle process
inventory and equality of its mount namespace with the lab's PID 1.
It rejects unrecognized mounts, stacked targets, different parents and
shared/slave roots. All five removable roots must be immediate children of
the already-private `/`; the helper does not change root propagation.

The fixed targets are `/tmp/.X11-unix`, `/mnt/wslg`, `/mnt/wsl`,
`/usr/lib/wsl/drivers` and `/usr/lib/wsl/lib`. Only the three known WSLg children
are allowed. Each subtree is made recursively private, verified, then removed
child-first with a fresh parent-private check. There is no lazy/force unmount,
directory deletion, temporary namespace, nsenter, sudo grant or Docker action.
Retained mountinfo lines and DNS content hashes must remain identical.

This distinction follows Linux's documented
[parent propagation semantics](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html).
Preparing only a target does not prove removal of that target is local.

## Resolver and lifetime

The first real repeat exposed WSL recreating `/etc/resolv.conf` as a link to
the removed `/mnt/wsl/resolv.conf`. The helper now preserves the exact generated
resolver bytes and sets only `[network] generateResolvConf=false` in this lab's
known `/etc/wsl.conf`. Unknown config fails closed; Windows DNS, global WSL
configuration and resolver addresses are never edited. This documented
[per-distro setting](https://learn.microsoft.com/en-us/windows/wsl/wsl-config#network-settings)
requires an explicit lab-only restart on first preparation. No backup/public
resolver is guessed. On a future host-network change the operator must review
lab DNS again; a failed official transport is not permission for fallback.

`session.mjs` is an unprivileged, no-child, ten-minute holder with three-second
stdin pulse expiry. It has no authority to prepare mounts and no service or
autostart. The live smoke retains it across preflight, registration and invoke,
then stops it. The adapter's unchanged inspectLab and canaries still execute
for every admission/invocation. A holder never substitutes for those checks.

## Reproduction (no inference)

```powershell
node scripts/lab/transfer.mjs --inspect
node scripts/lab/verify-preparation.mjs --confirm-lab-only-restart
```

The verifier inventories workloads before each explicit lab-only termination;
then checks cold denial, preparation, idempotent repeat, the actual codexlab
namespace and complete official preflight. It writes a unique bounded local
receipt, not raw auth/config logs. It never sends an inference request.

Actual Windows/WSL evidence on 2026-10-07 (local time): two cycles passed in
`lab-preparation-c803cf50-d25d-499a-ab6a-b789d5d234d0.json`. Cold admission was
`LAB_HOST_MOUNTS_PRESENT`; prepared status was `ready`; repeat removed nothing.
The actual client was official 0.153.4, ChatGPT account, model/list Astra/ultra,
managed requirements included. All pre-existing admission checks remained
active. Network denial used owned positive-control listeners and namespace,
interfaces/routes evidence, not an external service scan. No inference occurred.
Binary hashes remain those in `agent/codex/wsl-policy.mjs`.

## Same unused authorization

The original reservation/preflight/failure files are not edited or removed.
`--resume-preflight-only` validates their relationships, exact original input,
zero invocation counters, preflight-only LAB_HOST_MOUNTS_PRESENT failure,
absence of project/job/binding/start/unknown evidence, and all 12 historical
archive/original hashes. It exclusively creates `continuation-after-cold-start`
linked to the original reservation and current head/manifest. Evidence from
the continuation goes there, never over the original receipts.

Binding and consumption still use the ONE authorization-root `job-binding.json`
and `provider-start.json`. No new budget is created; concurrent continuation
and consumption are tested with actual Node child processes. Consumption is
before dispatch and never refunded, even after an uncertain outcome. A missing
database row is not consulted as proof of non-use.

After current-SHA CI, explicit fresh operator preparation, and with the existing
separate live-smoke TEST target selected (never the dev DB):

```powershell
node scripts/lab/transfer.mjs
node scripts/persistence/run-tests.mjs design-live-smoke --confirm-one-real-call --authorization pr15-live-smoke-02 --resume-preflight-only
```

Run these without a long idle gap; preparation alone is not admission.
The full Linux and native Windows gates include model-free mount and budget
regressions. They do not claim to test this computer's WSL or actual inference.
The real smoke outcome belongs in a separate receipt/PR report after green CI.
