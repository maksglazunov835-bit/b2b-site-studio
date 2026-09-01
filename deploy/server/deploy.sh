#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/b2b-site-studio"
BRANCH="${DEPLOY_BRANCH:-main}"

cd "$APP_DIR"
git fetch origin "$BRANCH"
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  echo "Already up to date."
  exit 0
fi

git reset --hard "origin/$BRANCH"
docker compose up --build -d
docker image prune -f
