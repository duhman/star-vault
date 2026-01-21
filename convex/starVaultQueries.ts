import { action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { embedTexts } from "./lib/embeddings";

const DEFAULT_MODEL = "text-embedding-3-small";

type RepoDoc = Doc<"sv_repos">;

function isRepoDoc(doc: RepoDoc | null): doc is RepoDoc {
  return doc !== null;
}

export const searchRepos = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    language: v.optional(v.string()),
    min_stars: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const model = process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_MODEL;
    const limit = args.limit ?? 10;
    const [vector] = await embedTexts([args.query], model);

    const candidates = await ctx.vectorSearch("sv_repos", "by_embedding", {
      vector,
      limit: Math.min(256, limit * 5),
    });

    const ids = candidates.map((match) => match._id);
    const docs = await ctx.runQuery(internal.starVaultInternal.getReposByIds, {
      ids,
    });
    const docMap = new Map(docs.filter(isRepoDoc).map((doc) => [doc._id, doc]));

    const repos = [] as Array<{
      repo: RepoDoc;
      score: number;
    }>;

    for (const match of candidates) {
      const repo = docMap.get(match._id as Id<"sv_repos">);
      if (!repo) continue;
      if (
        args.language &&
        repo.language?.toLowerCase() !== args.language.toLowerCase()
      ) {
        continue;
      }
      if (args.min_stars && (repo.stargazers_count ?? 0) < args.min_stars) {
        continue;
      }
      repos.push({ repo, score: match._score });
    }

    return repos.slice(0, limit);
  },
});

export const getRepoDetails = query({
  args: {
    full_name: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<(RepoDoc & { dependencies: string[] }) | null> => {
    const repo = await ctx.runQuery(
      internal.starVaultInternal.getRepoByFullName,
      {
        full_name: args.full_name,
      },
    );

    if (!repo) return null;

    const packageJson = repo.package_json as
      | Record<string, unknown>
      | undefined;
    const dependencies = packageJson
      ? [
          ...Object.keys((packageJson as any).dependencies || {}),
          ...Object.keys((packageJson as any).devDependencies || {}),
        ]
      : [];

    return {
      ...repo,
      dependencies,
    };
  },
});

export const getStats = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    total_repos: number;
    with_embeddings: number;
    with_readme: number;
    top_languages: string[];
    last_sync: string | null;
  }> => {
    // Only iterate repos WITHOUT embeddings (they don't have large embedding arrays)
    // Count repos with embeddings separately without loading their data
    let withoutEmbeddings = 0;
    let withReadmeFromNonEmbedded = 0;
    const languageCounts = new Map<string, number>();

    // Count and collect stats from repos without embeddings (lightweight - no embedding arrays)
    for await (const repo of ctx.db
      .query("sv_repos")
      .withIndex("by_has_embedding", (q) => q.eq("has_embedding", undefined))) {
      withoutEmbeddings++;
      if (repo.content_fetched_at) withReadmeFromNonEmbedded++;
      if (repo.language) {
        languageCounts.set(
          repo.language,
          (languageCounts.get(repo.language) ?? 0) + 1,
        );
      }
    }

    // For repos with embeddings, we can't iterate them (too large)
    // Use the last sync state to estimate counts, or use a separate count query
    const lastSync = await ctx.db.query("sv_sync_state").order("desc").first();

    // Calculate from sync history - sum all embeddings_generated
    let totalEmbeddings = 0;
    for await (const sync of ctx.db.query("sv_sync_state")) {
      totalEmbeddings += sync.embeddings_generated ?? 0;
    }

    // Total repos = repos without embeddings + repos with embeddings
    // We estimate repos with embeddings from sync history
    const total = withoutEmbeddings + totalEmbeddings;

    // Repos with content = all with embeddings (they must have content) + those without that have content
    const withReadme = totalEmbeddings + withReadmeFromNonEmbedded;

    // Top languages - we only have stats from non-embedded repos
    // This is approximate but avoids the memory issue
    const topLanguages = [...languageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([lang]) => lang);

    return {
      total_repos: total,
      with_embeddings: totalEmbeddings,
      with_readme: withReadme,
      top_languages: topLanguages,
      last_sync: lastSync?.last_sync_at ?? null,
    };
  },
});

export const listByLanguage = query({
  args: {
    language: v.string(),
    limit: v.optional(v.number()),
    sort_by: v.optional(
      v.union(v.literal("stars"), v.literal("forks"), v.literal("starred_at")),
    ),
  },
  handler: async (ctx, args): Promise<RepoDoc[]> => {
    const limit = args.limit ?? 20;
    const sortBy = args.sort_by ?? "stars";
    const language = args.language.toLowerCase();

    const repos = await ctx.db.query("sv_repos").collect();
    const filtered = repos.filter(
      (repo) => repo.language?.toLowerCase() === language,
    );

    filtered.sort((a, b) => {
      if (sortBy === "forks") {
        return (b.forks_count ?? 0) - (a.forks_count ?? 0);
      }
      if (sortBy === "starred_at") {
        return String(b.starred_at ?? "").localeCompare(
          String(a.starred_at ?? ""),
        );
      }
      return (b.stargazers_count ?? 0) - (a.stargazers_count ?? 0);
    });

    return filtered.slice(0, limit);
  },
});

export const findSimilar = action({
  args: {
    full_name: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ repo: RepoDoc; score: number }>> => {
    const limit = args.limit ?? 5;
    const repo = await ctx.runQuery(
      internal.starVaultInternal.getRepoByFullName,
      {
        full_name: args.full_name,
      },
    );

    if (!repo?.embedding) {
      return [];
    }

    const candidates = await ctx.vectorSearch("sv_repos", "by_embedding", {
      vector: repo.embedding,
      limit: Math.min(256, limit + 5),
    });

    const ids = candidates.map((match) => match._id);
    const docs = await ctx.runQuery(internal.starVaultInternal.getReposByIds, {
      ids,
    });
    const docMap = new Map(docs.filter(isRepoDoc).map((doc) => [doc._id, doc]));

    const results = [] as Array<{ repo: RepoDoc; score: number }>;
    for (const match of candidates) {
      const candidate = docMap.get(match._id as Id<"sv_repos">);
      if (!candidate) continue;
      if (candidate.full_name === args.full_name) continue;
      results.push({ repo: candidate, score: match._score });
    }

    return results.slice(0, limit);
  },
});
