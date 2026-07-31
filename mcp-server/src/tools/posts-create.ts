import { z } from 'zod';
import { type InferSchema, type ToolMetadata } from 'xmcp';
import { createPost, type PostStatus } from '../lib/convex-client';
import { requireMcpActor } from '../lib/clerk-session';
import { toToolResult } from '../lib/tool-result';

export const schema = {
  title: z.string().min(1),
  content: z.string().min(1),
  domain: z.string().min(1),
  topic: z.string().min(1),
  status: z.enum(['draft', 'generating', 'published']).optional(),
};

export const metadata: ToolMetadata = {
  name: 'posts_create',
  description: 'Create a post for the authenticated user.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
};

export default async function postsCreateTool({
  title,
  content,
  domain,
  topic,
  status,
}: InferSchema<typeof schema>) {
  const { userId } = await requireMcpActor();

  const post = await createPost({
    userId,
    title,
    content,
    domain,
    topic,
    status: status as PostStatus | undefined,
  });

  return toToolResult(post, `Created post${title ? `: ${title}` : ''}.`);
}
