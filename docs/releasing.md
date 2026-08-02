# Releasing

Three deployable units share one Convex backend:

| Unit                      | Deployed to       | Built from                         |
| ------------------------- | ----------------- | ---------------------------------- |
| Convex functions + schema | Convex production | `npx convex deploy`                |
| Web app                   | Vercel            | repo root                          |
| MCP server                | Vercel            | `mcp-server/` (isolated workspace) |

They are **not independently deployable** when a change alters the Convex API surface. The backend
is shared, so a signature change breaks whichever client is still running old code.

## Before deploying: the Clerk JWT template

The production Clerk instance → **JWT Templates → `convex`** must include:

```json
{ "email": "{{user.primary_email_address}}", "email_verified": "{{user.email_verified}}" }
```

`requireWebActor` ([`convex/lib/identity.ts`](../convex/lib/identity.ts)) throws without it, and
generation quotas are keyed on email. Verify this **before** deploying Convex, not after — the web
app breaks the moment the backend updates.

## Release order

```bash
# 1. Convex first — it is the dependency of both clients
npx convex deploy

# 2. then both clients, promptly
#    - web app  (Vercel, repo root)
#    - MCP server (Vercel, root directory mcp-server/)
```

Between steps 1 and 2 old clients are talking to the new backend. There is no ordering that avoids
this when function signatures change — deploying clients first would have them calling functions
that do not exist yet. Keep the gap short.

Environment variables are set on the deployment, not in the build, and `npx convex deploy` does not
change them. Adding a new one requires `npx convex env set --prod`.

## Checking what production is actually running

Worth doing before any release — deployments drift.

```bash
npx convex function-spec --prod | grep -o '"identifier": "[^"]*"'   # what exists
npx convex env list --prod                                          # what is configured
```

## Compatibility checklist

A change needs a coordinated release if it does any of these:

- **Adds or removes a required argument** on a function a client calls. Convex rejects both missing
  and unrecognised fields, so this breaks in both directions.
- **Removes a function.** Clients calling it get a runtime error.
- **Changes a return shape.** The client compiles against its own copy of the types and will
  mis-handle the response.
- **Changes the schema** in a way existing documents violate. Adding _optional_ fields and adding
  or dropping indexes are all safe; `npx convex deploy` validates existing documents and refuses
  the deploy if they do not match.

Renaming a Convex function is caught at build time in the MCP server, which imports the generated
`api` types — see [Typing the boundary](./ai-pipeline.md#typing-the-boundary). It is **not** caught
in the web app, which resolves `api` through the same codegen but is deployed from the same commit,
so the two stay in step.

## MCP server build notes

The MCP server is an isolated pnpm workspace (`packages: []`, its own lockfile), so a deploy
installs only its dependencies — the repo root `node_modules` does not exist there. Two
consequences, both already handled, both easy to reintroduce:

- Its build does not type-check (`typescript.skipTypeCheck` in `xmcp.config.ts`). Run
  `pnpm typecheck` in `mcp-server/` instead; root `vp check` skips the package entirely
  (`ignorePatterns` in `vite.config.ts`).
- It must not _value_-import anything under `convex/`. Type-only imports are fine.

To reproduce a deploy build locally — the failure mode is invisible otherwise, because local
resolution falls back to the repo root:

```bash
cp -r mcp-server /tmp/repro-mcp && rm -rf /tmp/repro-mcp/node_modules /tmp/repro-mcp/dist
mkdir -p /tmp/repro-convex && cp -r convex/_generated /tmp/repro-convex/
cd /tmp/repro-mcp && pnpm install --ignore-workspace && pnpm build
```

## Post-deploy smoke test

```bash
npx convex function-spec --prod | grep access     # access.* present
npx convex run --prod access:list '{}'            # [] — tables exist, no accounts yet
```

Then sign in to the web app and confirm the quota badge shows real numbers — that proves the
`email` claim resolves in production. Generate once, and check it was metered:

```bash
npx convex run --prod access:report '{}'          # expect bySource: { web: 1 }
```

Finally connect an MCP client and run `auth_whoami`; it should report your email and remaining
credits. Quota-state checks are in [`testing-the-ui.md`](./testing-the-ui.md).
