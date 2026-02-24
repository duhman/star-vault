/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import {
  EMBEDDING_MODEL,
  STAR_VAULT_SCHEMA,
  STAR_VAULT_TABLES,
  type ErrorBucket,
} from "../shared/starVault.js";
import { fetchRepoContent } from "../github/content.js";
import { fetchAllStarredRepos } from "../github/starred.js";
import { runWithConcurrency } from "./async.js";
import { classifyError, withRetry } from "./retry.js";

export interface Repo {
  id?: number;
  github_id: number;
  full_name: string;
  owner: string;
  name: string;
  description?: string;
  topics?: string[];
  language?: string;
  stargazers_count?: number;
  forks_count?: number;
  license?: string;
  html_url: string;
  default_branch?: string;
  starred_at?: string;
  readme_content?: string;
  package_json?: Record<string, unknown>;
  raw_data?: Record<string, unknown>;
  fetched_at?: string;
  content_fetched_at?: string;
  embedding?: number[];
}

export interface SyncStateInput {
  last_sync_at: string;
  repos_added: number;
  repos_updated: number;
  content_fetched: number;
  embeddings_generated: number;
  sync_type: string;
  metadata?: Record<string, unknown>;
}

export interface VaultStats {
  total_repos: number;
  with_embeddings: number;
  with_readme: number;
  top_languages: string[];
  last_sync: string | null;
}

export interface SyncResult {
  repos_fetched: number;
  repos_added: number;
  repos_updated: number;
  content_fetched: number;
  embeddings_generated: number;
  errors: string[];
  error_summary: Record<ErrorBucket, number>;
  phase_durations_ms: {
    repos: number;
    content: number;
    embeddings: number;
    total: number;
  };
}

export interface SyncOptions {
  fetchRepos?: boolean;
  contentLimit?: number;
  embeddingLimit?: number;
  syncType?: string;
  maxPages?: number;
  contentConcurrency?: number;
  embeddingConcurrency?: number;
}

type RepoStatsRow = { language: string | null };
type RepoIdRow = { github_id: number };

let supabaseClient: any = null;

function createErrorSummary(): Record<ErrorBucket, number> {
  return {
    rate_limit: 0,
    network: 0,
    validation: 0,
    db: 0,
    unknown: 0,
  };
}

function addSyncError(
  result: SyncResult,
  label: string,
  error: unknown,
): void {
  const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
  result.errors.push(message);
  result.error_summary[classifyError(error)] += 1;
}

function buildEmbeddingText(repo: Repo): string {
  const parts: string[] = [repo.full_name];
  if (repo.description) parts.push(repo.description);

  const metadata: string[] = [];
  if (repo.language) metadata.push(`Language: ${repo.language}`);
  if (repo.topics?.length) metadata.push(`Topics: ${repo.topics.join(", ")}`);
  if (repo.stargazers_count != null)
    metadata.push(`Stars: ${repo.stargazers_count}`);
  if (repo.forks_count != null) metadata.push(`Forks: ${repo.forks_count}`);
  if (repo.license) metadata.push(`License: ${repo.license}`);
  if (metadata.length > 0) parts.push(metadata.join(" | "));

  if (repo.readme_content) {
    parts.push(repo.readme_content.slice(0, 2000));
  }

  const pkg = repo.package_json;
  if (pkg && typeof pkg === "object") {
    const dependencies = pkg.dependencies as Record<string, string> | undefined;
    const devDependencies = pkg.devDependencies as
      | Record<string, string>
      | undefined;
    const depNames = [
      ...Object.keys(dependencies ?? {}),
      ...Object.keys(devDependencies ?? {}),
    ];
    if (depNames.length > 0) {
      parts.push(`Dependencies: ${depNames.slice(0, 80).join(", ")}`);
    }
  }

  return parts.join("\n");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function getSupabaseClient(): any {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable",
    );
  }

  supabaseClient = createClient(url, key, {
    db: { schema: STAR_VAULT_SCHEMA },
  } as any);

  return supabaseClient;
}

export async function upsertRepos(
  repos: Repo[],
): Promise<{ added: number; updated: number }> {
  if (repos.length === 0) return { added: 0, updated: 0 };

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const githubIds = [...new Set(repos.map((repo) => repo.github_id))];
  const existingIds = new Set<number>();

  for (const chunk of chunkArray(githubIds, 500)) {
    const { data, error } = await supabase
      .from(STAR_VAULT_TABLES.repos)
      .select("github_id")
      .in("github_id", chunk);

    if (error) throw error;
    for (const row of (data ?? []) as RepoIdRow[]) {
      existingIds.add(row.github_id);
    }
  }

  const rows = repos.map((repo) => ({
    github_id: repo.github_id,
    full_name: repo.full_name,
    owner: repo.owner,
    name: repo.name,
    description: repo.description,
    topics: repo.topics,
    language: repo.language,
    stargazers_count: repo.stargazers_count,
    forks_count: repo.forks_count,
    license: repo.license,
    html_url: repo.html_url,
    default_branch: repo.default_branch,
    starred_at: repo.starred_at,
    raw_data: repo.raw_data,
    fetched_at: now,
  }));

  const { error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .upsert(rows, { onConflict: "github_id" });

  if (error) throw error;

  const updated = repos.filter((repo) => existingIds.has(repo.github_id)).length;
  return { added: repos.length - updated, updated };
}

export async function recordSync(state: SyncStateInput): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from(STAR_VAULT_TABLES.syncState).insert({
    last_sync_at: state.last_sync_at,
    repos_added: state.repos_added,
    repos_updated: state.repos_updated,
    content_fetched: state.content_fetched,
    embeddings_generated: state.embeddings_generated,
    sync_type: state.sync_type,
    metadata: state.metadata,
  });

  if (error) throw error;
}

export async function getStats(): Promise<VaultStats> {
  const supabase = getSupabaseClient();

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
  (langData ?? []).forEach((row: unknown) => {
    const typed = row as RepoStatsRow;
    if (typed.language) {
      langCounts[typed.language] = (langCounts[typed.language] ?? 0) + 1;
    }
  });

  const topLangs = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([language]) => language);

  const { data: syncData } = await supabase
    .from(STAR_VAULT_TABLES.syncState)
    .select("last_sync_at")
    .order("last_sync_at", { ascending: false })
    .limit(1);

  return {
    total_repos: totalRepos ?? 0,
    with_embeddings: withEmbeddings ?? 0,
    with_readme: withReadme ?? 0,
    top_languages: topLangs,
    last_sync: (syncData?.[0] as { last_sync_at?: string } | undefined)
      ?.last_sync_at ?? null,
  };
}

export async function getReposWithoutContent(limit: number): Promise<Repo[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("*")
    .is("content_fetched_at", null)
    .order("starred_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Repo[];
}

export async function getReposWithoutEmbeddings(
  limit: number,
): Promise<Repo[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("*")
    .is("embedding", null)
    .not("content_fetched_at", "is", null)
    .order("starred_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Repo[];
}

export async function updateRepoContent(
  githubId: number,
  content: { readme_content?: string; package_json?: Record<string, unknown> },
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .update({
      ...content,
      content_fetched_at: new Date().toISOString(),
    })
    .eq("github_id", githubId);

  if (error) throw error;
}

export async function updateRepoEmbedding(
  githubId: number,
  embedding: number[],
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .update({ embedding })
    .eq("github_id", githubId);

  if (error) throw error;
}

export async function getAllRepos(): Promise<Repo[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("*")
    .order("starred_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as Repo[];
}

/**
 * Full sync orchestration:
 * GitHub fetch -> content fetch -> embedding generation.
 */
export async function syncStarVault(args?: SyncOptions): Promise<SyncResult> {
  const syncStartedAt = Date.now();
  const contentConcurrency = args?.contentConcurrency ?? 8;
  const embeddingConcurrency = args?.embeddingConcurrency ?? 4;
  const contentLimit = args?.contentLimit ?? 0;
  const embeddingLimit = args?.embeddingLimit ?? 0;

  const result: SyncResult = {
    repos_fetched: 0,
    repos_added: 0,
    repos_updated: 0,
    content_fetched: 0,
    embeddings_generated: 0,
    errors: [],
    error_summary: createErrorSummary(),
    phase_durations_ms: {
      repos: 0,
      content: 0,
      embeddings: 0,
      total: 0,
    },
  };

  if (args?.fetchRepos) {
    const reposPhaseStart = Date.now();
    try {
      console.log("  Fetching starred repos from GitHub...");
      const starredRepos = await fetchAllStarredRepos({
        maxPages: args.maxPages,
        onProgress: (count) => console.log(`    Fetched ${count} repos...`),
      });
      result.repos_fetched = starredRepos.length;

      const repos: Repo[] = starredRepos.map((repo) => ({
        github_id: repo.github_id,
        full_name: repo.full_name,
        owner: repo.owner,
        name: repo.name,
        description: repo.description ?? undefined,
        topics: repo.topics,
        language: repo.language ?? undefined,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        license: repo.license ?? undefined,
        html_url: repo.html_url,
        default_branch: repo.default_branch,
        starred_at: repo.starred_at?.toISOString(),
        raw_data: repo.raw_data as Record<string, unknown>,
      }));

      const { added, updated } = await upsertRepos(repos);
      result.repos_added = added;
      result.repos_updated = updated;
    } catch (error) {
      addSyncError(result, "Fetch repos", error);
    } finally {
      result.phase_durations_ms.repos = Date.now() - reposPhaseStart;
    }
  }

  if (contentLimit > 0) {
    const contentPhaseStart = Date.now();
    try {
      console.log(
        `  Fetching content for up to ${contentLimit} repos (concurrency ${contentConcurrency})...`,
      );
      const reposNeedingContent = await getReposWithoutContent(contentLimit);

      await runWithConcurrency(
        reposNeedingContent,
        contentConcurrency,
        async (repo) => {
          try {
            const content = await fetchRepoContent(
              repo.owner,
              repo.name,
              repo.default_branch ?? "main",
            );

            await updateRepoContent(repo.github_id, {
              readme_content: content.readme ?? undefined,
              package_json: content.packageJson ?? undefined,
            });

            result.content_fetched += 1;
          } catch (error) {
            addSyncError(result, `Content ${repo.full_name}`, error);
          }
        },
      );
    } catch (error) {
      addSyncError(result, "Fetch content", error);
    } finally {
      result.phase_durations_ms.content = Date.now() - contentPhaseStart;
    }
  }

  if (embeddingLimit > 0) {
    const embeddingsPhaseStart = Date.now();
    try {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("Missing OPENAI_API_KEY environment variable");
      }

      console.log(
        `  Generating embeddings for up to ${embeddingLimit} repos (concurrency ${embeddingConcurrency})...`,
      );
      const openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 2,
        timeout: 30_000,
      });
      const reposNeedingEmbeddings =
        await getReposWithoutEmbeddings(embeddingLimit);

      await runWithConcurrency(
        reposNeedingEmbeddings,
        embeddingConcurrency,
        async (repo) => {
          try {
            const text = buildEmbeddingText(repo);
            const response = await withRetry(
              () =>
                openai.embeddings.create({
                  model: EMBEDDING_MODEL,
                  input: text,
                }),
              { maxAttempts: 3, baseDelayMs: 500 },
            );
            await updateRepoEmbedding(repo.github_id, response.data[0].embedding);
            result.embeddings_generated += 1;
          } catch (error) {
            addSyncError(result, `Embedding ${repo.full_name}`, error);
          }
        },
      );
    } catch (error) {
      addSyncError(result, "Generate embeddings", error);
    } finally {
      result.phase_durations_ms.embeddings = Date.now() - embeddingsPhaseStart;
    }
  }

  result.phase_durations_ms.total = Date.now() - syncStartedAt;

  try {
    await recordSync({
      last_sync_at: new Date().toISOString(),
      repos_added: result.repos_added,
      repos_updated: result.repos_updated,
      content_fetched: result.content_fetched,
      embeddings_generated: result.embeddings_generated,
      sync_type: args?.syncType ?? "manual",
      metadata: {
        errors_count: result.errors.length,
        error_summary: result.error_summary,
        phase_durations_ms: result.phase_durations_ms,
      },
    });
  } catch (error) {
    addSyncError(result, "Record sync", error);
  }

  return result;
}
