/**
 * Batched OpenAI embeddings with content-hash idempotency.
 *
 * Why batched:
 *   `embeddings.create` accepts an array of up to 2048 inputs per call.
 *   Calling once per repo with concurrency=4 wastes ~100x the HTTP round
 *   trips and TPM quota for identical output. Batching is the single
 *   largest efficiency win in this file.
 *
 * Why content hash:
 *   We store SHA-256 of the exact input string alongside the vector. On
 *   subsequent runs, we skip any repo whose input string hashes to the
 *   stored value — a single cheap comparison that captures ALL upstream
 *   changes (description edit, README update, new topics, etc.).
 */

import { createHash } from "node:crypto";
import {
  EMBEDDING_DIMENSIONS,
  STAR_VAULT_TABLES,
} from "../shared/starVault.js";
import { getSupabaseClient, type Repo } from "../utils/supabase.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddingProvider.js";

/** Inputs per batch call. Well under the 2048 / 300k-token API ceilings. */
const EMBEDDING_BATCH_SIZE = 96;

export interface EmbeddingResult {
  repos_scanned: number;
  repos_skipped_unchanged: number;
  embeddings_generated: number;
  batches: number;
  embedding_provider: string;
  embedding_model: string;
}

export interface EmbeddableRepo extends Repo {
  embedding_input_hash?: string | null;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  embedding_generated_at?: string | null;
  needs_embedding?: boolean | null;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LEARNING-MODE DECISION POINT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Build the exact string sent to the embeddings API for one repo.
 *
 * This function directly shapes retrieval quality. Research notes from the
 * best-practices pass:
 *   - text-embedding-3-small handles ~8191 tokens (~30k chars) per input;
 *     the previous 2000-char README cap throws away most of the signal.
 *   - Markdown structure (headings, code fences) actually helps — don't
 *     flatten it unless you're stripping badge/HTML noise.
 *   - Include fields that match how you SEARCH:
 *       - "find me an X library" → description + topics matter most
 *       - "which of my starred repos uses Y"  → dependencies + language
 *       - "projects about Z concept"          → README body matters most
 *
 * Current default (below) is a reasonable starting point. Tune it based on
 * the kinds of queries you actually run against the MCP server.
 *
 * Keep the output deterministic — any non-determinism will defeat the
 * content-hash idempotency gate and cause spurious re-embeds.
 *
 * TODO(you): adjust to match your actual search patterns.
 */
export function buildEmbeddingInput(repo: Repo): string {
  const parts: string[] = [];

  // Identity
  parts.push(repo.full_name);
  if (repo.description) parts.push(`Description: ${repo.description}`);

  // Structured metadata
  const meta: string[] = [];
  if (repo.language) meta.push(`Language: ${repo.language}`);
  if (repo.topics?.length) meta.push(`Topics: ${repo.topics.join(", ")}`);
  if (repo.license) meta.push(`License: ${repo.license}`);
  if (repo.stargazers_count != null)
    meta.push(`Stars: ${repo.stargazers_count}`);
  if (repo.forks_count != null) meta.push(`Forks: ${repo.forks_count}`);
  if (meta.length) parts.push(meta.join(" | "));

  // Dependency context for JS/TS repos — the single most valuable signal
  // for "uses library X" queries. Runtime and dev deps are split into
  // separate labelled sections so retrieval can distinguish between
  // "production uses React" and "React only in dev tooling". 80 names per
  // section covers virtually every real-world package.json without
  // drowning the README.
  const pkg = repo.package_json as
    | {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    | undefined;
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

  // README — previously capped at 2000 chars, now ~6000. Strip common
  // noise (badges, HTML comments) that hurts retrieval quality.
  if (repo.readme_content) {
    const cleaned = stripReadmeNoise(repo.readme_content).slice(0, 6000);
    parts.push("--- README ---");
    parts.push(cleaned);
  }

  return parts.join("\n\n");
}

export function stripReadmeNoise(md: string): string {
  return (
    md
      // HTML comments
      .replace(/<!--[\s\S]*?-->/g, "")
      // shield.io / badge images in markdown: ![alt](https://img.shields.io/...)
      .replace(
        /!\[[^\]]*]\(https?:\/\/[^)]*(shields\.io|badge|ci|actions)[^)]*\)/gi,
        "",
      )
      // bare HTML tags (leaves inner text)
      .replace(/<\/?[a-z][^>]*>/gi, "")
      // collapse 3+ blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestration below this line — usually no need to edit.
// ───────────────────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export function shouldGenerateEmbedding(
  repo: EmbeddableRepo,
  provider: Pick<EmbeddingProvider, "name" | "model" | "dimensions">,
  inputHash: string,
): boolean {
  if (!repo.embedding) return true;
  if (!repo.embedding_input_hash) return true;
  if (repo.embedding_input_hash !== inputHash) return true;
  if (repo.needs_embedding) return true;
  if (repo.embedding_provider !== provider.name) return true;
  if (repo.embedding_model !== provider.model) return true;
  if (repo.embedding_dim !== provider.dimensions) return true;
  if (!repo.embedding_generated_at) return true;
  return false;
}

/**
 * Process up to `limit` repos lacking embeddings (or whose input hash has
 * drifted). Returns counts for reporting.
 */
export async function generateEmbeddingsBatch(options: {
  limit: number;
  providerName?: string;
}): Promise<EmbeddingResult> {
  const supabase = getSupabaseClient();
  const provider = createEmbeddingProvider({
    providerName: options.providerName,
  });

  // Candidate set: any repo with content fetched and either
  //   (a) needs_embedding was raised by repo/content changes,
  //   (b) there is no embedding/hash yet, or
  //   (c) the row belongs to another provider/model/dimension.
  const { data, error } = await supabase
    .from(STAR_VAULT_TABLES.repos)
    .select("*")
    .not("content_fetched_at", "is", null)
    .or(
      [
        "needs_embedding.eq.true",
        "embedding.is.null",
        "embedding_input_hash.is.null",
        `embedding_provider.neq.${provider.name}`,
        `embedding_model.neq.${provider.model}`,
        `embedding_dim.neq.${provider.dimensions}`,
        "embedding_generated_at.is.null",
      ].join(","),
    )
    .order("starred_at", { ascending: false })
    .limit(options.limit);

  if (error) throw error;
  const candidates = (data ?? []) as EmbeddableRepo[];

  const result: EmbeddingResult = {
    repos_scanned: candidates.length,
    repos_skipped_unchanged: 0,
    embeddings_generated: 0,
    batches: 0,
    embedding_provider: provider.name,
    embedding_model: provider.model,
  };

  // Compute inputs + hashes up front, drop rows whose hash hasn't changed.
  const workItems: Array<{ repo: EmbeddableRepo; input: string; hash: string }> = [];
  for (const repo of candidates) {
    const input = buildEmbeddingInput(repo);
    const hash = sha256Hex(input);
    if (!shouldGenerateEmbedding(repo, provider, hash)) {
      result.repos_skipped_unchanged += 1;
      continue;
    }
    workItems.push({ repo, input, hash });
  }

  for (const batch of chunk(workItems, EMBEDDING_BATCH_SIZE)) {
    const embeddings = await provider.embed(batch.map((w) => w.input));
    result.batches += 1;

    // The API guarantees positional alignment between inputs and data[i].
    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding API returned ${embeddings.length} vectors for ${batch.length} inputs`,
      );
    }

    // Write back in parallel but bounded — one UPDATE per repo is fine
    // because UPDATE on PK is cheap and writes are not the bottleneck.
    await Promise.all(
      batch.map(async (work, i) => {
        const embedding = embeddings[i];
        if (embedding.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Unexpected embedding dim ${embedding.length}, want ${EMBEDDING_DIMENSIONS}`,
          );
        }
        const { error: updateError } = await supabase
          .from(STAR_VAULT_TABLES.repos)
          .update({
            embedding,
            embedding_input_hash: work.hash,
            embedding_provider: provider.name,
            embedding_model: provider.model,
            embedding_dim: provider.dimensions,
            embedding_generated_at: new Date().toISOString(),
            needs_embedding: false,
          })
          .eq("github_id", work.repo.github_id);
        if (updateError) throw updateError;
        result.embeddings_generated += 1;
      }),
    );
  }

  return result;
}
