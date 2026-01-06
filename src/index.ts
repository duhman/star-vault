#!/usr/bin/env node
/**
 * Star Vault CLI
 * GitHub starred repos intelligence system
 */

import { config } from "dotenv";
config({ override: true }); // Override shell env vars with .env values
import { fetchAllStarredRepos } from "./github/starred.js";
import { getGitHubClient } from "./github/client.js";
import { fetchReadme, fetchPackageJson } from "./github/content.js";
import {
  upsertRepos,
  getReposNeedingContent,
  getReposNeedingEmbeddings,
  updateRepoContent,
  updateRepoEmbedding,
  recordSyncState,
} from "./process/repos.js";
import { generateRepoEmbedding } from "./process/embeddings.js";
import pLimit from "p-limit";

async function importStarredRepos(): Promise<void> {
  console.log("📦 Fetching starred repositories...\n");

  const client = getGitHubClient();
  const rateLimit = await client.getRateLimit();
  console.log(
    `Rate limit: ${rateLimit.remaining}/${rateLimit.limit} (resets ${rateLimit.reset.toLocaleTimeString()})\n`,
  );

  const repos = await fetchAllStarredRepos({
    onProgress: (fetched) => {
      process.stdout.write(`\r   Fetched: ${fetched} repos`);
    },
  });
  console.log(`\n\n✅ Fetched ${repos.length} starred repositories\n`);

  console.log("💾 Storing in database...");
  const { added, updated } = await upsertRepos(repos);
  console.log(`   Added: ${added}, Updated: ${updated}\n`);

  await recordSyncState({
    repos_added: added,
    repos_updated: updated,
    sync_type: "import",
    metadata: { total_repos: repos.length },
  });
  console.log("✅ Import complete!\n");
}

async function fetchContent(): Promise<void> {
  console.log("📖 Fetching README and package.json for repos...\n");

  // Fetch in batches
  let totalProcessed = 0;
  let totalErrors = 0;

  while (true) {
    const repos = await getReposNeedingContent(50);

    if (repos.length === 0) {
      break;
    }

    console.log(`   Batch: ${repos.length} repos to process`);

    const limit = pLimit(5); // 5 concurrent requests

    const tasks = repos.map((repo) =>
      limit(async () => {
        try {
          const [readme, packageJson] = await Promise.all([
            fetchReadme(repo.owner, repo.name, repo.default_branch),
            fetchPackageJson(repo.owner, repo.name, repo.default_branch),
          ]);

          await updateRepoContent(repo.id, readme, packageJson);
          totalProcessed++;

          if (totalProcessed % 25 === 0) {
            console.log(`   Progress: ${totalProcessed} processed`);
          }
        } catch (error) {
          totalErrors++;
          console.error(
            `   ⚠️  Error fetching content for ${repo.full_name}: ${error}`,
          );
        }
      }),
    );

    await Promise.all(tasks);
  }

  if (totalProcessed === 0 && totalErrors === 0) {
    console.log("✅ All repos already have content fetched!\n");
  } else {
    await recordSyncState({
      content_fetched: totalProcessed,
      sync_type: "content",
    });
    console.log(
      `\n✅ Content fetch complete! Processed: ${totalProcessed}, Errors: ${totalErrors}\n`,
    );
  }
}

async function processEmbeddings(): Promise<void> {
  console.log("🧠 Generating embeddings for repos...\n");

  // Fetch in batches
  let totalProcessed = 0;
  let totalErrors = 0;

  while (true) {
    const repos = await getReposNeedingEmbeddings(20);

    if (repos.length === 0) {
      break;
    }

    console.log(`   Batch: ${repos.length} repos to process`);

    const limit = pLimit(10); // 10 concurrent embedding requests

    const tasks = repos.map((repo) =>
      limit(async () => {
        try {
          const embedding = await generateRepoEmbedding(repo);
          await updateRepoEmbedding(repo.id, embedding);
          totalProcessed++;

          if (totalProcessed % 10 === 0) {
            console.log(`   Progress: ${totalProcessed} processed`);
          }
        } catch (error) {
          totalErrors++;
          console.error(
            `   ⚠️  Error generating embedding for ${repo.full_name}: ${error}`,
          );
        }
      }),
    );

    await Promise.all(tasks);
  }

  if (totalProcessed === 0 && totalErrors === 0) {
    console.log("✅ All repos already have embeddings!\n");
  } else {
    await recordSyncState({
      embeddings_generated: totalProcessed,
      sync_type: "embeddings",
    });
    console.log(
      `\n✅ Embedding generation complete! Processed: ${totalProcessed}, Errors: ${totalErrors}\n`,
    );
  }
}

async function fullSync(): Promise<void> {
  console.log("🔄 Running full sync...\n");
  console.log("═".repeat(50));

  await importStarredRepos();
  console.log("─".repeat(50));

  await fetchContent();
  console.log("─".repeat(50));

  await processEmbeddings();
  console.log("═".repeat(50));

  console.log("\n🎉 Full sync complete!\n");
}

async function showStats(): Promise<void> {
  const { supabase } = await import("./utils/supabase.js");

  // Get repo counts
  const { count: totalRepos } = await supabase
    .from("sv_repos")
    .select("*", { count: "exact", head: true });

  const { count: withEmbeddings } = await supabase
    .from("sv_repos")
    .select("*", { count: "exact", head: true })
    .not("embedding", "is", null);

  const { count: withReadme } = await supabase
    .from("sv_repos")
    .select("*", { count: "exact", head: true })
    .not("readme_content", "is", null);

  // Get top languages
  const { data: langs } = await supabase
    .from("sv_repos")
    .select("language")
    .not("language", "is", null);

  const langCounts: Record<string, number> = {};
  for (const row of langs || []) {
    if (row.language) {
      langCounts[row.language] = (langCounts[row.language] || 0) + 1;
    }
  }
  const topLanguages = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang, count]) => `${lang} (${count})`);

  // Get last sync
  const { data: lastSync } = await supabase
    .from("sv_sync_state")
    .select("last_sync_at")
    .order("last_sync_at", { ascending: false })
    .limit(1)
    .single();

  console.log("\n📊 Star Vault Statistics\n");
  console.log("═".repeat(40));
  console.log(`Total repos:        ${totalRepos ?? 0}`);
  console.log(`With embeddings:    ${withEmbeddings ?? 0}`);
  console.log(`With README:        ${withReadme ?? 0}`);
  console.log(`Top languages:      ${topLanguages.join(", ") || "N/A"}`);
  console.log(
    `Last synced:        ${lastSync?.last_sync_at ? new Date(lastSync.last_sync_at).toLocaleString() : "Never"}`,
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
  npm run import         Fetch and store starred repos from GitHub
  npm run fetch-content  Fetch README and package.json for all repos
  npm run embeddings     Generate embeddings for all repos
  npm run sync           Run full sync (import + content + embeddings)
  npm run stats          Show database statistics
`);
}
