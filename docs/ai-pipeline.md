# The AI pipeline

How topic research and post generation work. Everything lives in
[`convex/ai.ts`](../convex/ai.ts) (412 lines), reached from two front doors: the in-app AI writer
and the MCP server's two metered tools.

## Why it lives in Convex

Line 1 is `'use node'`. Convex runs functions in a V8 isolate by default; the `openai` SDK needs
Node built-ins, so the directive forces this file into Convex's Node runtime. Slower cold starts,
but it buys the official SDK.

The bigger constraint shaping the file is Convex's execution model:

| Kind       | I/O     | Database   | Transactional |
| ---------- | ------- | ---------- | ------------- |
| `query`    | no      | read       | —             |
| `mutation` | no      | read+write | yes           |
| `action`   | **yes** | **no**     | no            |

OpenAI calls are I/O, so they must be actions. Actions cannot write to the database. **Every write
here therefore goes through `ctx.runMutation`.** That one rule explains most of the structure — and
it is why metering is trustworthy: the counter bump lands in a real transaction, while the OpenAI
call does not.

## File layout

| Lines   | Contents                                                      |
| ------- | ------------------------------------------------------------- |
| 13–33   | Types                                                         |
| 38–66   | `withCredit` — the metering seam                              |
| 68–74   | `getClient`                                                   |
| 76–145  | `extractText`, `parseTopics`, `parsePost` — response handling |
| 147–243 | The two prompt functions                                      |
| 245–412 | Four exported actions                                         |

Pure helpers first, side-effecting actions last. The prompt functions take a `client` parameter
rather than calling `getClient()` themselves, so they stay independently testable — they are the
part most likely to need iteration.

## Talking to OpenAI

This uses the **Responses API** (`client.responses.create`), not Chat Completions, because that is
what enables the hosted `web_search_preview` tool:

```ts
const response = await client.responses.create({
  model: modelFor('topics'),
  tools: [{ type: 'web_search_preview' }],
  input: `Find ${limit} trending topics in the "${domain}" domain…`,
});
```

OpenAI runs the search server-side and folds the results into its answer — no scraping, no separate
search API key.

The cost is that a response is not a string. It is an array of output items, some of them search
calls, some messages. Hence `extractText` (`ai.ts:76`):

```ts
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
```

Two levels of filtering — items of type `message`, then content of type `output_text` — with type
predicates so the narrowing survives into the `.map`. The web search calls themselves get dropped.

### Choosing a model

No model is hardcoded. `modelFor` ([`convex/lib/models.ts`](../convex/lib/models.ts)) resolves each
call site independently:

```
OPENAI_MODEL_<ROLE>   →   OPENAI_MODEL   →   gpt-4o
```

Roles are `topics`, `research`, and `write`. The split exists because the calls differ sharply in
difficulty: `topics` and `research` drive web search and want a capable model, while `write` is
long-form generation with no tools. Set them on the Convex deployment:

```bash
npx convex env set OPENAI_MODEL_TOPICS gpt-4o-mini
```

The pattern mirrors `trialLimit()` in `convex/access.ts` — env override, sane built-in default.

## The two operations

**`findTrendingTopicsWithOpenAI`** (`ai.ts:147`) — one call, returning a JSON array of
`{ name, searchVolume, trend, reason }`.

**`generatePostWithOpenAI`** (`ai.ts:173`) — **two chained calls:**

1. **Research** — web search on the topic: key facts, recent developments, expert opinions,
   practical examples. Produces a research summary.
2. **Write** — that summary is interpolated into the next prompt (2000+ words, Markdown), which
   returns `{ title, content }` as strict structured output. Grounding the writing pass in
   retrieved research is what separates this from generic filler, and it is why one generation
   costs enough to be worth metering.

```ts
text: {
  format: {
    type: 'json_schema',
    name: 'blog_post',
    strict: true,
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, content: { type: 'string' } },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
}
```

`strict: true` requires `additionalProperties: false` and every property listed in `required`.

> **Why the title is not its own call.** It used to be — a third request reading
> `"Generate a … title for this content about "${topic}""`. But no content was ever interpolated
> into that prompt, so it titled from the topic string alone while paying full model rates, and a
> throw there discarded an already-finished 2000-word post. Asking the writing pass for both fields
> fixes all three problems at once: the title reflects what was actually written, the round trip
> disappears, and there is no longer a step that can fail after the expensive work succeeded.

Surrounding quotes are still stripped (`parsed.title.replace(/^["']|["']$/g, '')`) — models like to
quote titles even when told not to — and `topic` remains the fallback for an empty one.

## Defensive parsing

The two response paths defend differently, and the contrast is the point.

`parseTopics` (`ai.ts:90`) has no schema on the request, so it assumes the model will misbehave —
because it does.

````ts
const fenceMatch = normalized.match(/```(?:json)?\s*([\s\S]*?)```/);
if (fenceMatch) normalized = fenceMatch[1].trim();
````

The prompt says "no markdown fences." The model sometimes adds them anyway. So strip first, then
`JSON.parse`, then validate every field of every element:

```ts
if (typeof candidate.name !== 'string' || typeof candidate.searchVolume !== 'string' || …)
  throw new Error('Invalid topics response');
```

The `slice(0, limit)` enforces the count independently — asking for 5 and receiving 7 is common.

`parsePost` (`ai.ts:128`) is the same idea with most of the work delegated. Because the write call
sets a strict `json_schema`, malformed JSON is an API-level error rather than something to unpick
here, so it only asserts the two fields are strings and the content is non-empty. No fence
stripping.

> **The principle:** prompt instructions are requests, not constraints. Validate at the boundary —
> and where the API can enforce the boundary for you, let it. `findTrendingTopicsWithOpenAI` has
> not been converted yet; doing so would delete most of `parseTopics`.

## The 2×2 action matrix

Four exported actions — two operations, two callers:

|        | Web                        | MCP                              |
| ------ | -------------------------- | -------------------------------- |
| Topics | `findTrendingTopics` (245) | `findTrendingTopicsForMcp` (279) |
| Post   | `generatePost` (322)       | `generatePostForMcp` (364)       |

This is not duplicated logic. The OpenAI work is shared (`generatePostWithOpenAI`) and so is the
metering (`withCredit`). Only the ends differ:

```ts
// web — identity from the Convex token
const actor = await requireWebActor(ctx.auth);
await ctx.runMutation(api.posts.create, { userId: actor.userId, … });

// mcp — identity asserted by the service secret
assertServiceSecret(args.serviceSecret);
await ctx.runMutation(anyApi.mcp.postsCreateForMcp, { serviceSecret: args.serviceSecret, … });
```

That asymmetry is the point. The web path writes through `api.posts.create`, which re-checks
`ctx.auth.getUserIdentity()` itself. The MCP path writes through `mcp.postsCreateForMcp`, which has
no user identity available and instead trusts the service secret. **Two trust models cannot share
one write path**, so the entry and exit differ while the expensive middle is shared.

Inside `convex/`, the MCP variants reach for `anyApi` rather than the typed `api` because of a
circular-reference limitation in Convex's generated types when actions call modules that reference
them back. That is a Convex-internal constraint and does not apply to the MCP server, which imports
the generated `api` directly — see [Typing the boundary](#typing-the-boundary) below.

## `withCredit` — the metering seam

```ts
const reserved = await ctx.runMutation(internal.access.consume, {
  email,
  userId,
  tool,
  cost: 1,
  source,
});
try {
  return await work({ used: reserved.used, limit: reserved.limit, remaining: reserved.remaining });
} catch (error) {
  await ctx.runMutation(internal.access.refund, { usageId: reserved.usageId });
  throw error;
}
```

Reserve **before** spending, refund on failure. The ordering matters: charging afterwards means a
crash between OpenAI returning and the counter incrementing is a free generation. Charging first
means the worst case is an unfairly spent credit, which the refund usually recovers.

`consume` is an `internalMutation` — unreachable from the internet, callable only from inside
Convex — so no external caller can skip the check regardless of what credentials they hold. The
generic signature (`work: (quota: Quota) => Promise<T>`) is what lets four actions return four
shapes through one wrapper.

Full quota semantics: [Access control](../mcp-server/README.md#access-control).

## End to end

**Web** — `src/features/ai-writer/index.tsx` → `useAction(api.ai.findTrendingTopics)` →
`requireWebActor` → `consume` → OpenAI → `api.topics.createBatch` → `{ topics, quota }` → user picks
a topic → `generatePost` → two OpenAI calls → `api.posts.create`.

**MCP** — Claude Desktop → `topics_find_trending` → `requireMcpActor` (Clerk identity + blocklist) →
`convex.action(api.ai.findTrendingTopicsForMcp)` with the service secret → _the same action
body_ → returned as `structuredContent` plus a human sentence:
`"Found 5 trending topic(s)… 9 of 10 generations remaining."`

Same OpenAI code, same quota ledger, two front doors.

## Typing the boundary

`mcp-server/` is its own pnpm workspace, so it has no Convex functions of its own and no codegen of
its own. It imports the root deployment's instead:

```ts
// mcp-server/src/lib/convex-client.ts
import { api } from '../../../convex/_generated/api';
```

That single import is what makes the boundary typechecked. Function names, argument shapes, and
return types all come from the real Convex functions, so renaming one or changing its signature is
a **build error in the MCP server** rather than a runtime failure in production.

The client's exported types are derived rather than restated, which is the part that stops them
drifting:

```ts
export type PostStatus = NonNullable<FunctionArgs<typeof api.mcp.postsListForMcp>['status']>;
export type AccountSummary = FunctionReturnType<typeof api.access.ensureAccountForMcp>;
```

Two things make this cheap. `api` is `anyApi` at runtime (see `convex/_generated/api.js`), so
nothing is bundled and execution is unchanged — the entire benefit is at compile time. And
`skipLibCheck: true` in `mcp-server/tsconfig.json` absorbs the fact that the generated `api.d.ts`
type-imports `convex/ai.ts`, which imports `openai` — a package the MCP server does not depend on
and does not need.

> **Historical note.** `mcp-server/` used to contain its own `convex/_generated/` directory
> containing an _empty_ API (`ApiFromModules<{}>`), scaffolded by the Convex CLI because the package
> depends on `convex`. Nothing imported it, and because it typed nothing, the client fell back to
> `anyApi` plus `as` casts throughout. It has been deleted.

## Known weaknesses

- **No streaming.** `generatePost` blocks for the whole two-call chain, which can still exceed 60s
  behind a spinner. Convex actions cannot stream to a subscriber directly; this would mean writing
  chunks to a table and letting a reactive query carry them.
- **No retry on transient failures.** A 429 or 503 fails the generation outright. The credit is
  refunded, but the user still sees an error.
- **`parseTopics` throws one opaque message** for four distinct failure modes, so debugging a bad
  response means reading raw logs. Converting the topics call to structured output — as the write
  call now is — would remove most of that code rather than improve its error messages.
- **The research pass is unbounded.** Its summary is interpolated whole into the write prompt, so a
  long research response silently inflates the second call's input cost.
