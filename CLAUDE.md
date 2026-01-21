# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GitHub starred repositories intelligence system. Captures starred repos, extracts README content, generates OpenAI embeddings, and enables semantic search via MCP server.

| Metric         | Value                  |
| -------------- | ---------------------- |
| Repos imported | 652                    |
| Embeddings     | 652 (100%)             |
| Daily sync     | Convex cron (7 AM UTC) |
| MCP Server     | Ready for Claude       |

## Commands

```bash
# Development
bun install                    # Install dependencies
bun run typecheck              # TypeScript checking

# Convex (backend)
npx convex dev                 # Start dev server + watch
npx convex deploy              # Deploy to production
npx convex env set KEY "val"   # Set environment variable

# Sync operations (invoke Convex actions)
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
│  src/index.ts → src/utils/convex.ts → ConvexHttpClient          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Convex Backend                              │
│  convex/starVault.ts (actions)    → syncStarVault               │
│  convex/starVaultQueries.ts       → searchRepos, findSimilar    │
│  convex/starVaultInternal.ts      → mutations (upsert, update)  │
│  convex/lib/embeddings.ts         → OpenAI embedding wrapper    │
│  convex/crons.ts                  → Daily sync at 7 AM UTC      │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│                       MCP Server (Supabase)                      │
│  mcp-server/index.ts → 5 tools → Claude Code integration        │
│  Database: brawengrbiuvnmsyqhoe.supabase.co (star_vault schema) │
│  Uses: @supabase/supabase-js, OpenAI embeddings                 │
└─────────────────────────────────────────────────────────────────┘
```

**Note**: The CLI/sync operations use Convex backend, while the MCP server queries Supabase directly for better performance with Claude Code.

### Data Flow

1. **Import**: GitHub API → `syncStarVault` action → `sv_repos` table
2. **Content**: Raw GitHub → README + package.json → stored in repo doc
3. **Embeddings**: `buildEmbeddingText()` → OpenAI → 1536d vector stored
4. **Search**: Query → embed → Convex vector search → filter → results

### Key Patterns

- **Convex actions** for external API calls (GitHub, OpenAI)
- **Convex queries** for reads, **internal mutations** for writes
- **Vector index** on `sv_repos.embedding` for similarity search
- **Batched processing**: content (50/run), embeddings (20/run)

## Database Schema (Convex)

| Table           | Purpose                                    |
| --------------- | ------------------------------------------ |
| `sv_repos`      | Starred repos with 1536d embedding vectors |
| `sv_sync_state` | Sync history and statistics                |

### sv_repos indexes

- `by_github_id` - lookup by GitHub ID
- `by_embedding` - vector index (1536 dimensions)

## Environment Variables

### CLI Operations (.env)

- `CONVEX_URL` - Convex deployment URL (required for sync commands)

### Convex Dashboard

- `GITHUB_TOKEN` - GitHub PAT with `repo` scope
- `OPENAI_API_KEY` - For embeddings

### MCP Server (configured in MCP client configs)

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
    convex.ts           # Convex client wrapper
    convexApi.ts        # Generated API types
  github/               # (Legacy, now in Convex)

convex/
  schema.ts             # Database schema
  starVault.ts          # Main sync action
  starVaultQueries.ts   # Search/query actions
  starVaultInternal.ts  # Internal mutations
  crons.ts              # Daily sync schedule
  lib/
    embeddings.ts       # OpenAI embedding helper

mcp-server/
  index.ts              # MCP server (5 tools)
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

1. Start Convex dev server: `npx convex dev`
2. Make changes to `convex/` files (auto-deploys)
3. Test via CLI: `bun run stats` or `bun run sync`
4. Type check: `bun run typecheck`
5. Deploy to prod: `npx convex deploy`

## Embedding Strategy

The `buildEmbeddingText()` function in `convex/starVault.ts` combines:

- Repository full name and description
- Language, topics, license, star/fork counts
- First 6000 chars of README
- Dependency names from package.json

This creates rich searchable text for semantic matching.
