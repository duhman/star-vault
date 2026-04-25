// Weekly authoritative reconcile (no ETags, full walk).
//
// 1. Starts a sync_runs row with kind='reconcile'.
// 2. Snapshots current repo count.
// 3. Forces a useEtags=false walk of /user/starred, upserting each repo with
//    seen_at = run_id via star_vault.upsert_repos RPC.
// 4. Runs isSafeToReconcile(run). If true, deletes rows whose seen_at != run_id.
// 5. Writes the final counts and safety decision to sync_runs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.47.0";
import { fetchAllStarredRepos } from "../_shared/github.ts";
import { isSafeToReconcile, type SyncRun } from "../_shared/reconcile.ts";
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const githubToken = Deno.env.get("GITHUB_TOKEN")!;
  if (!githubToken) return json({ error: "GITHUB_TOKEN required" }, 500);

  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: STAR_VAULT_SCHEMA },
  });

  const { data: runRow, error: runErr } = await supabase
    .from(SYNC_RUNS_TABLE)
    .insert({ kind: "reconcile", status: "running" })
    .select("id")
    .single();
  if (runErr) return json({ error: runErr.message }, 500);
  const runId = (runRow as { id: number }).id;

  try {
    // Snapshot existing count BEFORE the upsert — this is the denominator
    // for the drop-ratio safety check.
    const { count: existingRepoCount, error: countErr } = await supabase
      .from(REPOS_TABLE)
      .select("*", { count: "exact", head: true });
    if (countErr) throw countErr;

    // Authoritative walk — no ETags.
    const fetchResult = await fetchAllStarredRepos({
      supabase,
      githubToken,
      useEtags: false,
    });

    // Upsert each observed repo with seen_at = runId.
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

    const { error: upsertErr } = await supabase.rpc("upsert_repos", {
      payload,
      run_id: runId,
    });
    if (upsertErr) throw upsertErr;

    const run: SyncRun = {
      id: runId,
      completed_walk: fetchResult.completed_walk,
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      repos_seen: fetchResult.repos.length,
      existing_repo_count: existingRepoCount ?? 0,
    };

    const safetyOk = isSafeToReconcile(run);
    let reposDeleted = 0;
    let reasonSkipped: string | undefined;

    if (safetyOk) {
      // Delete via RPC: PostgREST's .neq() skips NULL rows and the .or()
      // filter has proven fragile against our schema-scoped client.
      // The RPC uses `seen_at IS DISTINCT FROM run_id`, which handles NULL
      // correctly in SQL.
      const { data: deleted, error: delErr } = await supabase.rpc(
        "delete_unseen_repos",
        { run_id: runId },
      );
      if (delErr) throw delErr;
      reposDeleted = Number(deleted ?? 0);
    } else {
      reasonSkipped = describeSkipReason(run);
    }

    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "completed",
        pages_walked: fetchResult.pages_walked,
        pages_304: fetchResult.pages_304,
        repos_seen: fetchResult.repos.length,
        repos_deleted: reposDeleted,
        safety_ok: safetyOk,
        completed_at: new Date().toISOString(),
        metadata: reasonSkipped
          ? {
              reason_skipped: reasonSkipped,
              existing_repo_count: existingRepoCount,
            }
          : { existing_repo_count: existingRepoCount },
      })
      .eq("id", runId);

    return json({
      run_id: runId,
      existing_repo_count: existingRepoCount,
      repos_seen: fetchResult.repos.length,
      repos_deleted: reposDeleted,
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      completed_walk: fetchResult.completed_walk,
      safety_ok: safetyOk,
      reason_skipped: reasonSkipped,
    });
  } catch (error) {
    // Supabase PostgrestError is not an Error instance — has .message,
    // .details, .hint, .code. Preserve whatever shape we got.
    const msg =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error)
          : String(error);
    await supabase
      .from(SYNC_RUNS_TABLE)
      .update({
        status: "failed",
        error_message: msg,
        safety_ok: false,
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

function describeSkipReason(run: SyncRun): string {
  if (!run.completed_walk) return "walk incomplete";
  if (run.pages_304 > 0)
    return `${run.pages_304} × 304 — must force useEtags=false`;
  if (run.repos_seen === 0) return "repos_seen = 0 (would wipe everything)";
  if (run.existing_repo_count > 50) {
    const dropRatio =
      (run.existing_repo_count - run.repos_seen) / run.existing_repo_count;
    if (dropRatio > 0.25) {
      return `drop ratio ${(dropRatio * 100).toFixed(1)}% exceeds 25% guard`;
    }
  }
  return "unknown";
}
