/**
 * Fetch README and package.json content from GitHub repositories.
 *
 * Switched from raw.githubusercontent.com filename-guessing to the canonical
 * REST API endpoint `GET /repos/{owner}/{repo}/readme`, which:
 *   - Returns the canonical README regardless of filename or case.
 *   - Participates in ETag caching (304s don't count against rate limit).
 *   - Works for private repos without token-in-URL tricks.
 *
 * package.json still comes from raw.githubusercontent.com — there's no
 * "canonical package manifest" endpoint and it's conventionally at the repo
 * root. A 404 is normal for non-JS repos and is NOT an error.
 */

import { fetchWithRetry } from "../utils/retry.js";
import { conditionalHeaders, getEtags, saveEtag } from "../sync/etag-cache.js";

const GITHUB_API_BASE = "https://api.github.com";
const RAW_CONTENT_BASE = "https://raw.githubusercontent.com";

function getApiHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  const base: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) base.Authorization = `Bearer ${token}`;
  return base;
}

function getRawHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch the canonical README for a repository. Uses ETag cache: on 304 the
 * return value is `null` (no new content) — caller keeps the stored value.
 *
 * NOTE: 304 semantics here differ from the stars-list path. If a 304 is
 * returned, we don't update readme_content in the DB — the previous value
 * is assumed still correct. If the previous value was null (never fetched),
 * we'll issue the same request with no If-None-Match and get a 200.
 */
export async function fetchReadme(
  owner: string,
  name: string,
): Promise<string | null> {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${name}/readme`;
  const cachedMap = await getEtags([url]);
  const cached = cachedMap.get(url);

  const response = await fetchWithRetry(
    url,
    {
      headers: {
        ...getApiHeaders(),
        ...conditionalHeaders(cached),
      },
    },
    { maxAttempts: 3, baseDelayMs: 500 },
  );

  if (response.status === 304) {
    await saveEtag({
      url,
      etag: cached?.etag ?? null,
      lastModified: cached?.last_modified ?? null,
      status: 304,
    });
    return null;
  }

  if (response.status === 404) {
    // No README at all — cache a null-body hit so we don't re-ask.
    await saveEtag({
      url,
      etag: response.headers.get("ETag"),
      lastModified: response.headers.get("Last-Modified"),
      status: 404,
    });
    return null;
  }

  if (!response.ok) {
    return null;
  }

  // With Accept: application/vnd.github.raw+json the response body IS the
  // raw file bytes, not a wrapper object.
  const content = await response.text();
  await saveEtag({
    url,
    etag: response.headers.get("ETag"),
    lastModified: response.headers.get("Last-Modified"),
    status: 200,
  });
  return content.slice(0, 50000);
}

/**
 * Fetch package.json from the repo root via the raw CDN. Returns null for
 * any non-JS repo (404 is the common case). Does not throw.
 */
export async function fetchPackageJson(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `${RAW_CONTENT_BASE}/${owner}/${name}/${defaultBranch}/package.json`;
    const response = await fetchWithRetry(
      url,
      { headers: getRawHeaders() },
      { maxAttempts: 3, baseDelayMs: 500 },
    );

    if (response.ok) {
      const content = await response.json();
      return content as Record<string, unknown>;
    }
  } catch {
    // No package.json or invalid JSON
  }

  return null;
}

/**
 * Fetch both README and package.json for a repository.
 *
 * `readme` is `null` when either (a) no README exists (404) or
 * (b) the cached version is still current (304). Callers should only
 * overwrite readme_content when the returned value is non-null.
 */
export async function fetchRepoContent(
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<{
  readme: string | null;
  packageJson: Record<string, unknown> | null;
}> {
  const [readme, packageJson] = await Promise.all([
    fetchReadme(owner, name),
    fetchPackageJson(owner, name, defaultBranch),
  ]);

  return { readme, packageJson };
}

/**
 * Extract dependency list from package.json
 */
export function extractDependencies(
  packageJson: Record<string, unknown> | null,
): string[] {
  if (!packageJson) return [];

  const deps: string[] = [];

  const dependencies = packageJson.dependencies as
    | Record<string, string>
    | undefined;
  const devDependencies = packageJson.devDependencies as
    | Record<string, string>
    | undefined;

  if (dependencies) {
    deps.push(...Object.keys(dependencies));
  }
  if (devDependencies) {
    deps.push(...Object.keys(devDependencies));
  }

  return deps;
}
