/**
 * Fetch starred repositories from GitHub API
 */

import { z } from "zod";
import { getGitHubClient } from "./client.js";

// Schema for starred repo response (with starred_at from star+json media type)
const StarredRepoSchema = z.object({
  starred_at: z.string().datetime().optional(),
  repo: z.object({
    id: z.number(),
    full_name: z.string(),
    owner: z.object({
      login: z.string(),
    }),
    name: z.string(),
    description: z.string().nullable(),
    topics: z.array(z.string()).default([]),
    language: z.string().nullable(),
    stargazers_count: z.number(),
    forks_count: z.number(),
    license: z
      .object({
        spdx_id: z.string().nullable(),
      })
      .nullable(),
    html_url: z.string().url(),
    default_branch: z.string(),
  }),
});

// Alternative schema when not using star+json media type
const SimpleRepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  owner: z.object({
    login: z.string(),
  }),
  name: z.string(),
  description: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  language: z.string().nullable(),
  stargazers_count: z.number(),
  forks_count: z.number(),
  license: z
    .object({
      spdx_id: z.string().nullable(),
    })
    .nullable(),
  html_url: z.string().url(),
  default_branch: z.string(),
});

export type StarredRepo = z.infer<typeof StarredRepoSchema>;
export type SimpleRepo = z.infer<typeof SimpleRepoSchema>;

export interface NormalizedRepo {
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
  starred_at: Date | null;
  raw_data: unknown;
}

/**
 * Fetch all starred repositories with pagination
 * Uses star+json media type to get starred_at timestamp
 */
export async function fetchAllStarredRepos(options?: {
  perPage?: number;
  maxPages?: number;
  onProgress?: (fetched: number, total?: number) => void;
}): Promise<NormalizedRepo[]> {
  const client = getGitHubClient();
  const perPage = options?.perPage ?? 100;
  const maxPages = options?.maxPages ?? Infinity;
  const repos: NormalizedRepo[] = [];

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const { data, headers } = await client.request<unknown[]>(
      `/user/starred?per_page=${perPage}&page=${page}`,
      {
        headers: {
          // Use star+json to get starred_at timestamp
          Accept: "application/vnd.github.star+json",
        },
      },
    );

    // Parse and normalize each repo
    for (const item of data) {
      try {
        // Try star+json format first (has starred_at and repo nested)
        const parsed = StarredRepoSchema.safeParse(item);
        if (parsed.success) {
          const { starred_at, repo } = parsed.data;
          repos.push({
            github_id: repo.id,
            full_name: repo.full_name,
            owner: repo.owner.login,
            name: repo.name,
            description: repo.description,
            topics: repo.topics,
            language: repo.language,
            stargazers_count: repo.stargazers_count,
            forks_count: repo.forks_count,
            license: repo.license?.spdx_id ?? null,
            html_url: repo.html_url,
            default_branch: repo.default_branch,
            starred_at: starred_at ? new Date(starred_at) : null,
            raw_data: item,
          });
        } else {
          // Fallback to simple format
          const simpleParsed = SimpleRepoSchema.safeParse(item);
          if (simpleParsed.success) {
            const repo = simpleParsed.data;
            repos.push({
              github_id: repo.id,
              full_name: repo.full_name,
              owner: repo.owner.login,
              name: repo.name,
              description: repo.description,
              topics: repo.topics,
              language: repo.language,
              stargazers_count: repo.stargazers_count,
              forks_count: repo.forks_count,
              license: repo.license?.spdx_id ?? null,
              html_url: repo.html_url,
              default_branch: repo.default_branch,
              starred_at: null,
              raw_data: item,
            });
          } else {
            console.error("Failed to parse repo:", item);
          }
        }
      } catch (error) {
        console.error("Error parsing repo:", error);
      }
    }

    options?.onProgress?.(repos.length);

    // Check for next page
    const links = client.parseLinkHeader(headers);
    hasMore = !!links.next;
    page++;

    // Small delay to be nice to the API
    if (hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return repos;
}

/**
 * Get count of starred repos (via API header)
 */
export async function getStarredCount(): Promise<number> {
  const client = getGitHubClient();

  // Fetch just 1 repo but check the Link header for total
  const { data, headers } = await client.request<unknown[]>(
    "/user/starred?per_page=1",
  );

  const links = client.parseLinkHeader(headers);
  if (links.last) {
    // Extract page number from last link
    const match = links.last.match(/page=(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // If no pagination, the exact count is the number of returned rows (0 or 1)
  return data.length;
}
