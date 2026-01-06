/**
 * GitHub API client with PAT authentication
 */

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubClientOptions {
  token: string;
}

export class GitHubClient {
  private token: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
  }

  /**
   * Make an authenticated request to the GitHub API
   */
  async request<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<{ data: T; headers: Headers }> {
    const url = endpoint.startsWith("http")
      ? endpoint
      : `${GITHUB_API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as T;
    return { data, headers: response.headers };
  }

  /**
   * Parse Link header for pagination
   */
  parseLinkHeader(headers: Headers): {
    next?: string;
    last?: string;
    first?: string;
    prev?: string;
  } {
    const link = headers.get("Link");
    if (!link) return {};

    const links: Record<string, string> = {};
    const parts = link.split(",");

    for (const part of parts) {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (match) {
        links[match[2]] = match[1];
      }
    }

    return links;
  }

  /**
   * Get rate limit status
   */
  async getRateLimit(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
  }> {
    const { data } = await this.request<{
      rate: { limit: number; remaining: number; reset: number };
    }>("/rate_limit");

    return {
      limit: data.rate.limit,
      remaining: data.rate.remaining,
      reset: new Date(data.rate.reset * 1000),
    };
  }
}

// Singleton instance
let client: GitHubClient | null = null;

export function getGitHubClient(): GitHubClient {
  if (!client) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error("Missing GITHUB_TOKEN environment variable");
    }
    client = new GitHubClient({ token });
  }
  return client;
}
