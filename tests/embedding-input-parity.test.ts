/**
 * Parity test: Node buildEmbeddingInput must produce byte-identical output
 * (and therefore identical SHA-256 hash) to the Deno implementation in
 * supabase/functions/_shared/embedding-input.ts.
 *
 * Why this matters:
 *   Star Vault uses `embedding_input_hash` to skip re-embedding unchanged
 *   repos. The CLI (Bun/Node) and Edge Functions (Deno) BOTH write to this
 *   column. If the two builders drift — even by a trailing newline or field
 *   ordering — every repo embedded by one path is seen as "dirty" by the
 *   other, causing unbounded OpenAI quota churn.
 *
 *   This test runs both implementations over the SAME fixtures and asserts
 *   perfect equality. It fails loudly on any drift.
 *
 * How to run: `bun test`
 * Requires:   `deno` on PATH (checked at start; test is skipped otherwise).
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildEmbeddingInput } from "../src/sync/embeddings.js";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolve(here, "embedding-input-fixtures.json");
const denoScriptPath = resolve(here, "embedding-input-parity.deno.ts");

interface Fixture {
  name: string;
  // Structurally the same as RepoInput on both sides. Kept loose here because
  // the Node Repo type is wider than the Deno RepoInput type.
  repo: Record<string, unknown>;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function hasDeno(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["deno", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

async function runDeno(): Promise<
  Record<string, { input: string; hash: string }>
> {
  const proc = Bun.spawn(["deno", "run", "--allow-read", denoScriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `deno run failed (exit ${code}):\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`,
    );
  }
  return JSON.parse(stdout);
}

describe("buildEmbeddingInput: Node/Deno parity", () => {
  let fixtures: Fixture[] = [];
  let denoResults: Record<string, { input: string; hash: string }> = {};
  let denoAvailable = false;

  beforeAll(async () => {
    fixtures = JSON.parse(await readFile(fixturesPath, "utf8")) as Fixture[];
    denoAvailable = await hasDeno();
    if (denoAvailable) denoResults = await runDeno();
  });

  test("deno is installed (otherwise parity can't be checked)", () => {
    // If this skips in CI, Deno must be added to the CI image. Parity is too
    // important to let a missing runtime silently pass.
    if (!denoAvailable) {
      console.warn(
        "[parity test] deno not found on PATH — skipping parity check",
      );
    }
    expect(denoAvailable).toBe(true);
  });

  test("fixtures file is non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test("every fixture: Node and Deno produce byte-identical input strings", () => {
    if (!denoAvailable) return;
    for (const f of fixtures) {
      // The Node type (Repo) is wider than the Deno type (RepoInput), but the
      // function reads the same fields. Cast is safe for the builder.
      const nodeInput = buildEmbeddingInput(
        f.repo as Parameters<typeof buildEmbeddingInput>[0],
      );
      const denoInput = denoResults[f.name]?.input;
      expect(denoInput).toBeDefined();
      if (nodeInput !== denoInput) {
        // Helpful diff on failure
        console.error(`--- fixture: ${f.name} ---`);
        console.error("NODE:\n" + JSON.stringify(nodeInput));
        console.error("DENO:\n" + JSON.stringify(denoInput));
      }
      expect(nodeInput).toBe(denoInput);
    }
  });

  test("every fixture: SHA-256 hashes match", () => {
    if (!denoAvailable) return;
    for (const f of fixtures) {
      const nodeInput = buildEmbeddingInput(
        f.repo as Parameters<typeof buildEmbeddingInput>[0],
      );
      const nodeHash = sha256Hex(nodeInput);
      const denoHash = denoResults[f.name]?.hash;
      expect(denoHash).toBeDefined();
      expect(nodeHash).toBe(denoHash);
    }
  });
});
