# Star Vault

Supabase-backed GitHub stars intelligence system.

Star Vault imports your starred repositories, fetches README/package metadata,
generates embeddings, and exposes semantic search through CLI and MCP tools.

## Architecture

```text
GitHub API -> import repos -> fetch README/package.json -> generate embeddings
                                                     |
                                                     v
                                            Supabase (star_vault)
                                                     |
                                                     v
                                              MCP Server tools
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

`0014` is the source of truth for canonical `star_vault.*` structure and RPC
shape used by CLI and MCP.

## CLI Commands

```bash
bun run import
bun run fetch-content
bun run embeddings
bun run sync
bun run stats
```

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
bun run stats
bun run import --max-pages 1
```

For semantic smoke testing, run `search_repos` through MCP or call the
`search_repos` RPC with a real 1536-dimensional query embedding.
