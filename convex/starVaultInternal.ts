import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

export const upsertRepo = internalMutation({
  args: {
    repo: v.object({
      id: v.string(),
      github_id: v.string(),
      full_name: v.string(),
      owner: v.string(),
      name: v.string(),
      description: v.optional(v.string()),
      topics: v.array(v.string()),
      language: v.optional(v.string()),
      stargazers_count: v.optional(v.number()),
      forks_count: v.optional(v.number()),
      license: v.optional(v.string()),
      html_url: v.string(),
      default_branch: v.optional(v.string()),
      starred_at: v.optional(v.string()),
      raw_data: v.optional(v.any()),
      fetched_at: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sv_repos")
      .withIndex("by_github_id", (q) => q.eq("github_id", args.repo.github_id))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, args.repo);
      return { added: false, updated: true };
    }

    await ctx.db.insert("sv_repos", args.repo);
    return { added: true, updated: false };
  },
});

export const getReposMissingContent = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sv_repos")
      .filter((q) => q.eq(q.field("content_fetched_at"), undefined))
      .take(args.limit);
  },
});

export const getReposMissingEmbedding = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    // Use index to efficiently find repos without embeddings
    // has_embedding: undefined means no embedding yet
    return ctx.db
      .query("sv_repos")
      .withIndex("by_has_embedding", (q) => q.eq("has_embedding", undefined))
      .filter((q) => q.neq(q.field("content_fetched_at"), undefined))
      .take(args.limit);
  },
});

export const updateRepoContent = internalMutation({
  args: {
    id: v.id("sv_repos"),
    readme_content: v.optional(v.string()),
    package_json: v.optional(v.any()),
    content_fetched_at: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      readme_content: args.readme_content ?? undefined,
      package_json: args.package_json ?? undefined,
      content_fetched_at: args.content_fetched_at,
    });
  },
});

export const setRepoEmbedding = internalMutation({
  args: {
    id: v.id("sv_repos"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      embedding: args.embedding,
      has_embedding: true,
    });
  },
});

export const insertSyncState = internalMutation({
  args: {
    id: v.string(),
    last_sync_at: v.string(),
    repos_added: v.number(),
    repos_updated: v.number(),
    content_fetched: v.number(),
    embeddings_generated: v.number(),
    sync_type: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("sv_sync_state", {
      id: args.id,
      last_sync_at: args.last_sync_at,
      repos_added: args.repos_added,
      repos_updated: args.repos_updated,
      content_fetched: args.content_fetched,
      embeddings_generated: args.embeddings_generated,
      sync_type: args.sync_type,
      metadata: args.metadata,
    });
  },
});

export const getReposByIds = internalQuery({
  args: { ids: v.array(v.id("sv_repos")) },
  handler: async (ctx, args) => {
    return Promise.all(args.ids.map((id) => ctx.db.get(id)));
  },
});

export const getRepoByFullName = internalQuery({
  args: { full_name: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("sv_repos")
      .filter((q) => q.eq(q.field("full_name"), args.full_name))
      .first();
  },
});

// Migration: Set has_embedding flag for repos that already have embeddings
// Uses index to only scan repos without has_embedding flag
export const migrateHasEmbeddingFlag = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    let migrated = 0;
    // Use index to find repos where has_embedding is undefined
    const repos = await ctx.db
      .query("sv_repos")
      .withIndex("by_has_embedding", (q) => q.eq("has_embedding", undefined))
      .take(args.limit * 2); // Take extra since some may not have embeddings

    for (const repo of repos) {
      if (repo.embedding) {
        await ctx.db.patch(repo._id, { has_embedding: true });
        migrated++;
        if (migrated >= args.limit) break;
      }
    }
    return { migrated };
  },
});
