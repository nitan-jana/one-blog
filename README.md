# One Blog

A minimal writing interface, extended into an **agent-operable AI writing tool**.

The base project is a distraction-free Markdown editor. This fork adds two things on top: an
**MCP server** that lets a language model operate the blog as a set of tools, and a **Convex +
OpenAI generation backend** that turns a topic into a researched, published post. Put together:
an LLM can **research a topic, write a full post, and publish it — without ever touching the UI.**

> Forked from [yaralahruthik/one-blog](https://github.com/yaralahruthik/one-blog). The MCP server,
> the Convex/OpenAI generation backend, and the AI writer flow are my additions; the base editor is
> YHR's. See [Credits](#credits).

**Live**

- App — https://oneblog.nitanjana.com
- MCP server — https://mcp.oneblog.nitanjana.com/mcp
- Demo (60s) — <!-- TODO: add demo video link -->

---

## What's in this fork

**1. An MCP server** ([`mcp-server/`](./mcp-server)) built with `xmcp` over HTTP transport,
authenticated per-user via Clerk OAuth. It exposes the blog as **9 tools** any MCP client (Claude
Desktop, etc.) can call — post CRUD, trending-topic research, and topic-to-published-post
generation — with proper MCP tool annotations. Full docs and setup:
**[`mcp-server/README.md`](./mcp-server/README.md)**.

**2. A Convex + OpenAI generation backend** ([`convex/`](./convex)). An OpenAI-powered generation
action behind a swappable provider abstraction, with a `draft → generating → published` status flow.
The in-app **AI writer** wraps it in a multi-step flow: domain → trending topics → generate →
publish. The MCP server calls the same backend over a service-secret boundary.

---

## Architecture

```
MCP client (e.g. Claude Desktop)
      │  Clerk OAuth (per-user)
      ▼
MCP server  (xmcp, @xmcp-dev/clerk)      ── mcp.oneblog.nitanjana.com
      │  service secret (server-to-server)
      ▼
Convex backend  ── generation, posts, topics
      │
      ▼
OpenAI  (provider-abstracted)

Web app (React + Vite + Clerk + Convex)  ── oneblog.nitanjana.com
      └─ multi-step AI writer over the same Convex backend
```

Two independent auth mechanisms, kept deliberately separate:

- **Clerk OAuth / JWT** authenticates the _human user_ (web app and MCP client).
- **A service secret** authenticates the _MCP server itself_ to Convex (machine-to-machine).

---

## Stack

Convex · OpenAI · MCP (`xmcp`, `@xmcp-dev/clerk`) · Clerk · React · Vite · TypeScript ·
Tiptap/ProseMirror

---

## Local development

```bash
pnpm install

cp .env.example .env      # fill in the values (see below)

npx convex dev            # backend
pnpm dev                  # app

cd mcp-server && pnpm dev # MCP server
```

### Environment variables

**App**

- `VITE_CONVEX_URL` — Convex deployment URL
- `VITE_CLERK_PUBLISHABLE_KEY` — Clerk publishable key

**Convex** (set on the deployment)

- `OPENAI_API_KEY`
- `MCP_SERVICE_SECRET` — shared with the MCP server
- Clerk issuer domain (referenced by `convex/auth.config.ts`)

**MCP server** — see [`mcp-server/README.md`](./mcp-server/README.md).

---

## Editor features (base project)

The writing surface is a distraction-free Tiptap/ProseMirror editor: Markdown-first, focus mode,
syntax/clutter highlighting, and Markdown export with YAML frontmatter. My editor-side contribution
to the base project was a **filler-word highlighting plugin** — a ProseMirror decoration plugin that
flags weak phrasing in real time, with the scan regex compiled once to keep it off the typing hot path.

---

## Credits

Base project by [Hruthik Reddy (YHR)](https://github.com/yaralahruthik). MCP server, Convex/OpenAI
generation backend, and AI writer flow by [Nitan Jana](https://github.com/nitan-jana).

Licensed under the terms in [LICENSE](./LICENSE).
