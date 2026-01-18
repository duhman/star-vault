# ⭐ Star Vault

**GitHub Stars Intelligence System** — Capture your starred repositories, extract content, generate embeddings, and search them semantically via Claude MCP.

Ever starred hundreds of repos and forgot what's in there? Star Vault makes your GitHub stars searchable with natural language queries like _"that React animation library"_ or _"CLI tools for database migrations"_.

## Features

- 🔍 **Semantic Search** — Find repos by description, not just keywords
- 📚 **README Extraction** — Captures full README content for better context
- 🤖 **Claude MCP Integration** — Query your stars directly from Claude
- ⏰ **Daily Sync** — Automatically captures new stars via Convex cron
- 🧠 **Smart Embeddings** — OpenAI text-embedding-3-small (1536 dimensions)
- ⚡ **Fast Vector Search** — Convex vector index

## Architecture

```
GitHub API → Fetch Repos → Extract README → Generate Embeddings → Convex
                                                                        ↓
                                                                  MCP Server → Claude
```

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) 1.2+
- [Convex](https://docs.convex.dev) deployment (self-host project)
- [OpenAI API key](https://platform.openai.com/api-keys) (set in Convex env)
- [GitHub Personal Access Token](https://github.com/settings/tokens) (set in Convex env)

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

Convex schema and cron jobs live in `/Users/bigmac/projects/personal/self-host/convex/`.
Deploy with:

```bash
cd /Users/bigmac/projects/personal/self-host
CONVEX_DEPLOY_KEY="$(cat .convex-deploy-key)" npx convex deploy
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
        "CONVEX_URL": "https://utmost-gerbil-770.convex.cloud"
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

| Variable            | Required | Description                     |
| ------------------- | -------- | ------------------------------- |
| `CONVEX_URL`        | Yes      | Convex deployment URL           |
| `CONVEX_DEPLOY_KEY` | No       | Convex CLI deploy/run access    |
| `OPENAI_API_KEY`    | No       | Set in Convex env for embeddings|
| `GITHUB_TOKEN`      | No       | Set in Convex env for GitHub API|

## Database Schema

### Tables

| Table           | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `sv_repos`      | Starred repos with metadata and 1536d embeddings |
| `sv_sync_state` | Sync history and statistics                      |

### Key Functions (Convex)

- `starVaultQueries.searchRepos` — Vector similarity search
- `starVaultQueries.getRepoDetails` — Get repo by owner/name
- `starVaultQueries.getStats` — Vault statistics

## Automated Daily Sync

Automated sync runs via Convex cron in `convex/crons.ts` (7 AM UTC), calling
`starVault.syncStarVault`.

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) 1.2+
- **Language**: TypeScript 5.7
- **Database**: [Convex](https://docs.convex.dev)
- **Embeddings**: OpenAI text-embedding-3-small (1536d)
- **Vector Index**: Convex vector index
- **Validation**: [Zod](https://zod.dev)
- **MCP**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/sdk)

## Related Projects

- [Tweet Vault](https://github.com/duhman/tweet-vault) — Same concept for Twitter bookmarks
- [Bird CLI](https://github.com/steipete/bird) — Twitter/X CLI tool

## License

MIT
