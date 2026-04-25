// Hourly content-fetch tick. Reads up to CONTENT_BATCH_LIMIT repos lacking
// content_fetched_at, hits the canonical README endpoint, and writes back.
//
// ETag-cached at the repo-README level: rerunning on an unchanged repo
// costs a 304 that doesn't count against the primary rate limit.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";
import {
  CONTENT_BATCH_LIMIT,
  REPOS_TABLE,
  STAR_VAULT_SCHEMA,
  SYNC_RUNS_TABLE,
  ETAGS_TABLE,
} from "../_shared/constants.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const githubToken = Deno.env.get("GITHUB_TOKEN")!;
  if (!githubToken) return json({ error: "GITHUB_TOKEN required" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: STAR_VAULT_SCHEMA },
  });

  const { data: runRow, error: runErr } = await supabase
    .from(SYNC_RUNS_TABLE)
    .insert({ kind: "content", status: "running" })
    .select("id")
    .single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = (runRow as { id: number }).id;

  let contentFetched = 0;
  const errors: string[] = [];

  try {
    const { data: candidates, error: candErr } = await supabase
      .from(REPOS_TABLE)
      .select("github_id, owner, name, default_branch")
      .is("content_fetched_at", null)
      .order("starred_at", { ascending: false })
      .limit(CONTENT_BATCH_LIMIT);
    if (candErr) throw candErr;

    const concurrency = 8;
    const items = (candidates ?? []) as {
      github_id: number;
      owner: string;
      name: string;
      default_branch: string;
    }[];

    // Simple worker-pool for bounded parallelism
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
          const i = idx++;
          if (i >= items.length) break;
          const repo = items[i];
          try {
            const [readme, packageJson] = await Promise.all([
              fetchReadme(supabase, githubToken, repo.owner, repo.name),
              fetchPackageJson(
                githubToken,
                repo.owner,
                repo.name,
                repo.default_branch,
              ),
            ]);

            const patch: Record<string, unknown> = {
              content_fetched_at: new Date().toISOString(),
            };
            if (readme !== null) patch.readme_content = readme;
            if (packageJson !== null) patch.package_json = packageJson;

            const { error: updErr } = await supabase
              .from(REPOS_TABLE)
              .update(patch)
              .eq("github_id", repo.github_id);
            if (updErr) throw updErr;
            contentFetched++;
          } catch (e) {
            errors.push(
              `${repo.owner}/${repo.name}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }),
    );

    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "completed",
        content_fetched: contentFetched,
        completed_at: new Date().toISOString(),
        metadata: errors.length ? { errors: errors.slice(0, 20) } : null,
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      content_fetched: contentFetched,
      errors: errors.length,
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

// deno-lint-ignore no-explicit-any
async function fetchReadme(
  supabase: any,
  token: string,
  owner: string,
  name: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${name}/readme`;
  const { data: cached } = await supabase
    .from(ETAGS_TABLE)
    .select("etag, last_modified")
    .eq("url", url)
    .maybeSingle();

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  if (cached?.last_modified)
    headers["If-Modified-Since"] = cached.last_modified;

  const resp = await fetch(url, { headers });

  const saveCache = (status: number) =>
    supabase.from(ETAGS_TABLE).upsert(
      {
        url,
        etag: resp.headers.get("ETag"),
        last_modified: resp.headers.get("Last-Modified"),
        status,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "url" },
    );

  if (resp.status === 304 || resp.status === 404) {
    await saveCache(resp.status);
    return null;
  }
  if (!resp.ok) return null;

  const content = await resp.text();
  await saveCache(200);
  return content.slice(0, 50000);
}

async function fetchPackageJson(
  token: string,
  owner: string,
  name: string,
  defaultBranch: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${defaultBranch}/package.json`;
    const resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
