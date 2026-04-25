#!/bin/bash
# Deploy the star-vault Edge Functions to a self-hosted Supabase.
#
# If you're on Supabase cloud, prefer:
#   supabase functions deploy sync-stars
#   supabase functions deploy sync-content
#   supabase functions deploy sync-embeddings
#   supabase functions deploy sync-reconcile
#
# This script handles the self-hosted case (scp + docker compose restart).
#
# Prereqs:
# - SSH access to ${SERVER}
# - Supabase running in Docker at ${REMOTE_SUPABASE_DIR}
#
# Usage: ./scripts/deploy-edge-function.sh
#        ./scripts/deploy-edge-function.sh sync-stars   # deploy one

set -euo pipefail

SERVER="${SERVER:-srv1209224.hstgr.cloud}"
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
