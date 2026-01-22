# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub starred repositories intelligence system. Captures starred repos, extracts README content, generates OpenAI embeddings, and enables semantic search via MCP server.

| Metric         | Value                              |
| -------------- | ---------------------------------- |
| Repos imported | 678                                |
| Embeddings     | 678 (100%)                         |
| Daily sync     | Supabase Edge Function (7 AM UTC)  |
| MCP Server     | Ready for Claude                   |
| Database       | Supabase Cloud (star_vault schema) |

## Commands

```bash
# Development
bun install                    # Install dependencies
bun run typecheck              # TypeScript checking

# Sync operations (CLI → Supabase Cloud)
bun run import                 # Import starred repos from GitHub
bun run fetch-content          # Fetch README/package.json (batch 50)
bun run embeddings             # Generate embeddings (batch 20)
bun run sync                   # Full sync (all steps)
bun run stats                  # Show vault statistics

# MCP Server
bun run mcp                    # Run standalone for testing
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                                │
│  src/index.ts → src/utils/supabase.ts → Supabase Client         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Supabase Cloud Backend                        │
│  Database: brawengrbiuvnmsyqhoe.supabase.co (star_vault schema) │
│  Tables: repos, sync_state                                       │
│  RPC: search_repos (vector similarity search)                    │
│  Edge Function: star-vault-sync (daily cron at 7 AM UTC)        │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       MCP Server (Supabase)                      │
│  mcp-server/index.ts → 5 tools → Claude Code integration        │
│  Uses: @supabase/supabase-js, OpenAI embeddings                 │
└─────────────────────────────────────────────────────────────────┘
```

**Note**: All components (CLI, MCP Server, Edge Function) use the same Supabase Cloud database with `star_vault` schema.

### Data Flow

1. **Import**: GitHub API → `syncStarVault` → `star_vault.repos` table
2. **Content**: Raw GitHub → README + package.json → stored in repo row
3. **Embeddings**: OpenAI text-embedding-3-small → 1536d vector stored
4. **Search**: Query → embed → `search_repos` RPC → filter → results

### Key Patterns

- **Edge Function** for daily automated sync (GitHub + embeddings)
- **CLI** for manual sync operations
- **MCP Server** for Claude Code integration
- **Vector search** via `search_repos` RPC (pgvector)
- **Batched processing**: content (50/run), embeddings (20/run)

## Database Schema (Supabase)

| Table        | Purpose                                    |
| ------------ | ------------------------------------------ |
| `repos`      | Starred repos with 1536d embedding vectors |
| `sync_state` | Sync history and statistics                |

### repos indexes

- `repos_github_id_key` - unique lookup by GitHub ID
- `repos_embedding_idx` - HNSW vector index (1536 dimensions)

## Environment Variables

### CLI & MCP Server (.env)

| Variable                    | Description                      |
| --------------------------- | -------------------------------- |
| `SUPABASE_URL`              | Supabase Cloud project URL       |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (not anon key!) |
| `OPENAI_API_KEY`            | For embedding generation         |
| `GITHUB_TOKEN`              | GitHub PAT with `repo` scope     |
| `SUPABASE_SCHEMA`           | `star_vault` (default)           |

### MCP Server (configured in Claude Code)

| Variable                     | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `SUPABASE_URL`               | `https://brawengrbiuvnmsyqhoe.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY`  | `${PRIVATEBASE_SERVICE_ROLE_KEY}`          |
| `OPENAI_API_KEY`             | `${OPENAI_API_KEY}`                        |
| `SUPABASE_SCHEMA` (optional) | `star_vault` (default)                     |

## File Structure

```
src/
  index.ts              # CLI entry point
  utils/
    supabase.ts         # Supabase client + sync operations
  github/
    starred.ts          # Fetch starred repos from GitHub
    content.ts          # Fetch README/package.json

supabase/
  functions/
    star-vault-sync/    # Edge Function for daily sync

mcp-server/
  index.ts              # MCP server (5 tools)

convex/                 # (Legacy, deprecated - migrated to Supabase)
```

## MCP Tools

| Tool               | Type   | Description                      |
| ------------------ | ------ | -------------------------------- |
| `search_repos`     | action | Semantic search (embeds query)   |
| `get_repo_details` | query  | Get repo by full_name            |
| `list_by_language` | query  | Filter by language               |
| `find_similar`     | action | Find similar repos (uses vector) |
| `get_stats`        | query  | Vault statistics                 |

## Development Workflow

1. Make changes to CLI or MCP server
2. Test via CLI: `bun run stats` or `bun run sync`
3. Type check: `bun run typecheck`
4. Test MCP: `bun run mcp` (standalone mode)

## Embedding Strategy

The embedding text combines:

- Repository full name and description
- Language, topics, license, star/fork counts
- First 6000 chars of README
- Dependency names from package.json

This creates rich searchable text for semantic matching.

## Edge Function (Daily Sync)

The Edge Function at `supabase/functions/star-vault-sync/index.ts`:

- **pg_cron job**: `star-vault-daily-sync`
- **Schedule**: Daily at 7 AM UTC
- Fetches new starred repos from GitHub
- Generates embeddings for repos missing them
- Writes to `star_vault.repos` and `star_vault.sync_state`
