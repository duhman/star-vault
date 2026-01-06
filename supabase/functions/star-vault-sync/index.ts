/**
 * Star Vault Daily Sync Edge Function
 * Fetches starred repos, content, and generates embeddings
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";

const GITHUB_API_BASE = "https://api.github.com";
const RAW_CONTENT_BASE = "https://raw.githubusercontent.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

// GitHub API request helper
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

// Fetch all starred repos
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
      // Handle star+json format (has repo nested)
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
        // Fallback to simple format
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

    // Check for next page via Link header
    const linkHeader = headers.get("Link");
    hasMore = linkHeader?.includes('rel="next"') ?? false;
    page++;

    // Rate limit protection
    if (hasMore) await new Promise((r) => setTimeout(r, 100));
  }

  return repos;
}

// Fetch README content
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
        return content.slice(0, 50000); // Limit size
      }
    } catch {
      // Try next
    }
  }
  return null;
}

// Fetch package.json
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

// Generate embedding via OpenAI
async function generateEmbedding(
  text: string,
  apiKey: string,
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text.slice(0, 8000), // Limit input
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${await response.text()}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// Build embedding text from repo data
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
      ...Object.keys(repo.package_json.dependencies || {}),
      ...Object.keys(repo.package_json.devDependencies || {}),
    ];
    if (deps.length > 0) {
      parts.push("--- Dependencies ---");
      parts.push(deps.join(", "));
    }
  }

  return parts.join("\n\n");
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get environment variables
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const githubToken = Deno.env.get("GITHUB_TOKEN")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

    if (!githubToken) {
      throw new Error("GITHUB_TOKEN is required");
    }

    // Tables are sv_repos and sv_sync_state in public schema
    const supabase = createClient(supabaseUrl, supabaseKey);

    const results = {
      repos_fetched: 0,
      repos_added: 0,
      repos_updated: 0,
      content_fetched: 0,
      embeddings_generated: 0,
      errors: [] as string[],
    };

    // Step 1: Fetch starred repos from GitHub
    console.log("Fetching starred repos...");
    const repos = await fetchStarredRepos(githubToken);
    results.repos_fetched = repos.length;
    console.log(`Fetched ${repos.length} repos`);

    // Step 2: Upsert repos to database
    for (const repo of repos) {
      const { data: existing } = await supabase
        .from("sv_repos")
        .select("id")
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
        starred_at: repo.starred_at,
        raw_data: repo.raw_data,
        fetched_at: new Date().toISOString(),
      };

      if (existing) {
        await supabase.from("sv_repos").update(repoData).eq("id", existing.id);
        results.repos_updated++;
      } else {
        await supabase.from("sv_repos").insert(repoData);
        results.repos_added++;
      }
    }

    // Step 3: Fetch content for repos without it (limit to 50 per run)
    const { data: needContent } = await supabase
      .from("sv_repos")
      .select("id, owner, name, default_branch")
      .is("content_fetched_at", null)
      .limit(50);

    for (const repo of needContent || []) {
      try {
        const [readme, packageJson] = await Promise.all([
          fetchReadme(repo.owner, repo.name, repo.default_branch),
          fetchPackageJson(repo.owner, repo.name, repo.default_branch),
        ]);

        await supabase
          .from("sv_repos")
          .update({
            readme_content: readme,
            package_json: packageJson,
            content_fetched_at: new Date().toISOString(),
          })
          .eq("id", repo.id);

        results.content_fetched++;
      } catch (e) {
        results.errors.push(
          `Content fetch error for ${repo.owner}/${repo.name}: ${e}`,
        );
      }
    }

    // Step 4: Generate embeddings for repos without them (limit to 20 per run)
    if (openaiKey) {
      const { data: needEmbeddings } = await supabase
        .from("sv_repos")
        .select(
          "id, full_name, description, language, topics, license, stargazers_count, forks_count, readme_content, package_json",
        )
        .is("embedding", null)
        .not("content_fetched_at", "is", null)
        .limit(20);

      for (const repo of needEmbeddings || []) {
        try {
          const text = buildEmbeddingText({
            full_name: repo.full_name,
            description: repo.description,
            language: repo.language,
            topics: repo.topics,
            license: repo.license,
            stargazers_count: repo.stargazers_count,
            forks_count: repo.forks_count,
            readme_content: repo.readme_content,
            package_json: repo.package_json,
          });

          const embedding = await generateEmbedding(text, openaiKey);

          await supabase
            .from("sv_repos")
            .update({ embedding })
            .eq("id", repo.id);
          results.embeddings_generated++;
        } catch (e) {
          results.errors.push(`Embedding error for ${repo.full_name}: ${e}`);
        }
      }
    }

    // Record sync state
    await supabase.from("sv_sync_state").insert({
      last_sync_at: new Date().toISOString(),
      repos_added: results.repos_added,
      repos_updated: results.repos_updated,
      content_fetched: results.content_fetched,
      embeddings_generated: results.embeddings_generated,
      sync_type: "daily",
      metadata: { errors: results.errors },
    });

    console.log("Sync complete:", results);

    return new Response(JSON.stringify(results), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Sync error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
