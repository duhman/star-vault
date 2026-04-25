// Hourly ETag-cached walk of /user/starred. Upserts new/changed repos and
// tags each row with sync_runs.id. No deletions here — reconcile handles that.
//
// Trigger: pg_cron via pg_net (see supabase/migrations/0018_pg_cron_jobs.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";
import { fetchAllStarredRepos } from "../_shared/github.ts";
import {
  REPOS_TABLE,
  STAR_VAULT_SCHEMA,
  SYNC_RUNS_TABLE,
} from "../_shared/constants.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const useEtags = url.searchParams.get("useEtags") !== "false";

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const githubToken = Deno.env.get("GITHUB_TOKEN")!;
  if (!githubToken) return json({ error: "GITHUB_TOKEN required" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: STAR_VAULT_SCHEMA },
  });

  const { data: runRow, error: runErr } = await supabase
    .from(SYNC_RUNS_TABLE)
    .insert({ kind: "stars", status: "running" })
    .select("id")
    .single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = (runRow as { id: number }).id;

  try {
    const fetchResult = await fetchAllStarredRepos({
      supabase,
      githubToken,
      useEtags,
    });

    const payload = fetchResult.repos.map((r) => ({
      github_id: r.github_id,
      full_name: r.full_name,
      owner: r.owner,
      name: r.name,
      description: r.description,
      topics: r.topics,
      language: r.language,
      stargazers_count: r.stargazers_count,
      forks_count: r.forks_count,
      license: r.license,
      html_url: r.html_url,
      default_branch: r.default_branch,
      starred_at: r.starred_at,
      raw_data: r.raw_data,
    }));

    const { data: upsertRow, error: upsertErr } = await supabase.rpc(
      "upsert_repos",
      { payload, run_id: runId },
    );
    if (upsertErr) throw upsertErr;
    const { added = 0, updated = 0 } =
      (Array.isArray(upsertRow) ? upsertRow[0] : upsertRow) ?? {};

    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "completed",
        pages_walked: fetchResult.pages_walked,
        pages_304: fetchResult.pages_304,
        repos_seen: fetchResult.repos.length,
        completed_at: new Date().toISOString(),
        metadata: { added, updated },
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      repos_seen: fetchResult.repos.length,
      added,
      updated,
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
    // `REPOS_TABLE` import is referenced only to keep the import linter honest
    // if we later add a direct .from(REPOS_TABLE) call; silence unused warning:
    void REPOS_TABLE;
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
