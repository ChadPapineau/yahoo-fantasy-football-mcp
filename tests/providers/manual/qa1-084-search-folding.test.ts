// qa1-084-search-folding.test.ts — Stage C QA round 1 regression: QA-1-084 player search folds apostrophes and punctuation (plan 07 C1; plan 05 §2 crosswalk
// name normalisation).
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nameMatcher } from "../../../src/providers/manual/provider.js";
import type { PlayerQuery } from "../../../src/providers/platform.js";
import { EXAMPLE_LEAGUE, provider, tempLeague, type TempLeague } from "./helpers.js";

let t: TempLeague;
beforeEach(() => {
  t = tempLeague();
});
afterEach(() => {
  t.cleanup();
});

describe("QA-1-084: search folds apostrophes and punctuation", () => {
  const Q = (search: string): PlayerQuery => ({
    status: "A",
    position: null,
    search,
    sort: null,
    sort_type: null,
    sort_week: null,
  });
  const names = async (search: string): Promise<string[]> =>
    (
      await provider(t.file).listPlayers(EXAMPLE_LEAGUE, Q(search), { limit: 100, offset: 0 })
    ).value.items.map((p) => p.name);

  it.each([
    ["Ja'Marr", "Ja'Marr Chase"],
    ["Ja’Marr", "Ja'Marr Chase"],
    ["JaMarr Chase", "Ja'Marr Chase"],
    ["jamarr", "Ja'Marr Chase"],
    ["St. Brown", "Amon-Ra St. Brown"],
    ["St Brown", "Amon-Ra St. Brown"],
    ["Amon Ra", "Amon-Ra St. Brown"],
    ["amonra", "Amon-Ra St. Brown"],
    ["Smith Njigba", "Jaxon Smith-Njigba"],
    ["Kaimi", "Ka'imi Fairbairn"],
    ["Walker III", "Kenneth Walker III"],
    ["Fannin Jr.", "Harold Fannin Jr."],
  ])("%s finds %s", async (q, expected) => {
    expect(await names(q)).toContain(expected);
  });

  it("punctuation-only or unmatched queries do not match everything", async () => {
    expect(await names("'")).toEqual([]);
    expect(await names(".-")).toEqual([]);
    expect(await names("zzzz")).toEqual([]);
    expect(await names("Chase Ja'Marr")).toEqual([]);
  });
});

describe("QA-1-084: nameMatcher property", () => {
  const NAMES = [
    "Ja'Marr Chase",
    "Amon-Ra St. Brown",
    "Jaxon Smith-Njigba",
    "Ka'imi Fairbairn",
    "Kenneth Walker III",
    "Harold Fannin Jr.",
    "D.J. Moore",
  ];
  const variant = fc.record({
    apostrophe: fc.constantFrom("'", "’", "ʼ", "`", ""),
    hyphen: fc.constantFrom("-", " ", ""),
    period: fc.constantFrom(".", ""),
    upper: fc.boolean(),
  });

  it("apostrophe, hyphen, period and case variants of a name find the player", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NAMES), variant, (name, v) => {
        let q = name
          .replaceAll("'", v.apostrophe)
          .replaceAll("-", v.hyphen)
          .replaceAll(".", v.period);
        q = v.upper ? q.toUpperCase() : q.toLowerCase();
        expect(nameMatcher(q)(name)).toBe(true);
      }),
    );
  });

  it("a query naming someone else never matches", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NAMES), fc.constantFrom(...NAMES), (a, b) => {
        fc.pre(a !== b);
        expect(nameMatcher(a)(b)).toBe(false);
      }),
    );
  });
});
