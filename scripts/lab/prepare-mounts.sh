#!/bin/sh
set -eu
# Manual setup in the one authorized lab only, never a boot service.
test "${WSL_DISTRO_NAME:-}" = B2B-Codex-Lab
test "$(id -u)" = 0
# Detach propagation before unmounting so other WSL namespaces are untouched.
for target in /tmp/.X11-unix /mnt/wslg /mnt/wsl /usr/lib/wsl/drivers /usr/lib/wsl/lib; do
  if mountpoint -q "$target"; then
    mount --make-rprivate "$target"
  fi
done
# WSL's generated resolver may be a symlink into the shared mount.
if test -f /etc/resolv.conf; then
  cp --dereference /etc/resolv.conf /etc/b2b-lab-resolv.conf
fi
test -f /etc/b2b-lab-resolv.conf
cp --remove-destination /etc/b2b-lab-resolv.conf /etc/resolv.conf
for target in /tmp/.X11-unix /mnt/wslg /mnt/wsl /usr/lib/wsl/drivers /usr/lib/wsl/lib; do
  if mountpoint -q "$target"; then
    umount --recursive "$target"
  fi
done
