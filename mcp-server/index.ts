#!/usr/bin/env node
/**
 * Star Vault MCP Server
 * Semantic search over GitHub starred repositories
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/utils/convexApi.js";

const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) {
  throw new Error("CONVEX_URL is required for Star Vault MCP server");
}
const convex = new ConvexHttpClient(convexUrl);

const server = new McpServer({
  name: "star-vault",
  version: "1.0.0",
});

// Tool: Search repos by semantic query
server.tool(
  "search_repos",
  "Search starred GitHub repositories using semantic search. Returns repos matching the query based on their description, README, and topics.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results"),
    language: z.string().optional().describe("Filter by programming language"),
    min_stars: z.number().optional().describe("Minimum star count"),
  },
  async ({ query, limit = 10, language, min_stars }) => {
    try {
      const data = await convex.action(api.starVaultQueries.searchRepos, {
        query,
        limit,
        language,
        min_stars,
      });

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text", text: "No matching repositories found." }],
        };
      }

      const results = data.map((entry: any, i: number) => {
        const repo = entry.repo;
        const similarity = (entry.score * 100).toFixed(1);
        return `${i + 1}. **${repo.full_name}** (${similarity}% match)
   ⭐ ${repo.stargazers_count ?? 0} | 🍴 ${repo.forks_count ?? 0} | ${
     repo.language || "Unknown"
   }
   ${repo.description || "No description"}
   Topics: ${(repo.topics as string[])?.join(", ") || "none"}
   URL: ${repo.html_url}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.length} matching repositories:\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// Tool: Get detailed repo information
server.tool(
  "get_repo_details",
  "Get detailed information about a specific starred repository, including its README content.",
  {
    full_name: z.string().describe("Repository full name (e.g., 'owner/repo')"),
  },
  async ({ full_name }) => {
    try {
      const repo = await convex.query(api.starVaultQueries.getRepoDetails, {
        full_name,
      });

      if (!repo) {
        return {
          content: [
            {
              type: "text",
              text: `Repository "${full_name}" not found in starred repos.`,
            },
          ],
        };
      }

      const readme = repo.readme_content
        ? `\n\n## README (excerpt)\n\n${repo.readme_content.slice(0, 3000)}${repo.readme_content.length > 3000 ? "..." : ""}`
        : "";

      const deps = repo.dependencies
        ? `\n\n## Dependencies\n${(repo.dependencies as string[]).slice(0, 20).join(", ")}${(repo.dependencies as string[]).length > 20 ? "..." : ""}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `# ${repo.full_name}

${repo.description || "No description"}

**Language:** ${repo.language || "Unknown"}
**Stars:** ${repo.stargazers_count ?? 0} | **Forks:** ${repo.forks_count ?? 0}
**License:** ${repo.license || "Unknown"}
**Topics:** ${(repo.topics as string[])?.join(", ") || "none"}

**URL:** ${repo.html_url}
**Starred:** ${repo.starred_at ? new Date(repo.starred_at as string).toLocaleDateString() : "Unknown"}${readme}${deps}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// Tool: Get statistics
server.tool(
  "get_stats",
  "Get statistics about the starred repositories collection.",
  {},
  async () => {
    try {
      const stats = await convex.query(api.starVaultQueries.getStats, {});

      if (!stats) {
        return {
          content: [{ type: "text", text: "No statistics available." }],
        };
      }

      const topLangs =
        (stats.top_languages as string[])?.slice(0, 10).join(", ") || "N/A";

      return {
        content: [
          {
            type: "text",
            text: `# Star Vault Statistics

**Total Repositories:** ${stats.total_repos}
**With Embeddings:** ${stats.with_embeddings}
**With README:** ${stats.with_readme}

**Top Languages:** ${topLangs}

**Last Synced:** ${stats.last_sync ? new Date(stats.last_sync as string).toLocaleString() : "Never"}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// Tool: List repos by language
server.tool(
  "list_by_language",
  "List starred repositories filtered by programming language.",
  {
    language: z.string().describe("Programming language to filter by"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum number of results"),
    sort_by: z
      .enum(["stars", "forks", "starred_at"])
      .default("stars")
      .describe("Sort order"),
  },
  async ({ language, limit = 20, sort_by = "stars" }) => {
    try {
      const data = await convex.query(api.starVaultQueries.listByLanguage, {
        language,
        limit,
        sort_by,
      });

      if (!data || data.length === 0) {
        return {
          content: [
            { type: "text", text: `No ${language} repositories found.` },
          ],
        };
      }

      const results = data.map((repo: any, i: number) => {
        return `${i + 1}. **${repo.full_name}** ⭐ ${repo.stargazers_count ?? 0}
   ${repo.description || "No description"}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.length} ${language} repositories:\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// Tool: Find similar repos
server.tool(
  "find_similar",
  "Find repositories similar to a given one based on semantic similarity.",
  {
    full_name: z
      .string()
      .describe("Repository full name to find similar repos for"),
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results"),
  },
  async ({ full_name, limit = 5 }) => {
    try {
      // Get the embedding for the source repo
      const data = await convex.action(api.starVaultQueries.findSimilar, {
        full_name,
        limit,
      });

      const similar = data ?? [];

      if (similar.length === 0) {
        return {
          content: [{ type: "text", text: "No similar repositories found." }],
        };
      }

      const results = similar.map(
        (entry: { repo: any; score: number }, i: number) => {
          const repo = entry.repo;
          const similarity = (entry.score * 100).toFixed(1);
          return `${i + 1}. **${repo.full_name}** (${similarity}% similar)
   ⭐ ${repo.stargazers_count ?? 0} | ${repo.language || "Unknown"}
   ${repo.description || "No description"}`;
        },
      );

      return {
        content: [
          {
            type: "text",
            text: `Repositories similar to ${full_name}:\n\n${results.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Star Vault MCP Server running on stdio");
}

main().catch(console.error);
