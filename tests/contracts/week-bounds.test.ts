// week-bounds.test.ts — the tool-contract-1 week input bound is ONE constant (season-fresh spec §2.6):
// the recommendation log, the retrospective and the manual league file all accept weeks up to
// TOOL_INPUT_WEEK_MAX and refuse the next one — and so do the tools' week input (BOUNDS.week), the
// ff://rec/week/{week} resource and ff_get_league's weeks list — so raising it with a contract bump
// moves every site together; the data layer's structural bound is larger. D2's base-rate note reads
// its seasons from the reference registry.
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { REFERENCE_VINTAGES } from "../../src/config/reference-vintage.js";
import { TOOL_INPUT_WEEK_MAX, WEEK_INDEX_MAX } from "../../src/config/weeks.js";
import { fixedClock } from "../../src/domain/clock.js";
import { RECORD_BOUNDS } from "../../src/domain/reclog/record.js";
import {
  buildRetrospective,
  type RetrospectiveInput,
} from "../../src/domain/reclog/retrospective.js";
import { parseLeagueYaml } from "../../src/providers/manual/parse.js";
import { leagueFileSchema } from "../../src/providers/manual/schema.js";
import { BOUNDS, weekSchema } from "../../src/mcp/bounds.js";
import { REGISTRY } from "../../src/mcp/registry.js";
import { BASE_RATES_NOTE } from "../../src/mcp/tools/datasets.js";
import { connect, makeWorld } from "../mcp/helpers/env.js";
import { FIXTURE_TEXT } from "../providers/manual/helpers.js";

describe("the tool-input week bound", () => {
  it("is below the structural data bound", () => {
    expect(TOOL_INPUT_WEEK_MAX).toBeLessThan(WEEK_INDEX_MAX);
  });

  it("bounds a logged recommendation's week", () => {
    expect(RECORD_BOUNDS.week).toEqual({ min: 1, max: TOOL_INPUT_WEEK_MAX });
  });

  it("bounds the retrospective's week (the check runs before anything else is read)", () => {
    const at = (week: number) => () =>
      buildRetrospective({ week, min_n: 30 } as unknown as RetrospectiveInput, fixedClock(0));
    expect(at(TOOL_INPUT_WEEK_MAX + 1)).toThrow(
      new RangeError(`reclog: week must be an integer 1..${String(TOOL_INPUT_WEEK_MAX)}`),
    );
    expect(at(0)).toThrow(RangeError);
    // the bound itself passes the week check (the empty input then fails elsewhere)
    expect(at(TOOL_INPUT_WEEK_MAX)).not.toThrow(/week must be/);
  });

  it("bounds the manual league file's weeks and its opponents list", () => {
    const parsed = parseLeagueYaml(FIXTURE_TEXT) as { league: Record<string, unknown> };
    const withEnd = (end: number) => ({ ...parsed, league: { ...parsed.league, end_week: end } });
    expect(leagueFileSchema.safeParse(withEnd(TOOL_INPUT_WEEK_MAX)).success).toBe(true);
    const bad = leagueFileSchema.safeParse(withEnd(TOOL_INPUT_WEEK_MAX + 1));
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join("."))).toContain("league.end_week");
    const opponents = (n: number) => ({
      ...parsed,
      opponents: Array.from({ length: n }, (_, i) => ({
        week: (i % TOOL_INPUT_WEEK_MAX) + 1,
        team: 2,
      })),
    });
    expect(leagueFileSchema.safeParse(opponents(TOOL_INPUT_WEEK_MAX)).success).toBe(true);
    expect(leagueFileSchema.safeParse(opponents(TOOL_INPUT_WEEK_MAX + 1)).success).toBe(false);
  });
});

describe("the tool inputs and resources take the same bound (no literal week ceiling)", () => {
  it("BOUNDS.week and weekSchema: 1..TOOL_INPUT_WEEK_MAX", () => {
    expect(BOUNDS.week).toEqual({ min: 1, max: TOOL_INPUT_WEEK_MAX });
    expect(weekSchema.safeParse(TOOL_INPUT_WEEK_MAX).success).toBe(true);
    expect(weekSchema.safeParse(TOOL_INPUT_WEEK_MAX + 1).success).toBe(false);
  });

  it("ff://rec/week/{week}: completes and reads 1..TOOL_INPUT_WEEK_MAX, refuses the next week", async () => {
    const w = await makeWorld();
    const c = await connect(w);
    try {
      const all = await c.client.complete({
        ref: { type: "ref/resource", uri: "ff://rec/week/{week}" },
        argument: { name: "week", value: "" },
      });
      expect(all.completion.values).toEqual(
        Array.from({ length: TOOL_INPUT_WEEK_MAX }, (_, i) => String(i + 1)),
      );
      const ok = await c.client.readResource({
        uri: `ff://rec/week/${String(TOOL_INPUT_WEEK_MAX)}`,
      });
      expect(ok.contents).toHaveLength(1);
      const past = await c.client
        .readResource({ uri: `ff://rec/week/${String(TOOL_INPUT_WEEK_MAX + 1)}` })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(past).not.toBeNull();
    } finally {
      await c.close();
      w.cleanup();
    }
  }, 60_000);

  it("ff_get_league's weeks list is bounded by it", () => {
    const data = REGISTRY.find((e) => e.tool.name === "ff_get_league")?.tool.data;
    if (data == null) throw new Error("ff_get_league");
    const json = JSON.stringify(z.toJSONSchema(data));
    expect(json).toMatch(new RegExp(`"weeks":\\{[^}]*"maxItems":${String(TOOL_INPUT_WEEK_MAX)}`));
  });
});

describe("base-rate seasons come from the reference registry, never a string", () => {
  it("D2's base-rate note names the registry's p_active basis seasons", () => {
    const [first, last] = REFERENCE_VINTAGES.analytics_base_rates.basis_seasons?.p_active ?? [];
    expect(BASE_RATES_NOTE).toBe(`Q → played 71 % ${String(first)}–${String(last)} (05 §3.5)`);
  });
});
