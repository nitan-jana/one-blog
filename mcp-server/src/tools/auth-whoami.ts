import { type InferSchema, type ToolMetadata } from 'xmcp';
import { requireMcpActor } from '../lib/clerk-session';
import { toToolResult } from '../lib/tool-result';

export const schema = {};

export const metadata: ToolMetadata = {
  name: 'auth_whoami',
  description: 'Return authenticated MCP user identity and remaining generation credits.',
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
  },
};

export default async function authWhoAmITool(_: InferSchema<typeof schema>) {
  const { userId, sessionId, email, account } = await requireMcpActor();

  return toToolResult(
    {
      userId,
      authType: 'clerk' as const,
      sessionId,
      email,
      status: account.status,
      generationsUsed: account.generationsUsed,
      generationLimit: account.generationLimit,
      remaining: account.remaining,
    },
    `Authenticated as ${email}. ${account.remaining} of ${account.generationLimit} generations remaining.`,
  );
}
