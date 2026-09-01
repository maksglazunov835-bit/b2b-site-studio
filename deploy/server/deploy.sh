#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/b2b-site-studio"
BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-/var/lib/b2b-site-studio}"
DEPLOY_SHA_FILE="$DEPLOY_STATE_DIR/current-sha"

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
docker image prune -f
mkdir -p "$DEPLOY_STATE_DIR"
printf '%s\n' "$REMOTE_SHA" > "$DEPLOY_SHA_FILE"
