import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("0024 migration filters search by provider/model/dimension", async () => {
  const sql = await readFile(
    resolve(
      import.meta.dir,
      "..",
      "supabase/migrations/0024_embedding_provider_and_freshness.sql",
    ),
    "utf8",
  );

  expect(sql).toContain("embedding_provider_filter text default 'openai'");
  expect(sql).toContain("embedding_model_filter text default 'text-embedding-3-small'");
  expect(sql).toContain("embedding_dim_filter int default 1536");
  expect(sql).toContain("r.embedding_provider = embedding_provider_filter");
  expect(sql).toContain("needs_embedding");
  expect(sql).toContain("content_checked_at");
});
