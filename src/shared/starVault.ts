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

export const DEFAULT_EMBEDDING_PROVIDER = "openrouter";
export const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_MODEL = OPENROUTER_EMBEDDING_MODEL;
export const EMBEDDING_DIMENSIONS = 1536;
export const CONTENT_STALE_DAYS = 30;

export const EMBEDDING_PROVIDER_MODELS = {
  openrouter: OPENROUTER_EMBEDDING_MODEL,
  openai: OPENAI_EMBEDDING_MODEL,
  gemini: GEMINI_EMBEDDING_MODEL,
} as const;

export type EmbeddingProviderName = keyof typeof EMBEDDING_PROVIDER_MODELS;

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
  content_fetched_at?: string | null;
  content_checked_at?: string | null;
  content_changed_at?: string | null;
  source_changed_at?: string | null;
  embedding_provider?: EmbeddingProviderName | string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  embedding_generated_at?: string | null;
  dependency_match?: boolean;
  similarity: number;
}

export type ErrorBucket =
  | "rate_limit"
  | "network"
  | "validation"
  | "db"
  | "unknown";
