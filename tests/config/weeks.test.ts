// weeks.test.ts — src/config/weeks.ts (season-fresh spec §2.6): the week bounds are structural,
// never a season length — every synthetic season (18, 19 or 20 regular weeks plus four postseason
// weeks) fits the data-layer bound, and a 20-week season's last week exceeds the tool-input bound
// (the contract-2 reopen trigger the status blocks flag).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ALL_WEEK_INDEXES, TOOL_INPUT_WEEK_MAX, WEEK_INDEX_MAX } from "../../src/config/weeks.js";
import { arbSeasonOptions, syntheticSeason } from "../helpers/season/synthetic.js";

describe("week bounds", () => {
  it("ALL_WEEK_INDEXES is 1..WEEK_INDEX_MAX, frozen", () => {
    expect(ALL_WEEK_INDEXES).toEqual(Array.from({ length: WEEK_INDEX_MAX }, (_, i) => i + 1));
    expect(Object.isFrozen(ALL_WEEK_INDEXES)).toBe(true);
    expect(TOOL_INPUT_WEEK_MAX).toBeLessThan(WEEK_INDEX_MAX);
  });

  it("every synthetic season's weeks fit the structural bound", () => {
    fc.assert(
      fc.property(arbSeasonOptions, (o) => {
        const weeks = new Set(syntheticSeason(o).map((g) => g.week));
        for (const w of weeks) expect(ALL_WEEK_INDEXES).toContain(w);
        expect(Math.max(...weeks)).toBe(o.regWeeks + 4);
        expect(Math.max(...weeks) > TOOL_INPUT_WEEK_MAX).toBe(o.regWeeks + 4 > 22);
      }),
      { numRuns: 20 },
    );
  });
});
