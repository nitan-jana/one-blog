import { ConvexHttpClient } from 'convex/browser';
import { anyApi } from 'convex/server';
import { env } from './env';

const convex = new ConvexHttpClient(env.convexUrl);

export type PostStatus = 'draft' | 'generating' | 'published';
export type Provider = 'openai_web' | 'gsc';

export type Topic = {
  name: string;
  searchVolume: string;
  trend: string;
  reason: string;
};

type PostSummary = {
  _id: string;
  title: string;
  status: PostStatus;
  domain: string;
  topic: string;
  wordCount: number;
  generatedBy: string;
  createdAt: number;
  updatedAt: number;
};

type Post = PostSummary & {
  userId: string;
  content: string;
};

export type AccountSummary = {
  email: string;
  status: 'active' | 'blocked';
  generationsUsed: number;
  generationLimit: number;
  remaining: number;
};

export type Quota = {
  used: number;
  limit: number;
  remaining: number;
};

export const ensureAccount = async ({
  userId,
  email,
}: {
  userId: string;
  email: string;
}): Promise<AccountSummary> => {
  return (await convex.mutation(anyApi.access.ensureAccountForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
  })) as AccountSummary;
};

export const listRecentDomains = async (userId: string): Promise<{ domains: string[] }> => {
  return (await convex.query(anyApi.mcp.topicsRecentDomainsForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
  })) as { domains: string[] };
};

export const findTrendingTopics = async ({
  userId,
  email,
  domain,
  limit,
  provider,
}: {
  userId: string;
  email: string;
  domain: string;
  limit?: number;
  provider?: Provider;
}): Promise<{ topics: Topic[]; quota: Quota }> => {
  return (await convex.action(anyApi.ai.findTrendingTopicsForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
    domain,
    limit,
    provider,
  })) as { topics: Topic[]; quota: Quota };
};

export const generatePostFromTopic = async ({
  userId,
  email,
  topic,
  domain,
  provider,
}: {
  userId: string;
  email: string;
  topic: string;
  domain: string;
  provider?: Provider;
}): Promise<{
  _id: string;
  title: string;
  content: string;
  wordCount: number;
  quota: Quota;
}> => {
  return (await convex.action(anyApi.ai.generatePostForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    email,
    topic,
    domain,
    provider,
  })) as {
    _id: string;
    title: string;
    content: string;
    wordCount: number;
    quota: Quota;
  };
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
}): Promise<{
  items: PostSummary[];
  nextCursor?: string;
}> => {
  return (await convex.query(anyApi.mcp.postsListForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    status,
    limit,
    cursor,
  })) as { items: PostSummary[]; nextCursor?: string };
};

export const getPost = async ({
  userId,
  postId,
}: {
  userId: string;
  postId: string;
}): Promise<Post | null> => {
  return (await convex.query(anyApi.mcp.postGetForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId,
  })) as Post | null;
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
}): Promise<{
  postId: string;
  status: PostStatus;
  wordCount: number;
}> => {
  return (await convex.mutation(anyApi.mcp.postsCreateForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    title,
    content,
    status,
    generatedBy: 'mcp',
    domain,
    topic,
  })) as { postId: string; status: PostStatus; wordCount: number };
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
}): Promise<{ success: true }> => {
  return (await convex.mutation(anyApi.mcp.postsUpdateForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId,
    title,
    content,
    status,
  })) as { success: true };
};

export const deletePost = async ({
  userId,
  postId,
}: {
  userId: string;
  postId: string;
}): Promise<{ success: true }> => {
  return (await convex.mutation(anyApi.mcp.postsDeleteForMcp, {
    serviceSecret: env.serviceSecret,
    userId,
    postId,
  })) as { success: true };
};
