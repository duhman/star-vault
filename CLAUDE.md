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
bun test
bun run verify

# Sync lifecycle
bun run import
bun run fetch-content
bun run embeddings
bun run sync
bun run reconcile
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
5. `supabase/migrations/0015_sync_infrastructure.sql` — ETag cache, sync_runs, seen_at, hash
6. `supabase/migrations/0016_vector_ip_ops.sql` — HNSW on vector_ip_ops
7. `supabase/migrations/0017_upsert_repos_rpc.sql` — bulk upsert with xmax=0
8. `supabase/migrations/0018_pg_cron_jobs.sql` — hourly + weekly cron jobs
9. `supabase/migrations/0019_reconcile_cron_fix.sql` — point weekly at sync-reconcile
10. `supabase/migrations/0020_upsert_repos_dedupe.sql` — DISTINCT ON github_id
11. `supabase/migrations/0021_delete_unseen_repos_rpc.sql` — NULL-safe RPC delete
12. `supabase/migrations/0022_remove_orphan_daily_cron.sql` — drop pre-existing legacy job
13. `supabase/migrations/0023_invoke_edge_function_via_vault.sql` — read service-role JWT from Vault (required on newer Supabase Cloud)

The canonical reconciliation is in `0014`; `0015+` layer sync infrastructure
(ETag cache, sync_run_id, embedding_input_hash, RLS) on top.

`0003` through `0013` are retained as historical placeholders. See
`supabase/migrations/REPAIR.md` if a remote migration table needs repair.

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

1. `bun run verify` passes every schema/RPC probe (run this first after any
   migration; it's read-only and takes < 1s).
2. `bun run stats` returns coherent counts and last sync timestamp.
3. `bun run import --max-pages 1` can read current starred repos.
4. Semantic search works with real embeddings (`search_repos` RPC or MCP tool).

### Parity Test

`bun test` runs the Node/Deno parity check for `buildEmbeddingInput`. Must
pass before merging any change to either builder — otherwise the CLI and
Edge Function will disagree on the content hash and churn embeddings.
Requires `deno` on PATH.

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
- Search field drift: `search_repos` output contract is owned by migrations
  `0014` and `0016`.
