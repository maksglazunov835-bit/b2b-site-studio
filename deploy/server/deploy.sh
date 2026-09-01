#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/b2b-site-studio"
BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-/var/lib/b2b-site-studio}"
DEPLOY_SHA_FILE="$DEPLOY_STATE_DIR/current-sha"
SITE_URL="${SITE_URL:-http://127.0.0.1:3000/}"

css_url() {
  case "$1" in
    http://* | https://*) printf '%s\n' "$1" ;;
    /*) printf '%s%s\n' "${SITE_URL%/}" "$1" ;;
    *) printf '%s/%s\n' "${SITE_URL%/}" "$1" ;;
  esac
}

wait_for_site() {
  local attempt css_path html

  for attempt in $(seq 1 30); do
    if html="$(curl -fsS --max-time 10 "$SITE_URL" 2>/dev/null)"; then
      css_path="$(printf '%s' "$html" | sed -n 's/.*href="\([^"]*\.css\)".*/\1/p' | head -n 1)"

      if [ -z "$css_path" ] || curl -fsSI --max-time 10 "$(css_url "$css_path")" >/dev/null 2>&1; then
        return 0
      fi
    fi

    sleep 2
  done

  return 1
}

cd "$APP_DIR"
git fetch origin "$BRANCH"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
DEPLOYED_SHA="$(cat "$DEPLOY_SHA_FILE" 2>/dev/null || true)"

if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  git reset --hard "origin/$BRANCH"
fi

if [ "$DEPLOYED_SHA" = "$REMOTE_SHA" ]; then
  echo "Already up to date."
  exit 0
fi

docker compose up --build -d

if ! wait_for_site; then
  docker compose ps
  docker logs --tail 120 b2b-site-studio || true
  echo "Deploy failed: site or CSS asset did not become healthy." >&2
  exit 1
fi

docker image prune -f
mkdir -p "$DEPLOY_STATE_DIR"
printf '%s\n' "$REMOTE_SHA" > "$DEPLOY_SHA_FILE"
