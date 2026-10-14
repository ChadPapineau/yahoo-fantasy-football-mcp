// reference-vintage.test.ts — src/config/reference-vintage.ts (season-fresh spec §2.7): every
// hand-typed, season-dependent reference table carries the last season it was verified against;
// past that season (plus its grace) `pastVintage` names it, for any season in progress.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  REFERENCE_IDS,
  REFERENCE_VINTAGES,
  pastVintage,
} from "../../src/config/reference-vintage.js";

describe("reference vintages", () => {
  it("registers venues, flex rules and the analytics base rates, each dated and sourced", () => {
    expect(REFERENCE_IDS).toEqual(["venues", "flex_rules", "analytics_base_rates"]);
    for (const id of REFERENCE_IDS) {
      const v = REFERENCE_VINTAGES[id];
      expect(v.id).toBe(id);
      expect(v.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v.source.length).toBeGreaterThan(5);
      expect(v.grace_seasons).toBeGreaterThanOrEqual(0);
    }
    expect(REFERENCE_VINTAGES.analytics_base_rates.grace_seasons).toBe(3);
  });

  it("pastVintage names exactly the tables whose vintage + grace the season has passed", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), (season) => {
        const got = pastVintage(season).map((w) => w.id);
        const want = REFERENCE_IDS.filter((id) => {
          const v = REFERENCE_VINTAGES[id];
          return season > v.verified_through_season + v.grace_seasons;
        });
        expect(got).toEqual(want);
        for (const w of pastVintage(season))
          expect(w.verified_through_season).toBe(REFERENCE_VINTAGES[w.id].verified_through_season);
      }),
    );
  });

  it("the documented thresholds: venues and flex rules from 2027, base rates from 2029", () => {
    expect(pastVintage(2026)).toEqual([]);
    expect(pastVintage(2027).map((w) => w.id)).toEqual(["venues", "flex_rules"]);
    expect(pastVintage(2028).map((w) => w.id)).toEqual(["venues", "flex_rules"]);
    expect(pastVintage(2029).map((w) => w.id)).toEqual([
      "venues",
      "flex_rules",
      "analytics_base_rates",
    ]);
  });
});
