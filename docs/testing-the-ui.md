# Testing the UI

Manual verification for the AI writer and the generation quota it enforces. There is no automated
UI suite — Clerk sign-in makes browser tests awkward enough that it hasn't been worth it yet (see
[Automated tests](#automated-tests) at the end).

The quota states are the part worth testing deliberately: they only change when the account row in
Convex changes, so you have to drive them from the CLI.

## Start the app

```bash
npx convex dev    # backend, watch mode — redeploys on save
pnpm dev          # http://localhost:5173
```

Wait for `Convex functions ready!` before loading the page.

Sign in through the app. Every command below keys on the email you signed in with — substitute it
for `you@example.com` throughout.

## Quota states

Quota is a lifetime counter per account, shared with the MCP server. See
[Access control](../mcp-server/README.md#access-control) for how it is enforced.

### 1. Normal — the badge renders

Click **Generate**. The dialog header should read `N of 10 generations left` beside "AI Blog
Generator".

> **No badge at all?** `access:myQuota` returns `null` when the identity token carries no email
> claim. Add it to the `convex` JWT template in the Clerk dashboard — see
> [Clerk JWT template](../README.md#clerk-jwt-template) — then hard-refresh.

### 2. Out of credits — input disabled

```bash
npx convex run access:setLimit '{"email":"you@example.com","limit":0}'
```

**Do not refresh.** The badge should flip to `0 of 0` on its own, because `myQuota` is a reactive
Convex query. That live update is the real assertion here — it proves the subscription is wired.
The domain input and its submit button go disabled, and the banner shows the limit message.

### 3. Blocked — a different message

```bash
npx convex run access:revoke '{"email":"you@example.com"}'
```

The banner should change to "Access to AI generation has been revoked for this account." On the
topics step, the topic buttons dim and stop responding.

### 4. Spend a real credit

```bash
npx convex run access:reinstate '{"email":"you@example.com"}'
npx convex run access:setLimit '{"email":"you@example.com","limit":10}'
```

Generate for real — **this spends OpenAI credit.** Watch the badge decrement, then check the audit
trail:

```bash
npx convex run access:report '{"email":"you@example.com"}'
```

Look for `bySource: { mcp: 0, web: 1 }`. That field is the point of the whole metering change: it
proves the web path went _through_ the credit wrapper rather than around it.

## The refund path

Worth exercising occasionally — it is the branch most likely to rot unnoticed, since it only runs
when OpenAI fails.

```bash
npx convex env unset OPENAI_API_KEY
# generate in the UI — it fails
npx convex run access:usage '{"email":"you@example.com","limit":1}'   # expect refunded: true
npx convex env set OPENAI_API_KEY sk-...
```

`generationsUsed` should be unchanged afterward.

> **Restore the key.** The Convex deployment is shared with the MCP server, so leaving it unset
> breaks generation there too.

Note that the refund is best-effort: it fires on a caught exception, so an action timeout still
leaks the credit. See the known limitations in
[`mcp-server/README.md`](../mcp-server/README.md#access-control).

## Editor

The editor half of the app is independent of Convex — entries autosave to `localStorage` (3s
debounce, 10 entries max, `src/lib/storage.ts`). It works signed out. Quick pass:

- Type; wait 3s; the "Saved" indicator appears top-right.
- Reload, then load the entry back from the save/load menu.
- Toggle focus mode and filler-word highlighting from the settings menu.

## Automated tests

None currently. The tractable version would be Playwright driving a
[Clerk testing token](https://clerk.com/docs/testing/overview) rather than a real sign-in flow —
the interactive email-code step is what makes the naive approach painful.

The higher-value target is `convex/access.ts` rather than the UI: it is pure mutation logic with no
external I/O, and `convex-test` covers it well — the limit boundary, refund idempotency, the
email-vs-userId account matching, and the blocklist.
