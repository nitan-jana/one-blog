import { type XmcpConfig } from 'xmcp';

const config: XmcpConfig = {
  http: true,
  paths: {
    tools: './src/tools',
    prompts: false,
    resources: false,
  },
  // The bundler must not typecheck. `src/lib/convex-client.ts` imports the root deployment's
  // generated `api`, whose types reach into `convex/*.ts` — and module resolution from there walks
  // up to the repo root, never into `mcp-server/node_modules`. In a deploy that installs only this
  // package, none of those imports resolve and every handler collapses to `any`. Only the types
  // travel that path; `api` is `anyApi` at runtime, so bundling never needed them. Types are
  // gated by `pnpm typecheck`, which runs where the whole workspace is installed.
  typescript: {
    skipTypeCheck: true,
  },
  template: {
    name: 'one-blog',
    description: 'One Blog MCP server',
  },
};

export default config;
