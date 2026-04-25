// Deno-side of the reconcile-safety parity test.
// Reads the fixtures, runs isSafeToReconcile on each, prints a name→bool map
// as JSON to stdout. The Bun-side test compares against the Node builder's
// decisions AND against the fixture's own `expected` field.

import { isSafeToReconcile } from "../supabase/functions/_shared/reconcile.ts";

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

async function main() {
  const fixturesUrl = new URL(
    "./reconcile-safety-fixtures.json",
    import.meta.url,
  );
  const fixtures = JSON.parse(
    await Deno.readTextFile(fixturesUrl),
  ) as Fixture[];

  const out: Record<string, boolean> = {};
  for (const f of fixtures) out[f.name] = isSafeToReconcile(f.run);

  console.log(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
