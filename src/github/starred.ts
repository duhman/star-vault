/**
 * Fetch starred repositories from GitHub API
 */

import { z } from "zod";
import { getGitHubClient } from "./client.js";
import {
  conditionalHeaders,
  getEtags,
  saveEtag,
  type CachedEtag,
} from "../sync/etag-cache.js";

const GITHUB_API_BASE = "https://api.github.com";

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

function normalize(item: unknown): NormalizedRepo | null {
  const parsed = StarredRepoSchema.safeParse(item);
  if (parsed.success) {
    const { starred_at, repo } = parsed.data;
    return {
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
    };
  }

  const simpleParsed = SimpleRepoSchema.safeParse(item);
  if (simpleParsed.success) {
    const repo = simpleParsed.data;
    return {
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
    };
  }

  console.error("Failed to parse repo:", item);
  return null;
}

export interface FetchStarredResult {
  repos: NormalizedRepo[];
  pages_walked: number;
  pages_304: number;
  completed_walk: boolean;
}

/**
 * Fetch all starred repositories with ETag-cached pagination.
 *
 * Flow per page:
 *   1. Look up cached ETag/Last-Modified for the exact URL.
 *   2. Send If-None-Match / If-Modified-Since.
 *   3. On 304: NOTE — we don't have the page contents cached, so we still
 *      can't observe which repos are on that page for this run. In practice
 *      this is fine for:
 *        - ADD detection: a new star changes page 1, which returns 200 with
 *          the new repo (and may cascade 200s to all subsequent pages due to
 *          shifted ordering). New ETags are saved.
 *        - RECONCILE (delete detection): reconcile runs use
 *          `useEtags: false` to force a full authoritative walk.
 *
 * `completed_walk` is true iff every page in the range [1, maxPages or
 * lastPage] returned 200 OR 304 (i.e. no page errored). Callers that want
 * to hard-delete based on seen_at MUST gate on completed_walk === true.
 */
export async function fetchAllStarredRepos(options?: {
  perPage?: number;
  maxPages?: number;
  onProgress?: (fetched: number, total?: number) => void;
  useEtags?: boolean;
}): Promise<FetchStarredResult> {
  const client = getGitHubClient();
  const perPage = options?.perPage ?? 100;
  const maxPages = options?.maxPages ?? Infinity;
  const useEtags = options?.useEtags ?? true;

  const repos: NormalizedRepo[] = [];
  let pagesWalked = 0;
  let pages304 = 0;
  let completed = true;

  // Preload ETag cache for the pages we expect to visit (best-effort).
  // We don't know the last page up-front, so we fetch validators lazily.
  let cachedEtags = new Map<string, CachedEtag>();
  if (useEtags) {
    // Prefetch cache for the first 100 page URLs (10k stars ceiling).
    const probeUrls = Array.from({ length: 100 }, (_, i) =>
      pageUrl(perPage, i + 1),
    );
    cachedEtags = await getEtags(probeUrls);
  }

  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const url = pageUrl(perPage, page);
    const cached = cachedEtags.get(url);

    let response;
    try {
      response = await client.request<unknown[]>(url, {
        headers: {
          Accept: "application/vnd.github.star+json",
          ...(useEtags ? conditionalHeaders(cached) : {}),
        },
      });
    } catch (error) {
      completed = false;
      throw error;
    }

    pagesWalked += 1;

    if (response.notModified) {
      pages304 += 1;
      await saveEtag({
        url,
        etag: cached?.etag ?? null,
        lastModified: cached?.last_modified ?? null,
        status: 304,
      });
      // Link header is present on 304; continue pagination using it.
      const links304 = client.parseLinkHeader(response.headers);
      hasMore = !!links304.next;
      page += 1;
      if (hasMore) await sleep(100);
      continue;
    }

    for (const item of response.data ?? []) {
      const normalized = normalize(item);
      if (normalized) repos.push(normalized);
    }

    options?.onProgress?.(repos.length);

    // Save new validators
    await saveEtag({
      url,
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified"),
      status: 200,
    });

    const links = client.parseLinkHeader(response.headers);
    hasMore = !!links.next;
    page += 1;

    if (hasMore) await sleep(100);
  }

  // If we stopped early because of maxPages, the walk is incomplete for
  // reconcile purposes — but consistent for "sample" runs.
  if (page > maxPages && hasMore) completed = false;

  return {
    repos,
    pages_walked: pagesWalked,
    pages_304: pages304,
    completed_walk: completed,
  };
}

function pageUrl(perPage: number, page: number): string {
  return `${GITHUB_API_BASE}/user/starred?per_page=${perPage}&page=${page}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get count of starred repos (via API header)
 */
export async function getStarredCount(): Promise<number> {
  const client = getGitHubClient();

  // Fetch just 1 repo but check the Link header for total.
  // This call doesn't use ETag cache — it's invoked rarely.
  const response = await client.request<unknown[]>("/user/starred?per_page=1");
  if (response.notModified) return 0; // shouldn't happen without If-None-Match
  const { data, headers } = response;

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
