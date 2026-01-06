# ⭐ Star Vault

**GitHub Stars Intelligence System** — Capture your starred repositories, extract content, generate embeddings, and search them semantically via Claude MCP.

Ever starred hundreds of repos and forgot what's in there? Star Vault makes your GitHub stars searchable with natural language queries like _"that React animation library"_ or _"CLI tools for database migrations"_.

## Features

- 🔍 **Semantic Search** — Find repos by description, not just keywords
- 📚 **README Extraction** — Captures full README content for better context
- 🤖 **Claude MCP Integration** — Query your stars directly from Claude
- ⏰ **Daily Sync** — Automatically captures new stars via pg_cron
- 🧠 **Smart Embeddings** — OpenAI text-embedding-3-small (1536 dimensions)
- ⚡ **Fast Vector Search** — PostgreSQL pgvector with HNSW indexing

## Architecture

```
GitHub API → Fetch Repos → Extract README → Generate Embeddings → Supabase (pgvector)
                                                                        ↓
                                                                  MCP Server → Claude
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.2+
- [Supabase](https://supabase.com) instance (cloud or self-hosted)
- [OpenAI API key](https://platform.openai.com/api-keys)
- [GitHub Personal Access Token](https://github.com/settings/tokens)

### Installation

```bash
# Clone the repository
git clone https://github.com/duhman/star-vault.git
cd star-vault

# Install dependencies
bun install

# Configure environment
cp .env.example .env
# Edit .env with your credentials
```

### Database Setup

Run the migrations in your Supabase SQL editor:

```bash
# Apply migrations in order
cat supabase/migrations/001_initial_schema.sql
cat supabase/migrations/002_move_to_public_schema.sql
```

### Import Your Stars

```bash
# Full import (recommended for first run)
bun run sync

# Or run individual steps
bun run import         # Fetch starred repos from GitHub
bun run fetch-content  # Extract README content
bun run embeddings     # Generate vector embeddings
```

## MCP Server Setup

Add to your Claude MCP configuration (`~/.mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "star-vault": {
      "command": "bun",
      "args": ["run", "/path/to/star-vault/mcp-server/index.ts"],
      "env": {
        "SUPABASE_URL": "your-supabase-url",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "OPENAI_API_KEY": "your-openai-key"
      }
    }
  }
}
```

### Available MCP Tools

| Tool               | Description                               |
| ------------------ | ----------------------------------------- |
| `search_repos`     | Semantic search over starred repositories |
| `get_repo_details` | Get specific repo by owner/name           |
| `list_by_language` | Browse repos by programming language      |
| `find_similar`     | Find repos similar to a given one         |
| `get_stats`        | Show vault statistics                     |

### Example Queries

Once configured, ask Claude things like:

- _"Search my starred repos for state management libraries"_
- _"Find TypeScript repos related to CLI development"_
- _"What testing frameworks have I starred?"_
- _"Show me repos similar to zod"_

## Commands

| Command                 | Description                               |
| ----------------------- | ----------------------------------------- |
| `bun run import`        | Import starred repos from GitHub          |
| `bun run fetch-content` | Fetch README/package.json content         |
| `bun run embeddings`    | Generate pending embeddings               |
| `bun run sync`          | Full sync (import + content + embeddings) |
| `bun run stats`         | Show vault statistics                     |
| `bun run mcp`           | Run MCP server standalone                 |
| `bun run typecheck`     | TypeScript type checking                  |

## Environment Variables

| Variable                    | Required | Description                             |
| --------------------------- | -------- | --------------------------------------- |
| `SUPABASE_URL`              | Yes      | Your Supabase project URL               |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service role key (for admin operations) |
| `SUPABASE_ANON_KEY`         | No       | Anon key (for MCP server)               |
| `OPENAI_API_KEY`            | Yes      | OpenAI API key for embeddings           |
| `GITHUB_TOKEN`              | Yes      | GitHub PAT with `repo` scope            |

## Database Schema

### Tables

| Table           | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `sv_repos`      | Starred repos with metadata and 1536d embeddings |
| `sv_sync_state` | Sync history and statistics                      |

### Key Functions

- `sv_search_repos(embedding, threshold, limit)` — Vector similarity search
- `sv_get_repo_details(full_name)` — Get repo by owner/name
- `sv_get_stats()` — Vault statistics

## Automated Daily Sync

For automated syncing, deploy the Edge Function and configure pg_cron:

```sql
-- Schedule daily sync at 7 AM UTC
SELECT cron.schedule(
  'star-vault-daily-sync',
  '0 7 * * *',
  $$SELECT trigger_star_vault_sync()$$
);
```

See `supabase/functions/star-vault-sync/` for the Edge Function code.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) 1.2+
- **Language**: TypeScript 5.7
- **Database**: PostgreSQL + [pgvector](https://github.com/pgvector/pgvector)
- **Embeddings**: OpenAI text-embedding-3-small (1536d)
- **Vector Index**: HNSW (m=16, ef_construction=64)
- **Validation**: [Zod](https://zod.dev)
- **MCP**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)

## Related Projects

- [Tweet Vault](https://github.com/duhman/tweet-vault) — Same concept for Twitter bookmarks
- [Bird CLI](https://github.com/steipete/bird) — Twitter/X CLI tool

## License

MIT
