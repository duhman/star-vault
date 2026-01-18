# Star Vault - GitHub Stars Intelligence System

Capture GitHub starred repositories, extract content, generate embeddings, and make them searchable via semantic search.

## Status: ✅ Operational (Convex)

| Metric               | Value                         |
| -------------------- | ----------------------------- |
| Repos imported       | 652                           |
| README content       | 652 (100%)                    |
| Embeddings generated | 652 (100%)                    |
| Daily sync           | ✅ Convex cron (7 AM UTC)     |
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
GitHub API → Fetch Repos → Fetch Content → Generate Embeddings → Convex
                                                                        ↓
                                                                  MCP Server → Claude
```

## Database

Uses Convex deployment `https://utmost-gerbil-770.convex.cloud`

| Table           | Purpose                             |
| --------------- | ----------------------------------- |
| `sv_repos`      | Starred repos with 1536d embeddings |
| `sv_sync_state` | Sync history and stats              |

### Key Functions (Convex)

- `starVaultQueries.searchRepos` - Semantic repo search
- `starVaultQueries.getRepoDetails` - Get repo by owner/name
- `starVaultQueries.getStats` - Vault statistics

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
        "CONVEX_URL": "https://utmost-gerbil-770.convex.cloud"
      }
    }
  }
}
```

## Tech Stack

- **Runtime**: Bun 1.2+, TypeScript 5.7
- **Database**: Convex
- **Embeddings**: OpenAI text-embedding-3-small (1536d) in Convex
- **Vector Index**: Convex vector index
- **Validation**: Zod
- **MCP**: @modelcontextprotocol/sdk

## Environment Variables

| Variable                    | Required | Description                   |
| --------------------------- | -------- | ----------------------------- |
| `CONVEX_URL`                | Yes      | Convex deployment URL         |
| `CONVEX_DEPLOY_KEY`         | No       | Convex CLI deploy/run access  |
| `OPENAI_API_KEY`            | No       | Set in Convex env for embeddings |
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

The daily sync runs at **7 AM UTC** via Convex cron in
`/Users/bigmac/projects/personal/self-host/convex/crons.ts`, calling
`starVault.syncStarVault`.
