#!/usr/bin/env node
/**
 * Star Vault MCP Server
 * Semantic search over GitHub starred repositories using Supabase
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// Environment validation
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const schema = process.env.SUPABASE_SCHEMA || "star_vault";

if (!supabaseUrl || !supabaseKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}
if (!openaiKey) {
  throw new Error("OPENAI_API_KEY is required for embeddings");
}

// Initialize clients
const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema },
});
const openai = new OpenAI({ apiKey: openaiKey });

// Generate embedding for a query
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return response.data[0].embedding;
}

// Format repo result for display
interface Repo {
  id: number;
  full_name: string;
  description?: string;
  topics?: string[];
  language?: string;
  stargazers_count?: number;
  forks_count?: number;
  license?: string;
  html_url: string;
  starred_at?: string;
  readme_content?: string;
  package_json?: Record<string, unknown>;
}

interface SearchResult extends Repo {
  similarity: number;
}

const server = new McpServer({
  name: "star-vault",
  version: "2.0.0",
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
      const embedding = await getEmbedding(query);

      // Call the search function
      const { data, error } = await supabase.rpc("search_repos", {
        query_embedding: JSON.stringify(embedding),
        match_threshold: 0.5,
        match_count: limit * 2, // Fetch extra for filtering
      });

      if (error) throw error;

      let results: SearchResult[] = data || [];

      // Apply additional filters
      if (language) {
        results = results.filter(
          (r) => r.language?.toLowerCase() === language.toLowerCase(),
        );
      }
      if (min_stars) {
        results = results.filter((r) => (r.stargazers_count ?? 0) >= min_stars);
      }

      results = results.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching repositories found." }],
        };
      }

      const formatted = results.map((repo, i) => {
        const similarity = ((repo.similarity ?? 0) * 100).toFixed(1);
        return `${i + 1}. **${repo.full_name}** (${similarity}% match)
   ⭐ ${repo.stargazers_count ?? 0} | 🍴 ${repo.forks_count ?? 0} | ${repo.language || "Unknown"}
   ${repo.description || "No description"}
   Topics: ${repo.topics?.join(", ") || "none"}
   URL: ${repo.html_url}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matching repositories:\n\n${formatted.join("\n\n")}`,
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
      const { data: repo, error } = await supabase
        .from("repos")
        .select("*")
        .eq("full_name", full_name)
        .single();

      if (error || !repo) {
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

      const deps = repo.package_json?.dependencies
        ? `\n\n## Dependencies\n${Object.keys(repo.package_json.dependencies).slice(0, 20).join(", ")}${Object.keys(repo.package_json.dependencies).length > 20 ? "..." : ""}`
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
**Topics:** ${repo.topics?.join(", ") || "none"}

**URL:** ${repo.html_url}
**Starred:** ${repo.starred_at ? new Date(repo.starred_at).toLocaleDateString() : "Unknown"}${readme}${deps}`,
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
      // Get total count
      const { count: totalRepos } = await supabase
        .from("repos")
        .select("*", { count: "exact", head: true });

      // Get count with embeddings
      const { count: withEmbeddings } = await supabase
        .from("repos")
        .select("*", { count: "exact", head: true })
        .not("embedding", "is", null);

      // Get count with readme
      const { count: withReadme } = await supabase
        .from("repos")
        .select("*", { count: "exact", head: true })
        .not("readme_content", "is", null);

      // Get top languages
      const { data: langData } = await supabase
        .from("repos")
        .select("language")
        .not("language", "is", null);

      const langCounts: Record<string, number> = {};
      langData?.forEach((r) => {
        if (r.language) {
          langCounts[r.language] = (langCounts[r.language] || 0) + 1;
        }
      });
      const topLangs = Object.entries(langCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([lang, count]) => `${lang} (${count})`)
        .join(", ");

      // Get last sync
      const { data: syncData } = await supabase
        .from("sync_state")
        .select("last_sync_at")
        .order("last_sync_at", { ascending: false })
        .limit(1);

      const lastSync = syncData?.[0]?.last_sync_at;

      return {
        content: [
          {
            type: "text",
            text: `# Star Vault Statistics

**Total Repositories:** ${totalRepos ?? 0}
**With Embeddings:** ${withEmbeddings ?? 0}
**With README:** ${withReadme ?? 0}

**Top Languages:** ${topLangs || "N/A"}

**Last Synced:** ${lastSync ? new Date(lastSync).toLocaleString() : "Never"}`,
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
      const sortColumn =
        sort_by === "stars"
          ? "stargazers_count"
          : sort_by === "forks"
            ? "forks_count"
            : "starred_at";

      const { data, error } = await supabase
        .from("repos")
        .select(
          "full_name, description, stargazers_count, forks_count, html_url",
        )
        .ilike("language", language)
        .order(sortColumn, { ascending: false })
        .limit(limit);

      if (error) throw error;

      if (!data || data.length === 0) {
        return {
          content: [
            { type: "text", text: `No ${language} repositories found.` },
          ],
        };
      }

      const results = data.map((repo, i) => {
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
      // Get the source repo's embedding
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

      // Search for similar repos using the embedding
      const { data, error } = await supabase.rpc("search_repos", {
        query_embedding: JSON.stringify(sourceRepo.embedding),
        match_threshold: 0.5,
        match_count: limit + 1, // +1 to exclude the source repo
      });

      if (error) throw error;

      // Filter out the source repo
      const similar = (data || [])
        .filter((r: SearchResult) => r.full_name !== full_name)
        .slice(0, limit);

      if (similar.length === 0) {
        return {
          content: [{ type: "text", text: "No similar repositories found." }],
        };
      }

      const results = similar.map((repo: SearchResult, i: number) => {
        const similarity = ((repo.similarity ?? 0) * 100).toFixed(1);
        return `${i + 1}. **${repo.full_name}** (${similarity}% similar)
   ⭐ ${repo.stargazers_count ?? 0} | ${repo.language || "Unknown"}
   ${repo.description || "No description"}`;
      });

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
  console.error("Star Vault MCP Server v2.0.0 (Supabase) running on stdio");
}

main().catch(console.error);
