// Deno mirror of src/sync/reconcile.ts's isSafeToReconcile.
//
// MUST be kept byte-identical in behavior to the Node implementation.
// A parity test (tests/reconcile-safety-parity.test.ts) runs both against
// the same fixture runs and asserts matching decisions on every one.
//
// If you change the policy, change it in BOTH files and update the fixtures.

export interface SyncRun {
  id: number;
  completed_walk: boolean;
  pages_walked: number;
  pages_304: number;
  repos_seen: number;
  existing_repo_count: number;
}

export function isSafeToReconcile(run: SyncRun): boolean {
  // MODERATE policy — tolerates bulk-unstarring sessions up to 25% of the
  // vault in a single run while still refusing a delete when the API
  // clearly misbehaved.
  if (!run.completed_walk) return false;
  if (run.pages_304 > 0) return false;
  if (run.repos_seen === 0) return false;
  if (run.existing_repo_count > 50) {
    const dropRatio =
      (run.existing_repo_count - run.repos_seen) / run.existing_repo_count;
    if (dropRatio > 0.25) return false;
  }
  return true;
}
