import { getSession, getUser } from '@xmcp-dev/clerk';
import { ensureAccount, type AccountSummary } from './convex-client';

export type McpActor = {
  userId: string;
  sessionId?: string;
  email: string;
  account: AccountSummary;
};

export const getSessionUser = async () => {
  const session = await getSession();
  if (!session?.userId) {
    throw new Error('Unauthorized: no active Clerk session.');
  }

  const user = await getUser();
  return { session, user };
};

/**
 * The single entry point for every tool: resolves the caller's Clerk identity, enrols them if
 * this is their first connection, and enforces the blocklist. The email must be verified —
 * quota limits are granted by email, so an unverified address could claim someone else's.
 */
export const requireMcpActor = async (): Promise<McpActor> => {
  const { session, user } = await getSessionUser();

  const primaryEmail = user?.primaryEmailAddress;
  if (!primaryEmail?.emailAddress) {
    throw new Error(
      'Your account has no primary email address. One Blog MCP needs one to track usage.',
    );
  }

  if (primaryEmail.verification?.status !== 'verified') {
    throw new Error('Please verify your email address before using One Blog MCP.');
  }

  const email = primaryEmail.emailAddress.trim().toLowerCase();
  const account = await ensureAccount({ userId: session.userId, email });

  return { userId: session.userId, sessionId: session.sessionId, email, account };
};
