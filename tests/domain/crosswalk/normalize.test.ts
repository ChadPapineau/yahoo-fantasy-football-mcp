// normalize.test.ts — src/domain/crosswalk/normalize.ts: merge_name normalisation (research 04 §D
// step 2) and id cleaning (§D known defects); plan 05 §2 "name normalisation is idempotent".
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_ID_CHARS,
  MAX_NAME_CHARS,
  cleanGsisId,
  cleanId,
  mergeName,
  nameKey,
} from "../../../src/domain/crosswalk/normalize.js";
import { FIXTURE } from "./helpers.js";

describe("mergeName", () => {
  it.each([
    ["Josh Allen", "josh allen"],
    ["Kenneth Walker III", "kenneth walker"],
    ["Deebo Samuel Sr.", "deebo samuel"],
    ["Harold Fannin Jr.", "harold fannin"],
    ["Harold Fannin Jr", "harold fannin"],
    ["Harold Fannin", "harold fannin"],
    ["Odell Beckham Jr. II", "odell beckham"],
    ["Amon-Ra St. Brown", "amonra st brown"],
    ["Jaxon Smith-Njigba", "jaxon smithnjigba"],
    ["Ja'Marr Chase", "jamarr chase"],
    ["Ja’Marr Chase", "jamarr chase"],
    ["Kaʻimi Fairbairn", "kaimi fairbairn"],
    ["Ka´imi Fairbairn", "kaimi fairbairn"],
    ["D.J. Moore", "dj moore"],
    ["  JOSH\t\tALLEN  ", "josh allen"],
    ["Josh Allen", "josh allen"],
    ["Nîck Fölk", "nick folk"],
    ["Zdeněk Łukasz Ødegaard", "zdenek lukasz odegaard"],
    ["Björn Straße", "bjorn strasse"],
    ["İbrahim Ağır", "ibrahim agir"],
    ["Ｊｏｓｈ Allen", "josh allen"],
    ["Mike V", "mike v"],
    ["Jr Sr", "jr sr"],
    ["Walker III IV", "walker iii"],
    ["Patrick Mahomes II", "patrick mahomes"],
  ])("%j → %j", (raw, want) => {
    expect(mergeName(raw)).toBe(want);
  });

  it("treats O'Neil, O’Neil and ONeil as one name", () => {
    expect(mergeName("Mike O'Neil")).toBe("mike oneil");
    expect(mergeName("Mike O’Neil")).toBe("mike oneil");
    expect(mergeName("Mike ONeil")).toBe("mike oneil");
  });

  it.each([
    ["Cyrillic А homoglyph", "Josh Аllen"],
    ["Greek ο homoglyph", "Jοsh Allen"],
    ["zero-width space", "Jo​sh Allen"],
    ["zero-width joiner", "Josh‍Allen"],
    ["soft hyphen", "Jo­sh Allen"],
    ["RTL override", "‮Josh Allen"],
    ["control char", "Josh\u0000Allen"],
    ["emoji", "Josh Allen \u{1F3C8}"],
    ["math symbol", "Josh + Allen"],
    ["CJK", "大谷 翔平"],
    ["only punctuation", "...---'''"],
    ["empty", ""],
    ["whitespace", "   "],
  ])("rejects (never merges) %s", (_label, raw) => {
    expect(mergeName(raw)).toBeNull();
    expect(nameKey(raw)).toBeNull();
  });

  it("rejects non-strings and over-long names", () => {
    expect(mergeName(null)).toBeNull();
    expect(mergeName(undefined)).toBeNull();
    expect(mergeName(42)).toBeNull();
    expect(mergeName({ toString: () => "Josh Allen" })).toBeNull();
    expect(mergeName("a".repeat(MAX_NAME_CHARS))).toBe("a".repeat(MAX_NAME_CHARS));
    expect(mergeName("a".repeat(MAX_NAME_CHARS + 1))).toBeNull();
    expect(mergeName("x ".repeat(5_000_000))).toBeNull();
  });

  it("normalises every fixture name to a clean, distinct key", () => {
    const keys = FIXTURE.players.map((p) => nameKey(p.name));
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]+$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is idempotent on any input (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (s) => {
        const once = mergeName(s);
        if (once !== null) {
          expect(mergeName(once)).toBe(once);
          expect(once).toMatch(/^[a-z0-9]+(?: [a-z0-9]+)*$/);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it("is idempotent on name-like input (property)", () => {
    const part = fc.stringMatching(/^[A-Za-z][A-Za-z'.-]{0,10}$/);
    const suffix = fc.constantFrom("", " Jr.", " Sr", " II", " III", " IV", " V");
    fc.assert(
      fc.property(part, part, suffix, (a, b, s) => {
        const once = mergeName(`${a} ${b}${s}`);
        expect(once === null || mergeName(once) === once).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("nameKey", () => {
  it("ignores spacing between tokens", () => {
    expect(nameKey("Jaxon Smith Njigba")).toBe(nameKey("Jaxon Smith-Njigba"));
    expect(nameKey("DJ Moore")).toBe(nameKey("D. J. Moore"));
    expect(nameKey("Amon-Ra St.Brown")).toBe(nameKey("Amon-Ra St. Brown"));
    expect(nameKey("Josh Allen")).toBe("joshallen");
  });

  it("keeps different names different", () => {
    expect(nameKey("Josh Allen")).not.toBe(nameKey("Keenan Allen"));
    expect(nameKey("Jordan Love")).not.toBe(nameKey("Jeremiyah Love"));
  });
});

describe("cleanId", () => {
  it.each([
    [" 00-0034857", "00-0034857"],
    ["00-0034857 ", "00-0034857"],
    ["30977", "30977"],
    ["", null],
    ["   ", null],
    ["NA", null],
    ["na", null],
    ["N/A", null],
    ["null", null],
    ["NULL", null],
    ["None", null],
    ["NaN", null],
    ["undefined", null],
    ["-", null],
    ["30 977", null],
    ["30977\n1", null],
    ["30977\u0000", null],
  ])("%j → %j", (raw, want) => {
    expect(cleanId(raw)).toBe(want);
  });

  it("rejects non-strings and over-long ids", () => {
    expect(cleanId(30977)).toBeNull();
    expect(cleanId(null)).toBeNull();
    expect(cleanId(undefined)).toBeNull();
    expect(cleanId("1".repeat(MAX_ID_CHARS))).toBe("1".repeat(MAX_ID_CHARS));
    expect(cleanId("1".repeat(MAX_ID_CHARS + 1))).toBeNull();
  });
});

describe("cleanGsisId", () => {
  it("trims Sleeper's leading space and checks the grammar", () => {
    expect(cleanGsisId(" 00-0034857")).toBe("00-0034857");
    expect(cleanGsisId("00-0034857")).toBe("00-0034857");
    expect(cleanGsisId("NA")).toBeNull();
    expect(cleanGsisId("00-003485")).toBeNull();
    expect(cleanGsisId("00-00348570")).toBeNull();
    expect(cleanGsisId("01-0034857")).toBeNull();
    expect(cleanGsisId("００-0034857")).toBeNull();
    expect(cleanGsisId(null)).toBeNull();
  });
});
