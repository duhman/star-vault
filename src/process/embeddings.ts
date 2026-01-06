/**
 * Generate embeddings for repositories
 */

import { generateEmbedding } from "../utils/openai.js";
import { extractDependencies } from "../github/content.js";

/**
 * Build embedding text from repo data
 * Combines metadata, README, and dependencies for rich semantic search
 */
export function buildEmbeddingText(repo: {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  license: string | null;
  readme_content: string | null;
  package_json: Record<string, unknown> | null;
}): string {
  const parts: string[] = [];

  // Basic info
  parts.push(repo.full_name);

  if (repo.description) {
    parts.push(repo.description);
  }

  // Metadata
  const metadata: string[] = [];
  if (repo.language) {
    metadata.push(`Language: ${repo.language}`);
  }
  if (repo.topics.length > 0) {
    metadata.push(`Topics: ${repo.topics.join(", ")}`);
  }
  if (repo.license) {
    metadata.push(`License: ${repo.license}`);
  }
  metadata.push(`Stars: ${repo.stargazers_count}, Forks: ${repo.forks_count}`);

  if (metadata.length > 0) {
    parts.push(metadata.join("\n"));
  }

  // README content (first 6000 chars to stay within limits)
  if (repo.readme_content) {
    parts.push("--- README ---");
    parts.push(repo.readme_content.slice(0, 6000));
  }

  // Dependencies from package.json
  const deps = extractDependencies(repo.package_json);
  if (deps.length > 0) {
    parts.push("--- Dependencies ---");
    parts.push(deps.join(", "));
  }

  return parts.join("\n\n");
}

/**
 * Generate embedding for a repo
 */
export async function generateRepoEmbedding(repo: {
  full_name: string;
  owner: string;
  name: string;
  description: string | null;
  topics: string[];
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  license: string | null;
  readme_content: string | null;
  package_json: Record<string, unknown> | null;
}): Promise<number[]> {
  const text = buildEmbeddingText(repo);
  return generateEmbedding(text);
}
