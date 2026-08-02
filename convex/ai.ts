'use node';

import { anyApi } from 'convex/server';
import { v } from 'convex/values';
import OpenAI from 'openai';
import type { ActionCtx } from './_generated/server';
import { action } from './_generated/server';
import { api, internal } from './_generated/api';
import { requireWebActor } from './lib/identity';
import { modelFor } from './lib/models';
import { assertServiceSecret } from './lib/service';

type TopicCandidate = {
  name: string;
  searchVolume: string;
  trend: string;
  reason: string;
};

type GeneratedPost = {
  _id: string;
  title: string;
  content: string;
  wordCount: number;
};

type Quota = {
  used: number;
  limit: number;
  remaining: number;
};

/**
 * Reserve a credit, do the OpenAI work, refund if it fails. Every AI action goes through here —
 * the web app and the MCP server charge the same account, so neither surface is a way around the
 * other's quota.
 */
const withCredit = async <T>(
  ctx: ActionCtx,
  {
    email,
    userId,
    tool,
    source,
  }: { email: string; userId: string; tool: string; source: 'mcp' | 'web' },
  work: (quota: Quota) => Promise<T>,
): Promise<T> => {
  const reserved = await ctx.runMutation(internal.access.consume, {
    email,
    userId,
    tool,
    cost: 1,
    source,
  });

  try {
    return await work({
      used: reserved.used,
      limit: reserved.limit,
      remaining: reserved.remaining,
    });
  } catch (error) {
    await ctx.runMutation(internal.access.refund, { usageId: reserved.usageId });
    throw error;
  }
};

const getClient = () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Run: npx convex env set OPENAI_API_KEY <key>');
  }
  return new OpenAI({ apiKey });
};

const extractText = (response: OpenAI.Responses.Response): string => {
  const textItems = response.output.filter(
    (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === 'message',
  );
  return textItems
    .flatMap((item) =>
      item.content
        .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === 'output_text')
        .map((c) => c.text),
    )
    .join('\n')
    .trim();
};

const parseTopics = (jsonText: string, limit: number): TopicCandidate[] => {
  let normalized = jsonText;
  const fenceMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    normalized = fenceMatch[1].trim();
  }

  const parsed = JSON.parse(normalized);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Invalid topics response');
  }

  return parsed.slice(0, limit).map((item: unknown): TopicCandidate => {
    if (!item || typeof item !== 'object') {
      throw new Error('Invalid topics response');
    }
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.name !== 'string' ||
      typeof candidate.searchVolume !== 'string' ||
      typeof candidate.trend !== 'string' ||
      typeof candidate.reason !== 'string'
    ) {
      throw new Error('Invalid topics response');
    }
    return {
      name: candidate.name,
      searchVolume: candidate.searchVolume,
      trend: candidate.trend,
      reason: candidate.reason,
    };
  });
};

/**
 * The write call uses strict structured output, so malformed JSON is an API-level error rather
 * than something to defend against here. A refusal can still come back as prose, though.
 */
const parsePost = (jsonText: string): { title: string; content: string } => {
  const parsed: unknown = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid post response');
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.title !== 'string' || typeof candidate.content !== 'string') {
    throw new Error('Invalid post response');
  }

  const content = candidate.content.trim();
  if (!content) {
    throw new Error('No content generated');
  }

  return { title: candidate.title.trim(), content };
};

const findTrendingTopicsWithOpenAI = async ({
  client,
  domain,
  limit,
}: {
  client: OpenAI;
  domain: string;
  limit: number;
}): Promise<TopicCandidate[]> => {
  const response = await client.responses.create({
    model: modelFor('topics'),
    tools: [{ type: 'web_search_preview' }],
    input: `Find ${limit} trending topics in the "${domain}" domain that would make great blog posts right now. Use web search to find current trends, popular discussions, and emerging topics.

      Return ONLY a JSON array with exactly ${limit} objects, each having:
      - "name": the topic title (concise, blog-post-ready)
      - "searchVolume": estimated relative search interest ("high", "medium", or "rising")
      - "trend": brief trend description (e.g., "Growing 40% month-over-month")
      - "reason": why this topic is trending now (1 sentence)

      Return ONLY the JSON array, no markdown fences or other text.`,
  });

  return parseTopics(extractText(response), limit);
};

const generatePostWithOpenAI = async ({
  client,
  topic,
  domain,
}: {
  client: OpenAI;
  topic: string;
  domain: string;
}): Promise<{
  title: string;
  content: string;
  wordCount: number;
}> => {
  const researchResponse = await client.responses.create({
    model: modelFor('research'),
    tools: [{ type: 'web_search_preview' }],
    input: `Research the topic "${topic}" in the "${domain}" domain. Use web search to find:
      - Key facts and statistics
      - Recent developments
      - Expert opinions
      - Practical examples

      Provide a comprehensive research summary with sources.`,
  });

  const research = extractText(researchResponse);

  const writeResponse = await client.responses.create({
    model: modelFor('write'),
    input: `Using this research, write a comprehensive blog post:

      Research:
      ${research}

      Requirements:
      - Topic: "${topic}"
      - Domain: "${domain}"
      - Length: 2000+ words
      - Format: Markdown
      - Include: engaging introduction, clear headings (##), practical examples, statistics where relevant, actionable conclusion
      - Tone: professional but accessible

      Return two fields:
      - "title": one compelling title that reflects the post you actually wrote. No surrounding quotes.
      - "content": the post body. Do NOT repeat the title as a heading — it is stored separately.

      Write the blog post now.`,
    text: {
      format: {
        type: 'json_schema',
        name: 'blog_post',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['title', 'content'],
          additionalProperties: false,
        },
      },
    },
  });

  const parsed = parsePost(extractText(writeResponse));
  const title = parsed.title.replace(/^["']|["']$/g, '') || topic;
  const wordCount = parsed.content.split(/\s+/).filter(Boolean).length;

  return { title, content: parsed.content, wordCount };
};

export const findTrendingTopics = action({
  args: {
    domain: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ topics: TopicCandidate[]; quota: Quota }> => {
    const actor = await requireWebActor(ctx.auth);

    const limit = Math.min(Math.max(Math.floor(args.limit ?? 5), 1), 10);

    return await withCredit(
      ctx,
      { ...actor, tool: 'topics_find_trending', source: 'web' },
      async (quota) => {
        const client = getClient();

        const topics = await findTrendingTopicsWithOpenAI({
          client,
          domain: args.domain,
          limit,
        });

        await ctx.runMutation(api.topics.createBatch, {
          userId: actor.userId,
          domain: args.domain,
          topics,
        });

        return { topics, quota };
      },
    );
  },
});

export const findTrendingTopicsForMcp = action({
  args: {
    serviceSecret: v.string(),
    userId: v.string(),
    email: v.string(),
    domain: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ topics: TopicCandidate[]; quota: Quota }> => {
    assertServiceSecret(args.serviceSecret);

    const limit = Math.min(Math.max(Math.floor(args.limit ?? 5), 1), 10);

    return await withCredit(
      ctx,
      {
        email: args.email,
        userId: args.userId,
        tool: 'topics_find_trending',
        source: 'mcp',
      },
      async (quota) => {
        const client = getClient();

        const topics = await findTrendingTopicsWithOpenAI({
          client,
          domain: args.domain,
          limit,
        });

        await ctx.runMutation(anyApi.mcp.topicsCreateBatchForMcp, {
          serviceSecret: args.serviceSecret,
          userId: args.userId,
          domain: args.domain,
          topics,
        });

        return { topics, quota };
      },
    );
  },
});

export const generatePost = action({
  args: {
    topic: v.string(),
    domain: v.string(),
  },
  handler: async (ctx, args): Promise<GeneratedPost & { quota: Quota }> => {
    const actor = await requireWebActor(ctx.auth);

    return await withCredit(
      ctx,
      { ...actor, tool: 'post_generate_from_topic', source: 'web' },
      async (quota) => {
        const client = getClient();
        const generated = await generatePostWithOpenAI({
          client,
          topic: args.topic,
          domain: args.domain,
        });

        const postId = await ctx.runMutation(api.posts.create, {
          userId: actor.userId,
          title: generated.title,
          content: generated.content,
          status: 'published',
          generatedBy: 'ai',
          domain: args.domain,
          topic: args.topic,
          wordCount: generated.wordCount,
        });

        return {
          _id: postId,
          title: generated.title,
          content: generated.content,
          wordCount: generated.wordCount,
          quota,
        };
      },
    );
  },
});

export const generatePostForMcp = action({
  args: {
    serviceSecret: v.string(),
    userId: v.string(),
    email: v.string(),
    topic: v.string(),
    domain: v.string(),
  },
  handler: async (ctx, args): Promise<GeneratedPost & { quota: Quota }> => {
    assertServiceSecret(args.serviceSecret);

    return await withCredit(
      ctx,
      {
        email: args.email,
        userId: args.userId,
        tool: 'post_generate_from_topic',
        source: 'mcp',
      },
      async (quota) => {
        const client = getClient();
        const generated = await generatePostWithOpenAI({
          client,
          topic: args.topic,
          domain: args.domain,
        });

        const created = await ctx.runMutation(anyApi.mcp.postsCreateForMcp, {
          serviceSecret: args.serviceSecret,
          userId: args.userId,
          title: generated.title,
          content: generated.content,
          status: 'published',
          generatedBy: 'ai',
          domain: args.domain,
          topic: args.topic,
        });

        return {
          _id: created.postId,
          title: generated.title,
          content: generated.content,
          wordCount: generated.wordCount,
          quota,
        };
      },
    );
  },
});
