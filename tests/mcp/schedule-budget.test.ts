// schedule-budget.test.ts — D3 ff_get_schedule over budget is cut by WHOLE weeks, says which weeks
// it dropped, and never advises an argument the tool does not accept (QA-1-006, QA-1-034; plan 01
// §4.2 "a warning says how to page or filter"); and, for every tool, the truncation advice names
// only inputs that tool accepts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { truncationHint } from "../../src/mcp/define.js";
import { RESULT_BUDGET_CHARS } from "../../src/mcp/envelope.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { connect, makeWorld, type World } from "./helpers/env.js";

interface D3 {
  data: { games: { week: number }[]; byes: Record<string, string[]> };
  page?: unknown;
  truncated: boolean;
  warnings: string[];
}

describe("ff_get_schedule over budget (QA-1-006, QA-1-034)", () => {
  let world: World;
  beforeAll(async () => {
    world = await makeWorld();
  }, 60_000);
  afterAll(() => {
    world.cleanup();
  });

  it("6 weeks: whole weeks kept from the first, dropped weeks named, byes for every week", async () => {
    const { client, close } = await connect(world);
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "ff_get_schedule", arguments: args });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      expect(r.isError, text.slice(0, 200)).not.toBe(true);
      expect(text.length).toBeLessThanOrEqual(RESULT_BUDGET_CHARS);
      return JSON.parse(text) as D3;
    };
    const perWeek = new Map<number, number>();
    for (const w of [1, 2, 3, 4, 5, 6])
      perWeek.set(w, (await call({ weeks: [w] })).data.games.length);
    const b = await call({ weeks: [1, 2, 3, 4, 5, 6] });
    expect(b.truncated).toBe(true);
    const shown = new Map<number, number>();
    for (const g of b.data.games) shown.set(g.week, (shown.get(g.week) ?? 0) + 1);
    const weeks = [...shown.keys()].sort((x, y) => x - y);
    // whole weeks only, a prefix of the requested weeks
    expect(weeks).toEqual([1, 2, 3, 4, 5, 6].slice(0, weeks.length));
    expect(weeks.length).toBeGreaterThanOrEqual(1);
    for (const w of weeks) expect(shown.get(w), `week ${String(w)}`).toBe(perWeek.get(w));
    // every requested week's byes are still answered
    expect(Object.keys(b.data.byes).sort()).toEqual(["1", "2", "3", "4", "5", "6"]);
    const text = b.warnings.join(" ");
    const dropped = [1, 2, 3, 4, 5, 6].filter((w) => !shown.has(w));
    expect(dropped.length).toBeGreaterThan(0);
    for (const w of dropped) expect(text).toContain(String(w));
    expect(text).not.toMatch(/\blimit\b|\boffset\b/);
    expect(text).toMatch(/fewer weeks/);
    expect(b.page).toBeUndefined();
    // following the advice works: the dropped weeks alone are answered
    const rest = await call({ weeks: dropped.slice(0, 2) });
    expect(rest.data.games.length).toBe(
      dropped.slice(0, 2).reduce((n, w) => n + (perWeek.get(w) ?? 0), 0),
    );
    await close();
  });
});

describe("every tool's truncation advice names only inputs it accepts (QA-1-006)", () => {
  const advice: readonly [RegExp, string][] = [
    [/\blimit\b/, "limit"],
    [/\boffset\b/, "offset"],
    [/\bcount\b/, "count"],
    [/\bsince\b/, "since"],
    [/\bnfl_team\b/, "nfl_team"],
    [/\bweeks\b.*\bnfl_team\b|fewer weeks/, "weeks"],
    [/detail compact/, "detail"],
  ];
  for (const { tool } of REGISTRY)
    it(tool.name, () => {
      const json = z.toJSONSchema(tool.input, { io: "input" }) as { properties?: object };
      const props = new Set(Object.keys(json.properties ?? {}));
      // arguments reach the hint only after the tool's strict parse: `detail` only where accepted
      for (const args of props.has("detail") ? [{}, { detail: "full" }] : [{}]) {
        const hint = truncationHint(tool, args);
        for (const [re, input] of advice)
          if (re.test(hint)) expect(props, `${tool.name}: "${hint}"`).toContain(input);
      }
    });
});
