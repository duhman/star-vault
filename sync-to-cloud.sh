#!/bin/bash
# Daily GitHub stars sync to cloud
# Designed to run at 7 AM UTC via cron

set -e

cd "$(dirname "$0")"

# Load environment (filter out comments before exporting)
export $(grep -v '^#' .env.cloud | grep -v '^$' | xargs)

# Build TypeScript
bun run typecheck 2>/dev/null || true

# Run daily sync
echo "[$(date -u '+%Y-%m-%d %H:%M:%S UTC')] ⭐ Starting stars sync..."

# Run existing sync and mirror to cloud
bun run sync

echo "✅ Stars sync completed"
