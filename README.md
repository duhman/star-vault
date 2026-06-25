# Star Vault

Supabase-backed GitHub stars intelligence system.

Star Vault imports your starred repositories, fetches README/package metadata,
generates embeddings, and exposes semantic search through CLI and MCP tools.

## Architecture

```text
     ┌── Bun CLI (dev) ─────────────────────────────┐
     │                                              │
     │  import  fetch-content  embeddings           │
     │  sync    reconcile                           │
     │                                              │
     └────────────┬─────────────────────────────────┘
                  │                    ┌─ pg_cron (hourly / weekly)
                  ▼                    ▼
            Supabase (star_vault schema)
            ├── repos (+ embedding, seen_at, hash)
            ├── sync_runs           ├── github_etags
            └── sync_state          └── upsert_repos RPC
                  ▲                    ▲
                  │                    │
     ┌── Edge Functions (prod) ───────┴────┐
     │  sync-stars      (hourly, ETag)     │
     │  sync-content    (hourly, 50/run)   │
     │  sync-embeddings (hourly, 96/batch) │
     │  sync-reconcile  (weekly, delete)   │
     └─────────────────────────────────────┘
                  ▲
                  │
            MCP Server (stdio)
```

- Runtime: Bun + TypeScript
- Database: Supabase Postgres + pgvector
- Embeddings: OpenAI `text-embedding-3-small` (1536-d)
- Canonical schema: `star_vault`
- Canonical tables: `star_vault.repos`, `star_vault.sync_state`
- Canonical RPC: `star_vault.search_repos`

## Prerequisites

- Bun 1.2+
- Supabase project with pgvector extension
- GitHub PAT with access to starred repos
- OpenAI API key (for embeddings and semantic query embedding)

## Setup

```bash
bun install
cp .env.example .env
```

Set required variables in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`

## Database Migrations

Apply migrations in order:

1. `0001_initial_schema.sql`
2. `0002_move_to_public_schema.sql` (obsolete no-op kept for compatibility)
3. `0003..0013_legacy_remote_placeholder.sql` (history alignment placeholders)
4. `0014_reconcile_star_vault_canonical.sql`
5. `0015_sync_infrastructure.sql` — ETag cache, sync_run_id, embedding_input_hash, RLS
6. `0016_vector_ip_ops.sql` — HNSW on vector_ip_ops (OpenAI embeddings are normalized)
7. `0017_upsert_repos_rpc.sql` — single-RPC upsert that returns added/updated counts
8. `0018_pg_cron_jobs.sql` — hourly + weekly cron jobs
9. `0019_reconcile_cron_fix.sql` — point weekly cron at `sync-reconcile`
10. `0020_upsert_repos_dedupe.sql` — `DISTINCT ON github_id` guards against GitHub pagination overlap
11. `0021_delete_unseen_repos_rpc.sql` — NULL-safe delete via `IS DISTINCT FROM`
12. `0022_remove_orphan_daily_cron.sql` — clean up legacy daily cron job
13. `0023_invoke_edge_function_via_vault.sql` — read the service-role JWT from Supabase Vault (newer Supabase Cloud projects no longer allow `ALTER DATABASE ... SET` for `app.settings.*`)

After migrations, store the service-role JWT in Vault (once, via `supabase db query` or the dashboard SQL editor):

```sql
select vault.create_secret(
  '<your service_role_jwt>',
  'star_vault_service_role_key',
  'Service role JWT for pg_cron to invoke star_vault Edge Functions'
);
```

Rotate later with `vault.update_secret(id, '<new_jwt>')` — no restart required.

After applying, run `bun run verify` to smoke-test the schema. It confirms
every table, column, and RPC the TypeScript expects, and performs one
throwaway insert/delete round-trip against `sync_runs` to verify grants.

`0014` is the source of truth for canonical `star_vault.*` structure and RPC
shape used by CLI and MCP. `0003` through `0013` are retained as historical
placeholders; see `supabase/migrations/REPAIR.md` if a remote migration table
needs to be reconciled.

## CLI Commands

```bash
bun run import         # ETag-cached walk of /user/starred
bun run fetch-content  # Canonical README endpoint + package.json
bun run embeddings     # Batched (~96/call), content-hash gated
bun run sync           # import + fetch-content + embeddings
bun run reconcile      # Forced full walk; hard-deletes unstarred repos
                       # (gated by isSafeToReconcile in src/sync/reconcile.ts)
bun run verify         # Smoke-test DB schema + RPCs
bun run test           # Parity test: Node + Deno embedding builders agree
bun run stats
```

### Sync architecture

- Stars walk uses per-page ETags (`star_vault.github_etags`). 304 responses
  don't count against the GitHub primary rate limit — daily syncs touch
  near-zero of the budget when nothing changed.
- README fetch uses `GET /repos/{owner}/{repo}/readme` (ETag-cached), not
  filename-guessing on `raw.githubusercontent.com`.
- Embeddings batch up to ~96 inputs per OpenAI call. Each row stores a
  SHA-256 of the exact embedding input; unchanged inputs are skipped.
- Reconcile (hard-delete of unstarred repos) is gated on `isSafeToReconcile`.

### Optional Flags

- `--max-pages <n>` limit GitHub pages fetched during import/sync
- `--content-limit <n>` override content batch size
- `--embedding-limit <n>` override embedding batch size
- `--concurrency-content <n>` content worker concurrency
- `--concurrency-embeddings <n>` embedding worker concurrency

Examples:

```bash
bun run import --max-pages 1
bun run sync --max-pages 1 --content-limit 10 --embedding-limit 10
```

## MCP Server

Run standalone:

```bash
bun run mcp
```

For Codex, the canonical MCP entry is managed from
`/Users/workboi/agents/mcp/servers/star-vault/server.yaml` and launches with:

```toml
[mcp_servers.star-vault]
command = "bun"
args = ["run", "--cwd", "/Users/workboi/projects/star-vault", "mcp"]
env = { "SUPABASE_SCHEMA" = "star_vault" }
```

The `--cwd` is intentional: it lets the MCP server load this project's `.env`
without copying secrets into Codex config. During bookmark ingestion, use
`get_repo_details` for exact GitHub repo URLs and `find_similar` for high-signal
repos before falling back to live GitHub extraction.

MCP tools:

- `search_repos`
- `get_repo_details`
- `list_by_language`
- `find_similar`
- `get_stats`

The server performs startup checks for canonical table and RPC availability and
fails fast with actionable errors if schema drift is detected.

## Verification

```bash
bun run typecheck
bun test
bun run verify
bun run stats
bun run import --max-pages 1
```

For semantic smoke testing, run `search_repos` through MCP or call the
`search_repos` RPC with a real 1536-dimensional query embedding.
