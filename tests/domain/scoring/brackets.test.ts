// brackets.test.ts — src/domain/scoring/brackets.ts: plan 08 §4.1 (derivation from names, contiguity
// and overlap errors naming offenders, bracketize, FG distance counts — critic C-09) and the
// BRACKET_FAMILY_RE slug rule (critic C-12).
import { describe, expect, it } from "vitest";
import {
  binCounts,
  bracketize,
  deriveBrackets,
  FAMILY_SCALAR,
  familyKind,
  familyScalar,
  parseBinCanonical,
  slugFamily,
} from "../../../src/domain/scoring/brackets.js";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import type {
  BracketFamily,
  PositionType,
  ScoringRule,
} from "../../../src/domain/scoring/types.js";
import { BRACKET_FAMILY_RE } from "../../../src/domain/scoring/types.js";
import { sampleSettings } from "./fixtures.js";

const rule = (
  canonical: string | null,
  name: string,
  pts: PositionType[] = ["DT"],
  id = name,
): ScoringRule => ({
  canonical,
  platform_id: id,
  name,
  position_types: pts,
  modifier: 1,
  bonuses: [],
});

function errorOf(fn: () => unknown): ScoringError {
  try {
    fn();
  } catch (e) {
    return e as ScoringError;
  }
  throw new Error("expected a throw");
}

describe("deriveBrackets", () => {
  it("derives the sample league's two families (plan 08 §4.1)", () => {
    const s = sampleSettings();
    expect(s.brackets.map((b) => [b.family, b.position_type, b.kind, b.members.length])).toEqual([
      ["fg_distance", "K", "count", 5],
      ["dst_points_allowed", "DT", "indicator", 7],
    ]);
    const pa = s.brackets[1]!;
    expect(pa.members.map((m) => [m.lower, m.upper, m.platform_id])).toEqual([
      [0, 0, "50"],
      [1, 6, "51"],
      [7, 13, "52"],
      [14, 20, "53"],
      [21, 27, "54"],
      [28, 34, "55"],
      [35, null, "56"],
    ]);
    expect(Object.isFrozen(s.brackets)).toBe(true);
  });

  it("derives a yards-allowed family and a missed-FG count family", () => {
    const fams = deriveBrackets([
      rule("dst_ya_100_199", "Yards Allowed 100-199"),
      rule("dst_ya_0_99", "Yards Allowed 0-99"),
      rule("dst_ya_200p", "Yards Allowed 200+"),
      rule("fg_miss_0_39", "Field Goals Missed 0-39 Yards", ["K"]),
      rule("fg_miss_40p", "Field Goals Missed 40+ Yards", ["K"]),
    ]);
    expect(fams.map((f) => [f.family, f.kind, f.members.map((m) => m.canonical)])).toEqual([
      ["fg_miss_distance", "count", ["fg_miss_0_39", "fg_miss_40p"]],
      ["dst_yards_allowed", "indicator", ["dst_ya_0_99", "dst_ya_100_199", "dst_ya_200p"]],
    ]);
  });

  it.each([
    ["gap", [rule("dst_pa_0", "a"), rule("dst_pa_2_6", "b")], "gap dst_pa_0 / dst_pa_2_6"],
    [
      "overlap",
      [rule("dst_pa_0_7", "a"), rule("dst_pa_7_13", "b")],
      "overlap dst_pa_0_7 / dst_pa_7_13",
    ],
    [
      "open not last",
      [rule("dst_pa_0p", "a"), rule("dst_pa_7_13", "b")],
      "overlap dst_pa_0p / dst_pa_7_13",
    ],
    ["inverted", [rule("dst_pa_13_7", "a")], "inverted range dst_pa_13_7"],
    [
      "same lower",
      [rule("dst_pa_0", "a"), rule("dst_pa_0_6", "b")],
      "overlap dst_pa_0 / dst_pa_0_6",
    ],
  ])(
    "a named family with a %s is a bracket_bounds error naming the members",
    (_, rules, detail) => {
      const e = errorOf(() => deriveBrackets(rules));
      expect(e).toBeInstanceOf(ScoringError);
      expect(e.code).toBe("bracket_bounds");
      expect(e.detail).toEqual([detail]);
      expect(e.message).toContain("dst_points_allowed");
    },
  );

  it("orders members sharing a lower bound by canonical, whatever the rule order", () => {
    for (const rules of [
      [rule("dst_pa_0_6", "b"), rule("dst_pa_0", "a")],
      [rule("dst_pa_0", "a"), rule("dst_pa_0_6", "b")],
    ]) {
      expect(errorOf(() => deriveBrackets(rules)).detail).toEqual([
        "overlap dst_pa_0 / dst_pa_0_6",
      ]);
    }
  });

  it("forms a generic family from bounded display names only when ≥ 2 contiguous members", () => {
    const ok = deriveBrackets([
      rule("idp_tkl_a", "Tackles 0-4", ["D"]),
      rule("idp_tkl_b", "Tackles 5-9", ["D"]),
      rule("idp_tkl_c", "Tackles 10+", ["D"]),
    ]);
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ family: "tackles", kind: "count", position_type: "D" });
    expect(deriveBrackets([rule("idp_tkl_a", "Tackles 0-4", ["D"])])).toEqual([]);
    expect(
      deriveBrackets([
        rule("idp_tkl_a", "Tackles 0-4", ["D"]),
        rule("idp_tkl_b", "Tackles 6-9", ["D"]),
      ]),
    ).toEqual([]);
    expect(deriveBrackets([rule("x_a", "0-4", ["D"]), rule("x_b", "5-9", ["D"])])).toEqual([]);
    expect(
      deriveBrackets([rule(null, "Tackles 0-4", ["D"]), rule(null, "Tackles 5+", ["D"])]),
    ).toEqual([]);
    expect(deriveBrackets([rule("pass_yd", "Passing Yards", ["O"])])).toEqual([]);
  });

  it("keeps named members when a generic display name collides with a named family slug", () => {
    const fams = deriveBrackets([
      rule("fg_0_19", "Field Goals 0-19 Yards", ["K"]),
      rule("fg_20p", "Field Goals 20+ Yards", ["K"]),
      rule("custom_x", "FG Distance 0-9", ["K"]),
    ]);
    expect(fams).toHaveLength(1);
    expect(fams[0]!.members.map((m) => m.canonical)).toEqual(["fg_0_19", "fg_20p"]);
  });

  it("suffixes a family name repeated under a second position type", () => {
    const fams = deriveBrackets([
      rule("dst_pa_0_9", "a", ["DT", "D"]),
      rule("dst_pa_10p", "b", ["DT", "D"]),
    ]);
    expect(fams.map((f) => [f.family, f.position_type])).toEqual([
      ["dst_points_allowed", "DT"],
      ["dst_points_allowed_d", "D"],
    ]);
    for (const f of fams) expect(BRACKET_FAMILY_RE.test(f.family)).toBe(true);
  });

  it("orders several families in one position type by name", () => {
    const fams = deriveBrackets([
      rule("dst_ya_0_99", "a"),
      rule("dst_ya_100p", "b"),
      rule("dst_pa_0_9", "c"),
      rule("dst_pa_10p", "d"),
      rule("q_a", "Quux 0-1"),
      rule("q_b", "Quux 2+"),
    ]);
    expect(fams.map((f) => f.family)).toEqual(["dst_points_allowed", "dst_yards_allowed", "quux"]);
  });
});

describe("parseBinCanonical / familyKind / FAMILY_SCALAR", () => {
  it.each([
    ["fg_40_49", { family: "fg_distance", lower: 40, upper: 49 }],
    ["fg_50p", { family: "fg_distance", lower: 50, upper: null }],
    ["fg_miss_0_19", { family: "fg_miss_distance", lower: 0, upper: 19 }],
    ["dst_pa_0", { family: "dst_points_allowed", lower: 0, upper: 0 }],
    ["dst_ya_500p", { family: "dst_yards_allowed", lower: 500, upper: null }],
    ["fg_40", null],
    ["fg_miss_7", null],
    ["pass_yd", null],
    ["dst_pa", null],
    ["dst_pa_12345", null],
  ])("%s", (c, want) => {
    expect(parseBinCanonical(c)).toEqual(want);
  });

  it("kinds and scalars", () => {
    expect(familyKind("dst_points_allowed")).toBe("indicator");
    expect(familyKind("dst_yards_allowed")).toBe("indicator");
    expect(familyKind("fg_distance")).toBe("count");
    expect(familyKind("fg_miss_distance")).toBe("count");
    expect(familyKind("anything_else")).toBe("count");
    expect(familyKind("constructor")).toBe("count");
    expect(FAMILY_SCALAR).toEqual({ dst_points_allowed: "dst_pa", dst_yards_allowed: "dst_ya" });
    expect(familyScalar("dst_points_allowed")).toBe("dst_pa");
    expect(familyScalar("fg_distance")).toBeNull();
    expect(familyScalar("constructor")).toBeNull();
    expect(familyScalar("__proto__")).toBeNull();
  });
});

describe("slugFamily (critic C-12)", () => {
  it.each([
    ["Points Allowed", "points_allowed"],
    ["  --Tackles!!  ", "tackles"],
    ["40 yard plays", "f_40_yard_plays"],
    ["Überraschung", "berraschung"],
    ["", null],
    ["!!!", null],
    ["日本語", null],
  ])("%s → %s", (raw, want) => {
    expect(slugFamily(raw)).toBe(want);
  });

  it("always yields BRACKET_FAMILY_RE with room for a suffix", () => {
    const s = slugFamily(`${"a_".repeat(100)}b`)!;
    expect(s.length).toBeLessThanOrEqual(36);
    expect(s.endsWith("_")).toBe(false);
    expect(BRACKET_FAMILY_RE.test(`${s}_dt`)).toBe(true);
  });
});

describe("bracketize (P3) and binCounts", () => {
  const pa = sampleSettings().brackets[1]!;
  const fg: BracketFamily = sampleSettings().brackets[0]!;

  it.each([
    [0, 0],
    [1, 1],
    [6, 1],
    [7, 2],
    [13, 2],
    [14, 3],
    [20, 3],
    [21, 4],
    [27, 4],
    [28, 5],
    [34, 5],
    [35, 6],
    [99, 6],
    [-3, 0],
    [6.5, 1],
    [13.5, 2],
  ])("scalar %d → member %d", (x, i) => {
    expect(bracketize(pa, x)).toBe(i);
  });

  it("counts kicks per league bin with a key for every member", () => {
    expect(binCounts(fg, [40, 49, 50, 19, 39])).toEqual({
      fg_0_19: 1,
      fg_20_29: 0,
      fg_30_39: 1,
      fg_40_49: 2,
      fg_50p: 1,
    });
    expect(binCounts(fg, [])).toEqual({
      fg_0_19: 0,
      fg_20_29: 0,
      fg_30_39: 0,
      fg_40_49: 0,
      fg_50p: 0,
    });
    const e = errorOf(() => binCounts(fg, [40, NaN]));
    expect(e.code).toBe("invalid_line");
    expect(e.detail).toEqual(["fg_distance"]);
  });
});
