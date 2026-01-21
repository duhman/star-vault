import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  sv_repos: defineTable({
    id: v.string(),
    github_id: v.string(),
    full_name: v.string(),
    owner: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    topics: v.optional(v.array(v.string())),
    language: v.optional(v.string()),
    stargazers_count: v.optional(v.number()),
    forks_count: v.optional(v.number()),
    license: v.optional(v.string()),
    html_url: v.string(),
    default_branch: v.optional(v.string()),
    starred_at: v.optional(v.string()),
    readme_content: v.optional(v.string()),
    package_json: v.optional(v.any()),
    raw_data: v.optional(v.any()),
    fetched_at: v.optional(v.string()),
    content_fetched_at: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    has_embedding: v.optional(v.boolean()),
  })
    .index("by_legacy_id", ["id"])
    .index("by_github_id", ["github_id"])
    .index("by_content_fetched", ["content_fetched_at"])
    .index("by_has_embedding", ["has_embedding"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
    }),

  sv_sync_state: defineTable({
    id: v.string(),
    last_sync_at: v.optional(v.string()),
    repos_added: v.optional(v.number()),
    repos_updated: v.optional(v.number()),
    content_fetched: v.optional(v.number()),
    embeddings_generated: v.optional(v.number()),
    sync_type: v.optional(v.string()),
    metadata: v.optional(v.any()),
  }).index("by_sync_id", ["id"]),
});
