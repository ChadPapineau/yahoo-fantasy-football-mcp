// @ts-check
// fixture-serve.mjs — the stdio server command the CI `smoke` job hands to the MCP Inspector CLI:
// `node dist/cli.js serve` in fixture mode (FF_FIXTURE_DIR, FF_TOOLSET=core) over a private temp
// home, config and cache. A launcher rather than `-e KEY=VALUE` flags because an MCP stdio client
// passes only a safe subset of its environment to the server by default, and this way the smoke
// does not depend on one Inspector version's env flags. The temp root is removed on exit.
import { rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, fixtureEnv } from "./smoke-lib.mjs";

const { root, env } = fixtureEnv({ logLevel: "warn" });
for (const [k, v] of Object.entries(env)) if (k !== "PATH") process.env[k] = v;
process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
const entry = path.join(REPO_ROOT, "dist", "cli.js");
process.argv = [process.argv[0] ?? process.execPath, entry, "serve"];
await import(pathToFileURL(entry).href);
