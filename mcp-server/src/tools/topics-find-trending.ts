import { z } from 'zod';
import { type InferSchema, type ToolMetadata } from 'xmcp';
import { findTrendingTopics } from '../lib/convex-client';
import { requireMcpActor } from '../lib/clerk-session';
import { toToolResult } from '../lib/tool-result';

export const schema = {
  domain: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
};

export const metadata: ToolMetadata = {
  name: 'topics_find_trending',
  description:
    'Find trending blog topics for a domain and persist them to One Blog. Consumes one generation credit from the caller.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
};

export default async function topicsFindTrendingTool({
  domain,
  limit,
}: InferSchema<typeof schema>) {
  const { userId, email } = await requireMcpActor();

  const { topics, quota } = await findTrendingTopics({
    userId,
    email,
    domain,
    limit,
  });

  const result = {
    topics,
    quota,
    dataScope: 'app',
    fetchedAt: Date.now(),
  };

  return toToolResult(
    result,
    `Found ${topics.length} trending topic(s) for "${domain}". ` +
      `${quota.remaining} of ${quota.limit} generations remaining.`,
  );
}
