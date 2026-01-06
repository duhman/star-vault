#!/usr/bin/env node
/**
 * Star Vault MCP Server
 * Semantic search over GitHub starred repositories
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { supabase } from "../src/utils/supabase.js";
import { generateEmbedding } from "../src/utils/openai.js";

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
      const queryEmbedding = await generateEmbedding(query);

      const { data, error } = await supabase.rpc("search_repos", {
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_language: language || null,
        filter_min_stars: min_stars || null,
      });

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text", text: "No matching repositories found." }],
        };
      }

      const results = data.map((repo: Record<string, unknown>, i: number) => {
        const similarity = ((repo.similarity as number) * 100).toFixed(1);
        return `${i + 1}. **${repo.full_name}** (${similarity}% match)
   ⭐ ${repo.stars} | 🍴 ${repo.forks} | ${repo.language || "Unknown"}
   ${repo.description || "No description"}
   Topics: ${(repo.topics as string[])?.join(", ") || "none"}
   URL: https://github.com/${repo.full_name}`;
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
      const { data, error } = await supabase.rpc("get_repo_details", {
        repo_full_name: full_name,
      });

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Repository "${full_name}" not found in starred repos.`,
            },
          ],
        };
      }

      const repo = data[0];
      const readme = repo.readme
        ? `\n\n## README (excerpt)\n\n${(repo.readme as string).slice(0, 3000)}${(repo.readme as string).length > 3000 ? "..." : ""}`
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
**Stars:** ${repo.stars} | **Forks:** ${repo.forks}
**License:** ${repo.license || "Unknown"}
**Topics:** ${(repo.topics as string[])?.join(", ") || "none"}

**URL:** https://github.com/${repo.full_name}
**Starred:** ${new Date(repo.starred_at as string).toLocaleDateString()}${readme}${deps}`,
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
      const { data, error } = await supabase.rpc("get_stats");

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return {
          content: [{ type: "text", text: "No statistics available." }],
        };
      }

      const stats = data[0];
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
      let query = supabase
        .from("repos")
        .select("full_name, description, stars, forks, topics, starred_at")
        .ilike("language", language)
        .limit(limit);

      if (sort_by === "stars") {
        query = query.order("stars", { ascending: false });
      } else if (sort_by === "forks") {
        query = query.order("forks", { ascending: false });
      } else {
        query = query.order("starred_at", { ascending: false });
      }

      const { data, error } = await query;

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }

      if (!data || data.length === 0) {
        return {
          content: [
            { type: "text", text: `No ${language} repositories found.` },
          ],
        };
      }

      const results = data.map((repo, i) => {
        return `${i + 1}. **${repo.full_name}** ⭐ ${repo.stars}
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
      const { data: sourceRepo, error: sourceError } = await supabase
        .from("repos")
        .select("embedding")
        .eq("full_name", full_name)
        .single();

      if (sourceError || !sourceRepo?.embedding) {
        return {
          content: [
            {
              type: "text",
              text: `Repository "${full_name}" not found or has no embedding.`,
            },
          ],
        };
      }

      // Find similar repos
      const { data, error } = await supabase.rpc("search_repos", {
        query_embedding: sourceRepo.embedding,
        match_count: limit + 1, // +1 to exclude self
        filter_language: null,
        filter_min_stars: null,
      });

      if (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      }

      // Filter out the source repo
      const similar = (data || [])
        .filter((r: Record<string, unknown>) => r.full_name !== full_name)
        .slice(0, limit);

      if (similar.length === 0) {
        return {
          content: [{ type: "text", text: "No similar repositories found." }],
        };
      }

      const results = similar.map(
        (repo: Record<string, unknown>, i: number) => {
          const similarity = ((repo.similarity as number) * 100).toFixed(1);
          return `${i + 1}. **${repo.full_name}** (${similarity}% similar)
   ⭐ ${repo.stars} | ${repo.language || "Unknown"}
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
