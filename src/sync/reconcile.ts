/**
 * Weekly authoritative reconcile: force a full page walk (no ETags), tag
 * every currently-starred repo with sync_run_id, then hard-delete any row
 * whose seen_at doesn't match.
 *
 * The delete step is GATED on isSafeToReconcile(). If that returns false,
 * the run completes but no deletions occur. This is deliberate: the cost of
 * a skipped reconcile is one unstar staying in the DB for a week; the cost
 * of a wrong reconcile is losing embedding data for currently-starred repos.
 */

import { getSupabaseClient } from "../utils/supabase.js";

export interface SyncRun {
  /** sync_runs row id. */
  id: number;
  /** Set by fetchAllStarredRepos: true iff every page returned 200 or 304. */
  completed_walk: boolean;
  /** Total pages this run visited. */
  pages_walked: number;
  /** How many pages returned 304 Not Modified. */
  pages_304: number;
  /** Count of repos observed in this run's /user/starred pass. */
  repos_seen: number;
  /**
   * Count of repos currently in star_vault.repos (before any delete).
   * Snapshot taken by the reconcile orchestrator.
   */
  existing_repo_count: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * LEARNING-MODE DECISION POINT
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Decide when it is SAFE to hard-delete rows whose seen_at !== run.id.
 *
 * Return TRUE  → orchestrator proceeds with DELETE WHERE seen_at != run.id.
 * Return FALSE → orchestrator completes the run WITHOUT deleting anything
 *                (still useful: it refreshes starred_at, seen_at, etc.).
 *
 * Reasonable invariants to encode (pick your risk tolerance):
 *   (a) `run.completed_walk === true`
 *       — obvious baseline: don't delete if the walk was incomplete.
 *
 *   (b) `run.pages_304 === 0`
 *       — reconcile MUST use `useEtags: false`. If any page returned 304,
 *         we lack fresh page contents and can't trust seen_at.
 *
 *   (c) `run.repos_seen > 0`
 *       — a zero-repo response from GitHub should never wipe everything.
 *
 *   (d) Drop ratio guard: reject if `(existing - seen) / existing > X`
 *       — protects against a transient partial GitHub response that would
 *         otherwise delete ~all rows. Reasonable X: 0.10 (10%).
 *       — only applies when existing_repo_count is non-trivial
 *         (e.g. > 50), otherwise small collections trip it constantly.
 *
 * Your call: write the invariants. Keep it to ~5-10 lines. Be explicit
 * about which you chose and why — this is the blast-radius gate.
 */
export function isSafeToReconcile(run: SyncRun): boolean {
  // MODERATE policy — tolerates bulk-unstarring sessions (e.g. cleaning up
  // an old account) up to 25% of the vault in a single run, while still
  // refusing a delete when the API clearly misbehaved.
  //
  // All invariants must hold. Any FALSE refuses the delete; the walk still
  // succeeds (starred_at/seen_at are updated), only the DELETE is skipped
  // and logged in sync_runs.metadata.reason_skipped.
  if (!run.completed_walk) return false; // partial walk → untrusted seen_at
  if (run.pages_304 > 0) return false; // reconcile must force no-ETag
  if (run.repos_seen === 0) return false; // API blip must never wipe everything
  if (run.existing_repo_count > 50) {
    // skip ratio check on tiny vaults
    const dropRatio =
      (run.existing_repo_count - run.repos_seen) / run.existing_repo_count;
    if (dropRatio > 0.25) return false; // >25% drop = investigate by hand
  }
  return true;
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestration below this line — usually no need to edit.
// ───────────────────────────────────────────────────────────────────────────

export async function startSyncRun(
  kind: "stars" | "content" | "embeddings" | "reconcile" | "full",
): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("sync_runs")
    .insert({ kind, status: "running" })
    .select("id")
    .single();

  if (error) throw error;
  return (data as { id: number }).id;
}

export async function completeSyncRun(
  id: number,
  patch: {
    status: "completed" | "failed";
    pages_walked?: number;
    pages_304?: number;
    repos_seen?: number;
    repos_deleted?: number;
    content_fetched?: number;
    embeddings_generated?: number;
    safety_ok?: boolean;
    error_message?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("sync_runs")
    .update({ ...patch, completed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw error;
}

export async function countRepos(): Promise<number> {
  const supabase = getSupabaseClient();
  const { count, error } = await supabase
    .from("repos")
    .select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

/**
 * Delete any repo whose seen_at does not match this run's id.
 * Returns the number of rows deleted.
 *
 * Implemented as an RPC (star_vault.delete_unseen_repos) that uses
 * `seen_at IS DISTINCT FROM run_id` — the NULL-safe SQL operator that
 * treats NULL as a distinguishable value. This sidesteps two PostgREST
 * pitfalls: .neq() silently skipping NULL rows, and .or() filter-string
 * parsing being fragile against schema-scoped clients.
 */
export async function deleteUnseenRepos(runId: number): Promise<number> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc("delete_unseen_repos", {
    run_id: runId,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

export interface ReconcileResult {
  run_id: number;
  repos_seen: number;
  repos_deleted: number;
  existing_repo_count: number;
  pages_walked: number;
  pages_304: number;
  completed_walk: boolean;
  safety_ok: boolean;
  reason_skipped?: string;
}

/**
 * Full authoritative reconcile: force-walks every page (no ETags), tags each
 * observed repo with this run's id, and hard-deletes unseen rows IF the
 * safety gate allows.
 */
export async function runReconcile(): Promise<ReconcileResult> {
  // Lazy imports to avoid a circular import with src/utils/supabase.ts.
  const { fetchAllStarredRepos } = await import("../github/starred.js");
  const { upsertRepos } = await import("../utils/supabase.js");

  const runId = await startSyncRun("reconcile");
  const existingRepoCount = await countRepos();
  let reposDeleted = 0;
  let safetyOk = false;
  let reasonSkipped: string | undefined;

  try {
    const fetchResult = await fetchAllStarredRepos({ useEtags: false });

    // Re-normalize and upsert with seen_at = runId.
    const repos = fetchResult.repos.map((r) => ({
      github_id: r.github_id,
      full_name: r.full_name,
      owner: r.owner,
      name: r.name,
      description: r.description ?? undefined,
      topics: r.topics,
      language: r.language ?? undefined,
      stargazers_count: r.stargazers_count,
      forks_count: r.forks_count,
      license: r.license ?? undefined,
      html_url: r.html_url,
      default_branch: r.default_branch,
      starred_at: r.starred_at?.toISOString(),
      raw_data: r.raw_data as Record<string, unknown>,
    }));
    await upsertRepos(repos, runId);

    const run: SyncRun = {
      id: runId,
      completed_walk: fetchResult.completed_walk,
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      repos_seen: fetchResult.repos.length,
      existing_repo_count: existingRepoCount,
    };

    safetyOk = isSafeToReconcile(run);

    if (safetyOk) {
      reposDeleted = await deleteUnseenRepos(runId);
    } else {
      reasonSkipped = "isSafeToReconcile returned false";
    }

    await completeSyncRun(runId, {
      status: "completed",
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      repos_seen: fetchResult.repos.length,
      repos_deleted: reposDeleted,
      safety_ok: safetyOk,
      metadata: reasonSkipped ? { reason_skipped: reasonSkipped } : undefined,
    });

    return {
      run_id: runId,
      repos_seen: fetchResult.repos.length,
      repos_deleted: reposDeleted,
      existing_repo_count: existingRepoCount,
      pages_walked: fetchResult.pages_walked,
      pages_304: fetchResult.pages_304,
      completed_walk: fetchResult.completed_walk,
      safety_ok: safetyOk,
      reason_skipped: reasonSkipped,
    };
  } catch (error) {
    await completeSyncRun(runId, {
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
      safety_ok: false,
    });
    throw error;
  }
}
