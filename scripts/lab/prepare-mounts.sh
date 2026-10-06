#!/bin/sh
set -eu
# Operator-only entrypoint. Fixed committed source on stdin, never a job payload.
test "${WSL_DISTRO_NAME:-}" = B2B-Codex-Lab
test "$(id -u)" = 0
case "${1:-}" in --operator-inspect|--operator-prepare) ;; *) exit 2 ;; esac
exec /opt/b2b-lab/node-24.19.0/bin/node --input-type=module - "$1"
