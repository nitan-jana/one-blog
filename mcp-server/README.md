# One Blog — MCP Server

A Clerk-authenticated [MCP](https://modelcontextprotocol.io) server that makes One Blog
**agent-operable**: a language model can research topics, write posts, and publish them through a set
of tools, without touching the web UI.

Built with [`xmcp`](https://www.npmjs.com/package/xmcp) (HTTP transport) and
[`@xmcp-dev/clerk`](https://www.npmjs.com/package/@xmcp-dev/clerk).

**Endpoint:** `https://mcp.oneblog.nitanjana.com/mcp`

---

## Tools

Nine tools, each carrying MCP annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`) so a
client knows which calls are safe to retry, which mutate state, and which are destructive.

| Tool                         | Purpose                                                           | Behavior       |
| ---------------------------- | ----------------------------------------------------------------- | -------------- |
| `auth_whoami`                | Return the caller's identity and remaining generation credits     | read-only      |
| `posts_list`                 | List the authenticated user's posts (paginated, filter by status) | read-only      |
| `posts_get`                  | Fetch a single post by id                                         | read-only      |
| `topics_list_recent_domains` | List the user's recently searched domains                         | read-only      |
| `topics_find_trending`       | Research trending topics for a domain and persist them            | **metered**    |
| `post_generate_from_topic`   | Research a topic, generate a full post, and save it               | **metered**    |
| `posts_create`               | Create a post for the authenticated user                          | non-idempotent |
| `posts_update`               | Update an existing post                                           | non-idempotent |
| `posts_delete`               | Delete a post                                                     | destructive    |

All `posts_*` and `topics_*` tools operate on **the authenticated user's** data — there is no
anonymous read or write path.

The two **metered** tools are the ones that spend OpenAI credits, so each call costs one generation
credit against the caller's quota. See [Access control](#access-control).

---

## Authentication

Auth is handled entirely by `@xmcp-dev/clerk`, which makes the server a **Clerk-backed OAuth
resource server**. Every tool call runs in the context of an authenticated Clerk user.

```ts
// src/middleware.ts
import { clerkProvider } from '@xmcp-dev/clerk';

export default clerkProvider({
  secretKey: process.env.CLERK_SECRET_KEY!,
  clerkDomain: process.env.CLERK_DOMAIN!,
  baseURL: process.env.BASE_URL!,
});
```

**Dynamic Client Registration** is enabled on the Clerk instance, so a compliant MCP client can
self-register and walk the user through Clerk sign-in on first connect — no manually provisioned
client ID required.

The server authenticates to the Convex backend separately, over a shared **service secret**
(`MCP_SERVICE_SECRET`) — machine-to-machine auth, independent of the per-user Clerk OAuth above.

Signing in is necessary but not sufficient: every tool call also passes through the access check
below.

---

## Access control

Clerk answers _who you are_; it does not answer _how much of my OpenAI budget you may spend_. That
is what the `mcpAccounts` table in Convex is for.

- **Anyone who signs in is auto-enrolled** on their first tool call, with a lifetime trial of
  **10 generations** (`MCP_TRIAL_GENERATION_LIMIT` on the Convex deployment; defaults to 10).
- **Only the two metered tools consume credits** — one each. Reads and plain CRUD are unlimited.
- **The quota is lifetime**, not per-month. Once it is spent, the owner has to raise the limit.
- Accounts are keyed on the caller's **verified** primary email. An unverified email is rejected,
  since limits are granted by email address.
- **The web app charges the same account.** Generating from the React UI spends a credit from the
  same balance as the MCP tools, so a spent or blocked account cannot fall back to the browser.

Enforcement sits in two places. The blocklist check runs in the MCP server on every call
(`requireMcpActor` in `src/lib/clerk-session.ts`). The credit itself is reserved inside the Convex
action, before any OpenAI call — so it cannot be bypassed by pointing a modified MCP server at the
same backend, and the counter bump and audit row commit in one transaction. If the OpenAI work then
fails, the credit is refunded. Both surfaces go through one wrapper, `withCredit` in
`convex/ai.ts`; the web path resolves its identity from the Convex token
(`requireWebActor` in `convex/lib/identity.ts`), never from the client.

Every metered call is logged to the `mcpUsage` table with a `source` of `mcp` or `web`, so spend is
attributable per person and per surface.

### Administration

Access is managed with Convex `internalMutation`s — not reachable over the internet, but callable
from the CLI, which authenticates with the deploy key:

```bash
npx convex run access:list '{"limit":50}'                                    # who has what, newest use first
npx convex run access:grant '{"email":"friend@example.com","limit":50,"note":"beta"}'
npx convex run access:setLimit '{"email":"friend@example.com","limit":25}'   # also resets a spent trial
npx convex run access:revoke '{"email":"spammer@example.com"}'               # blocks every tool
npx convex run access:reinstate '{"email":"friend@example.com"}'

npx convex run access:usage '{"limit":20}'                                   # recent calls, everyone
npx convex run access:usage '{"email":"friend@example.com"}'                 # recent calls, one person
npx convex run access:report '{}'                                            # net spend per account, last 30d
npx convex run access:report '{"since":0}'                                   # ...since the beginning

npx convex env set MCP_TRIAL_GENERATION_LIMIT 10                             # change the default trial
```

`report` breaks each account down by tool and by surface (`mcp` vs `web`), and nets out refunds —
it is the "where did my OpenAI budget go" view. `list` and `usage` are capped (defaults 50, maxima
200 and 500) so they stay bounded reads.

`grant` works before the person has ever connected — the row is matched by email when they first
sign in.

> This controls **who** and **how much**, not **how fast**: a user with a limit of 50 can still
> spend all 50 in a minute. It also assumes `MCP_SERVICE_SECRET` stays secret — anyone holding it
> can call the Convex functions directly and bypass the gate. The endpoint URL is safe to share;
> the secret is not.

---

## Connecting a client

**Claude Desktop** → Settings → Connectors → Add custom connector, and use:

```
https://mcp.oneblog.nitanjana.com/mcp
```

On first connect the client self-registers (DCR) and routes you through Clerk sign-in. After that,
tool calls resolve against your account.

Sanity check once connected:

```
auth_whoami  →  { "authType": "clerk", "userId": "user_...", "email": "...",
                  "status": "active", "generationsUsed": 0, "generationLimit": 10, "remaining": 10 }
```

A full run:

```
topics_find_trending { "domain": "ai" }
post_generate_from_topic { "domain": "ai", "topic": "<one of the returned topics>" }
posts_list { "status": "published" }
```

---

## Local development

```bash
pnpm install
pnpm dev        # starts the MCP server locally
```

### Environment variables

| Variable             | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `CLERK_SECRET_KEY`   | Clerk secret key (use the production `sk_live_…` in production)                 |
| `CLERK_DOMAIN`       | Clerk frontend/issuer domain, e.g. `clerk.oneblog.nitanjana.com`                |
| `BASE_URL`           | The MCP server's own public URL, e.g. `https://mcp.oneblog.nitanjana.com`       |
| `MCP_CONVEX_URL`     | Convex deployment URL (must be the **production** deployment in prod)           |
| `MCP_SERVICE_SECRET` | Shared secret for the MCP → Convex boundary; must match the value set on Convex |

`MCP_TRIAL_GENERATION_LIMIT` and `OPENAI_API_KEY` are set on the **Convex** deployment
(`npx convex env set …`), not here.

> In production, set every variable on the deployment (Vercel → project → Settings → Environment
> Variables, **Production** scope) and redeploy — env changes don't apply to the existing build.
> Ensure `CLERK_DOMAIN` points at the production Clerk instance and `MCP_CONVEX_URL` at the production
> Convex deployment, or auth and data calls resolve against the wrong environment.

---

## How it fits together

```
MCP client ──Clerk OAuth──▶ this server ──service secret──▶ Convex ──▶ OpenAI
```

See the [root README](../README.md) for the full-project overview and the web app.
