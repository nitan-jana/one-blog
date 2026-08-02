import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, mutation, query } from './_generated/server';
import { assertServiceSecret, normalizeEmail } from './lib/service';

const DEFAULT_TRIAL_LIMIT = 10;
const DEFAULT_REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const sourceValidator = v.union(v.literal('mcp'), v.literal('web'));

/** Admin reads are bounded so a growing table cannot blow the Convex read limit. */
const clampLimit = (value: number | undefined, fallback: number, max: number): number => {
  if (!value) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), max);
};

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
  ctx: QueryCtx,
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
 * The signed-in caller's own quota, for the web app. Authenticated by the Clerk identity rather
 * than the service secret. A query cannot enrol anyone, so a first-time user — who has no row
 * until their first generation — is shown the trial allowance they are about to get.
 */
export const myQuota = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.email) {
      return null;
    }

    const email = identity.email.trim().toLowerCase();
    const account = await findAccount(ctx, email, identity.subject);
    if (!account) {
      return {
        email,
        status: 'active' as const,
        generationsUsed: 0,
        generationLimit: trialLimit(),
        remaining: trialLimit(),
      };
    }

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
    source: v.optional(sourceValidator),
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
      source: args.source,
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
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const accounts = await ctx.db
      .query('mcpAccounts')
      .withIndex('by_last_used')
      .order('desc')
      .take(clampLimit(args.limit, 50, 200));

    return accounts.map((account) => ({
      ...toSummary(account),
      userId: account.userId,
      note: account.note,
      createdAt: account.createdAt,
      lastUsedAt: account.lastUsedAt,
    }));
  },
});

/** Raw audit rows, newest first — for one account with `email`, or everyone without it. */
export const usage = internalQuery({
  args: { email: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = clampLimit(args.limit, 50, 500);
    const email = args.email ? normalizeEmail(args.email) : undefined;

    const rows = email
      ? await ctx.db
          .query('mcpUsage')
          .withIndex('by_email', (q) => q.eq('email', email))
          .order('desc')
          .take(limit)
      : await ctx.db.query('mcpUsage').withIndex('by_at').order('desc').take(limit);

    return rows.map((row) => ({
      email: row.email,
      tool: row.tool,
      cost: row.cost,
      refunded: row.refunded,
      source: row.source ?? 'mcp',
      at: row.at,
    }));
  },
});

/**
 * Where the OpenAI budget went: net spend per account over a window, broken down by tool and by
 * surface. Bounded by `since` (default 30 days) so it stays a windowed read, not a table scan.
 */
export const report = internalQuery({
  args: { email: v.optional(v.string()), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const since = args.since ?? Date.now() - DEFAULT_REPORT_WINDOW_MS;
    const email = args.email ? normalizeEmail(args.email) : undefined;

    const rows = email
      ? await ctx.db
          .query('mcpUsage')
          .withIndex('by_email', (q) => q.eq('email', email))
          .filter((q) => q.gte(q.field('at'), since))
          .collect()
      : await ctx.db
          .query('mcpUsage')
          .withIndex('by_at', (q) => q.gte('at', since))
          .collect();

    type Row = {
      email: string;
      charged: number;
      refunded: number;
      net: number;
      byTool: Record<string, number>;
      bySource: { mcp: number; web: number };
      lastUsedAt: number;
    };

    const byEmail = new Map<string, Row>();

    for (const row of rows) {
      const entry = byEmail.get(row.email) ?? {
        email: row.email,
        charged: 0,
        refunded: 0,
        net: 0,
        byTool: {},
        bySource: { mcp: 0, web: 0 },
        lastUsedAt: 0,
      };

      entry.charged += row.cost;
      if (row.refunded) {
        entry.refunded += row.cost;
      } else {
        entry.net += row.cost;
        entry.byTool[row.tool] = (entry.byTool[row.tool] ?? 0) + row.cost;
        entry.bySource[row.source ?? 'mcp'] += row.cost;
      }
      entry.lastUsedAt = Math.max(entry.lastUsedAt, row.at);

      byEmail.set(row.email, entry);
    }

    return {
      since,
      accounts: [...byEmail.values()].sort((a, b) => b.net - a.net),
    };
  },
});
