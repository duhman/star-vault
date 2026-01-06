/**
 * Process repositories - store in database and prepare for embeddings
 */

import { supabase } from "../utils/supabase.js";
import type { NormalizedRepo } from "../github/starred.js";

/**
 * Upsert repositories to the database
 * Returns count of new and updated repos
 */
export async function upsertRepos(
  repos: NormalizedRepo[],
): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;

  for (const repo of repos) {
    // Check if repo exists
    const { data: existing } = await supabase
      .from("sv_repos")
      .select("id, github_id")
      .eq("github_id", repo.github_id)
      .single();

    const repoData = {
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
      starred_at: repo.starred_at?.toISOString() ?? null,
      raw_data: repo.raw_data,
      fetched_at: new Date().toISOString(),
    };

    if (existing) {
      // Update existing
      const { error } = await supabase
        .from("sv_repos")
        .update(repoData)
        .eq("id", existing.id);

      if (error) {
        console.error(`Failed to update ${repo.full_name}:`, error.message);
      } else {
        updated++;
      }
    } else {
      // Insert new
      const { error } = await supabase.from("sv_repos").insert(repoData);

      if (error) {
        console.error(`Failed to insert ${repo.full_name}:`, error.message);
      } else {
        added++;
      }
    }
  }

  return { added, updated };
}

/**
 * Get repos that need content fetching (README, package.json)
 */
export async function getReposNeedingContent(limit: number = 50): Promise<
  Array<{
    id: number;
    full_name: string;
    owner: string;
    name: string;
    default_branch: string;
  }>
> {
  const { data, error } = await supabase
    .from("sv_repos")
    .select("id, full_name, owner, name, default_branch")
    .is("content_fetched_at", null)
    .order("starred_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch repos: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Update repo with fetched content
 */
export async function updateRepoContent(
  id: number,
  readme: string | null,
  packageJson: Record<string, unknown> | null,
): Promise<void> {
  const { error } = await supabase
    .from("sv_repos")
    .update({
      readme_content: readme,
      package_json: packageJson,
      content_fetched_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    throw new Error(
      `Failed to update content for repo ${id}: ${error.message}`,
    );
  }
}

/**
 * Get repos that need embeddings generated
 */
export async function getReposNeedingEmbeddings(limit: number = 20): Promise<
  Array<{
    id: number;
    full_name: string;
    owner: string;
    name: string;
    description: string | null;
    topics: string[];
    language: string | null;
    stargazers_count: number;
    forks_count: number;
    license: string | null;
    readme_content: string | null;
    package_json: Record<string, unknown> | null;
  }>
> {
  const { data, error } = await supabase
    .from("sv_repos")
    .select(
      "id, full_name, owner, name, description, topics, language, stargazers_count, forks_count, license, readme_content, package_json",
    )
    .is("embedding", null)
    .order("starred_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to fetch repos: ${error.message}`);
  }

  return data ?? [];
}

/**
 * Update repo with embedding
 */
export async function updateRepoEmbedding(
  id: number,
  embedding: number[],
): Promise<void> {
  const { error } = await supabase
    .from("sv_repos")
    .update({ embedding })
    .eq("id", id);

  if (error) {
    throw new Error(
      `Failed to update embedding for repo ${id}: ${error.message}`,
    );
  }
}

/**
 * Record sync state
 */
export async function recordSyncState(state: {
  repos_added?: number;
  repos_updated?: number;
  content_fetched?: number;
  embeddings_generated?: number;
  sync_type: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await supabase.from("sv_sync_state").insert({
    last_sync_at: new Date().toISOString(),
    repos_added: state.repos_added ?? 0,
    repos_updated: state.repos_updated ?? 0,
    content_fetched: state.content_fetched ?? 0,
    embeddings_generated: state.embeddings_generated ?? 0,
    sync_type: state.sync_type,
    metadata: state.metadata ?? {},
  });

  if (error) {
    console.error("Failed to record sync state:", error.message);
  }
}
