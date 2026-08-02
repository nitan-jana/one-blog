import { ConvexHttpClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { api } from '../../../convex/_generated/api';
import { env } from './env';

const convex = new ConvexHttpClient(env.convexUrl);

/**
 * Types are derived from the Convex functions rather than restated here, so renaming a function or
 * changing its shape is a compile error in this package instead of a runtime surprise. `api` is
 * `anyApi` at runtime — this costs nothing at execution time and buys everything at build time.
 */
export type PostStatus = NonNullable<FunctionArgs<typeof api.mcp.postsListForMcp>['status']>;
export type AccountSummary = FunctionReturnType<typeof api.access.ensureAccountForMcp>;
export type Topic = FunctionReturnType<typeof api.ai.findTrendingTopicsForMcp>['topics'][number];
export type Quota = FunctionReturnType<typeof api.ai.findTrendingTopicsForMcp>['quota'];

export const ensureAccount = async ({ userId, email }: { userId: string; email: string }) => {
  return await convex.mutation(api.access.ensureAccountForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
  });
};

export const listRecentDomains = async (userId: string) => {
  return await convex.query(api.mcp.topicsRecentDomainsForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
  });
};

export const findTrendingTopics = async ({
  userId,
  email,
  domain,
  limit,
}: {
  userId: string;
  email: string;
  domain: string;
  limit?: number;
}) => {
  return await convex.action(api.ai.findTrendingTopicsForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
    domain,
    limit,
  });
};

export const generatePostFromTopic = async ({
  userId,
  email,
  topic,
  domain,
}: {
  userId: string;
  email: string;
  topic: string;
  domain: string;
}) => {
  return await convex.action(api.ai.generatePostForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
    topic,
    domain,
  });
};

export const listPosts = async ({
  userId,
  status,
  limit,
  cursor,
}: {
  userId: string;
  status?: PostStatus;
  limit?: number;
  cursor?: string;
}) => {
  return await convex.query(api.mcp.postsListForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    status,
    limit,
    cursor,
  });
};

export const getPost = async ({ userId, postId }: { userId: string; postId: string }) => {
  return await convex.query(api.mcp.postGetForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId: postId as FunctionArgs<typeof api.mcp.postGetForMcp>['postId'],
  });
};

export const createPost = async ({
  userId,
  title,
  content,
  status,
  domain,
  topic,
}: {
  userId: string;
  title: string;
  content: string;
  status?: PostStatus;
  domain: string;
  topic: string;
}) => {
  return await convex.mutation(api.mcp.postsCreateForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    title,
    content,
    status,
    generatedBy: 'mcp',
    domain,
    topic,
  });
};

export const updatePost = async ({
  userId,
  postId,
  title,
  content,
  status,
}: {
  userId: string;
  postId: string;
  title?: string;
  content?: string;
  status?: PostStatus;
}) => {
  return await convex.mutation(api.mcp.postsUpdateForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId: postId as FunctionArgs<typeof api.mcp.postsUpdateForMcp>['postId'],
    title,
    content,
    status,
  });
};

export const deletePost = async ({ userId, postId }: { userId: string; postId: string }) => {
  return await convex.mutation(api.mcp.postsDeleteForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId: postId as FunctionArgs<typeof api.mcp.postsDeleteForMcp>['postId'],
  });
};
