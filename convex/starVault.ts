import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { embedTexts } from "./lib/embeddings";

const GITHUB_API_BASE = "https://api.github.com";
const RAW_CONTENT_BASE = "https://raw.githubusercontent.com";
const DEFAULT_MODEL = "text-embedding-3-small";

interface NormalizedRepo {
  github_id: number;
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  license: string | null;
  html_url: string;
  default_branch: string;
  starred_at: string | null;
  raw_data: unknown;
}

async function githubRequest<T>(
  endpoint: string,
  token: string,
  headers: Record<string, string> = {},
): Promise<{ data: T; headers: Headers }> {
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${GITHUB_API_BASE}${endpoint}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API error (${response.status}): ${await response.text()}`,
    );
  }

  return { data: (await response.json()) as T, headers: response.headers };
}

async function fetchStarredRepos(token: string): Promise<NormalizedRepo[]> {
  const repos: NormalizedRepo[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const { data, headers } = await githubRequest<
      Array<{
        starred_at?: string;
        repo?: {
          id: number;
          full_name: string;
          owner: { login: string };
          name: string;
          description: string | null;
          topics: string[];
          language: string | null;
          stargazers_count: number;
          forks_count: number;
          license: { spdx_id: string | null } | null;
          html_url: string;
          default_branch: string;
        };
        id?: number;
        full_name?: string;
        owner?: { login: string };
        name?: string;
        description?: string | null;
        topics?: string[];
        language?: string | null;
        stargazers_count?: number;
        forks_count?: number;
        license?: { spdx_id: string | null } | null;
        html_url?: string;
        default_branch?: string;
      }>
    >(`/user/starred?per_page=100&page=${page}`, token, {
      Accept: "application/vnd.github.star+json",
    });

    for (const item of data) {
      if (item.repo) {
        repos.push({
          github_id: item.repo.id,
          full_name: item.repo.full_name,
          owner: item.repo.owner.login,
          name: item.repo.name,
          description: item.repo.description,
          topics: item.repo.topics || [],
          language: item.repo.language,
          stargazers_count: item.repo.stargazers_count,
          forks_count: item.repo.forks_count,
          license: item.repo.license?.spdx_id ?? null,
          html_url: item.repo.html_url,
          default_branch: item.repo.default_branch,
          starred_at: item.starred_at ?? null,
          raw_data: item,
        });
      } else if (item.id) {
        repos.push({
          github_id: item.id,
          full_name: item.full_name!,
          owner: item.owner!.login,
          name: item.name!,
          description: item.description ?? null,
          topics: item.topics || [],
          language: item.language ?? null,
          stargazers_count: item.stargazers_count!,
          forks_count: item.forks_count!,
          license: item.license?.spdx_id ?? null,
          html_url: item.html_url!,
          default_branch: item.default_branch!,
          starred_at: null,
          raw_data: item,
        });
      }
    }

    const linkHeader = headers.get("Link");
    hasMore = linkHeader?.includes('rel="next"') ?? false;
    page += 1;

    if (hasMore) await new Promise((r) => setTimeout(r, 100));
  }

  return repos;
}

async function fetchReadme(
  owner: string,
  name: string,
  branch: string,
): Promise<string | null> {
  const readmeNames = ["README.md", "readme.md", "Readme.md", "README"];

  for (const filename of readmeNames) {
    try {
      const response = await fetch(
        `${RAW_CONTENT_BASE}/${owner}/${name}/${branch}/${filename}`,
      );
      if (response.ok) {
        const content = await response.text();
        return content.slice(0, 50000);
      }
    } catch {
      // Try next filename
    }
  }
  return null;
}

async function fetchPackageJson(
  owner: string,
  name: string,
  branch: string,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `${RAW_CONTENT_BASE}/${owner}/${name}/${branch}/package.json`,
    );
    if (response.ok) {
      return await response.json();
    }
  } catch {
    // No package.json
  }
  return null;
}

function buildEmbeddingText(repo: {
  full_name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  license: string | null;
  stargazers_count: number;
  forks_count: number;
  readme_content: string | null;
  package_json: Record<string, unknown> | null;
}): string {
  const parts: string[] = [repo.full_name];

  if (repo.description) parts.push(repo.description);

  const metadata: string[] = [];
  if (repo.language) metadata.push(`Language: ${repo.language}`);
  if (repo.topics.length > 0)
    metadata.push(`Topics: ${repo.topics.join(", ")}`);
  if (repo.license) metadata.push(`License: ${repo.license}`);
  metadata.push(`Stars: ${repo.stargazers_count}, Forks: ${repo.forks_count}`);
  parts.push(metadata.join("\n"));

  if (repo.readme_content) {
    parts.push("--- README ---");
    parts.push(repo.readme_content.slice(0, 6000));
  }

  if (repo.package_json) {
    const deps = [
      ...Object.keys((repo.package_json as any).dependencies || {}),
      ...Object.keys((repo.package_json as any).devDependencies || {}),
    ];
    if (deps.length > 0) {
      parts.push("--- Dependencies ---");
      parts.push(deps.join(", "));
    }
  }

  return parts.join("\n\n");
}

export const syncStarVault = action({
  args: {
    fetchRepos: v.optional(v.boolean()),
    contentLimit: v.optional(v.number()),
    embeddingLimit: v.optional(v.number()),
    syncType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error("GITHUB_TOKEN is required in Convex env vars");
    }

    const model = process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_MODEL;

    const results = {
      repos_fetched: 0,
      repos_added: 0,
      repos_updated: 0,
      content_fetched: 0,
      embeddings_generated: 0,
      errors: [] as string[],
    };

    const fetchRepos = args.fetchRepos ?? true;
    if (fetchRepos) {
      const repos = await fetchStarredRepos(githubToken);
      results.repos_fetched = repos.length;

      for (const repo of repos) {
        const repoId = String(repo.github_id);
        const repoData = {
          id: repoId,
          github_id: repoId,
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
          starred_at: repo.starred_at ?? undefined,
          raw_data: repo.raw_data,
          fetched_at: new Date().toISOString(),
        };
        const upsertResult = await ctx.runMutation(
          internal.starVaultInternal.upsertRepo,
          { repo: repoData },
        );
        if (upsertResult.added) results.repos_added += 1;
        if (upsertResult.updated) results.repos_updated += 1;
      }
    }

    const contentLimit = args.contentLimit ?? 50;
    const needContent = await ctx.runQuery(
      internal.starVaultInternal.getReposMissingContent,
      { limit: contentLimit },
    );

    for (const repo of needContent) {
      try {
        const [readme, packageJson] = await Promise.all([
          fetchReadme(repo.owner, repo.name, repo.default_branch ?? "main"),
          fetchPackageJson(
            repo.owner,
            repo.name,
            repo.default_branch ?? "main",
          ),
        ]);

        await ctx.runMutation(internal.starVaultInternal.updateRepoContent, {
          id: repo._id,
          readme_content: readme ?? undefined,
          package_json: packageJson ?? undefined,
          content_fetched_at: new Date().toISOString(),
        });

        results.content_fetched += 1;
      } catch (error) {
        results.errors.push(
          `Content fetch error for ${repo.owner}/${repo.name}: ${String(error)}`,
        );
      }
    }

    const embeddingLimit = args.embeddingLimit ?? 20;
    const needEmbeddings = await ctx.runQuery(
      internal.starVaultInternal.getReposMissingEmbedding,
      { limit: embeddingLimit },
    );

    if (needEmbeddings.length > 0) {
      const texts = needEmbeddings.map((repo) =>
        buildEmbeddingText({
          full_name: repo.full_name,
          description: repo.description ?? null,
          language: repo.language ?? null,
          topics: repo.topics ?? [],
          license: repo.license ?? null,
          stargazers_count: repo.stargazers_count ?? 0,
          forks_count: repo.forks_count ?? 0,
          readme_content: repo.readme_content ?? null,
          package_json: (repo.package_json as Record<string, unknown>) ?? null,
        }),
      );

      const embeddings = await embedTexts(texts, model);
      for (let i = 0; i < needEmbeddings.length; i += 1) {
        const repo = needEmbeddings[i];
        await ctx.runMutation(internal.starVaultInternal.setRepoEmbedding, {
          id: repo._id,
          embedding: embeddings[i],
        });
        results.embeddings_generated += 1;
      }
    }

    const syncId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await ctx.runMutation(internal.starVaultInternal.insertSyncState, {
      id: syncId,
      last_sync_at: new Date().toISOString(),
      repos_added: results.repos_added,
      repos_updated: results.repos_updated,
      content_fetched: results.content_fetched,
      embeddings_generated: results.embeddings_generated,
      sync_type: args.syncType ?? "daily",
      metadata: { errors: results.errors },
    });

    return results;
  },
});
