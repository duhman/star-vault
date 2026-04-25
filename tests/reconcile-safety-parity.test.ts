/**
 * Parity + behavior test for isSafeToReconcile.
 *
 * Enforces:
 *   1. Node and Deno implementations agree on every fixture.
 *   2. Both implementations match the fixture's documented `expected` value.
 *
 * A mismatch would mean a DELETE decision diverges between CLI and Edge
 * Function — very bad for a destructive op. Test fails loudly on any drift.
 *
 * Run: `bun test` (requires `deno` on PATH)
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isSafeToReconcile } from "../src/sync/reconcile.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesPath = resolve(here, "reconcile-safety-fixtures.json");
const denoScriptPath = resolve(here, "reconcile-safety-parity.deno.ts");

interface Fixture {
  name: string;
  run: {
    id: number;
    completed_walk: boolean;
    pages_walked: number;
    pages_304: number;
    repos_seen: number;
    existing_repo_count: number;
  };
  expected: boolean;
}

async function hasDeno(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["deno", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function runDeno(): Promise<Record<string, boolean>> {
  const proc = Bun.spawn(["deno", "run", "--allow-read", denoScriptPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`deno run failed (exit ${code}):\n${stderr}\n${stdout}`);
  return JSON.parse(stdout);
}

describe("isSafeToReconcile: Node/Deno parity + expected behavior", () => {
  let fixtures: Fixture[] = [];
  let denoResults: Record<string, boolean> = {};
  let denoAvailable = false;

  beforeAll(async () => {
    fixtures = JSON.parse(await readFile(fixturesPath, "utf8")) as Fixture[];
    denoAvailable = await hasDeno();
    if (denoAvailable) denoResults = await runDeno();
  });

  test("deno on PATH", () => {
    expect(denoAvailable).toBe(true);
  });

  test("fixture file non-empty", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  test("Node decisions match fixture expectations", () => {
    for (const f of fixtures) {
      const nodeDecision = isSafeToReconcile(f.run);
      if (nodeDecision !== f.expected) {
        console.error(
          `Fixture ${f.name}: Node returned ${nodeDecision}, expected ${f.expected}`,
        );
      }
      expect(nodeDecision).toBe(f.expected);
    }
  });

  test("Node and Deno decisions match on every fixture", () => {
    if (!denoAvailable) return;
    for (const f of fixtures) {
      const nodeDecision = isSafeToReconcile(f.run);
      const denoDecision = denoResults[f.name];
      if (nodeDecision !== denoDecision) {
        console.error(
          `DIVERGENCE on ${f.name}: Node=${nodeDecision} Deno=${denoDecision} (expected ${f.expected})`,
        );
      }
      expect(denoDecision).toBe(nodeDecision);
    }
  });
});
