/**
 * ETag cache for GitHub REST requests.
 *
 * Why this exists:
 *   A 304 Not Modified response from the GitHub REST API does not count
 *   against the primary rate limit. Caching ETags per URL lets a daily sync
 *   of ~5000 stars typically touch the API budget almost zero, because the
 *   underlying pages rarely change.
 *
 *   See: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
 *
 * Shape:
 *   The cache key is the full URL (including per_page and page parameters).
 *   An unchanged page 1 tells us nothing about page 2, so every page keeps
 *   its own ETag.
 */

import { getSupabaseClient } from "../utils/supabase.js";

const ETAGS_TABLE = "github_etags";

export interface CachedEtag {
  url: string;
  etag: string | null;
  last_modified: string | null;
  status: number | null;
  fetched_at: string;
}

/** Fetch cached validators for a batch of URLs in one round-trip. */
export async function getEtags(
  urls: string[],
): Promise<Map<string, CachedEtag>> {
  if (urls.length === 0) return new Map();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(ETAGS_TABLE)
    .select("url, etag, last_modified, status, fetched_at")
    .in("url", urls);

  if (error) throw error;

  const map = new Map<string, CachedEtag>();
  for (const row of (data ?? []) as CachedEtag[]) {
    map.set(row.url, row);
  }
  return map;
}

/** Upsert one ETag row after a conditional request. */
export async function saveEtag(params: {
  url: string;
  etag: string | null;
  lastModified: string | null;
  status: number;
}): Promise<void> {
  const supabase = getSupabaseClient();
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

/**
 * Convert a CachedEtag into `If-None-Match` / `If-Modified-Since` headers.
 * Returns an empty object if there's no cached validator.
 */
export function conditionalHeaders(
  cached: CachedEtag | undefined,
): Record<string, string> {
  if (!cached) return {};
  const headers: Record<string, string> = {};
  if (cached.etag) headers["If-None-Match"] = cached.etag;
  if (cached.last_modified) headers["If-Modified-Since"] = cached.last_modified;
  return headers;
}
