#!/bin/bash
# Deploy star-vault-sync Edge Function to self-hosted Supabase
#
# Prerequisites:
# - SSH access to srv1209224.hstgr.cloud
# - Supabase running in Docker
#
# Usage: ./scripts/deploy-edge-function.sh

set -e

SERVER="srv1209224.hstgr.cloud"
FUNCTION_NAME="star-vault-sync"
LOCAL_PATH="supabase/functions/${FUNCTION_NAME}"
REMOTE_PATH="/root/supabase/volumes/functions/${FUNCTION_NAME}"

echo "Deploying ${FUNCTION_NAME} to ${SERVER}..."

# Copy function files to server
scp -r ${LOCAL_PATH} root@${SERVER}:${REMOTE_PATH}

echo "Function files copied. Restarting edge-runtime..."

# Restart the edge-functions container to pick up new function
ssh root@${SERVER} "cd /root/supabase && docker compose restart functions"

echo "Deployment complete!"
echo ""
echo "Test with:"
echo "curl -X POST https://${SERVER}/functions/v1/${FUNCTION_NAME} \\"
echo "  -H 'Authorization: Bearer YOUR_SERVICE_ROLE_KEY' \\"
echo "  -H 'Content-Type: application/json'"
