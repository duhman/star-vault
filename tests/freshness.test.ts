import { describe, expect, test } from "bun:test";
import {
  didContentMateriallyChange,
  isContentStale,
} from "../src/utils/supabase.js";
import { shouldGenerateEmbedding, type EmbeddableRepo } from "../src/sync/embeddings.js";

const now = new Date("2026-06-26T12:00:00.000Z");

const provider = {
  name: "openai" as const,
  model: "text-embedding-3-small",
  dimensions: 1536,
};

function embeddedRepo(overrides: Partial<EmbeddableRepo> = {}): EmbeddableRepo {
  return {
    github_id: 1,
    full_name: "owner/repo",
    owner: "owner",
    name: "repo",
    html_url: "https://github.com/owner/repo",
    embedding: [0.1, 0.2],
    embedding_input_hash: "hash-a",
    embedding_provider: "openai",
    embedding_model: "text-embedding-3-small",
    embedding_dim: 1536,
    embedding_generated_at: "2026-06-26T11:00:00.000Z",
    needs_embedding: false,
    ...overrides,
  };
}

describe("content freshness", () => {
  test("treats never-checked content as stale", () => {
    expect(isContentStale({}, 30, now)).toBe(true);
  });

  test("keeps recently checked content fresh", () => {
    expect(
      isContentStale(
        {
          content_fetched_at: "2026-06-20T12:00:00.000Z",
          content_checked_at: "2026-06-20T12:00:00.000Z",
        },
        30,
        now,
      ),
    ).toBe(false);
  });

  test("refreshes content beyond the stale window", () => {
    expect(
      isContentStale(
        {
          content_fetched_at: "2026-05-20T12:00:00.000Z",
          content_checked_at: "2026-05-20T12:00:00.000Z",
        },
        30,
        now,
      ),
    ).toBe(true);
  });

  test("ignores package.json key order but detects material changes", () => {
    expect(
      didContentMateriallyChange(
        { package_json: { b: "2", a: "1" } },
        { package_json: { a: "1", b: "2" } },
      ),
    ).toBe(false);
    expect(
      didContentMateriallyChange(
        { readme_content: "old" },
        { readme_content: "new" },
      ),
    ).toBe(true);
  });
});

describe("embedding freshness", () => {
  test("skips rows already embedded for the active provider and input hash", () => {
    expect(shouldGenerateEmbedding(embeddedRepo(), provider, "hash-a")).toBe(
      false,
    );
  });

  test("regenerates when source/content marked the row dirty", () => {
    expect(
      shouldGenerateEmbedding(
        embeddedRepo({ needs_embedding: true }),
        provider,
        "hash-a",
      ),
    ).toBe(true);
  });

  test("regenerates when provider/model/hash drift", () => {
    expect(
      shouldGenerateEmbedding(
        embeddedRepo({ embedding_provider: "gemini" }),
        provider,
        "hash-a",
      ),
    ).toBe(true);
    expect(shouldGenerateEmbedding(embeddedRepo(), provider, "hash-b")).toBe(
      true,
    );
  });
});
