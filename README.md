# ⭐ Star Vault

**GitHub Stars Intelligence System** — Capture your starred repositories, extract content, generate embeddings, and search them semantically via Claude MCP.

Ever starred hundreds of repos and forgot what's in there? Star Vault makes your GitHub stars searchable with natural language queries like _"that React animation library"_ or _"CLI tools for database migrations"_.

## Features

- 🔍 **Semantic Search** — Find repos by description, not just keywords
- 📚 **README Extraction** — Captures full README content for better context
- 🤖 **Claude MCP Integration** — Query your stars directly from Claude
- ⏰ **Daily Sync** — Automatically captures new stars via Supabase Edge Function
- 🧠 **Smart Embeddings** — OpenAI text-embedding-3-small (1536 dimensions)
- ⚡ **Fast Vector Search** — pgvector with HNSW index

## Architecture

```
GitHub API → Fetch Repos → Extract README → Generate Embeddings → Supabase
                                                                       ↓
                                                                 MCP Server → Claude
```

**Database**: Supabase Cloud with `star_vault` schema
**Tables**: `repos`, `sync_state`
**Search**: `search_repos` RPC function (pgvector similarity)

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.2+
- [Supabase](https://supabase.com) project with pgvector enabled
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
# Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY, GITHUB_TOKEN
```

### Database Setup

Run the migrations in `supabase/migrations/` via Supabase SQL Editor or CLI:

```sql
-- 001_initial_schema.sql creates:
-- - star_vault schema
-- - repos table with embedding column
-- - sync_state table
-- - search_repos function
-- - HNSW vector index
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

Add to your Claude MCP configuration (`~/.config/claude-code/settings.json` or Claude Desktop):

```json
{
  "mcpServers": {
    "star-vault": {
      "command": "bun",
      "args": ["run", "/path/to/star-vault/mcp-server/index.ts"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key",
        "OPENAI_API_KEY": "sk-..."
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

| Variable                    | Required | Description                         |
| --------------------------- | -------- | ----------------------------------- |
| `SUPABASE_URL`              | Yes      | Supabase project URL                |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes      | Service role key (not anon!)        |
| `OPENAI_API_KEY`            | Yes      | For embeddings generation           |
| `GITHUB_TOKEN`              | Yes      | GitHub PAT with `repo` scope        |
| `SUPABASE_SCHEMA`           | No       | Schema name (default: `star_vault`) |

## Database Schema

### Tables (in `star_vault` schema)

| Table        | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `repos`      | Starred repos with metadata and 1536d embeddings |
| `sync_state` | Sync history and statistics                      |

### Key Functions

- `search_repos` — Vector similarity search via pgvector
- `get_repo_details` — Get repo by full_name (owner/repo)
- `get_stats` — Vault statistics

## Automated Daily Sync

The Edge Function at `supabase/functions/star-vault-sync/` runs daily at 7 AM UTC via Supabase cron:

- Fetches new starred repos from GitHub
- Extracts README and package.json content
- Generates embeddings for repos missing them

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) 1.2+
- **Language**: TypeScript 5.7
- **Database**: [Supabase](https://supabase.com) (PostgreSQL + pgvector)
- **Embeddings**: OpenAI text-embedding-3-small (1536d)
- **Vector Index**: HNSW (pgvector)
- **Validation**: [Zod](https://zod.dev)
- **MCP**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)

## Related Projects

- [Tweet Vault](https://github.com/duhman/tweet-vault) — Same concept for Twitter bookmarks

## License

MIT
