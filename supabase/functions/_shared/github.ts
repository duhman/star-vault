// Deno mirror of src/github/*.ts for the ETag-cached stars walk.
// Keep in sync with src/github/client.ts and src/github/starred.ts.

import { ETAGS_TABLE } from "./constants.ts";

export interface CachedEtag {
  url: string;
  etag: string | null;
  last_modified: string | null;
  status: number | null;
}

// deno-lint-ignore no-explicit-any
export async function getEtags(
  supabase: any,
  urls: string[],
): Promise<Map<string, CachedEtag>> {
  if (urls.length === 0) return new Map();
  const { data, error } = await supabase
    .from(ETAGS_TABLE)
    .select("url, etag, last_modified, status")
    .in("url", urls);
  if (error) throw error;
  const map = new Map<string, CachedEtag>();
  for (const row of (data ?? []) as CachedEtag[]) map.set(row.url, row);
  return map;
}

// deno-lint-ignore no-explicit-any
export async function saveEtag(
  supabase: any,
  params: {
    url: string;
    etag: string | null;
    lastModified: string | null;
    status: number;
  },
): Promise<void> {
  const { error } = await supabase.from(ETAGS_TABLE).upsert(
    {
      url: params.url,
      etag: params.etag,
      last_modified: params.lastModified,
      status: params.status,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "url" },
  );
  if (error) throw error;
}

export function conditionalHeaders(
  cached: CachedEtag | undefined,
): Record<string, string> {
  if (!cached) return {};
  const headers: Record<string, string> = {};
  if (cached.etag) headers["If-None-Match"] = cached.etag;
  if (cached.last_modified) headers["If-Modified-Since"] = cached.last_modified;
  return headers;
}

function parseLinkHeader(headers: Headers): Record<string, string> {
  const link = headers.get("Link");
  if (!link) return {};
  const out: Record<string, string> = {};
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) out[match[2]] = match[1];
  }
  return out;
}

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
  starred_at: string | null;
  raw_data: unknown;
}

function normalize(item: Record<string, unknown>): NormalizedRepo | null {
  // star+json form
  const inner = item.repo as Record<string, unknown> | undefined;
  if (inner) {
    const owner = inner.owner as { login: string } | null;
    const license = inner.license as { spdx_id: string | null } | null;
    if (!owner) return null;
    return {
      github_id: inner.id as number,
      full_name: inner.full_name as string,
      owner: owner.login,
      name: inner.name as string,
      description: (inner.description as string | null) ?? null,
      topics: (inner.topics as string[]) ?? [],
      language: (inner.language as string | null) ?? null,
      stargazers_count: inner.stargazers_count as number,
      forks_count: inner.forks_count as number,
      license: license?.spdx_id ?? null,
      html_url: inner.html_url as string,
      default_branch: inner.default_branch as string,
      starred_at: (item.starred_at as string | undefined) ?? null,
      raw_data: item,
    };
  }
  // simple form fallback
  const owner = item.owner as { login: string } | null;
  const license = item.license as { spdx_id: string | null } | null;
  if (!owner) return null;
  return {
    github_id: item.id as number,
    full_name: item.full_name as string,
    owner: owner.login,
    name: item.name as string,
    description: (item.description as string | null) ?? null,
    topics: (item.topics as string[]) ?? [],
    language: (item.language as string | null) ?? null,
    stargazers_count: item.stargazers_count as number,
    forks_count: item.forks_count as number,
    license: license?.spdx_id ?? null,
    html_url: item.html_url as string,
    default_branch: item.default_branch as string,
    starred_at: null,
    raw_data: item,
  };
}

export interface FetchStarredResult {
  repos: NormalizedRepo[];
  pages_walked: number;
  pages_304: number;
  completed_walk: boolean;
}

/**
 * ETag-cached walk of /user/starred. 304 responses don't count against the
 * primary rate limit. `useEtags: false` forces a full authoritative walk
 * (used by reconcile).
 */
export async function fetchAllStarredRepos(params: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  githubToken: string;
  useEtags?: boolean;
  maxPages?: number;
}): Promise<FetchStarredResult> {
  const {
    supabase,
    githubToken,
    useEtags = true,
    maxPages = Infinity,
  } = params;
  const perPage = 100;

  // Prefetch cache for up to the first 100 pages (10k stars ceiling)
  const probe = Array.from(
    { length: 100 },
    (_, i) =>
      `https://api.github.com/user/starred?per_page=${perPage}&page=${i + 1}`,
  );
  const cache = useEtags ? await getEtags(supabase, probe) : new Map();

  const repos: NormalizedRepo[] = [];
  let pagesWalked = 0;
  let pages304 = 0;
  let completed = true;
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= maxPages) {
    const url = `https://api.github.com/user/starred?per_page=${perPage}&page=${page}`;
    const cached = cache.get(url);
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.star+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(useEtags ? conditionalHeaders(cached) : {}),
      },
    });

    pagesWalked += 1;

    if (response.status === 304) {
      pages304 += 1;
      await saveEtag(supabase, {
        url,
        etag: cached?.etag ?? null,
        lastModified: cached?.last_modified ?? null,
        status: 304,
      });
      const links304 = parseLinkHeader(response.headers);
      hasMore = !!links304.next;
      page += 1;
      if (hasMore) await new Promise((r) => setTimeout(r, 100));
      continue;
    }

    if (!response.ok) {
      completed = false;
      throw new Error(
        `GitHub ${response.status} on ${url}: ${await response.text()}`,
      );
    }

    const data = (await response.json()) as Record<string, unknown>[];
    for (const item of data) {
      const n = normalize(item);
      if (n) repos.push(n);
    }

    await saveEtag(supabase, {
      url,
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified"),
      status: 200,
    });

    const links = parseLinkHeader(response.headers);
    hasMore = !!links.next;
    page += 1;
    if (hasMore) await new Promise((r) => setTimeout(r, 100));
  }

  if (page > maxPages && hasMore) completed = false;

  return {
    repos,
    pages_walked: pagesWalked,
    pages_304: pages304,
    completed_walk: completed,
  };
}
