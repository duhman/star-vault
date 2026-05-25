// Hourly batched embeddings tick. Reads up to EMBEDDING_BATCH_LIMIT repos
// whose content is fetched but embedding is missing or whose
// embedding_input_hash has drifted. One OpenAI API call per batch (~96 inputs).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";
import OpenAI from "https://esm.sh/openai@4.104.0";
import {
  EMBEDDING_BATCH_LIMIT,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  GEMINI_EMBEDDING_MODEL,
  REPOS_TABLE,
  STAR_VAULT_SCHEMA,
  SYNC_RUNS_TABLE,
} from "../_shared/constants.ts";
import {
  buildEmbeddingInput,
  sha256Hex,
  type RepoInput,
} from "../_shared/embedding-input.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type EmbeddingProvider = {
  name: string;
  model: string;
  embed(inputs: string[]): Promise<number[][]>;
};

function createEmbeddingProvider(openaiKey: string | null, geminiKey: string | null): EmbeddingProvider | null {
  if (geminiKey) {
    return {
      name: "gemini",
      model: GEMINI_EMBEDDING_MODEL,
      async embed(inputs: string[]) {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              requests: inputs.map((input) => ({
                model: `models/${GEMINI_EMBEDDING_MODEL}`,
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
        const body = await response.json();
        const embeddings = (body.embeddings ?? []).map((item: { values?: number[] }) => item.values ?? []);
        if (embeddings.length !== inputs.length) {
          throw new Error(`Gemini returned ${embeddings.length} vectors for ${inputs.length} inputs`);
        }
        return embeddings;
      },
    };
  }

  if (openaiKey) {
    const openai = new OpenAI({
      apiKey: openaiKey,
      maxRetries: 5,
      timeout: 60_000,
    });
    return {
      name: "openai",
      model: EMBEDDING_MODEL,
      async embed(inputs: string[]) {
        const response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: inputs,
          encoding_format: "float",
        });
        return response.data.map((item) => item.embedding);
      },
    };
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY") || null;
  const geminiKey = Deno.env.get("GOOGLE_API_KEY") || Deno.env.get("GEMINI_API_KEY") || null;
  const embeddingProvider = createEmbeddingProvider(openaiKey, geminiKey);
  if (!embeddingProvider) return json({ error: "OPENAI_API_KEY or GOOGLE_API_KEY/GEMINI_API_KEY required" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: STAR_VAULT_SCHEMA },
  });

  const { data: runRow, error: runErr } = await supabase
    .from(SYNC_RUNS_TABLE)
    .insert({ kind: "embeddings", status: "running" })
    .select("id")
    .single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = (runRow as { id: number }).id;

  try {
    const { data, error } = await supabase
      .from(REPOS_TABLE)
      .select(
        "github_id, full_name, description, language, topics, license, stargazers_count, forks_count, readme_content, package_json, embedding, embedding_input_hash",
      )
      .not("content_fetched_at", "is", null)
      .or("embedding.is.null,embedding_input_hash.is.null")
      .order("starred_at", { ascending: false })
      .limit(EMBEDDING_BATCH_LIMIT);
    if (error) throw error;

    const candidates = (data ?? []) as (RepoInput & {
      github_id: number;
      embedding: number[] | null;
      embedding_input_hash: string | null;
    })[];

    let skippedUnchanged = 0;
    const work: { githubId: number; input: string; hash: string }[] = [];
    for (const repo of candidates) {
      const input = buildEmbeddingInput(repo);
      const hash = await sha256Hex(input);
      if (repo.embedding_input_hash === hash && repo.embedding) {
        skippedUnchanged++;
        continue;
      }
      work.push({ githubId: repo.github_id, input, hash });
    }

    let generated = 0;
    let batches = 0;
    for (let i = 0; i < work.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = work.slice(i, i + EMBEDDING_BATCH_SIZE);
      const embeddings = await embeddingProvider.embed(batch.map((w) => w.input));
      batches++;

      if (embeddings.length !== batch.length) {
        throw new Error(
          `Embedding provider returned ${embeddings.length} vectors for ${batch.length} inputs`,
        );
      }

      await Promise.all(
        batch.map(async (w, idx) => {
          const embedding = embeddings[idx];
          if (embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(`Unexpected embedding dim ${embedding.length}`);
          }
          const { error: updErr } = await supabase
            .from(REPOS_TABLE)
            .update({
              embedding,
              embedding_input_hash: w.hash,
              embedding_model: embeddingProvider.model,
              embedding_dim: EMBEDDING_DIMENSIONS,
            })
            .eq("github_id", w.githubId);
          if (updErr) throw updErr;
          generated++;
        }),
      );
    }

    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "completed",
        embeddings_generated: generated,
        completed_at: new Date().toISOString(),
        metadata: { batches, skipped_unchanged: skippedUnchanged, embedding_provider: embeddingProvider.name },
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      scanned: candidates.length,
      skipped_unchanged: skippedUnchanged,
      embeddings_generated: generated,
      batches,
      embedding_provider: embeddingProvider.name,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "failed",
        error_message: msg,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return json({ run_id: runId, error: msg }, 500);
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
