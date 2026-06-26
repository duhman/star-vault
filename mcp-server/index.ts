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
import { z } from "zod/v4";
import { createClient } from "@supabase/supabase-js";
import {
  CONTENT_STALE_DAYS,
  EMBEDDING_DIMENSIONS,
  STAR_VAULT_RPC,
  STAR_VAULT_SCHEMA,
  STAR_VAULT_TABLES,
  type SearchRepoRow,
} from "../src/shared/starVault.js";
import { createEmbeddingProvider } from "../src/sync/embeddingProvider.js";

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
  content_fetched_at?: string | null;
  content_checked_at?: string | null;
  content_changed_at?: string | null;
  source_changed_at?: string | null;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  embedding_generated_at?: string | null;
  readme_content?: string | null;
  package_json?: Record<string, unknown> | null;
}

interface RepoDependencyCandidate extends SearchRepoRow {
  package_json?: Record<string, unknown> | null;
}

interface SearchReposArgs {
  query: string;
  limit?: number;
  language?: string;
  min_stars?: number;
  dependency?: string;
}

interface RepoNameArgs {
  full_name: string;
}

interface ListByLanguageArgs {
  language: string;
  limit?: number;
  sort_by?: "stars" | "forks" | "starred_at";
}

interface FindSimilarArgs extends RepoNameArgs {
  limit?: number;
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

const supabase = createClient(supabaseUrl, supabaseKey, {
  db: { schema: STAR_VAULT_SCHEMA },
});
const embeddingProvider = createEmbeddingProvider();

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
    embedding_provider_filter: embeddingProvider.name,
    embedding_model_filter: embeddingProvider.model,
    embedding_dim_filter: embeddingProvider.dimensions,
  });

  if (rpcError) {
    throw new Error(
      `Supabase RPC check failed for ${STAR_VAULT_SCHEMA}.${STAR_VAULT_RPC.searchRepos}: ${rpcError.message}. ` +
        `Run the canonical reconciliation migration.`,
    );
  }
}

async function getEmbedding(text: string): Promise<number[]> {
  const [embedding] = await embeddingProvider.embed([text]);
  return embedding;
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
  if (repo.stargazers_count != null) metrics.push(`Stars ${repo.stargazers_count}`);
  if (repo.forks_count != null) metrics.push(`Forks ${repo.forks_count}`);
  metrics.push(repo.language || "Unknown");
  if (repo.starred_at) {
    metrics.push(`Starred ${new Date(repo.starred_at).toLocaleDateString()}`);
  }
  if (repo.dependency_match) metrics.push("dependency match");

  return `${index + 1}. **${repo.full_name}** (${similarity}% match)
   ${metrics.join(" | ")}
   ${repo.description || "No description"}
   Topics: ${repo.topics?.join(", ") || "none"}
   ${formatFreshness(repo)}
   URL: ${repo.html_url}`;
}

function ageInDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
}

function formatAge(value: string | null | undefined): string {
  const days = ageInDays(value);
  if (days === null) return "unknown";
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatFreshness(repo: SearchRepoRow): string {
  const contentAge = ageInDays(repo.content_checked_at);
  const contentState =
    contentAge === null
      ? "content not checked"
      : contentAge > CONTENT_STALE_DAYS
        ? `content stale (${contentAge} days)`
        : `content checked ${formatAge(repo.content_checked_at)}`;
  const embeddingState = repo.embedding_generated_at
    ? `embedding ${repo.embedding_provider ?? "unknown"}/${repo.embedding_model ?? "unknown"} generated ${formatAge(repo.embedding_generated_at)}`
    : "embedding age unknown";
  return `Freshness: ${contentState}; ${embeddingState}`;
}

function dependencyNames(
  packageJson: Record<string, unknown> | null | undefined,
): string[] {
  if (!packageJson) return [];
  const names: string[] = [];
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = packageJson[key];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      names.push(...Object.keys(deps as Record<string, unknown>));
    }
  }
  return [...new Set(names)];
}

function inferDependencyQuery(query: string): string | null {
  const match = query.match(
    /\b(?:using|uses|use|depends on|dependency|package|library)\s+(@?[\w./-]+)/i,
  );
  return match?.[1] ?? null;
}

async function findDependencyMatches(options: {
  dependency: string;
  limit: number;
  language?: string;
  minStars?: number;
}): Promise<SearchRepoRow[]> {
  const needle = options.dependency.toLowerCase();
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select(
      "id, full_name, description, topics, language, html_url, stargazers_count, forks_count, starred_at, content_fetched_at, content_checked_at, content_changed_at, source_changed_at, embedding_provider, embedding_model, embedding_dim, embedding_generated_at, package_json",
    )
    .not("package_json", "is", null)
    .limit(2000);

  if (error) throw error;

  return ((data ?? []) as RepoDependencyCandidate[])
    .filter((repo) =>
      dependencyNames(repo.package_json).some(
        (name) => name.toLowerCase() === needle,
      ),
    )
    .filter((repo) => !options.language || repo.language === options.language)
    .filter((repo) => (repo.stargazers_count ?? 0) >= (options.minStars ?? 0))
    .sort((a, b) => (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0))
    .slice(0, options.limit)
    .map((repo) => ({
      ...repo,
      dependency_match: true,
      similarity: 1,
    }));
}

function mergeResults(
  semanticResults: SearchRepoRow[],
  dependencyResults: SearchRepoRow[],
): SearchRepoRow[] {
  const byName = new Map<string, SearchRepoRow>();
  for (const repo of dependencyResults) {
    byName.set(repo.full_name, repo);
  }
  for (const repo of semanticResults) {
    const existing = byName.get(repo.full_name);
    byName.set(repo.full_name, {
      ...repo,
      dependency_match: existing?.dependency_match ?? repo.dependency_match,
    });
  }
  return [...byName.values()].sort((a, b) => {
    if (a.dependency_match !== b.dependency_match) {
      return a.dependency_match ? -1 : 1;
    }
    return (b.similarity ?? 0) - (a.similarity ?? 0);
  });
}

const server = new McpServer({
  name: "star-vault",
  version: "2.1.0",
});

server.registerTool(
  "search_repos",
  {
    title: "Search Repositories",
    description:
      "Search starred GitHub repositories using semantic search, with optional dependency matching.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results"),
      language: z.string().optional().describe("Filter by programming language"),
      min_stars: z.number().optional().describe("Minimum star count"),
      dependency: z
        .string()
        .optional()
        .describe("Exact package/dependency name to prioritize"),
    }) as any,
  },
  async (args: unknown) => {
    const {
      query,
      limit = 10,
      language,
      min_stars,
      dependency,
    } = args as SearchReposArgs;
    try {
      const dependencyQuery = dependency ?? inferDependencyQuery(query);
      const embedding = await getEmbedding(query);
      const { data, error } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
        query_embedding: JSON.stringify(embedding),
        match_threshold: 0.5,
        match_count: limit * 3,
        embedding_provider_filter: embeddingProvider.name,
        embedding_model_filter: embeddingProvider.model,
        embedding_dim_filter: embeddingProvider.dimensions,
      });

      if (error) throw error;

      let canonicalLanguage: string | null | undefined;

      if (language) {
        canonicalLanguage = await resolveCanonicalLanguage(language);
        if (!canonicalLanguage) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No repositories found for language "${language}".`,
              },
            ],
          };
        }
      }

      const dependencyResults = dependencyQuery
        ? await findDependencyMatches({
            dependency: dependencyQuery,
            limit,
            language: canonicalLanguage ?? undefined,
            minStars: min_stars,
          })
        : [];

      let results = mergeResults(
        ((data ?? []) as SearchRepoRow[]).slice(),
        dependencyResults,
      );

      if (canonicalLanguage) {
        results = results.filter((repo) => repo.language === canonicalLanguage);
      }

      if (min_stars != null) {
        results = results.filter((repo) => (repo.stargazers_count ?? 0) >= min_stars);
      }

      results = results.slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No matching repositories found." }],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} matching repositories using ${embeddingProvider.name}/${embeddingProvider.model}${dependencyQuery ? ` with dependency lens "${dependencyQuery}"` : ""}:\n\n${results
              .map((repo, index) => formatRepoLine(repo, index))
              .join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.registerTool(
  "get_repo_details",
  {
    title: "Get Repository Details",
    description:
      "Get detailed information about a specific starred repository, including README content.",
    inputSchema: z.object({
      full_name: z
        .string()
        .describe("Repository full name (e.g., 'owner/repo')"),
    }) as any,
  },
  async (args: unknown) => {
    const { full_name } = args as RepoNameArgs;
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
              type: "text" as const,
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
            type: "text" as const,
            text: `# ${typedRepo.full_name}

${typedRepo.description || "No description"}

**Language:** ${typedRepo.language || "Unknown"}
**Stars:** ${typedRepo.stargazers_count ?? "N/A"} | **Forks:** ${typedRepo.forks_count ?? "N/A"}
**License:** ${typedRepo.license || "Unknown"}
**Topics:** ${typedRepo.topics?.join(", ") || "none"}

**URL:** ${typedRepo.html_url}
**Starred:** ${typedRepo.starred_at ? new Date(typedRepo.starred_at).toLocaleDateString() : "Unknown"}
**Freshness:** ${formatFreshness({
              id: typedRepo.id,
              full_name: typedRepo.full_name,
              description: typedRepo.description ?? null,
              topics: typedRepo.topics ?? null,
              language: typedRepo.language ?? null,
              html_url: typedRepo.html_url,
              stargazers_count: typedRepo.stargazers_count,
              forks_count: typedRepo.forks_count,
              starred_at: typedRepo.starred_at,
              content_fetched_at: typedRepo.content_fetched_at,
              content_checked_at: typedRepo.content_checked_at,
              content_changed_at: typedRepo.content_changed_at,
              source_changed_at: typedRepo.source_changed_at,
              embedding_provider: typedRepo.embedding_provider,
              embedding_model: typedRepo.embedding_model,
              embedding_dim: typedRepo.embedding_dim,
              embedding_generated_at: typedRepo.embedding_generated_at,
              similarity: 1,
            })}${readme}${deps}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.registerTool("get_stats", {
  title: "Get Statistics",
  description: "Get statistics about the starred repositories collection.",
}, async () => {
  try {
    const { count: totalRepos } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true });

    const { count: withEmbeddings } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true })
      .not("embedding", "is", null);

    const { count: withActiveProviderEmbeddings } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("*", { count: "exact", head: true })
      .eq("embedding_provider", embeddingProvider.name)
      .eq("embedding_model", embeddingProvider.model)
      .eq("embedding_dim", embeddingProvider.dimensions)
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
          type: "text" as const,
          text: `# Star Vault Statistics

**Total Repositories:** ${totalRepos ?? 0}
**With Embeddings:** ${withEmbeddings ?? 0}
**With Active Provider Embeddings:** ${withActiveProviderEmbeddings ?? 0} (${embeddingProvider.name}/${embeddingProvider.model})
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
          type: "text" as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
});

server.registerTool(
  "list_by_language",
  {
    title: "List By Language",
    description: "List starred repositories filtered by programming language.",
    inputSchema: z.object({
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
    }) as any,
  },
  async (args: unknown) => {
    const {
      language,
      limit = 20,
      sort_by = "stars",
    } = args as ListByLanguageArgs;
    try {
      const canonicalLanguage = await resolveCanonicalLanguage(language);
      if (!canonicalLanguage) {
        return {
          content: [
            { type: "text" as const, text: `No ${language} repositories found.` },
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
            { type: "text" as const, text: `No ${language} repositories found.` },
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
            type: "text" as const,
            text: `Found ${data.length} ${canonicalLanguage} repositories:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
);

server.registerTool(
  "find_similar",
  {
    title: "Find Similar Repositories",
    description:
      "Find repositories similar to a given one using the active embedding provider.",
    inputSchema: z.object({
      full_name: z
        .string()
        .describe("Repository full name to find similar repos for"),
      limit: z
        .number()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum number of results"),
    }) as any,
  },
  async (args: unknown) => {
    const { full_name, limit = 5 } = args as FindSimilarArgs;
    try {
      const { data: sourceRepo, error: sourceError } = await supabase
        .from(STAR_VAULT_TABLES.repos)
        .select("embedding, embedding_provider, embedding_model, embedding_dim")
        .eq("full_name", full_name)
        .single();

      const typedSource = sourceRepo as
        | {
            embedding?: number[] | null;
            embedding_provider?: string | null;
            embedding_model?: string | null;
            embedding_dim?: number | null;
          }
        | null;

      if (sourceError || !typedSource?.embedding) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Repository "${full_name}" not found or has no embedding.`,
            },
          ],
        };
      }

      if (
        typedSource.embedding_provider !== embeddingProvider.name ||
        typedSource.embedding_model !== embeddingProvider.model ||
        typedSource.embedding_dim !== embeddingProvider.dimensions
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Repository "${full_name}" does not have an active ${embeddingProvider.name}/${embeddingProvider.model} embedding yet.`,
            },
          ],
        };
      }

      const { data, error } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
        query_embedding: JSON.stringify(typedSource.embedding),
        match_threshold: 0.5,
        match_count: limit + 1,
        embedding_provider_filter: embeddingProvider.name,
        embedding_model_filter: embeddingProvider.model,
        embedding_dim_filter: embeddingProvider.dimensions,
      });

      if (error) throw error;

      const similar = ((data ?? []) as SearchRepoRow[])
        .filter((repo) => repo.full_name !== full_name)
        .slice(0, limit);

      if (similar.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No similar repositories found." }],
        };
      }

      const lines = similar.map((repo, index) => {
        const similarity = ((repo.similarity ?? 0) * 100).toFixed(1);
        return `${index + 1}. **${repo.full_name}** (${similarity}% similar)
   ${repo.language || "Unknown"}
   ${repo.description || "No description"}
   ${formatFreshness(repo)}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Repositories similar to ${full_name}:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
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
