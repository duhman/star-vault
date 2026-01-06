# Star Vault - GitHub Stars Intelligence System

Capture GitHub starred repositories, extract content, generate embeddings, and make them searchable via semantic search.

## Status: ✅ Operational

| Metric               | Value                         |
| -------------------- | ----------------------------- |
| Repos imported       | 638                           |
| README content       | 630 (98.7%)                   |
| Embeddings generated | 638 (100%)                    |
| Daily sync           | ✅ Cron job active (7 AM UTC) |
| Edge Function        | ✅ Deployed                   |
| MCP Server           | ✅ Ready to use               |

## Quick Start

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# Import all starred repos
bun run import

# Or run individual steps
bun run fetch-content   # Fetch README/package.json
bun run embeddings      # Generate embeddings
```

## Architecture

```
GitHub API → Fetch Repos → Fetch Content → Generate Embeddings → Supabase (pgvector)
                                                                        ↓
                                                                  MCP Server → Claude
```

## Database

Uses self-hosted Supabase at `srv1209224.hstgr.cloud`

| Table           | Purpose                             |
| --------------- | ----------------------------------- |
| `sv_repos`      | Starred repos with 1536d embeddings |
| `sv_sync_state` | Sync history and stats              |

### Key Functions

- `sv_search_repos(embedding, threshold, limit)` - Semantic repo search
- `sv_get_repo_details(full_name)` - Get repo by owner/name
- `sv_get_stats()` - Vault statistics

## MCP Server

The MCP server exposes these tools to Claude:

| Tool               | Description                                     |
| ------------------ | ----------------------------------------------- |
| `search_repos`     | Semantic search over starred repositories       |
| `get_repo`         | Get specific repo by full_name with all details |
| `list_by_language` | Browse repos by programming language            |
| `list_by_topic`    | Browse repos by topic/tag                       |
| `find_related`     | Find repos related to a concept or project      |
| `vault_stats`      | Show vault statistics                           |
| `recent_stars`     | List recently starred repos                     |

### Setup MCP Server

Add to `~/.mcp.json`:

```json
{
  "mcpServers": {
    "star-vault": {
      "command": "bun",
      "args": [
        "run",
        "/Users/bigmac/projects/personal/star-vault/mcp-server/index.ts"
      ],
      "env": {
        "SUPABASE_URL": "${SUPABASE_SELFHOSTED_URL}",
        "SUPABASE_SERVICE_ROLE_KEY": "${SUPABASE_SELFHOSTED_SERVICE_KEY}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

## Tech Stack

- **Runtime**: Bun 1.2+, TypeScript 5.7
- **Database**: Supabase (PostgreSQL + pgvector)
- **Embeddings**: OpenAI text-embedding-3-small (1536d)
- **Vector Index**: HNSW (m=16, ef_construction=64)
- **Validation**: Zod
- **MCP**: @modelcontextprotocol/sdk

## Environment Variables

| Variable                    | Required | Description                   |
| --------------------------- | -------- | ----------------------------- |
| `SUPABASE_URL`              | Yes      | Self-hosted Supabase URL      |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service role key              |
| `OPENAI_API_KEY`            | Yes      | OpenAI API key for embeddings |
| `GITHUB_TOKEN`              | Yes      | GitHub PAT for API access     |

## Commands

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `bun run import`        | Import all starred repos from GitHub      |
| `bun run fetch-content` | Fetch README/package.json content         |
| `bun run embeddings`    | Generate pending embeddings               |
| `bun run sync`          | Full sync (import + content + embeddings) |
| `bun run stats`         | Show vault statistics                     |
| `bun run mcp`           | Run MCP server standalone                 |
| `bun run typecheck`     | Type checking                             |

## Daily Sync (Automated)

The daily sync runs at **7 AM UTC** via pg_cron, after tweet-vault (6 AM).

### Architecture

```
pg_cron (7 AM) → trigger_star_vault_sync() → pg_net HTTP POST → Edge Function
                                                                      ↓
                                                              GitHub API fetch
                                                              Content fetch
                                                              Embedding generation
                                                              Database upsert
```

### Deploy Edge Function

For self-hosted Supabase, deploy manually via SSH:

```bash
# Option 1: Use deploy script
chmod +x scripts/deploy-edge-function.sh
./scripts/deploy-edge-function.sh

# Option 2: Manual deployment
scp -r supabase/functions/star-vault-sync root@srv1209224.hstgr.cloud:/root/supabase/volumes/functions/
ssh root@srv1209224.hstgr.cloud "cd /root/supabase && docker compose restart functions"
```

### Configure Secrets

Add to `/root/supabase/.env` on the server:

```bash
# Star Vault secrets
GITHUB_TOKEN=github_pat_...
OPENAI_API_KEY=sk-proj-...
```

Then restart functions: `docker compose restart functions`

### Verify Cron Job

```sql
-- Check job status
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'star-vault-daily-sync';

-- Check recent runs
SELECT * FROM cron.job_run_details WHERE jobid = 10 ORDER BY start_time DESC LIMIT 5;

-- Manual trigger
SELECT public.trigger_star_vault_sync();
```
