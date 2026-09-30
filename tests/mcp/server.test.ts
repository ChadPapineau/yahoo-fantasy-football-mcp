// server.test.ts — the MCP surface as a client sees it (plan 10 A3a, plan 05 §5 smoke assertions
// in-process): tools/list equals tests/smoke/expected-tools.json in order with no write tool whatever
// FF_WRITE_ENABLED says; instructions carry the plan 02 §6.3 rule exactly once in both eras; every
// description ends with the ≤ 45-char pointer; annotations by family (plan 01 §4.1); list/resource
// results carry ttlMs + cacheScope private; the three 1a prompts; G3 only in fixture mode.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UNTRUSTED_POINTER, UNTRUSTED_TEXT_RULE } from "../../src/mcp/envelope.js";
import { FAMILY_ANNOTATIONS } from "../../src/mcp/define.js";
import {
  DEBUG_TOOL_NAME,
  REGISTRY,
  TOOL_CONTRACT,
  toolNames,
  toolsFor,
} from "../../src/mcp/registry.js";
import { LIST_TTL_MS, SERVER_INSTRUCTIONS, SERVER_NAME } from "../../src/mcp/server.js";
import {
  DEBUG_ECHO_TEXT,
  SDK_VERSION,
  TOOL_CONTRACT as STATUS_CONTRACT,
} from "../../src/mcp/tools/ops.js";
import { ROOT, connect, makeWorld, type World } from "./helpers/env.js";

const expected = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "smoke", "expected-tools.json"), "utf8"),
) as { core: string[]; full: string[] };
const manifest = JSON.parse(
  readFileSync(path.join(ROOT, "skills", "_shared", "manifest.json"), "utf8"),
) as { tools: string[]; tool_contract: number; server: string };
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
};

const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

let world: World;
beforeAll(async () => {
  world = await makeWorld({ publish: false });
});
afterAll(() => {
  world.cleanup();
});

describe("tools/list (A3a)", () => {
  it("core in production mode equals expected-tools.json, in registry order", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expected.core);
    expect(names).toHaveLength(19);
    await close();
  });

  it("the expected list, the registry and the Skills manifest agree (19 names, same order)", () => {
    expect(expected.core).toEqual(manifest.tools);
    expect(toolNames("core", false)).toEqual(expected.core);
    expect(toolNames("full", false)).toEqual(expected.full);
    expect(REGISTRY.map((e) => e.tool.name)).toEqual(expected.core);
    expect(new Set(expected.core).size).toBe(expected.core.length);
  });

  it("full registers the same list in Phase 1a (no P1/P2 tool exists yet)", async () => {
    const { client, close } = await connect(world, {
      options: { toolset: "full", fixtureMode: false },
    });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expected.full);
    expect(toolsFor("full")).toEqual(toolsFor("core"));
    await close();
  });

  it("no ff_prepare_*/ff_commit_*/cancel tool is ever registered, even with FF_WRITE_ENABLED=1", async () => {
    const w = await makeWorld({ publish: false, env: { FF_WRITE_ENABLED: "1" } });
    expect(w.config.writeRequested).toBe(true);
    for (const toolset of ["core", "full"] as const) {
      const { client, close } = await connect(w, { options: { toolset } });
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => /prepare|commit|cancel/.test(n))).toEqual([]);
      await close();
    }
    w.cleanup();
  });

  it("fixture mode appends ff_debug_echo last; production mode never lists it", async () => {
    const fx = await connect(world, { options: { fixtureMode: true } });
    const names = (await fx.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual([...expected.core, DEBUG_TOOL_NAME]);
    await fx.close();
    expect(expected.core).not.toContain(DEBUG_TOOL_NAME);
    expect(expected.full).not.toContain(DEBUG_TOOL_NAME);
  });

  it("every description ends with the pointer (≤ 45 chars) and never carries the rule sentence", async () => {
    expect(UNTRUSTED_POINTER.length).toBeLessThanOrEqual(45);
    const { client, close } = await connect(world);
    for (const t of (await client.listTools()).tools) {
      expect(t.description?.endsWith(UNTRUSTED_POINTER)).toBe(true);
      expect(count(t.description ?? "", UNTRUSTED_POINTER)).toBe(1);
      expect(t.description).not.toContain(UNTRUSTED_TEXT_RULE.slice(0, 60));
      expect(t.name).toMatch(/^ff_[a-z][a-z0-9_]{1,36}$/);
    }
    await close();
  });

  it("annotations follow the plan 01 §4.1 family table (record = local write, idempotent)", async () => {
    const { client, close } = await connect(world);
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    expect(byName.get("ff_record_recommendation")?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const n of ["ff_get_roster", "ff_list_leagues", "ff_get_league", "ff_list_players"])
      expect(byName.get(n)?.annotations).toEqual(FAMILY_ANNOTATIONS.platform);
    for (const n of ["ff_project_players", "ff_analyze_lineup", "ff_analyze_waivers"])
      expect(byName.get(n)?.annotations).toEqual(FAMILY_ANNOTATIONS.analytics);
    expect(byName.get("ff_get_status")?.annotations).toEqual(FAMILY_ANNOTATIONS.ops);
    for (const t of byName.values()) {
      if (t.name === "ff_record_recommendation") continue;
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
    await close();
  });

  it("the C10 list tools carry no outputSchema; every other tool does (a superset outline)", async () => {
    const { client, close } = await connect(world);
    const c10 = new Set(["ff_list_players", "ff_list_transactions", "ff_list_recommendations"]);
    for (const t of (await client.listTools()).tools) {
      if (c10.has(t.name)) expect(t.outputSchema).toBeUndefined();
      else {
        expect(t.outputSchema?.type).toBe("object");
        expect(t.outputSchema?.required).toEqual(["data", "meta"]);
      }
    }
    await close();
  });

  it("input schemas advertise the real shape without the long key patterns", async () => {
    const { client, close } = await connect(world);
    const tools = (await client.listTools()).tools;
    const record = tools.find((t) => t.name === "ff_record_recommendation");
    expect(Object.keys(record?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["kind", "week", "rec", "alternatives", "source_calls", "client_ref"]),
    );
    expect(JSON.stringify(tools)).not.toContain('"pattern"');
    expect(record?.inputSchema.required).toEqual(expect.arrayContaining(["kind", "week", "rec"]));
    await close();
  });
});

describe("instructions: the rule sentence exactly once (plan 02 §6.3; C13)", () => {
  it("legacy era (initialize result)", async () => {
    const { client, close } = await connect(world);
    const i = client.getInstructions() ?? "";
    expect(count(i, UNTRUSTED_TEXT_RULE)).toBe(1);
    expect(i.startsWith(UNTRUSTED_TEXT_RULE)).toBe(true);
    expect(i).toBe(SERVER_INSTRUCTIONS);
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(SERVER_NAME).toBe(manifest.server);
    await close();
  });

  it("2026-07-28 era (server/discover through serveStdio) with ttlMs/cacheScope on discovery", async () => {
    const { client, close } = await connect(world, { modern: true });
    expect(client.getProtocolEra()).toBe("modern");
    const d = client.getDiscoverResult() as unknown as {
      instructions: string;
      ttlMs: number;
      cacheScope: string;
    };
    expect(count(d.instructions, UNTRUSTED_TEXT_RULE)).toBe(1);
    expect(d.ttlMs).toBe(LIST_TTL_MS);
    expect(d.cacheScope).toBe("private");
    await close();
  });
});

describe("lists carry ttlMs + cacheScope private (plan 01 §3.1)", () => {
  it("tools/list, resources/list, templates, prompts/list, and each resource read", async () => {
    const { client, close } = await connect(world, { modern: true });
    for (const r of [
      await client.listTools(),
      await client.listResources(),
      await client.listResourceTemplates(),
      await client.listPrompts(),
    ]) {
      const c = r as unknown as { ttlMs: number; cacheScope: string };
      expect(c.ttlMs).toBe(LIST_TTL_MS);
      expect(c.cacheScope).toBe("private");
    }
    const read = (await client.readResource({ uri: "ff://status/freshness" })) as unknown as {
      ttlMs: number;
      cacheScope: string;
    };
    expect(read.ttlMs).toBe(60_000);
    expect(read.cacheScope).toBe("private");
    const docs = (await client.readResource({ uri: "ff://docs/tool-outputs" })) as unknown as {
      ttlMs: number;
    };
    expect(docs.ttlMs).toBe(86_400_000);
    await close();
  });

  it("resources/list names the five static 1a resources and the two templates", async () => {
    const { client, close } = await connect(world);
    expect((await client.listResources()).resources.map((r) => r.uri).sort()).toEqual([
      "ff://docs/tool-outputs",
      "ff://league",
      "ff://league/settings",
      "ff://status",
      "ff://status/freshness",
    ]);
    expect(
      (await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate).sort(),
    ).toEqual(["ff://rec/week/{week}", "ff://rec/{log_id}"]);
    await close();
  });

  it("prompts/list has exactly the three 1a prompts", async () => {
    const { client, close } = await connect(world);
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
      "ff.start_sit",
      "ff.stream",
      "ff.retro",
    ]);
    await close();
  });
});

describe("G3 ff_debug_echo (A17, fixture mode only)", () => {
  it("returns a nonce ONLY in structuredContent; the text block omits it", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: true } });
    const r = (await client.callTool({ name: DEBUG_TOOL_NAME, arguments: {} })) as {
      content: { type: string; text: string }[];
      structuredContent: { data: { nonce: string }; meta: { request_id: string } };
    };
    const nonce = r.structuredContent.data.nonce;
    expect(nonce).toMatch(/^[0-9a-f]{12}$/);
    expect(r.content).toEqual([{ type: "text", text: DEBUG_ECHO_TEXT }]);
    expect(JSON.stringify(r.content)).not.toContain(nonce);
    const again = (await client.callTool({ name: DEBUG_TOOL_NAME, arguments: {} })) as {
      structuredContent: { data: { nonce: string } };
    };
    expect(again.structuredContent.data.nonce).not.toBe(nonce);
    const bad = await client.callTool({ name: DEBUG_TOOL_NAME, arguments: { x: 1 } });
    expect(bad.isError).toBe(true);
    await close();
  });

  it("is not callable in production mode (unknown tool)", async () => {
    const { client, close } = await connect(world, { options: { fixtureMode: false } });
    const r = await client
      .callTool({ name: DEBUG_TOOL_NAME, arguments: {} })
      .then((x) => ({ ok: true, x }))
      .catch((e: unknown) => ({ ok: false, x: e }));
    const failed = !r.ok || (r.x as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    await close();
  });
});

describe("contract constants", () => {
  it("TOOL_CONTRACT matches the Skills manifest and G1; the SDK pin matches package.json", () => {
    expect(TOOL_CONTRACT).toBe(manifest.tool_contract);
    expect(STATUS_CONTRACT).toBe(TOOL_CONTRACT);
    expect(pkg.dependencies["@modelcontextprotocol/server"]).toBe(SDK_VERSION);
  });
});
