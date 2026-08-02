import { z } from 'zod';
import { type InferSchema, type ToolMetadata } from 'xmcp';
import { updatePost } from '../lib/convex-client';
import { requireMcpActor } from '../lib/clerk-session';
import { toToolResult } from '../lib/tool-result';

export const schema = {
  postId: z.string().min(1),
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  status: z.enum(['draft', 'generating', 'published']).optional(),
};

export const metadata: ToolMetadata = {
  name: 'posts_update',
  description: 'Update a post for the authenticated user.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
  },
};

export default async function postsUpdateTool({
  postId,
  title,
  content,
  status,
}: InferSchema<typeof schema>) {
  if (title === undefined && content === undefined && status === undefined) {
    throw new Error('At least one of title, content, or status is required.');
  }

  const { userId } = await requireMcpActor();
  const result = await updatePost({
    userId,
    postId,
    title,
    content,
    status,
  });

  return toToolResult(result, `Updated post: ${postId}.`);
}
