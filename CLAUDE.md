# CLAUDE.md

## Project Overview

Star Vault is a Supabase-only GitHub stars intelligence system.

It imports starred repos from GitHub, fetches README/package metadata,
generates OpenAI embeddings, and serves semantic retrieval through an MCP
server.

## Canonical Runtime

- Runtime: Bun + TypeScript
- Backend: Supabase only
- Schema: `star_vault`
- Tables: `repos`, `sync_state`
- Search RPC: `search_repos`
- Embedding model: `text-embedding-3-small` (1536 dimensions)

Legacy Convex artifacts have been removed and are no longer part of this
repository.

## Commands

```bash
# Install / checks
bun install
bun run typecheck

# Sync lifecycle
bun run import
bun run fetch-content
bun run embeddings
bun run sync
bun run stats

# MCP server
bun run mcp
```

## CLI Flags

Supported on sync-style commands:

- `--max-pages <n>`
- `--content-limit <n>`
- `--embedding-limit <n>`
- `--concurrency-content <n>`
- `--concurrency-embeddings <n>`

## Database Migrations

Apply in order:

1. `supabase/migrations/0001_initial_schema.sql`
2. `supabase/migrations/0002_move_to_public_schema.sql` (obsolete no-op)
3. `supabase/migrations/0003..0013_legacy_remote_placeholder.sql`
4. `supabase/migrations/0014_reconcile_star_vault_canonical.sql`

The canonical reconciliation is in `0014`.

## Operational Runbook

### Daily/Manual Sync

```bash
bun run sync
```

Recommended constrained smoke run:

```bash
bun run sync --max-pages 1 --content-limit 10 --embedding-limit 10
```

### Read-Path Smoke Checks

1. `bun run stats` returns coherent counts and last sync timestamp.
2. `bun run import --max-pages 1` can read current starred repos.
3. Semantic search works with real embeddings (`search_repos` RPC or MCP tool).

### MCP Smoke

Run `bun run mcp` and verify:

- `search_repos`
- `get_repo_details`
- `list_by_language`
- `find_similar`
- `get_stats`

If MCP startup fails schema checks, re-apply `0014_reconcile_star_vault_canonical.sql`.

## Troubleshooting

- Missing env vars: ensure `.env` defines `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`.
- Repeated content fetches: candidates are now based on
  `content_fetched_at is null`; check data integrity if behavior regresses.
- Search field drift: `search_repos` output contract is owned by migration `003`.
