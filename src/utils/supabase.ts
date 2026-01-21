/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "@supabase/supabase-js";

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
}

let supabaseClient: any = null;

export function getSupabaseClient(): any {
  if (supabaseClient) return supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const schema = process.env.SUPABASE_SCHEMA || "star_vault";

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable",
    );
  }

  supabaseClient = createClient(url, key, {
    db: { schema },
  });

  return supabaseClient;
}

export async function upsertRepos(
  repos: Repo[],
): Promise<{ added: number; updated: number }> {
  const supabase = getSupabaseClient();
  let added = 0;
  let updated = 0;

  for (const repo of repos) {
    // Check if repo exists
    const { data: existing } = await supabase
      .from("repos")
      .select("id")
      .eq("github_id", repo.github_id)
      .single();

    if (existing) {
      // Update existing repo
      const { error } = await supabase
        .from("repos")
        .update({
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
          fetched_at: new Date().toISOString(),
        })
        .eq("github_id", repo.github_id);

      if (!error) updated++;
    } else {
      // Insert new repo
      const { error } = await supabase.from("repos").insert({
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
        fetched_at: new Date().toISOString(),
      });

      if (!error) added++;
    }
  }

  return { added, updated };
}

export async function recordSync(state: SyncStateInput): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("sync_state").insert({
    last_sync_at: state.last_sync_at,
    repos_added: state.repos_added,
    repos_updated: state.repos_updated,
    content_fetched: state.content_fetched,
    embeddings_generated: state.embeddings_generated,
    sync_type: state.sync_type,
    metadata: state.metadata,
  });

  if (error) {
    console.error("Failed to record sync:", error);
    throw error;
  }
}

export async function getStats(): Promise<VaultStats> {
  const supabase = getSupabaseClient();

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
  langData?.forEach((r: any) => {
    if (r.language) {
      langCounts[r.language] = (langCounts[r.language] || 0) + 1;
    }
  });
  const topLangs = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([lang]) => lang);

  // Get last sync
  const { data: syncData } = await supabase
    .from("sync_state")
    .select("last_sync_at")
    .order("last_sync_at", { ascending: false })
    .limit(1);

  return {
    total_repos: totalRepos ?? 0,
    with_embeddings: withEmbeddings ?? 0,
    with_readme: withReadme ?? 0,
    top_languages: topLangs,
    last_sync: syncData?.[0]?.last_sync_at ?? null,
  };
}

export async function getReposWithoutContent(limit: number): Promise<Repo[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("repos")
    .select("*")
    .is("readme_content", null)
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function getReposWithoutEmbeddings(
  limit: number,
): Promise<Repo[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("repos")
    .select("*")
    .is("embedding", null)
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function updateRepoContent(
  githubId: number,
  content: { readme_content?: string; package_json?: Record<string, unknown> },
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("repos")
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
    .from("repos")
    .update({ embedding })
    .eq("github_id", githubId);

  if (error) throw error;
}

export async function getAllRepos(): Promise<Repo[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("repos")
    .select("*")
    .order("starred_at", { ascending: false });

  if (error) throw error;
  return data ?? [];
}

/**
 * Full sync function that replaces the Convex action
 * Orchestrates: GitHub fetch -> content fetch -> embedding generation
 */
export async function syncStarVault(args?: {
  fetchRepos?: boolean;
  contentLimit?: number;
  embeddingLimit?: number;
  syncType?: string;
}): Promise<SyncResult> {
  // Dynamic imports to avoid circular dependencies
  const { fetchAllStarredRepos } = await import("../github/starred.js");
  const { fetchRepoContent } = await import("../github/content.js");
  const OpenAI = (await import("openai")).default;

  const result: SyncResult = {
    repos_fetched: 0,
    repos_added: 0,
    repos_updated: 0,
    content_fetched: 0,
    embeddings_generated: 0,
    errors: [],
  };

  // Step 1: Fetch starred repos from GitHub
  if (args?.fetchRepos) {
    try {
      console.log("  Fetching starred repos from GitHub...");
      const starredRepos = await fetchAllStarredRepos({
        onProgress: (count) => console.log(`    Fetched ${count} repos...`),
      });
      result.repos_fetched = starredRepos.length;

      // Convert to Repo format and upsert
      const repos: Repo[] = starredRepos.map((r) => ({
        github_id: r.github_id,
        full_name: r.full_name,
        owner: r.owner,
        name: r.name,
        description: r.description ?? undefined,
        topics: r.topics,
        language: r.language ?? undefined,
        stargazers_count: r.stargazers_count,
        forks_count: r.forks_count,
        license: r.license ?? undefined,
        html_url: r.html_url,
        default_branch: r.default_branch,
        starred_at: r.starred_at?.toISOString(),
        raw_data: r.raw_data as Record<string, unknown>,
      }));

      const { added, updated } = await upsertRepos(repos);
      result.repos_added = added;
      result.repos_updated = updated;
    } catch (error) {
      result.errors.push(`Fetch repos: ${error}`);
    }
  }

  // Step 2: Fetch content for repos without it
  const contentLimit = args?.contentLimit ?? 0;
  if (contentLimit > 0) {
    try {
      console.log(`  Fetching content for up to ${contentLimit} repos...`);
      const reposNeedingContent = await getReposWithoutContent(contentLimit);

      for (const repo of reposNeedingContent) {
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

          result.content_fetched++;
        } catch (error) {
          result.errors.push(`Content ${repo.full_name}: ${error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Fetch content: ${error}`);
    }
  }

  // Step 3: Generate embeddings
  const embeddingLimit = args?.embeddingLimit ?? 0;
  if (embeddingLimit > 0) {
    try {
      console.log(
        `  Generating embeddings for up to ${embeddingLimit} repos...`,
      );
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const reposNeedingEmbeddings =
        await getReposWithoutEmbeddings(embeddingLimit);

      for (const repo of reposNeedingEmbeddings) {
        try {
          // Create embedding text from repo metadata
          const parts = [repo.full_name];
          if (repo.description) parts.push(repo.description);
          if (repo.topics?.length)
            parts.push(`Topics: ${repo.topics.join(", ")}`);
          if (repo.language) parts.push(`Language: ${repo.language}`);
          if (repo.readme_content) {
            // Include first 2000 chars of README
            parts.push(repo.readme_content.slice(0, 2000));
          }

          const text = parts.join("\n");
          const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: text,
          });

          await updateRepoEmbedding(repo.github_id, response.data[0].embedding);
          result.embeddings_generated++;
        } catch (error) {
          result.errors.push(`Embedding ${repo.full_name}: ${error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Generate embeddings: ${error}`);
    }
  }

  // Record sync
  await recordSync({
    last_sync_at: new Date().toISOString(),
    repos_added: result.repos_added,
    repos_updated: result.repos_updated,
    content_fetched: result.content_fetched,
    embeddings_generated: result.embeddings_generated,
    sync_type: args?.syncType ?? "manual",
  });

  return result;
}
