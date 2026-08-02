import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  topics: defineTable({
    userId: v.string(),
    domain: v.string(),
    name: v.string(),
    searchVolume: v.string(),
    trend: v.string(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_domain', ['userId', 'domain'])
    .index('by_created', ['createdAt']),
  posts: defineTable({
    userId: v.string(),
    title: v.string(),
    content: v.string(),
    status: v.union(v.literal('draft'), v.literal('generating'), v.literal('published')),
    generatedBy: v.string(),
    domain: v.string(),
    topic: v.string(),
    wordCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_user_status', ['userId', 'status'])
    .index('by_created', ['createdAt']),
  mcpAccounts: defineTable({
    email: v.string(),
    userId: v.optional(v.string()),
    status: v.union(v.literal('active'), v.literal('blocked')),
    generationLimit: v.number(),
    generationsUsed: v.number(),
    note: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.number(),
  })
    .index('by_email', ['email'])
    .index('by_user', ['userId'])
    .index('by_last_used', ['lastUsedAt']),
  mcpUsage: defineTable({
    email: v.string(),
    userId: v.optional(v.string()),
    tool: v.string(),
    cost: v.number(),
    refunded: v.boolean(),
    at: v.number(),
    // Optional: rows written before the web app was metered predate this field.
    source: v.optional(v.union(v.literal('mcp'), v.literal('web'))),
  })
    .index('by_email', ['email'])
    .index('by_at', ['at']),
});
