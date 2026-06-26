# AGENTS.md

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
- Default embedding provider/model: OpenAI `text-embedding-3-small` (1536 dimensions)
- Optional embedding provider: Gemini `gemini-embedding-001` with 1536 output dimensions

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
- `--concurrency-embeddings <n>` (deprecated no-op; embeddings are batched)
- `--embedding-provider <openai|gemini>`
- `--content-stale-days <n>`

## Database Migrations

Apply in order:

1. `supabase/migrations/0001_initial_schema.sql`
2. `supabase/migrations/0002_move_to_public_schema.sql` (obsolete no-op)
3. `supabase/migrations/0003..0013_legacy_remote_placeholder.sql`
4. `supabase/migrations/0014_reconcile_star_vault_canonical.sql`
5. `supabase/migrations/0015..0024_*.sql`

The canonical reconciliation starts in `0014`; provider/freshness search
behavior is owned by `0024`.

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
  `SUPABASE_SERVICE_ROLE_KEY`, `GITHUB_TOKEN`, and either `OPENAI_API_KEY`
  or `GEMINI_API_KEY` / `GOOGLE_API_KEY` when `EMBEDDING_PROVIDER=gemini`.
- Repeated content fetches: candidates are based on missing or stale
  `content_checked_at`; default staleness is 30 days.
- Search field drift: provider-filtered `search_repos` output is owned by
  migration `0024`.
