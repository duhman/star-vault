#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -n "${CONVEX_DEPLOY_KEY:-}" ]]; then
  CONVEX_DEPLOY_KEY="${CONVEX_DEPLOY_KEY}" npx convex deploy -y
else
  npx convex deploy -y
fi
