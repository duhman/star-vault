export const STAR_VAULT_SCHEMA = process.env.SUPABASE_SCHEMA || "star_vault";

export const STAR_VAULT_TABLES = {
  repos: "repos",
  syncState: "sync_state",
} as const;

export const STAR_VAULT_RPC = {
  searchRepos: "search_repos",
  getRepoDetails: "get_repo_details",
  getStats: "get_stats",
} as const;

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export interface SearchRepoRow {
  id: number;
  full_name: string;
  description: string | null;
  topics: string[] | null;
  language: string | null;
  html_url: string;
  stargazers_count?: number | null;
  forks_count?: number | null;
  starred_at?: string | null;
  similarity: number;
}

export type ErrorBucket =
  | "rate_limit"
  | "network"
  | "validation"
  | "db"
  | "unknown";
