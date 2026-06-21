#!/usr/bin/env node
/**
 * Star Vault MCP Server
 * Semantic search over GitHub starred repositories using Supabase.
 */

// override: true ensures project .env wins over stale shell exports
// (e.g. SUPABASE_SCHEMA=tweet_vault leaking from another project session)
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  STAR_VAULT_RPC,
  STAR_VAULT_SCHEMA,
  STAR_VAULT_TABLES,
  type SearchRepoRow,
} from "../src/shared/starVault.js";

interface RepoDetails {
  id: number;
  full_name: string;
  description?: string | null;
  topics?: string[] | null;
  language?: string | null;
  stargazers_count?: number | null;
  forks_count?: number | null;
  license?: string | null;
  html_url: string;
  starred_at?: string | null;
  readme_content?: string | null;
  package_json?: Record<string, unknown> | null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env or MCP env configuration before starting the server.`,
    );
  }
  return value;
}

const supabaseUrl = requireEnv("SUPABASE_URL");
const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const openaiKey = requireEnv("OPENAI_API_KEY");

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: STAR_VAULT_SCHEMA },
});
const openai = new OpenAI({
  apiKey: openaiKey,
  maxRetries: 2,
  timeout: 20_000,
});

async function verifyBackendReadiness(): Promise<void> {
  const { error: tableError } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("id")
    .limit(1);

  if (tableError) {
    throw new Error(
      `Supabase table check failed for ${STAR_VAULT_SCHEMA}.${STAR_VAULT_TABLES.repos}: ${tableError.message}. ` +
        `Ensure migrations for star_vault schema are applied.`,
    );
  }

  const zeroVector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  const { error: rpcError } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
    query_embedding: JSON.stringify(zeroVector),
    match_threshold: 2,
    match_count: 1,
  });

  if (rpcError) {
    throw new Error(
      `Supabase RPC check failed for ${STAR_VAULT_SCHEMA}.${STAR_VAULT_RPC.searchRepos}: ${rpcError.message}. ` +
        `Run the canonical reconciliation migration.`,
    );
  }
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function resolveCanonicalLanguage(input: string): Promise<string | null> {
  const exact = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("language")
    .eq("language", input)
    .limit(1);
  if (!exact.error && exact.data && exact.data.length > 0) return input;

  const fallback = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("language")
    .ilike("language", input)
    .limit(1);

  if (fallback.error || !fallback.data || fallback.data.length === 0) {
    return null;
  }

  return (fallback.data[0] as { language?: string | null }).language ?? null;
}

function formatRepoLine(repo: SearchRepoRow, index: number): string {
  const similarity = ((repo.similarity ?? 0) * 100).toFixed(1);
  const metrics: string[] = [];
  if (repo.stargazers_count != null) metrics.push(`⭐ ${repo.stargazers_count}`);
  if (repo.forks_count != null) metrics.push(`🍴 ${repo.forks_count}`);
  metrics.push(repo.language || "Unknown");
  if (repo.starred_at) {
    metrics.push(`Starred ${new Date(repo.starred_at).toLocaleDateString()}`);
  }

  return `${index + 1}. **${repo.full_name}** (${similarity}% match)
   ${metrics.join(" | ")}
   ${repo.description || "No description"}
   Topics: ${repo.topics?.join(", ") || "none"}
   URL: ${repo.html_url}`;
}

const server = new McpServer({
  name: "star-vault",
  version: "2.1.0",
});

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
      const { data, error } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
        query_embedding: JSON.stringify(embedding),
        match_threshold: 0.5,
        match_count: limit * 3,
      });

      if (error) throw error;

      let results = ((data ?? []) as SearchRepoRow[]).slice();

      if (language) {
        const canonicalLanguage = await resolveCanonicalLanguage(language);
        if (!canonicalLanguage) {
          return {
            content: [
              {
                type: "text",
                text: `No repositories found for language "${language}".`,
              },
            ],
          };
        }
        results = results.filter((repo) => repo.language === canonicalLanguage);
      }

      if (min_stars != null) {
        results = results.filter((repo) => (repo.stargazers_count ?? 0) >= min_stars);
      }

      results = results.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No matching repositories found." }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} matching repositories:\n\n${results
              .map((repo, index) => formatRepoLine(repo, index))
              .join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  "get_repo_details",
  "Get detailed information about a specific starred repository, including its README content.",
  {
    full_name: z.string().describe("Repository full name (e.g., 'owner/repo')"),
  },
  async ({ full_name }) => {
    try {
      const { data: repo, error } = await supabase
        .from(STAR_VAULT_TABLES.repos)
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

      const typedRepo = repo as RepoDetails;
      const readme = typedRepo.readme_content
        ? `\n\n## README (excerpt)\n\n${typedRepo.readme_content.slice(0, 3000)}${typedRepo.readme_content.length > 3000 ? "..." : ""}`
        : "";

      const dependencies =
        typedRepo.package_json &&
        typeof typedRepo.package_json === "object" &&
        typedRepo.package_json.dependencies &&
        typeof typedRepo.package_json.dependencies === "object"
          ? Object.keys(
              typedRepo.package_json.dependencies as Record<string, string>,
            )
          : [];

      const deps =
        dependencies.length > 0
          ? `\n\n## Dependencies\n${dependencies.slice(0, 20).join(", ")}${dependencies.length > 20 ? "..." : ""}`
          : "";

      return {
        content: [
          {
            type: "text",
            text: `# ${typedRepo.full_name}

${typedRepo.description || "No description"}

**Language:** ${typedRepo.language || "Unknown"}
**Stars:** ${typedRepo.stargazers_count ?? "N/A"} | **Forks:** ${typedRepo.forks_count ?? "N/A"}
**License:** ${typedRepo.license || "Unknown"}
**Topics:** ${typedRepo.topics?.join(", ") || "none"}

**URL:** ${typedRepo.html_url}
**Starred:** ${typedRepo.starred_at ? new Date(typedRepo.starred_at).toLocaleDateString() : "Unknown"}${readme}${deps}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.tool("get_stats", "Get statistics about the starred repositories collection.", {}, async () => {
  try {
    const { count: totalRepos } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true });

    const { count: withEmbeddings } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true })
      .not("embedding", "is", null);

    const { count: withReadme } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true })
      .not("readme_content", "is", null);

    const { data: langData } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("language")
      .not("language", "is", null);

    const langCounts: Record<string, number> = {};
    (langData ?? []).forEach((row) => {
      const language = (row as { language?: string | null }).language;
      if (language) langCounts[language] = (langCounts[language] ?? 0) + 1;
    });
    const topLangs = Object.entries(langCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([language, count]) => `${language} (${count})`)
      .join(", ");

    const { data: syncData } = await supabase
      .from(STAR_VAULT_TABLES.syncState)
      .select("last_sync_at")
      .order("last_sync_at", { ascending: false })
      .limit(1);

    const lastSync = (syncData?.[0] as { last_sync_at?: string } | undefined)
      ?.last_sync_at;

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
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

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
      const canonicalLanguage = await resolveCanonicalLanguage(language);
      if (!canonicalLanguage) {
        return {
          content: [
            { type: "text", text: `No ${language} repositories found.` },
          ],
        };
      }

      const sortColumn =
        sort_by === "stars"
          ? "stargazers_count"
          : sort_by === "forks"
            ? "forks_count"
            : "starred_at";

      const { data, error } = await supabase
        .from(STAR_VAULT_TABLES.repos)
        .select(
          "full_name, description, stargazers_count, forks_count, html_url, language",
        )
        .eq("language", canonicalLanguage)
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

      const lines = data.map((repo, index) => {
        const typed = repo as {
          full_name: string;
          description?: string | null;
          stargazers_count?: number | null;
          forks_count?: number | null;
          html_url: string;
        };
        return `${index + 1}. **${typed.full_name}**
   ⭐ ${typed.stargazers_count ?? "N/A"} | 🍴 ${typed.forks_count ?? "N/A"}
   ${typed.description || "No description"}
   ${typed.html_url}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Found ${data.length} ${canonicalLanguage} repositories:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

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
      const { data: sourceRepo, error: sourceError } = await supabase
        .from(STAR_VAULT_TABLES.repos)
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

      const { data, error } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
        query_embedding: JSON.stringify(sourceRepo.embedding),
        match_threshold: 0.5,
        match_count: limit + 1,
      });

      if (error) throw error;

      const similar = ((data ?? []) as SearchRepoRow[])
        .filter((repo) => repo.full_name !== full_name)
        .slice(0, limit);

      if (similar.length === 0) {
        return {
          content: [{ type: "text", text: "No similar repositories found." }],
        };
      }

      const lines = similar.map((repo, index) => {
        const similarity = ((repo.similarity ?? 0) * 100).toFixed(1);
        return `${index + 1}. **${repo.full_name}** (${similarity}% similar)
   ${repo.language || "Unknown"}
   ${repo.description || "No description"}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `Repositories similar to ${full_name}:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

async function main(): Promise<void> {
  await verifyBackendReadiness();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Star Vault MCP Server v2.1.0 (${STAR_VAULT_SCHEMA} schema) running on stdio`,
  );
}

main().catch((error) => {
  console.error("Failed to start Star Vault MCP server:", error);
  process.exit(1);
});
