import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation } from './_generated/server';
import { assertServiceSecret, normalizeEmail } from './lib/service';

const DEFAULT_TRIAL_LIMIT = 10;

const trialLimit = (): number => {
  const raw = process.env.MCP_TRIAL_GENERATION_LIMIT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_TRIAL_LIMIT;
};

/**
 * Accounts are keyed on email — it is the admin-facing handle, and it is known before a person
 * has ever connected. The `by_user` fallback keeps someone from minting a fresh trial by
 * switching their primary email in Clerk.
 */
const findAccount = async (
  ctx: MutationCtx,
  email: string,
  userId?: string,
): Promise<Doc<'mcpAccounts'> | null> => {
  const byEmail = await ctx.db
    .query('mcpAccounts')
    .withIndex('by_email', (q) => q.eq('email', email))
    .unique();
  if (byEmail) {
    return byEmail;
  }

  if (!userId) {
    return null;
  }

  return await ctx.db
    .query('mcpAccounts')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique();
};

const upsertAccount = async (
  ctx: MutationCtx,
  { email, userId }: { email: string; userId?: string },
): Promise<Doc<'mcpAccounts'>> => {
  const now = Date.now();
  const existing = await findAccount(ctx, email, userId);

  if (!existing) {
    const id = await ctx.db.insert('mcpAccounts', {
      email,
      userId,
      status: 'active',
      generationLimit: trialLimit(),
      generationsUsed: 0,
      createdAt: now,
      lastUsedAt: now,
    });
    return (await ctx.db.get(id))!;
  }

  const patch: Partial<Doc<'mcpAccounts'>> = { lastUsedAt: now };
  if (userId && existing.userId !== userId) {
    patch.userId = userId;
  }
  if (existing.email !== email) {
    patch.email = email;
  }
  await ctx.db.patch(existing._id, patch);

  return { ...existing, ...patch };
};

const assertActive = (account: Doc<'mcpAccounts'>) => {
  if (account.status === 'blocked') {
    throw new Error('Access to One Blog MCP has been revoked for this account.');
  }
};

const toSummary = (account: Doc<'mcpAccounts'>) => ({
  email: account.email,
  status: account.status,
  generationsUsed: account.generationsUsed,
  generationLimit: account.generationLimit,
  remaining: Math.max(account.generationLimit - account.generationsUsed, 0),
});

/**
 * Called by the MCP server on every tool call: auto-enrols first-time users with the trial
 * limit, binds their Clerk user id, and enforces the blocklist.
 */
export const ensureAccountForMcp = mutation({
  args: {
    serviceSecret: v.string(),
    userId: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    assertServiceSecret(args.serviceSecret);

    const account = await upsertAccount(ctx, {
      email: normalizeEmail(args.email),
      userId: args.userId,
    });
    assertActive(account);

    return toSummary(account);
  },
});

/**
 * Reserve a generation credit before spending on OpenAI. Lives here rather than in the MCP
 * server so it cannot be bypassed, and so the counter bump and the audit row commit together.
 */
export const consume = internalMutation({
  args: {
    email: v.string(),
    userId: v.optional(v.string()),
    tool: v.string(),
    cost: v.number(),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const account = await upsertAccount(ctx, { email, userId: args.userId });
    assertActive(account);

    const used = account.generationsUsed + args.cost;
    if (used > account.generationLimit) {
      throw new Error(
        `Generation limit reached (${account.generationsUsed}/${account.generationLimit}). ` +
          'Ask the owner of One Blog to raise your limit.',
      );
    }

    await ctx.db.patch(account._id, { generationsUsed: used });

    const usageId = await ctx.db.insert('mcpUsage', {
      email,
      userId: args.userId,
      tool: args.tool,
      cost: args.cost,
      refunded: false,
      at: Date.now(),
    });

    return {
      usageId,
      used,
      limit: account.generationLimit,
      remaining: Math.max(account.generationLimit - used, 0),
    };
  },
});

/** Give the credit back when the OpenAI work fails after it was reserved. */
export const refund = internalMutation({
  args: { usageId: v.id('mcpUsage') },
  handler: async (ctx, args) => {
    const usage = await ctx.db.get(args.usageId);
    if (!usage || usage.refunded) {
      return { success: true };
    }

    const account = await findAccount(ctx, usage.email, usage.userId);
    if (account) {
      await ctx.db.patch(account._id, {
        generationsUsed: Math.max(account.generationsUsed - usage.cost, 0),
      });
    }

    await ctx.db.patch(args.usageId, { refunded: true });
    return { success: true };
  },
});

// --- Admin -----------------------------------------------------------------
// Internal functions: not reachable over the wire, but callable from the CLI, which
// authenticates with the deploy key. e.g.
//   npx convex run access:grant '{"email":"friend@example.com","limit":50}'

export const grant = internalMutation({
  args: {
    email: v.string(),
    limit: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email);
    const account = await upsertAccount(ctx, { email });

    await ctx.db.patch(account._id, {
      status: 'active',
      generationLimit: args.limit ?? account.generationLimit,
      ...(args.note === undefined ? {} : { note: args.note }),
    });

    return toSummary((await ctx.db.get(account._id))!);
  },
});

export const setLimit = internalMutation({
  args: { email: v.string(), limit: v.number() },
  handler: async (ctx, args) => {
    const account = await upsertAccount(ctx, { email: normalizeEmail(args.email) });
    await ctx.db.patch(account._id, { generationLimit: args.limit });
    return toSummary((await ctx.db.get(account._id))!);
  },
});

export const revoke = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const account = await upsertAccount(ctx, { email: normalizeEmail(args.email) });
    await ctx.db.patch(account._id, { status: 'blocked' });
    return toSummary((await ctx.db.get(account._id))!);
  },
});

export const reinstate = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const account = await upsertAccount(ctx, { email: normalizeEmail(args.email) });
    await ctx.db.patch(account._id, { status: 'active' });
    return toSummary((await ctx.db.get(account._id))!);
  },
});

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query('mcpAccounts').collect();
    return accounts
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((account) => ({
        ...toSummary(account),
        userId: account.userId,
        note: account.note,
        createdAt: account.createdAt,
        lastUsedAt: account.lastUsedAt,
      }));
  },
});
