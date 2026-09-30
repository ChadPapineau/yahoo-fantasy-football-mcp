// smoke-lib.test.ts — the smoke assertions themselves (tests/smoke/smoke-lib.mjs; plan 10 A3a):
// each check passes the real registry's output and FAILS on the mutations that matter — a write tool,
// a reordered or missing tool, the debug tool outside fixture mode, a missing pointer, the rule
// sentence twice, a missing cache hint, a fourth prompt — plus hostile shapes (never a throw).
import { existsSync, rmSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNTRUSTED_POINTER, UNTRUSTED_TEXT_RULE } from "../../src/mcp/envelope.js";
import { DEBUG_TOOL_NAME, toolNames } from "../../src/mcp/registry.js";
import { SERVER_INSTRUCTIONS } from "../../src/mcp/server.js";
import {
  DEBUG_TOOL,
  EXPECTED_PROMPTS,
  EXPECTED_RESOURCES,
  EXPECTED_TEMPLATES,
  POINTER,
  RULE_SENTENCE,
  checkDescriptions,
  checkInstructions,
  checkPrompts,
  checkResources,
  checkToolNames,
  fixtureEnv,
  inspectorResult,
  readExpectedTools,
} from "./smoke-lib.mjs";

const expected = readExpectedTools();
const fixtureNames = toolNames("core", true);

describe("the smoke's constants track the server", () => {
  it("rule sentence, pointer and debug tool are the server's own", () => {
    expect(RULE_SENTENCE).toBe(UNTRUSTED_TEXT_RULE);
    expect(POINTER).toBe(UNTRUSTED_POINTER);
    expect(POINTER.length).toBeLessThanOrEqual(45);
    expect(DEBUG_TOOL).toBe(DEBUG_TOOL_NAME);
  });
  it("expected-tools.json is the registry's core list (19, in order), full = core in 1a", () => {
    expect(expected.core).toEqual(toolNames("core", false));
    expect(expected.core).toHaveLength(19);
    expect(expected.full).toEqual(expected.core);
  });
});

describe("checkToolNames", () => {
  it("passes the registry's fixture-mode and production lists", () => {
    expect(checkToolNames(fixtureNames, expected.core, { fixtureMode: true })).toEqual([]);
    expect(checkToolNames(expected.core, expected.core, { fixtureMode: false })).toEqual([]);
  });
  it("fails on a write tool, a reorder, a missing or extra tool, a duplicate", () => {
    const withWrite = [...expected.core, "ff_prepare_lineup"];
    expect(checkToolNames(withWrite, expected.core, { fixtureMode: false }).join()).toMatch(
      /write tool listed: ff_prepare_lineup/,
    );
    expect(
      checkToolNames(["ff_commit_x", ...expected.core], expected.core, { fixtureMode: false }),
    ).not.toEqual([]);
    const swapped = [...expected.core];
    [swapped[0], swapped[1]] = [swapped[1] ?? "", swapped[0] ?? ""];
    expect(checkToolNames(swapped, expected.core, { fixtureMode: false })).not.toEqual([]);
    expect(
      checkToolNames(expected.core.slice(1), expected.core, { fixtureMode: false }),
    ).not.toEqual([]);
    expect(
      checkToolNames([...expected.core, "ff_extra"], expected.core, { fixtureMode: false }),
    ).not.toEqual([]);
    expect(
      checkToolNames([...expected.core, expected.core[0] ?? ""], expected.core, {
        fixtureMode: false,
      }).join(),
    ).toMatch(/duplicate/);
  });
  it("the debug tool: required last in fixture mode, forbidden outside it", () => {
    expect(checkToolNames(fixtureNames, expected.core, { fixtureMode: false }).join()).toMatch(
      /outside fixture mode/,
    );
    expect(checkToolNames(expected.core, expected.core, { fixtureMode: true }).join()).toMatch(
      /missing in fixture mode/,
    );
    expect(
      checkToolNames([DEBUG_TOOL, ...expected.core], expected.core, { fixtureMode: true }).join(),
    ).toMatch(/registered last/);
  });
  it("hostile shapes are problems, never throws", () => {
    for (const bad of [null, undefined, "ff_get_status", 7, [1, 2], [{ name: "x" }], {}]) {
      expect(checkToolNames(bad, expected.core, { fixtureMode: true }).length).toBeGreaterThan(0);
    }
  });
});

describe("checkDescriptions", () => {
  const tool = (d: unknown) => ({ name: "ff_x", description: d });
  it("passes a description ending with the pointer", () => {
    expect(checkDescriptions([tool(`Does x. ${POINTER}`)])).toEqual([]);
  });
  it("fails a missing, doubled, non-string or trailing-space pointer; hostile input", () => {
    expect(checkDescriptions([tool("Does x.")])).toHaveLength(1);
    expect(checkDescriptions([tool(`${POINTER} ${POINTER}`)])).toHaveLength(1);
    expect(checkDescriptions([tool(`Does x. ${POINTER} `)])).toHaveLength(1);
    expect(checkDescriptions([tool(null)])).toHaveLength(1);
    expect(checkDescriptions([null, 3])).toHaveLength(2);
    expect(checkDescriptions("x")).toHaveLength(1);
  });
});

describe("checkInstructions", () => {
  it("the server's own instructions carry the sentence exactly once", () => {
    expect(checkInstructions(SERVER_INSTRUCTIONS)).toEqual([]);
  });
  it("zero, two, or no instructions fail", () => {
    expect(checkInstructions("hello")).toHaveLength(1);
    expect(checkInstructions(`${RULE_SENTENCE}\n${RULE_SENTENCE}`)).toHaveLength(1);
    expect(checkInstructions(undefined)).toHaveLength(1);
    expect(checkInstructions(RULE_SENTENCE.slice(0, -1))).toHaveLength(1);
  });
});

describe("checkResources / checkPrompts / inspectorResult", () => {
  const list = {
    ttlMs: 300_000,
    cacheScope: "private",
    resources: EXPECTED_RESOURCES.map((uri) => ({ uri })),
  };
  const templates = {
    ttlMs: 300_000,
    cacheScope: "private",
    resourceTemplates: EXPECTED_TEMPLATES.map((uriTemplate) => ({ uriTemplate })),
  };
  it("passes the 1a set with and without required cache hints", () => {
    expect(checkResources(list, templates, { requireCacheHints: true })).toEqual([]);
    const bare = { resources: list.resources };
    const bareT = { resourceTemplates: templates.resourceTemplates };
    expect(checkResources(bare, bareT, { requireCacheHints: false })).toEqual([]);
    expect(checkResources(bare, bareT, { requireCacheHints: true })).toHaveLength(4);
  });
  it("fails a missing or extra resource, a public cache scope, hostile shapes", () => {
    expect(
      checkResources({ ...list, resources: list.resources.slice(1) }, templates, {
        requireCacheHints: true,
      }),
    ).toHaveLength(1);
    expect(
      checkResources(
        { ...list, resources: [...list.resources, { uri: "ff://roster/snapshot" }] },
        templates,
        { requireCacheHints: false },
      ),
    ).toHaveLength(1);
    expect(
      checkResources({ ...list, cacheScope: "public" }, templates, { requireCacheHints: true }),
    ).toHaveLength(1);
    expect(checkResources(null, "x", { requireCacheHints: true }).length).toBeGreaterThan(1);
  });
  it("prompts: exactly the three 1a prompts", () => {
    expect(checkPrompts({ prompts: EXPECTED_PROMPTS.map((name) => ({ name })) })).toEqual([]);
    expect(checkPrompts({ prompts: [{ name: "ff.start_sit" }] })).toHaveLength(1);
    expect(
      checkPrompts({ prompts: [...EXPECTED_PROMPTS, "ff.weekly"].map((name) => ({ name })) }),
    ).toHaveLength(1);
    expect(checkPrompts([])).toHaveLength(1);
  });
  it("inspectorResult unwraps { result } (v2) or takes the bare object (v1)", () => {
    expect(inspectorResult({ result: { tools: [] } })).toEqual({ tools: [] });
    expect(inspectorResult({ tools: [] })).toEqual({ tools: [] });
    expect(inspectorResult([1])).toBeNull();
    expect(inspectorResult("x")).toBeNull();
  });
});

describe("fixtureEnv", () => {
  it("a private temp home (0700 dirs) in fixture mode, never the real HOME", () => {
    const { root, env } = fixtureEnv();
    try {
      for (const k of ["HOME", "FF_CONFIG_DIR", "FF_CACHE_DIR"] as const) {
        const p = env[k] ?? "";
        expect(p.startsWith(root)).toBe(true);
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).mode & 0o777).toBe(0o700);
      }
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(env.FF_FIXTURE_DIR).toMatch(/fixtures$/);
      expect(env.FF_TOOLSET).toBe("core");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
