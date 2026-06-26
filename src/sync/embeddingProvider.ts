import OpenAI from "openai";
import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDER_MODELS,
  type EmbeddingProviderName,
} from "../shared/starVault.js";

export interface EmbeddingProvider {
  name: EmbeddingProviderName;
  model: string;
  dimensions: number;
  embed(inputs: string[]): Promise<number[][]>;
}

export interface CreateEmbeddingProviderOptions {
  providerName?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function normalizeEmbeddingProviderName(
  raw: string | null | undefined,
): EmbeddingProviderName {
  const value = (raw ?? DEFAULT_EMBEDDING_PROVIDER).trim().toLowerCase();
  if (value === "openai" || value === "gemini") return value;
  throw new Error(
    `Unsupported EMBEDDING_PROVIDER "${raw}". Use "openai" or "gemini".`,
  );
}

export function getConfiguredEmbeddingProviderName(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProviderName {
  return normalizeEmbeddingProviderName(env.EMBEDDING_PROVIDER);
}

export function getEmbeddingProviderModel(
  providerName: EmbeddingProviderName,
): string {
  return EMBEDDING_PROVIDER_MODELS[providerName];
}

function getRequiredKey(
  env: NodeJS.ProcessEnv,
  names: string[],
  providerName: EmbeddingProviderName,
): string {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  throw new Error(
    `Missing API key for ${providerName} embeddings. Set ${names.join(" or ")}.`,
  );
}

function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

async function embedWithGemini(
  apiKey: string,
  model: string,
  inputs: string[],
): Promise<number[][]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: inputs.map((input) => ({
          model: `models/${model}`,
          content: { parts: [{ text: input }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini embedding API error: ${body.slice(0, 500)}`);
  }

  const body = (await response.json()) as {
    embeddings?: Array<{ values?: number[] }>;
  };
  const embeddings = (body.embeddings ?? []).map((item) => item.values ?? []);
  if (embeddings.length !== inputs.length) {
    throw new Error(
      `Gemini returned ${embeddings.length} vectors for ${inputs.length} inputs`,
    );
  }
  return embeddings.map(normalizeVector);
}

export function createEmbeddingProvider(
  options: CreateEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const env = options.env ?? process.env;
  const name = normalizeEmbeddingProviderName(
    options.providerName ?? env.EMBEDDING_PROVIDER,
  );
  const model = getEmbeddingProviderModel(name);

  if (name === "openai") {
    const apiKey = getRequiredKey(env, ["OPENAI_API_KEY"], name);
    const openai = new OpenAI({
      apiKey,
      maxRetries: 5,
      timeout: 60_000,
    });
    return {
      name,
      model,
      dimensions: EMBEDDING_DIMENSIONS,
      async embed(inputs) {
        const response = await openai.embeddings.create({
          model,
          input: inputs,
          encoding_format: "float",
        });
        return response.data.map((item) => normalizeVector(item.embedding));
      },
    };
  }

  const apiKey = getRequiredKey(env, ["GOOGLE_API_KEY", "GEMINI_API_KEY"], name);
  return {
    name,
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    embed(inputs) {
      return embedWithGemini(apiKey, model, inputs);
    },
  };
}
