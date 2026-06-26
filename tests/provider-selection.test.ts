import { describe, expect, test } from "bun:test";
import {
  getConfiguredEmbeddingProviderName,
  getEmbeddingProviderModel,
  normalizeEmbeddingProviderName,
} from "../src/sync/embeddingProvider.js";

describe("embedding provider selection", () => {
  test("defaults to OpenAI when EMBEDDING_PROVIDER is unset", () => {
    expect(getConfiguredEmbeddingProviderName({})).toBe("openai");
  });

  test("accepts case-insensitive Gemini configuration", () => {
    expect(
      getConfiguredEmbeddingProviderName({ EMBEDDING_PROVIDER: "Gemini" }),
    ).toBe("gemini");
  });

  test("rejects unsupported providers", () => {
    expect(() => normalizeEmbeddingProviderName("cohere")).toThrow(
      /Unsupported EMBEDDING_PROVIDER/,
    );
  });

  test("maps providers to explicit models", () => {
    expect(getEmbeddingProviderModel("openai")).toBe("text-embedding-3-small");
    expect(getEmbeddingProviderModel("gemini")).toBe("gemini-embedding-001");
  });
});
