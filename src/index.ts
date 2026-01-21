#!/usr/bin/env node
/**
 * Star Vault CLI
 * GitHub starred repos intelligence system
 */

import { config } from "dotenv";
import { getStats, syncStarVault } from "./utils/supabase.js";

config({ override: true });

async function importStarredRepos(): Promise<void> {
  console.log("📦 Syncing starred repositories...\n");
  const result = await syncStarVault({
    fetchRepos: true,
    contentLimit: 0,
    embeddingLimit: 0,
    syncType: "import",
  });

  console.log(
    `✅ Fetched ${result.repos_fetched} repos (added ${result.repos_added}, updated ${result.repos_updated})\n`,
  );
}

async function fetchContent(): Promise<void> {
  console.log("📖 Fetching README/package.json content...\n");
  const result = await syncStarVault({
    fetchRepos: false,
    contentLimit: 50,
    embeddingLimit: 0,
    syncType: "content",
  });

  console.log(`✅ Content fetched: ${result.content_fetched}\n`);
}

async function processEmbeddings(): Promise<void> {
  console.log("🧠 Generating embeddings...\n");
  const result = await syncStarVault({
    fetchRepos: false,
    contentLimit: 0,
    embeddingLimit: 20,
    syncType: "embeddings",
  });

  console.log(`✅ Embeddings generated: ${result.embeddings_generated}\n`);
}

async function fullSync(): Promise<void> {
  console.log("🔄 Running full sync...\n");
  const result = await syncStarVault({
    fetchRepos: true,
    contentLimit: 50,
    embeddingLimit: 20,
    syncType: "manual",
  });

  console.log(
    `✅ Sync complete (added ${result.repos_added}, updated ${result.repos_updated}, content ${result.content_fetched}, embeddings ${result.embeddings_generated})\n`,
  );
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

switch (command) {
  case "import":
    importStarredRepos().catch(console.error);
    break;
  case "fetch-content":
    fetchContent().catch(console.error);
    break;
  case "embeddings":
    processEmbeddings().catch(console.error);
    break;
  case "sync":
    fullSync().catch(console.error);
    break;
  case "stats":
    showStats().catch(console.error);
    break;
  default:
    console.log(`
Star Vault CLI - GitHub Starred Repos Intelligence

Usage:
  npm run import         Fetch starred repos from GitHub
  npm run fetch-content  Fetch README/package.json content
  npm run embeddings     Generate embeddings
  npm run sync           Run full sync
  npm run stats          Show database statistics
`);
}
