import { describe, expect, test } from "bun:test";
import {
  createEmbeddingProvider,
  getConfiguredEmbeddingProviderName,
  getEmbeddingProviderModel,
  normalizeEmbeddingProviderName,
} from "../src/sync/embeddingProvider.js";

describe("embedding provider selection", () => {
  test("defaults to OpenRouter when EMBEDDING_PROVIDER is unset", () => {
    expect(getConfiguredEmbeddingProviderName({})).toBe("openrouter");
  });

  test("accepts case-insensitive OpenRouter configuration", () => {
    expect(
      getConfiguredEmbeddingProviderName({ EMBEDDING_PROVIDER: "OpenRouter" }),
    ).toBe("openrouter");
  });

  test("falls back to direct OpenAI only when OpenRouter is not configured", () => {
    expect(
      getConfiguredEmbeddingProviderName({ OPENAI_API_KEY: "test-key" }),
    ).toBe("openai");
    expect(
      getConfiguredEmbeddingProviderName({
        OPENROUTER_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
      }),
    ).toBe("openrouter");
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
    expect(getEmbeddingProviderModel("openrouter")).toBe(
      "openai/text-embedding-3-small",
    );
    expect(getEmbeddingProviderModel("openai")).toBe("text-embedding-3-small");
    expect(getEmbeddingProviderModel("gemini")).toBe("gemini-embedding-001");
  });

  test("constructs OpenRouter with the shared model metadata", () => {
    const provider = createEmbeddingProvider({
      providerName: "openrouter",
      env: { OPENROUTER_API_KEY: "test-key" },
    });
    expect(provider.name).toBe("openrouter");
    expect(provider.model).toBe("openai/text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);
  });
});
