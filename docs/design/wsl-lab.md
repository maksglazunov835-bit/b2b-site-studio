# Authorized WSL lab: measured, not admitted

Local machine evidence, 2026-09-09. This is not Linux GitHub Actions evidence,
an independent acceptance, or a successful Codex generation. Actual model calls:
**0**. The application still fails closed with `CODEX_ISOLATION_UNVERIFIED`.

## Windows configuration comparison

Coordinator comment [5602209896](https://github.com/maksglazunov835-bit/b2b-site-studio/pull/15#issuecomment-5602209896)
and owner decision [5601101683](https://github.com/maksglazunov835-bit/b2b-site-studio/pull/15#issuecomment-5601101683)
remain the product policy. The owner's subsequent explicit permission authorizes
one new lab, not changes to the existing Windows sandbox, Docker or production.

The installed Windows 0.153.4 app-server has no `--ignore-user-config` option;
its exec help explicitly documents that option as skipping `CODEX_HOME/config.toml`
while retaining authentication resolution. Official [permission documentation](https://learn.chatgpt.com/docs/permissions)
says legacy sandbox configuration and named profiles do not compose.
The generated `CommandExecParams` schema nevertheless allows an explicit
`permissionProfile` in standalone `command/exec`. This distinction required a
test; a matching profile name or `config/read` alone is not proof.

One bounded comparison used only synthetic files and two own TCP listeners:

| Source | Legacy config | Readiness | Actual standalone command |
| --- | --- | --- | --- |
| Existing user home | `danger-full-access` | `ready` | Restricted offline user; input/output pass and writes outside denied, but outside/junction reads and both loopback connections succeeded |
| Fresh, empty, owned `CODEX_HOME` | `null` | `updateRequired` | Not run; no setup/UAC or sandbox ACL changes attempted |

Both IPv4/IPv6 listeners passed positive control. The first sandboxed command
made two connections to them; the second case made zero because no command ran.
The fresh home demonstrates configuration exclusion, but not safe command
execution or retention of the existing login. It was removed without copying
any authorization files. **Legacy configuration is a hypothesis, not an
established cause. Windows command/exec and future exec equivalence is unproven.**

## Inventory and actual installation

- Windows 11 Pro, build `26200.9168`; non-administrator operator.
- WSL `2.7.3.0`, kernel `6.6.114.1-1`; default version 2.
- Only `docker-desktop` existed, stopped and default. It was not operated on.
- C had 116,980,486,144 free bytes before installation (about 109 GiB).
- CBS and Windows Update already reported pending reboot flags. Import worked
  without reboot, UAC, enabling features, changing WSL version or global settings.
- New name: `B2B-Codex-Lab`. Previously absent installation directory:
  `%LOCALAPPDATA%\B2B-Codex-Lab`. No previous directory or distro was reused.
- Imported official Ubuntu **24.04.4 LTS**, then installed official Codex
  **0.153.4** and Node **24.19.0** under root-owned `/opt/b2b-lab` in this distro.
- Created `codexlab`, uid/gid 1000, with no supplementary groups or sudo grant.
- The stopped lab VHDX occupies 2,048,917,504 logical bytes; the four retained
  task-owned archives total 1,802,458,498 bytes (about 3.6 GiB combined).
- No Windows Codex/profile/auth/.env/database/Runner/GitHub data was transferred.
  Official archives and fixed diagnostic/setup modules travel over stdin;
  no drive share, platform API listener or secret-bearing channel is opened.

Sources: [Ubuntu image](https://releases.ubuntu.com/noble/ubuntu-24.04.4-wsl-amd64.wsl),
[Ubuntu checksums](https://releases.ubuntu.com/noble/SHA256SUMS),
[official Codex release](https://github.com/openai/codex/releases/tag/rust-v0.153.4),
[Node checksums](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt).

| Artifact | SHA-256 |
| --- | --- |
| Original Ubuntu WSL archive | `9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5` |
| Repacked lab import tar (local, not upstream-signed) | `b248aaacead1be43e5ef9cf8bd1e714f9f93ed8686f63ac3f96403bfde27e968` |
| Linux Codex package tar.gz | `a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821` |
| Linux Codex executable | `56ef98ab4032d317ab26e9b5e5a175650717351edb16ed9cde0cb6d1734d62da` |
| Bundled bwrap | `77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c` |
| Linux Node archive | `14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647` |
| Linux Node executable | `bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12` |
| Unchanged Windows Codex executable | `e5aa76d19c7c94e2e9ef9b707d590206a73ac0e97c8ddc8382181242494bef75` |

The verified upstream Ubuntu tar was repacked with only `etc/wsl.conf` replaced
by `scripts/lab/image/etc/wsl.conf` before first boot. bsdtar emitted untranslated
owner/group-name warnings on several original entries; numeric ownership and
the actual non-root runtime were inspected. No signed-upstream claim is made
for the modified archive. Original and repacked archives remain separate.

## Distro boundary and its limits

The new distro's wsl.conf disables automount, fstab processing, interop and
Windows PATH. It disables systemd so no service/autostart is installed.
Windows drive mounts were absent on first boot, but WSLg, GPU/driver and shared
`/mnt/wsl` mounts were present. Merely checking config would have missed this.

`prepare-mounts.sh` is a manually invoked, distro-name/root-checked setup step.
It makes only those lab mounts recursively private before unmounting, avoiding
propagation to other distro namespaces. It preserves the generated resolver
contents locally, then removes WSLg/X11, shared WSL and WSL driver/library mounts.
There is no firewall, global AppArmor, WSL config, Docker or default-distro change.

These mount removals are **per boot**, not a permanent WSL configuration feature.
WSL may recreate mounts at its next start. A future supported launcher must
verify the actual boundary before *every* invocation; this diagnostic is not
that launcher. Do not launch the model just because setup once succeeded.

During the measured command, mountinfo contained no drive, WSLg, shared WSL or
WSL driver/library mounts. `WSL_INTEROP` was absent and `/init` was invisible
inside the official sandbox. The kernel's `WSLInterop` binfmt registration still
existed outside that sandbox; it was not globally disabled or rewritten. A full
Windows-executable interop probe has not been completed. No real credentials
were used to test exclusion, only a synthetic marker outside the task.

## Actual Linux canaries

Official app-server `command/exec`, clean owned home, no legacy config,
explicit named profile, `approval_policy=never`, root deny, minimal runtime
read, root-owned `/opt/b2b-lab` read, task read, output write, network disabled.
The original profile needed the official Codex runtime as well as Node readable:
without it bwrap could not re-exec the official binary. That initial failure
was not a successful isolation test.

| Check | Measured result |
| --- | --- |
| Non-root; permitted input read and output write | Pass |
| Input overwrite denied | Pass, `EROFS`; parent input remained identical |
| Sibling, relative alternate path, symlink escape, credential marker | Pass, hidden with `ENOENT`; targets existed in positive setup |
| `/init` and platform credential environment | Not visible / not inherited |
| Own IPv4 loopback listener | Positive control connects; sandbox cannot connect |
| Own listener on lab private interface | Positive control connects; sandbox cannot connect |
| Windows-host listener and controlled external listener | Not tested; no isolation claim |
| Official client HTTPS connectivity | ChatGPT endpoint returned HTTP 403 challenge; not proof of authenticated service availability |
| Same-profile standalone `codex sandbox` | Exit 0 but no probe JSON; not accepted as execution evidence |
| WSL cancellation/process-tree completion | Not yet verified; earlier CI process tests are not this boundary |
| All other model-directed tools / future exec equivalence | Not proven; not inferred from command/exec |

The first draft of the local probe did not recognize Linux `EROFS`, producing
a false-negative overwrite check. Inspecting the actual errno and unchanged
parent bytes corrected the diagnostic; there was no successful overwrite.
The standalone CLI also returned no matrix after moving its home out of `/tmp`
to remove a documented helper-alias warning. No additional flag sweep followed.

## Auth, model and smoke

Linux `codex login status`: **Not logged in**. A separate bounded read-only
Linux app-server probe called `account/read` (without token refresh) and
`model/list`: the account was `not_logged_in`; the single catalog page did list
`gpt-6-astra` with `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
This is unauthenticated capability advertisement, not account entitlement,
quota or inference proof. No login was initiated because isolation admission
is incomplete. An authenticated Linux catalog receipt is still absent; the
earlier Windows receipt is not substituted. No API-key fallback, account
transfer or model request was performed. There are no real concepts, output
hash or reload smoke to report. CI screenshots remain `test_stub` evidence.

Remaining blockers: complete same-exec/tool-surface proof, positive-controlled
Windows-host/external-network and cancellation matrix, verified fixed-channel
launcher, then official user-performed Linux ChatGPT login and fresh catalog
receipt. Keep the existing adapter fail-closed throughout. No manual status flip.

## Reproduce diagnostics, not generation

From PowerShell in the repo, while the lab is present:

```powershell
node scripts/lab/transfer.mjs
# Run only if the setup command succeeded:
node scripts/lab/run-canary.mjs
wsl -d B2B-Codex-Lab -u codexlab --cd /home/codexlab --exec /opt/b2b-lab/codex-0.153.4/bin/codex login status
```

`run-canary.mjs` deliberately exits nonzero while the full matrix remains
incomplete. It never starts a model turn or grants readiness. It transfers only
the fixed synthetic diagnostic source over stdin with a filtered environment.
Model calls remain zero. No command here connects to a database.

For Windows comparison, use the already-installed absolute binary:

```powershell
node scripts/codex-isolation-diagnostic.mjs '<absolute-existing-codex.exe>'
node scripts/codex-isolation-diagnostic.mjs '<absolute-existing-codex.exe>' --clean-home
```

The fresh-home path checks sandbox readiness before command execution and will
not perform setup. Missing assertions, wrong exit status or unavailable positive
listeners cannot count as passing. These receipt regressions are included in
both full Linux CI and native Windows CI, but do not install WSL on CI.

## Removal plan (not executed)

After separately confirming no lab operation is running, inspect
`wsl --list --verbose` and the installation path again. To remove this lab only,
the owner can use `wsl --terminate B2B-Codex-Lab` followed by
`wsl --unregister B2B-Codex-Lab`. Unregister is destructive to this lab, so it
was not executed. Never substitute a different name, use `wsl --shutdown`, or
operate on docker-desktop. Remove the residual installation directory only
after resolving it to the exact new `%LOCALAPPDATA%\B2B-Codex-Lab` path.
The task-owned temporary archives are `b2b-lab-ubuntu-24.04.4.wsl`,
`b2b-lab-rootfs.tar`, `b2b-lab-codex-0.153.4.tar.gz` and
`b2b-lab-node-v24.19.0-linux-x64.tar.xz` under `%TEMP%`; inspect these exact
names before any cleanup. Nothing outside these owned targets is included.

At the end of diagnostics, `ps` contained no Codex/Node workload and only the
WSL init/session/relay plus the inspecting ps. The lab alone was terminated;
both `B2B-Codex-Lab` and the unchanged default `docker-desktop` were then stopped.
The lab was not unregistered or deleted. No service or recurring task remains.
