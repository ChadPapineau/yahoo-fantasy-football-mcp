// @ts-check
// run-smoke.mjs — `npm run smoke`: the A3a smoke (plan 10 §3.1a; plan 04 §4.1) against the BUILT
// server over real stdio, in fixture mode (FF_TOOLSET=core): `node dist/cli.js serve` spawned by the
// SDK's StdioClientTransport, once per protocol era (legacy `initialize`; 2026-07-28 discovery).
// Asserts tools/list = tests/smoke/expected-tools.json (+ ff_debug_echo, fixture mode only), no
// ff_prepare_*/ff_commit_*, every description ends with the pointer, the rule sentence exactly
// once in the instructions, the 1a resources/templates (ttlMs + cacheScope in the modern era), the
// three prompts, G3's nonce only in structuredContent, a clean stdin-EOF shutdown and no error-level
// stderr line. No network; temp dirs only. Exit 0 = pass, 1 = a check failed, 2 = not built.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  DEBUG_TOOL,
  REPO_ROOT,
  checkDescriptions,
  checkInstructions,
  checkPrompts,
  checkResources,
  checkToolNames,
  fixtureEnv,
  readExpectedTools,
} from "./smoke-lib.mjs";

const ENTRY = path.join(REPO_ROOT, "dist", "cli.js");

/**
 * One era: spawn, list, check, close; returns the problems.
 * @param {"legacy" | "modern"} era
 * @returns {Promise<string[]>}
 */
async function runEra(era) {
  const { root, env } = fixtureEnv();
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "serve"],
    env,
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (/** @type {Buffer} */ b) => stderr.push(b.toString("utf8")));
  const client = new Client(
    { name: "ff-smoke", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" } } : {},
  );
  try {
    const t0 = performance.now();
    await client.connect(transport);
    const connectMs = Math.round(performance.now() - t0);
    const tools = await client.listTools();
    const expected = readExpectedTools();
    problems.push(
      ...checkToolNames(
        tools.tools.map((t) => t.name),
        expected.core,
        { fixtureMode: true },
      ),
      ...checkDescriptions(tools.tools),
      ...checkInstructions(client.getInstructions()),
      ...checkResources(await client.listResources(), await client.listResourceTemplates(), {
        requireCacheHints: era === "modern",
      }),
      ...checkPrompts(await client.listPrompts()),
    );
    const status = await client.callTool({ name: "ff_get_status", arguments: {} });
    if (status.isError === true) problems.push("ff_get_status returned an error");
    const echo = await client.callTool({ name: DEBUG_TOOL, arguments: {} });
    const sc = /** @type {{ data?: { nonce?: unknown } } | undefined} */ (echo.structuredContent);
    const nonce = sc?.data?.nonce;
    if (typeof nonce !== "string" || !/^[0-9a-f]{12}$/.test(nonce))
      problems.push(`${DEBUG_TOOL}: no nonce in structuredContent`);
    else if (JSON.stringify(echo.content).includes(nonce))
      problems.push(`${DEBUG_TOOL}: the nonce leaked into the text content`);
    process.stdout.write(
      `smoke[${era}]: ${String(client.getNegotiatedProtocolVersion())}, connect ${connectMs} ms, ${tools.tools.length} tools\n`,
    );
  } catch (e) {
    problems.push(`${era}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    rmSync(root, { recursive: true, force: true });
  }
  const lines = stderr.join("").split("\n").filter(Boolean);
  for (const l of lines) {
    /** @type {unknown} */
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      problems.push(`${era}: a non-JSON stderr line`);
      continue;
    }
    const level = /** @type {{ level?: unknown }} */ (rec).level;
    if (level === "error" || level === "fatal")
      problems.push(`${era}: stderr error: ${l.slice(0, 200)}`);
  }
  if (!lines.some((l) => l.includes('"event":"serve.shutdown"') && l.includes('"reason":"stdin"')))
    problems.push(`${era}: no clean stdin-EOF shutdown logged`);
  return problems.map((p) => `[${era}] ${p}`);
}

if (!existsSync(ENTRY)) {
  process.stderr.write("smoke: dist/cli.js is missing — run `npm run build` first\n");
  process.exit(2);
}
const problems = [...(await runEra("legacy")), ...(await runEra("modern"))];
for (const p of problems) process.stderr.write(`smoke: FAIL ${p}\n`);
process.stdout.write(
  problems.length === 0 ? "smoke: PASS\n" : `smoke: ${problems.length} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
