#!/usr/bin/env node
/**
 * Star Vault CLI
 * GitHub starred repos intelligence system
 */

import { config } from "dotenv";
import {
  getStats,
  syncStarVault,
  type SyncOptions,
} from "./utils/supabase.js";

config({ override: true });

interface CliFlags {
  maxPages?: number;
  contentLimit?: number;
  embeddingLimit?: number;
  contentConcurrency?: number;
  embeddingConcurrency?: number;
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
  return {
    maxPages: parseNumberFlag("--max-pages", args),
    contentLimit: parseNumberFlag("--content-limit", args),
    embeddingLimit: parseNumberFlag("--embedding-limit", args),
    contentConcurrency: parseNumberFlag("--concurrency-content", args),
    embeddingConcurrency: parseNumberFlag("--concurrency-embeddings", args),
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
  };
}

function printSyncDetails(result: Awaited<ReturnType<typeof syncStarVault>>): void {
  console.log("Durations (ms):", result.phase_durations_ms);
  if (result.errors.length > 0) {
    console.log("Error summary:", result.error_summary);
    console.log(`Errors captured: ${result.errors.length}`);
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

switch (command) {
  case "import":
    importStarredRepos(flags).catch(console.error);
    break;
  case "fetch-content":
    fetchContent(flags).catch(console.error);
    break;
  case "embeddings":
    processEmbeddings(flags).catch(console.error);
    break;
  case "sync":
    fullSync(flags).catch(console.error);
    break;
  case "stats":
    showStats().catch(console.error);
    break;
  default:
    console.log(`
Star Vault CLI - GitHub Starred Repos Intelligence

Usage:
  bun run import         Fetch starred repos from GitHub
  bun run fetch-content  Fetch README/package.json content
  bun run embeddings     Generate embeddings
  bun run sync           Run full sync
  bun run stats          Show database statistics

Optional flags:
  --max-pages <n>                Limit GitHub pages read during repo fetch
  --content-limit <n>            Override content batch size
  --embedding-limit <n>          Override embeddings batch size
  --concurrency-content <n>      Content fetch worker concurrency
  --concurrency-embeddings <n>   Embeddings worker concurrency
`);
}
