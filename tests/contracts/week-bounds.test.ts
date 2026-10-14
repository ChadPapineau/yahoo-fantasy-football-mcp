// week-bounds.test.ts — the tool-contract-1 week input bound is ONE constant (season-fresh spec §2.6):
// the recommendation log, the retrospective and the manual league file all accept weeks up to
// TOOL_INPUT_WEEK_MAX and refuse the next one, so raising it with a contract bump moves every site
// together; the data layer's structural bound is larger.
import { describe, expect, it } from "vitest";
import { TOOL_INPUT_WEEK_MAX, WEEK_INDEX_MAX } from "../../src/config/weeks.js";
import { fixedClock } from "../../src/domain/clock.js";
import { RECORD_BOUNDS } from "../../src/domain/reclog/record.js";
import {
  buildRetrospective,
  type RetrospectiveInput,
} from "../../src/domain/reclog/retrospective.js";
import { parseLeagueYaml } from "../../src/providers/manual/parse.js";
import { leagueFileSchema } from "../../src/providers/manual/schema.js";
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
