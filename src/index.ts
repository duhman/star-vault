#!/usr/bin/env node
/**
 * Star Vault CLI
 * GitHub starred repos intelligence system
 */

import { config } from "dotenv";
import { getStats, syncStarVault, type SyncOptions } from "./utils/supabase.js";
import { runReconcile } from "./sync/reconcile.js";
import { runVerify } from "./sync/verify.js";

config({ override: true });

interface CliFlags {
  maxPages?: number;
  contentLimit?: number;
  embeddingLimit?: number;
  contentConcurrency?: number;
  embeddingConcurrency?: number;
  embeddingProvider?: string;
  contentStaleDays?: number;
}

function parseNumberFlag(name: string, args: string[]): number | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    const value = Number(inline.split("=")[1]);
    return Number.isFinite(value) ? value : undefined;
  }

  const index = args.indexOf(name);
  if (index >= 0 && index + 1 < args.length) {
    const value = Number(args[index + 1]);
    return Number.isFinite(value) ? value : undefined;
  }

  return undefined;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(3);
  const embeddingProviderInline = args.find((arg) =>
    arg.startsWith("--embedding-provider="),
  );
  const embeddingProviderIndex = args.indexOf("--embedding-provider");
  return {
    maxPages: parseNumberFlag("--max-pages", args),
    contentLimit: parseNumberFlag("--content-limit", args),
    embeddingLimit: parseNumberFlag("--embedding-limit", args),
    contentConcurrency: parseNumberFlag("--concurrency-content", args),
    embeddingConcurrency: parseNumberFlag("--concurrency-embeddings", args),
    embeddingProvider: embeddingProviderInline
      ? embeddingProviderInline.split("=")[1]
      : embeddingProviderIndex >= 0
        ? args[embeddingProviderIndex + 1]
        : undefined,
    contentStaleDays: parseNumberFlag("--content-stale-days", args),
  };
}

function getSyncOptions(base: SyncOptions, flags: CliFlags): SyncOptions {
  return {
    ...base,
    maxPages: flags.maxPages ?? base.maxPages,
    contentLimit: flags.contentLimit ?? base.contentLimit,
    embeddingLimit: flags.embeddingLimit ?? base.embeddingLimit,
    contentConcurrency: flags.contentConcurrency ?? base.contentConcurrency,
    embeddingConcurrency:
      flags.embeddingConcurrency ?? base.embeddingConcurrency,
    embeddingProvider: flags.embeddingProvider ?? base.embeddingProvider,
    contentStaleDays: flags.contentStaleDays ?? base.contentStaleDays,
  };
}

function printSyncDetails(
  result: Awaited<ReturnType<typeof syncStarVault>>,
): void {
  console.log("Durations (ms):", result.phase_durations_ms);
  if (result.errors.length > 0) {
    console.log("Error summary:", result.error_summary);
    console.log(`Errors captured: ${result.errors.length}`);
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }
}

function failIfSyncHadErrors(
  result: Awaited<ReturnType<typeof syncStarVault>>,
): void {
  if (result.errors.length > 0) {
    throw new Error(`Sync completed with ${result.errors.length} error(s)`);
  }
}

async function importStarredRepos(flags: CliFlags): Promise<void> {
  console.log("📦 Syncing starred repositories...\n");
  const result = await syncStarVault(
    getSyncOptions(
      {
        fetchRepos: true,
        contentLimit: 0,
        embeddingLimit: 0,
        syncType: "import",
      },
      flags,
    ),
  );

  console.log(
    `✅ Fetched ${result.repos_fetched} repos (added ${result.repos_added}, updated ${result.repos_updated})\n`,
  );
  printSyncDetails(result);
  failIfSyncHadErrors(result);
}

async function fetchContent(flags: CliFlags): Promise<void> {
  console.log("📖 Fetching README/package.json content...\n");
  const result = await syncStarVault(
    getSyncOptions(
      {
        fetchRepos: false,
        contentLimit: 50,
        embeddingLimit: 0,
        syncType: "content",
      },
      flags,
    ),
  );

  console.log(`✅ Content fetched: ${result.content_fetched}\n`);
  printSyncDetails(result);
  failIfSyncHadErrors(result);
}

async function processEmbeddings(flags: CliFlags): Promise<void> {
  console.log("🧠 Generating embeddings...\n");
  const result = await syncStarVault(
    getSyncOptions(
      {
        fetchRepos: false,
        contentLimit: 0,
        embeddingLimit: 20,
        syncType: "embeddings",
      },
      flags,
    ),
  );

  console.log(`✅ Embeddings generated: ${result.embeddings_generated}\n`);
  printSyncDetails(result);
  failIfSyncHadErrors(result);
}

async function fullSync(flags: CliFlags): Promise<void> {
  console.log("🔄 Running full sync...\n");
  const result = await syncStarVault(
    getSyncOptions(
      {
        fetchRepos: true,
        contentLimit: 50,
        embeddingLimit: 20,
        syncType: "manual",
      },
      flags,
    ),
  );

  console.log(
    `✅ Sync complete (added ${result.repos_added}, updated ${result.repos_updated}, content ${result.content_fetched}, embeddings ${result.embeddings_generated})\n`,
  );
  printSyncDetails(result);
  failIfSyncHadErrors(result);
}

async function reconcile(): Promise<void> {
  console.log("🔍 Running authoritative reconcile (no ETags, full walk)...\n");
  const result = await runReconcile();
  console.log(
    `✅ Run #${result.run_id}: ${result.repos_seen} seen, ${result.existing_repo_count} existing, walked ${result.pages_walked} pages (${result.pages_304} × 304)`,
  );
  if (result.safety_ok) {
    console.log(`   Hard-deleted ${result.repos_deleted} unseen repos.`);
  } else {
    console.log(
      `   DELETE skipped: ${result.reason_skipped ?? "safety gate returned false"}`,
    );
    console.log(
      `   (Implement isSafeToReconcile in src/sync/reconcile.ts to enable deletions.)`,
    );
  }
}

async function verify(): Promise<void> {
  console.log("🩺 Verifying star_vault schema and RPCs...\n");
  const { ok, results } = await runVerify();
  for (const r of results) {
    const mark = r.ok ? "✅" : "❌";
    const detail = r.detail ? `  — ${r.detail}` : "";
    console.log(`  ${mark} ${r.name}${detail}`);
  }
  console.log();
  if (!ok) {
    console.log(
      "Some checks failed. See supabase/migrations/REPAIR.md and apply any missing migrations.",
    );
    process.exit(1);
  }
  console.log("All checks passed.");
}

async function showStats(): Promise<void> {
  const stats = await getStats();

  console.log("\n📊 Star Vault Statistics\n");
  console.log("═".repeat(40));
  console.log(`Total repos:        ${stats.total_repos ?? 0}`);
  console.log(`With embeddings:    ${stats.with_embeddings ?? 0}`);
  console.log(`With README:        ${stats.with_readme ?? 0}`);
  console.log(
    `Top languages:      ${stats.top_languages?.slice(0, 5).join(", ") || "N/A"}`,
  );
  console.log(
    `Last synced:        ${stats.last_sync ? new Date(stats.last_sync).toLocaleString() : "Never"}`,
  );
  console.log("═".repeat(40) + "\n");
}

// CLI command handler
const command = process.argv[2];
const flags = parseFlags();

function runCommand(commandPromise: Promise<void>): void {
  commandPromise.catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

switch (command) {
  case "import":
    runCommand(importStarredRepos(flags));
    break;
  case "fetch-content":
    runCommand(fetchContent(flags));
    break;
  case "embeddings":
    runCommand(processEmbeddings(flags));
    break;
  case "sync":
    runCommand(fullSync(flags));
    break;
  case "stats":
    runCommand(showStats());
    break;
  case "reconcile":
    runCommand(reconcile());
    break;
  case "verify":
    runCommand(verify());
    break;
  default:
    console.log(`
Star Vault CLI - GitHub Starred Repos Intelligence

Usage:
  bun run import         Fetch starred repos from GitHub (ETag-cached)
  bun run fetch-content  Fetch README/package.json content
  bun run embeddings     Generate embeddings
  bun run sync           Run full sync (ETag-cached)
  bun run reconcile      Authoritative walk (no ETags); hard-deletes unstarred
                         repos when isSafeToReconcile() returns true
  bun run verify         Smoke-test DB schema + RPCs (read-only, no API calls)
  bun run stats          Show database statistics

Optional flags:
  --max-pages <n>                Limit GitHub pages read during repo fetch
  --content-limit <n>            Override content batch size
  --embedding-limit <n>          Override embeddings batch size
  --concurrency-content <n>      Content fetch worker concurrency
  --concurrency-embeddings <n>   Deprecated: embeddings are batched
  --embedding-provider <name>    openai (default) or gemini
  --content-stale-days <n>       Refresh content last checked >= n days ago
`);
}
