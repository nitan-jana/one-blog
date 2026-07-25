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
| `auth_whoami`                | Return the authenticated MCP user identity                        | read-only      |
| `posts_list`                 | List the authenticated user's posts (paginated, filter by status) | read-only      |
| `posts_get`                  | Fetch a single post by id                                         | read-only      |
| `topics_find_trending`       | Research trending topics for a domain and persist them            | read-only      |
| `topics_list_recent_domains` | List the user's recently searched domains                         | read-only      |
| `post_generate_from_topic`   | Research a topic, generate a full post, and save it               | non-idempotent |
| `posts_create`               | Create a post for the authenticated user                          | non-idempotent |
| `posts_update`               | Update an existing post                                           | idempotent     |
| `posts_delete`               | Delete a post                                                     | destructive    |

All `posts_*` and `topics_*` tools operate on **the authenticated user's** data — there is no
anonymous read or write path.

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
auth_whoami  →  { "authType": "clerk", "userId": "user_...", "email": "..." }
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
| `CONVEX_URL`         | Convex deployment URL (must be the **production** deployment in prod)           |
| `MCP_SERVICE_SECRET` | Shared secret for the MCP → Convex boundary; must match the value set on Convex |

> In production, set every variable on the deployment (Vercel → project → Settings → Environment
> Variables, **Production** scope) and redeploy — env changes don't apply to the existing build.
> Ensure `CLERK_DOMAIN` points at the production Clerk instance and `CONVEX_URL` at the production
> Convex deployment, or auth and data calls resolve against the wrong environment.

---

## How it fits together

```
MCP client ──Clerk OAuth──▶ this server ──service secret──▶ Convex ──▶ OpenAI
```

See the [root README](../README.md) for the full-project overview and the web app.
