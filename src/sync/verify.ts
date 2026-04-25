/**
 * Post-migration healthcheck.
 *
 * Runs a set of read-only probes against Supabase to confirm the schema is
 * the shape the TypeScript code expects. Use after `supabase db push` or
 * when cloning the project to a fresh database.
 *
 * Every check is IDEMPOTENT and READ-ONLY. The only "writes" are to
 * sync_runs via an intentional insert-then-delete round-trip for the
 * insertability probe.
 *
 * Exit code: 0 if every check passes, 1 otherwise.
 */

import {
  EMBEDDING_DIMENSIONS,
  STAR_VAULT_RPC,
  STAR_VAULT_TABLES,
} from "../shared/starVault.js";
import { getSupabaseClient } from "../utils/supabase.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function check(
  name: string,
  fn: () => Promise<string | undefined>,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return { name, ok: true, detail };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runVerify(): Promise<{
  ok: boolean;
  results: CheckResult[];
}> {
  const supabase = getSupabaseClient();
  const results: CheckResult[] = [];

  // 1. repos table reachable (and thus schema exists + RLS grants correct)
  results.push(
    await check("repos table reachable", async () => {
      const { error, count } = await supabase
        .from(STAR_VAULT_TABLES.repos)
        .select("*", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return `${count ?? 0} rows`;
    }),
  );

  // 2. sync_state table reachable
  results.push(
    await check("sync_state table reachable", async () => {
      const { error } = await supabase
        .from(STAR_VAULT_TABLES.syncState)
        .select("id", { head: true });
      if (error) throw new Error(error.message);
      return undefined;
    }),
  );

  // 3. NEW tables from 0015
  results.push(
    await check("sync_runs table reachable (0015)", async () => {
      const { error } = await supabase
        .from("sync_runs")
        .select("id", { head: true });
      if (error) throw new Error(error.message);
      return undefined;
    }),
  );
  results.push(
    await check("github_etags table reachable (0015)", async () => {
      const { error } = await supabase
        .from("github_etags")
        .select("url", { head: true });
      if (error) throw new Error(error.message);
      return undefined;
    }),
  );

  // 4. new repos columns from 0015
  results.push(
    await check(
      "repos.seen_at + embedding_input_hash exist (0015)",
      async () => {
        const { error } = await supabase
          .from(STAR_VAULT_TABLES.repos)
          .select(
            "seen_at, embedding_input_hash, embedding_model, embedding_dim",
          )
          .limit(1);
        if (error) throw new Error(error.message);
        return undefined;
      },
    ),
  );

  // 5. search_repos RPC with the new IP-ops shape (0016)
  results.push(
    await check("search_repos RPC executable (0016)", async () => {
      const zero = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
      const { error } = await supabase.rpc(STAR_VAULT_RPC.searchRepos, {
        query_embedding: JSON.stringify(zero),
        match_threshold: 2, // guarantees 0 results
        match_count: 1,
      });
      if (error) throw new Error(error.message);
      return undefined;
    }),
  );

  // 6. upsert_repos RPC with empty payload (0017) — should return (0, 0).
  results.push(
    await check("upsert_repos RPC executable (0017)", async () => {
      const { data, error } = await supabase.rpc("upsert_repos", {
        payload: [],
        run_id: null,
      });
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      const added = Number(row?.added ?? -1);
      const updated = Number(row?.updated ?? -1);
      if (added !== 0 || updated !== 0) {
        throw new Error(`expected (0,0), got (${added},${updated})`);
      }
      return "returned (0, 0)";
    }),
  );

  // 7. sync_runs is writable (probes RLS + grants + schema)
  results.push(
    await check("sync_runs insert round-trip", async () => {
      const insert = await supabase
        .from("sync_runs")
        .insert({ kind: "full", status: "running" })
        .select("id")
        .single();
      if (insert.error) throw new Error(insert.error.message);
      const id = (insert.data as { id: number }).id;
      const del = await supabase.from("sync_runs").delete().eq("id", id);
      if (del.error)
        throw new Error(`insert ok, delete failed: ${del.error.message}`);
      return `ok (used throwaway id ${id})`;
    }),
  );

  const ok = results.every((r) => r.ok);
  return { ok, results };
}
