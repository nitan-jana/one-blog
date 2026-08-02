import type { Auth } from 'convex/server';
import { normalizeEmail } from './service';

export type WebActor = {
  userId: string;
  email: string;
};

/**
 * The browser-side counterpart to `requireMcpActor` in the MCP server: resolves the signed-in
 * caller into the same `{ userId, email }` pair the metering functions key on. The email comes
 * from the verified Convex identity rather than from the client, since that is the whole point —
 * a client-supplied email would let anyone spend against someone else's quota.
 */
export const requireWebActor = async (auth: Auth): Promise<WebActor> => {
  const identity = await auth.getUserIdentity();
  if (!identity) {
    throw new Error('Unauthorized: Please sign in to use AI features');
  }

  if (identity.emailVerified === false) {
    throw new Error('Please verify your email address before using AI features.');
  }

  if (!identity.email) {
    throw new Error(
      'Your identity token has no email claim. Add `"email": "{{user.primary_email_address}}"` ' +
        'to the `convex` JWT template in the Clerk dashboard.',
    );
  }

  return { userId: identity.subject, email: normalizeEmail(identity.email) };
};
