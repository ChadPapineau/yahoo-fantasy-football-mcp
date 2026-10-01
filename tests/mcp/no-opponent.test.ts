// no-opponent.test.ts — a week with no `opponents:` entry in league.yaml (QA-1-008, QA-1-028): E3's
// NOT_FOUND hint is actionable FOR E3 (it names no argument E3 lacks — plan 01 §4.3 errors exist so
// the model can self-correct), following it works, and ff_get_scoreboard names the missing matchup
// instead of answering an empty list silently (plan 01 §5.7: a missing driver is named).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { analyzeMatchupTool } from "../../src/mcp/tools/analytics.js";
import { connect, makeWorld, type World } from "./helpers/env.js";

interface Err {
  error: { code: string; hint: string };
}

let world: World;
beforeAll(async () => {
  world = await makeWorld();
}, 60_000);
afterAll(() => {
  world.cleanup();
});

describe("ff_analyze_matchup without an opponent for the week (QA-1-008, QA-1-028)", () => {
  it("NOT_FOUND with an E3 hint that names only E3's own arguments", async () => {
    const { client, close } = await connect(world);
    const r = await client.callTool({ name: "ff_analyze_matchup", arguments: {} });
    expect(r.isError).toBe(true);
    const b = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as Err;
    expect(b.error.code).toBe("NOT_FOUND");
    const props = Object.keys(
      (z.toJSONSchema(analyzeMatchupTool.input, { io: "input" }) as { properties: object })
        .properties,
    );
    // every snake_case argument-like word the hint advises on E3 itself is an E3 argument
    expect(props).not.toContain("objective");
    expect(b.error.hint).not.toMatch(/use objective/);
    expect(b.error.hint).toMatch(/opponents/);
    expect(b.error.hint).toMatch(/\bweek\b/);
    // the advice works: a week that has an opponent answers
    const ok = await client.callTool({ name: "ff_analyze_matchup", arguments: { week: 3 } });
    expect(ok.isError).not.toBe(true);
    // and the cross-tool advice names a real tool argument
    const lineup = await client.callTool({
      name: "ff_analyze_lineup",
      arguments: { objective: "mean" },
    });
    expect(lineup.isError).not.toBe(true);
    await close();
  });

  it("ff_get_scoreboard names the week's missing matchup; a week that has one carries no such warning", async () => {
    const { client, close } = await connect(world);
    const get = async (week: number) => {
      const r = await client.callTool({ name: "ff_get_scoreboard", arguments: { week } });
      expect(r.isError).not.toBe(true);
      return JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}") as {
        data: { matchups: unknown[] };
        warnings: string[];
      };
    };
    const w4 = await get(4);
    expect(w4.data.matchups).toEqual([]);
    expect(w4.warnings.join(" ")).toMatch(/no matchup for week 4 in league\.yaml/);
    const w3 = await get(3);
    expect(w3.data.matchups.length).toBeGreaterThan(0);
    expect(w3.warnings.join(" ")).not.toMatch(/no matchup/);
    await close();
  });
});
