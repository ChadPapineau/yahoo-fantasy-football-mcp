// server.ts — createServer (plan 01 §3.1/§4): one McpServer named `fantasy-football-mcp-server`
// with the plan 02 §6.3 untrusted-text rule served ONCE in `instructions` (plus a short guide),
// tools/resources/prompts capabilities, `ttlMs`/`cacheScope: "private"` on every cacheable list
// (300 000 ms — plan 01 §3.1), the registry's tools in order (FF_TOOLSET; G3 only in fixture mode),
// and the Phase-1a resources and prompts. No I/O here: the composition root injects everything.
import { McpServer, type CacheHint } from "@modelcontextprotocol/server";
import { UNTRUSTED_TEXT_RULE } from "./envelope.js";
import { registerDefinedTool } from "./define.js";
import { registerPrompts } from "./prompts/index.js";
import { toolsFor } from "./registry.js";
import { registerResources } from "./resources/index.js";
import type { McpServerOptions, McpServices } from "./services.js";
import { registerDebugEcho } from "./tools/ops.js";

/** The server name clients and the Skills use (plan 01 §4.1; skills/_shared/manifest.json). */
export const SERVER_NAME = "fantasy-football-mcp-server";

/** `ttlMs` for the list results and discovery (plan 01 §3.1). */
export const LIST_TTL_MS = 300_000;

/** The short usage guide after the rule sentence (static; no dynamic text — plan 07 §5.4). */
export const SERVER_GUIDE = [
  "Fantasy-football analysis for the operator's own league, read-only: no tool changes the league.",
  "Start with ff_get_status and ff_get_league once per session; ff://docs/tool-outputs lists every tool's fields.",
  "Every result is an envelope {data, meta, page, truncated, warnings}; meta.estimate marks numbers that are this server's own, and every Dist carries its basis.",
  "Log a recommendation with ff_record_recommendation before presenting it.",
].join(" ");

/** The `instructions` text: the rule sentence exactly once, then the guide. */
export const SERVER_INSTRUCTIONS = `${UNTRUSTED_TEXT_RULE}\n\n${SERVER_GUIDE}`;

const LIST_HINT: CacheHint = { ttlMs: LIST_TTL_MS, cacheScope: "private" };

/** Builds the server (tools, resources, prompts) over the injected services. */
export function createServer(services: McpServices, options: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: SERVER_INSTRUCTIONS,
      cacheHints: {
        "tools/list": LIST_HINT,
        "prompts/list": LIST_HINT,
        "resources/list": LIST_HINT,
        "resources/templates/list": LIST_HINT,
        "server/discover": LIST_HINT,
      },
    },
  );
  for (const tool of toolsFor(options.toolset))
    registerDefinedTool(server, tool, services, options);
  if (options.fixtureMode) registerDebugEcho(server, services);
  registerResources(server, services, options);
  registerPrompts(server, services, options);
  return server;
}
