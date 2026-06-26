/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";
import {
  CONTENT_STALE_DAYS,
  STAR_VAULT_SCHEMA,
  STAR_VAULT_TABLES,
  type ErrorBucket,
} from "../shared/starVault.js";
import { fetchRepoContent } from "../github/content.js";
import { fetchAllStarredRepos } from "../github/starred.js";
import { runWithConcurrency } from "./async.js";
import { classifyError } from "./retry.js";
import { getConfiguredEmbeddingProviderName } from "../sync/embeddingProvider.js";

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
  content_checked_at?: string;
  content_changed_at?: string;
  source_changed_at?: string;
  embedding?: number[];
  embedding_input_hash?: string | null;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  embedding_generated_at?: string | null;
  needs_embedding?: boolean | null;
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
  pages_walked: number;
  pages_304: number;
  completed_walk: boolean;
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
  embeddingProvider?: string;
  contentStaleDays?: number;
  /** Use ETag-cached requests to /user/starred. Default true. Disable for reconcile. */
  useEtags?: boolean;
}

type RepoStatsRow = { language: string | null };

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

function addSyncError(result: SyncResult, label: string, error: unknown): void {
  const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
  result.errors.push(message);
  result.error_summary[classifyError(error)] += 1;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function isContentStale(
  repo: Pick<Repo, "content_fetched_at" | "content_checked_at">,
  staleDays = CONTENT_STALE_DAYS,
  now = new Date(),
): boolean {
  if (!repo.content_fetched_at || !repo.content_checked_at) return true;
  const checkedAt = new Date(repo.content_checked_at).getTime();
  if (!Number.isFinite(checkedAt)) return true;
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  return now.getTime() - checkedAt >= staleMs;
}

export function didContentMateriallyChange(
  current: Pick<Repo, "readme_content" | "package_json">,
  next: { readme_content?: string; package_json?: Record<string, unknown> },
): boolean {
  if (
    next.readme_content !== undefined &&
    next.readme_content !== (current.readme_content ?? undefined)
  ) {
    return true;
  }
  if (next.package_json !== undefined) {
    return stableJson(next.package_json) !== stableJson(current.package_json);
  }
  return false;
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
  runId?: number,
): Promise<{ added: number; updated: number }> {
  if (repos.length === 0) return { added: 0, updated: 0 };

  const supabase = getSupabaseClient();
  let added = 0;
  let updated = 0;

  // Chunk to avoid massive single payloads. Server uses xmax=0 to count
  // inserts vs updates in a single round-trip per chunk.
  for (const chunk of chunkArray(repos, 500)) {
    const payload = chunk.map((repo) => ({
      github_id: repo.github_id,
      full_name: repo.full_name,
      owner: repo.owner,
      name: repo.name,
      description: repo.description ?? null,
      topics: repo.topics ?? [],
      language: repo.language ?? null,
      stargazers_count: repo.stargazers_count ?? null,
      forks_count: repo.forks_count ?? null,
      license: repo.license ?? null,
      html_url: repo.html_url,
      default_branch: repo.default_branch ?? "main",
      starred_at: repo.starred_at ?? null,
      raw_data: repo.raw_data ?? null,
    }));

    const { data, error } = await supabase.rpc("upsert_repos", {
      payload,
      run_id: runId ?? null,
    });

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    added += Number(row?.added ?? 0);
    updated += Number(row?.updated ?? 0);
  }

  return { added, updated };
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
    last_sync:
      (syncData?.[0] as { last_sync_at?: string } | undefined)?.last_sync_at ??
      null,
  };
}

export async function getReposNeedingContent(
  limit: number,
  staleDays = CONTENT_STALE_DAYS,
): Promise<Repo[]> {
  const supabase = getSupabaseClient();
  const staleBefore = new Date(
    Date.now() - staleDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("*")
    .or(
      [
        "content_fetched_at.is.null",
        "content_checked_at.is.null",
        `content_checked_at.lt.${staleBefore}`,
      ].join(","),
    )
    .order("content_checked_at", { ascending: true, nullsFirst: true })
    .order("starred_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Repo[];
}

export async function getReposWithoutContent(limit: number): Promise<Repo[]> {
  return getReposNeedingContent(limit);
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
): Promise<{ changed: boolean }> {
  const supabase = getSupabaseClient();
  const currentResult = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("readme_content, package_json")
    .eq("github_id", githubId)
    .single();

  if (currentResult.error) throw currentResult.error;
  const changed = didContentMateriallyChange(
    (currentResult.data ?? {}) as Pick<Repo, "readme_content" | "package_json">,
    content,
  );

  const now = new Date().toISOString();
  const { error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .update({
      ...content,
      content_fetched_at: now,
      content_checked_at: now,
      ...(changed
        ? {
            content_changed_at: now,
            needs_embedding: true,
          }
        : {}),
    })
    .eq("github_id", githubId);

  if (error) throw error;
  return { changed };
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
  // embeddingConcurrency from SyncOptions is now a no-op: batched embeddings
  // parallelize inside a single API call. Kept on the type for CLI compat.
  const contentLimit = args?.contentLimit ?? 0;
  const embeddingLimit = args?.embeddingLimit ?? 0;
  const embeddingProvider = getConfiguredEmbeddingProviderName({
    ...process.env,
    ...(args?.embeddingProvider
      ? { EMBEDDING_PROVIDER: args.embeddingProvider }
      : {}),
  });

  const result: SyncResult = {
    repos_fetched: 0,
    repos_added: 0,
    repos_updated: 0,
    content_fetched: 0,
    embeddings_generated: 0,
    pages_walked: 0,
    pages_304: 0,
    completed_walk: false,
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
      const fetchResult = await fetchAllStarredRepos({
        maxPages: args.maxPages,
        useEtags: args.useEtags ?? true,
        onProgress: (count) => console.log(`    Fetched ${count} repos...`),
      });
      const starredRepos = fetchResult.repos;
      result.repos_fetched = starredRepos.length;
      result.pages_walked = fetchResult.pages_walked;
      result.pages_304 = fetchResult.pages_304;
      result.completed_walk = fetchResult.completed_walk;
      console.log(
        `    ${fetchResult.pages_walked} pages walked (${fetchResult.pages_304} × 304 Not Modified)`,
      );

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
      const reposNeedingContent = await getReposNeedingContent(
        contentLimit,
        args?.contentStaleDays ?? CONTENT_STALE_DAYS,
      );

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

            // fetchReadme returns null on 304/404. Don't overwrite an
            // existing readme_content with null — only write when we have
            // fresh bytes. 404 will cache a null-body entry in github_etags
            // so we don't re-ask on every sync.
            const patch: {
              readme_content?: string;
              package_json?: Record<string, unknown>;
            } = {};
            if (content.readme !== null) patch.readme_content = content.readme;
            if (content.packageJson !== null)
              patch.package_json = content.packageJson;

            await updateRepoContent(repo.github_id, patch);
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
      console.log(
        `  Generating ${embeddingProvider} embeddings for up to ${embeddingLimit} repos (batched)...`,
      );
      const { generateEmbeddingsBatch } = await import("../sync/embeddings.js");
      const emb = await generateEmbeddingsBatch({
        limit: embeddingLimit,
        providerName: embeddingProvider,
      });
      result.embeddings_generated = emb.embeddings_generated;
      console.log(
        `    Scanned ${emb.repos_scanned}, skipped ${emb.repos_skipped_unchanged} unchanged, generated ${emb.embeddings_generated} in ${emb.batches} batch call(s)`,
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
        embedding_provider: embeddingProvider,
        content_stale_days: args?.contentStaleDays ?? CONTENT_STALE_DAYS,
      },
    });
  } catch (error) {
    addSyncError(result, "Record sync", error);
  }

  return result;
}
