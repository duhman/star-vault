// Deno-side of the parity test.
// Reads tests/embedding-input-fixtures.json, runs the Deno buildEmbeddingInput
// + sha256Hex on each fixture, and prints a JSON map of { name: { input, hash } }
// to stdout. The Bun-side test (embedding-input-parity.test.ts) spawns this
// under `deno run` and compares against the Node output for byte-exact parity.

import {
  buildEmbeddingInput,
  sha256Hex,
  type RepoInput,
} from "../supabase/functions/_shared/embedding-input.ts";

interface Fixture {
  name: string;
  repo: RepoInput;
}

async function main() {
  const fixturesUrl = new URL(
    "./embedding-input-fixtures.json",
    import.meta.url,
  );
  const fixtures = JSON.parse(
    await Deno.readTextFile(fixturesUrl),
  ) as Fixture[];

  const out: Record<string, { input: string; hash: string }> = {};
  for (const f of fixtures) {
    const input = buildEmbeddingInput(f.repo);
    const hash = await sha256Hex(input);
    out[f.name] = { input, hash };
  }

  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
