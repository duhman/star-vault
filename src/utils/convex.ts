import { ConvexHttpClient } from "convex/browser";
import { api } from "./convexApi.js";

export interface SyncResult {
  repos_fetched: number;
  repos_added: number;
  repos_updated: number;
  content_fetched: number;
  embeddings_generated: number;
  errors: string[];
}

export interface VaultStats {
  total_repos: number;
  with_embeddings: number;
  with_readme: number;
  top_languages: string[];
  last_sync: string | null;
}

let convexClient: ConvexHttpClient | null = null;

export function getConvexClient(): ConvexHttpClient {
  if (convexClient) return convexClient;
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new Error("Missing CONVEX_URL environment variable");
  }
  convexClient = new ConvexHttpClient(url);
  return convexClient;
}

export async function syncStarVault(args?: {
  fetchRepos?: boolean;
  contentLimit?: number;
  embeddingLimit?: number;
  syncType?: string;
}): Promise<SyncResult> {
  const convex = getConvexClient();
  return convex.action(api.starVault.syncStarVault, args ?? {});
}

export async function getStats(): Promise<VaultStats> {
  const convex = getConvexClient();
  return convex.query(api.starVaultQueries.getStats, {});
}
