// Deno mirror of the default buildEmbeddingInput from src/sync/embeddings.ts.
// MUST produce byte-identical output to the Node path — the embedding_input_hash
// idempotency gate depends on it.
//
// If you edit `buildEmbeddingInput` in src/sync/embeddings.ts, update this too.
// An integration test in the next commit validates parity.

export interface RepoInput {
  full_name: string;
  description: string | null;
  language: string | null;
  topics: string[] | null;
  license: string | null;
  stargazers_count: number | null;
  forks_count: number | null;
  readme_content: string | null;
  package_json: Record<string, unknown> | null;
}

export function buildEmbeddingInput(repo: RepoInput): string {
  const parts: string[] = [];

  parts.push(repo.full_name);
  if (repo.description) parts.push(`Description: ${repo.description}`);

  const meta: string[] = [];
  if (repo.language) meta.push(`Language: ${repo.language}`);
  if (repo.topics?.length) meta.push(`Topics: ${repo.topics.join(", ")}`);
  if (repo.license) meta.push(`License: ${repo.license}`);
  if (repo.stargazers_count != null)
    meta.push(`Stars: ${repo.stargazers_count}`);
  if (repo.forks_count != null) meta.push(`Forks: ${repo.forks_count}`);
  if (meta.length) parts.push(meta.join(" | "));

  const pkg = repo.package_json as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } | null;
  if (pkg) {
    const runtime = Object.keys(pkg.dependencies ?? {});
    const dev = Object.keys(pkg.devDependencies ?? {});
    if (runtime.length) {
      parts.push(`Runtime dependencies: ${runtime.slice(0, 80).join(", ")}`);
    }
    if (dev.length) {
      parts.push(`Dev dependencies: ${dev.slice(0, 80).join(", ")}`);
    }
  }

  if (repo.readme_content) {
    const cleaned = stripReadmeNoise(repo.readme_content).slice(0, 6000);
    parts.push("--- README ---");
    parts.push(cleaned);
  }

  return parts.join("\n\n");
}

export function stripReadmeNoise(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /!\[[^\]]*]\(https?:\/\/[^)]*(shields\.io|badge|ci|actions)[^)]*\)/gi,
      "",
    )
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
