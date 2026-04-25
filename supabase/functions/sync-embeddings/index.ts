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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
  if (!openaiKey) return json({ error: "OPENAI_API_KEY required" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: STAR_VAULT_SCHEMA },
  });
  const openai = new OpenAI({
    apiKey: openaiKey,
    maxRetries: 5,
    timeout: 60_000,
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
      const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch.map((w) => w.input),
        encoding_format: "float",
      });
      batches++;

      if (response.data.length !== batch.length) {
        throw new Error(
          `Embedding API returned ${response.data.length} vectors for ${batch.length} inputs`,
        );
      }

      await Promise.all(
        batch.map(async (w, idx) => {
          const embedding = response.data[idx].embedding;
          if (embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(`Unexpected embedding dim ${embedding.length}`);
          }
          const { error: updErr } = await supabase
            .from(REPOS_TABLE)
            .update({
              embedding,
              embedding_input_hash: w.hash,
              embedding_model: EMBEDDING_MODEL,
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
        metadata: { batches, skipped_unchanged: skippedUnchanged },
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      scanned: candidates.length,
      skipped_unchanged: skippedUnchanged,
      embeddings_generated: generated,
      batches,
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
