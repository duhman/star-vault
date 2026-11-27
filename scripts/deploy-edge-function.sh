#!/bin/bash
# Deploy the star-vault Edge Functions to a self-hosted Supabase over SSH
# (scp + docker compose restart).
#
# star-vault itself runs on Supabase Cloud. Deploy there with:
#   bun run deploy:cron
#
# This script has no default host. The self-hosted instance it used to
# target is retired, so SERVER must be set explicitly.
#
# Prereqs:
# - SSH access to ${SERVER}
# - Supabase running in Docker at ${REMOTE_SUPABASE_DIR}
#
# Usage: SERVER=supabase.example.com ./scripts/deploy-edge-function.sh
#        SERVER=supabase.example.com ./scripts/deploy-edge-function.sh sync-stars   # deploy one

set -euo pipefail

: "${SERVER:?set SERVER to the SSH host of a self-hosted Supabase (there is no default host; for Supabase Cloud run: bun run deploy:cron)}"
REMOTE_SUPABASE_DIR="${REMOTE_SUPABASE_DIR:-/root/supabase}"
REMOTE_FUNCTIONS_DIR="${REMOTE_SUPABASE_DIR}/volumes/functions"

ALL_FUNCTIONS=(sync-stars sync-content sync-embeddings sync-reconcile)
TARGETS=("${@:-${ALL_FUNCTIONS[@]}}")

echo "Deploying to ${SERVER}: ${TARGETS[*]}"

# _shared is imported by all functions; always ship it.
scp -r supabase/functions/_shared root@${SERVER}:${REMOTE_FUNCTIONS_DIR}/

for fn in "${TARGETS[@]}"; do
  echo "  → ${fn}"
  scp -r supabase/functions/${fn} root@${SERVER}:${REMOTE_FUNCTIONS_DIR}/
done

echo "Restarting edge-runtime..."
ssh root@${SERVER} "cd ${REMOTE_SUPABASE_DIR} && docker compose restart functions"

echo ""
echo "Deployment complete. Smoke test:"
for fn in "${TARGETS[@]}"; do
  echo "  curl -X POST https://${SERVER}/functions/v1/${fn} \\"
  echo "    -H 'Authorization: Bearer \$SUPABASE_SERVICE_ROLE_KEY'"
done
