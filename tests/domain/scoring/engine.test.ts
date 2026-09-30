// engine.test.ts — src/domain/scoring/engine.ts `score`/`explain`: plan 08 §3.3 (gating), §4.1
// (indicator vs count families, exclusivity, scalar bracketize), §4.2 (bonuses), §4.4 / E4 (floor
// and verified-only rounding), §4.5 (complete / ignored / unmapped), hostile lines and settings.
import { describe, expect, it } from "vitest";
import {
  appliedRounding,
  applyPolicy,
  explain,
  floorApplies,
  score,
  scoringEngine,
} from "../../../src/domain/scoring/engine.js";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import * as surface from "../../../src/domain/scoring/index.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { ScoringSettings, StatLine } from "../../../src/domain/scoring/types.js";
import { lineOf, sampleSettings } from "./fixtures.js";

const S = sampleSettings();

function errorOf(fn: () => unknown): ScoringError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ScoringError);
    return e as ScoringError;
  }
  throw new Error("expected a throw");
}

/** A hand-built settings object (bypassing the normaliser) for defensive branches. */
function handBuilt(over: Partial<ScoringSettings>): ScoringSettings {
  return { ...S, ...over, settings_hash: "hand" };
}

describe("score — linear rules and contributions", () => {
  it("scores a QB line with contributions in rule (platform id) order", () => {
    const r = score(
      lineOf("O", { pass_yd: 300, pass_td: 2, pass_int: 1, rush_att: 5, rush_yd: 20 }),
      S,
    );
    expect(r.points).toBe(12 + 8 - 1 + 2);
    expect(r.points_exact).toBe(21);
    expect(r.complete).toBe(true);
    expect(r.contributions).toEqual([
      { canonical: "pass_yd", value: 300, modifier: 0.04, points: 12, kind: "linear" },
      { canonical: "pass_td", value: 2, modifier: 4, points: 8, kind: "linear" },
      { canonical: "pass_int", value: 1, modifier: -1, points: -1, kind: "linear" },
      { canonical: "rush_yd", value: 20, modifier: 0.1, points: 2, kind: "linear" },
    ]);
  });

  it("display-only stats contribute nothing and are not ignored", () => {
    const r = score(lineOf("O", { rush_att: 20, targets: 9 }), S);
    expect(r.points).toBe(0);
    expect(r.contributions).toEqual([]);
    expect(r.ignored).toEqual([]);
  });

  it("explain is score; the engine object exposes all three", () => {
    const l = lineOf("O", { rec: 4 });
    expect(explain(l, S)).toEqual(score(l, S));
    expect(scoringEngine.score(l, S)).toEqual(score(l, S));
    expect(scoringEngine.explain(l, S)).toEqual(score(l, S));
    expect(Object.isFrozen(scoringEngine)).toBe(true);
    expect(surface.score).toBe(score);
    expect(typeof surface.normalizeSettings).toBe("function");
  });

  it("is deterministic and does not mutate its inputs", () => {
    const l = lineOf("K", { fg_40_49: 2, pat_made: 3 });
    const snap = JSON.stringify(l);
    expect(JSON.stringify(score(l, S))).toBe(JSON.stringify(score(l, S)));
    expect(JSON.stringify(l)).toBe(snap);
  });

  it("treats `values` as the present set (a stale `present` is not consulted)", () => {
    const l: StatLine = { ...lineOf("O", { rec: 2 }), present: ["pass_yd", "rec"] };
    expect(score(l, S).points).toBe(1);
  });
});

describe("score — position-type gating (plan 08 §3.3, §4.3)", () => {
  it("an O line never scores DT stats and a DT line never scores O stats", () => {
    const both = { rec_td: 1, dst_td: 1, ret_td_off: 1, dst_ret_td: 1 };
    const o = score(lineOf("O", both), S);
    const dt = score(lineOf("DT", both), S);
    expect(o.points).toBe(12);
    expect(o.ignored).toEqual(["dst_ret_td", "dst_td"]);
    expect(dt.points).toBe(12);
    expect(dt.ignored).toEqual(["rec_td", "ret_td_off"]);
  });

  it("a K line ignores passing; a D (IDP) line scores nothing in a non-IDP league", () => {
    expect(score(lineOf("K", { pass_td: 1, pat_made: 1 }), S)).toMatchObject({
      points: 1,
      ignored: ["pass_td"],
    });
    expect(score(lineOf("D", { pass_yd: 100 }), S)).toMatchObject({
      points: 0,
      ignored: ["pass_yd"],
    });
  });
});

describe("score — bracket families (plan 08 §4.1)", () => {
  const PA0 = {
    dst_pa_0: 0,
    dst_pa_1_6: 0,
    dst_pa_7_13: 0,
    dst_pa_14_20: 0,
    dst_pa_21_27: 0,
    dst_pa_28_34: 0,
    dst_pa_35p: 0,
  };

  it("indicator family from a platform line: the one set member scores", () => {
    const r = score(lineOf("DT", { ...PA0, dst_pa_7_13: 1, dst_sack: 3 }), S);
    expect(r.points).toBe(7);
    expect(r.contributions).toContainEqual({
      canonical: "dst_pa_7_13",
      value: 1,
      modifier: 4,
      points: 4,
      kind: "bracket",
    });
  });

  it("indicators take precedence over the scalar; the scalar is not ignored", () => {
    const r = score(lineOf("DT", { ...PA0, dst_pa_0: 1, dst_pa: 30 }), S);
    expect(r.points).toBe(10);
    expect(r.ignored).toEqual([]);
  });

  it("a partial indicator set counts missing members as 0", () => {
    expect(score(lineOf("DT", { dst_pa_35p: 1 }), S).points).toBe(-4);
  });

  it.each([
    [{ ...PA0, dst_pa_0: 1, dst_pa_1_6: 1 }, "two bracket indicators set in one game"],
    [{ ...PA0, dst_pa_0: 2 }, "indicator member is not 0 or 1"],
    [{ ...PA0, dst_pa_0: 0.5 }, "indicator member is not 0 or 1"],
    [{ ...PA0, dst_pa_1_6: -1 }, "indicator member is not 0 or 1"],
  ])("refuses bad indicator data %#", (values, msg) => {
    const e = errorOf(() => score(lineOf("DT", values), S));
    expect(e.code).toBe("bracket_exclusivity");
    expect(e.detail[0]).toBe("dst_points_allowed");
    expect(e.message).toContain(msg);
  });

  it("count family: linear per bin, several FGs in one bin sum (critic C-09)", () => {
    const r = score(
      lineOf("K", { fg_0_19: 0, fg_20_29: 1, fg_30_39: 0, fg_40_49: 3, fg_50p: 2, pat_made: 4 }),
      S,
    );
    expect(r.points).toBe(3 + 12 + 10 + 4);
    expect(r.contributions.filter((c) => c.kind === "bracket")).toHaveLength(5);
  });

  it("a count member with no modifier scores nothing whether present or absent", () => {
    const s = sampleSettings({ modifiers: { "19": null } });
    expect(score(lineOf("K", { fg_0_19: 3 }), s).points).toBe(0);
    expect(
      score(lineOf("K", { fg_20_29: 1, fg_30_39: 0, fg_40_49: 0, fg_50p: 0, pat_made: 0 }, true), s)
        .complete,
    ).toBe(true);
    expect(score(lineOf("K", { fg_20_29: 1 }, true), s).complete).toBe(false);
  });

  it("an indicator member with no modifier fires without points; an all-null family never blocks completeness", () => {
    const s = sampleSettings({ modifiers: { "54": null } });
    expect(score(lineOf("DT", { dst_pa: 24 }), s).points).toBe(0);
    const none = sampleSettings({
      modifiers: {
        "50": null,
        "51": null,
        "52": null,
        "53": null,
        "54": null,
        "55": null,
        "56": null,
      },
    });
    const all = {
      dst_sack: 0,
      dst_int: 0,
      dst_fum_rec: 0,
      dst_td: 0,
      dst_safety: 0,
      dst_blk: 0,
      dst_ret_td: 0,
      dst_xpr: 0,
    };
    expect(score(lineOf("DT", all, true), none).complete).toBe(true);
    expect(score(lineOf("DT", all, true), S).complete).toBe(false);
  });
});

describe("score — bonuses (plan 08 §4.2)", () => {
  const s = sampleSettings({
    bonuses: {
      "9": [
        { target: 100, points: 3 },
        { target: 200, points: 5 },
      ],
      "8": [{ target: 25, points: 1 }],
    },
  });

  it("threshold indicators, inclusive, summed", () => {
    expect(score(lineOf("O", { rush_yd: 99 }), s).points).toBe(9.9);
    expect(score(lineOf("O", { rush_yd: 100 }), s).points).toBe(13);
    expect(score(lineOf("O", { rush_yd: 250 }), s).points).toBe(33);
    const r = score(lineOf("O", { rush_yd: 250 }), s);
    expect(r.contributions.filter((c) => c.kind === "bonus")).toEqual([
      { canonical: "rush_yd", value: 250, modifier: 3, points: 3, kind: "bonus" },
      { canonical: "rush_yd", value: 250, modifier: 5, points: 5, kind: "bonus" },
    ]);
  });

  it("a bonus on a display-only stat still pays; absence on a provisional week leaves it open", () => {
    expect(score(lineOf("O", { rush_att: 30 }), s).points).toBe(1);
    const full = {
      pass_yd: 0,
      pass_td: 0,
      pass_int: 0,
      rush_yd: 0,
      rush_td: 0,
      rec: 0,
      rec_yd: 0,
      rec_td: 0,
      ret_td_off: 0,
      two_pt: 0,
      fum_lost: 0,
      off_fum_ret_td: 0,
    };
    expect(score(lineOf("O", full, true), s).complete).toBe(false);
    expect(score(lineOf("O", { ...full, rush_att: 0 }, true), s).complete).toBe(true);
  });

  it("a negative bonus target and points work arithmetically", () => {
    const neg = sampleSettings({ bonuses: { "9": [{ target: -10, points: -2 }] } });
    expect(score(lineOf("O", { rush_yd: -5 }), neg).points).toBe(-2.5);
    expect(score(lineOf("O", { rush_yd: -11 }), neg).points).toBe(-1.1);
  });
});

describe("score — complete / ignored / unmapped (plan 08 §4.5)", () => {
  it("complete only fails on a provisional week with a scoring stat absent", () => {
    expect(score(lineOf("K", {}, false), S).complete).toBe(true);
    expect(score(lineOf("K", {}, true), S).complete).toBe(false);
    const k = { fg_0_19: 0, fg_20_29: 0, fg_30_39: 0, fg_40_49: 0, fg_50p: 0, pat_made: 0 };
    expect(score(lineOf("K", k, true), S).complete).toBe(true);
    const truthy = { ...lineOf("K", {}), provisional: "yes" } as unknown as StatLine;
    expect(score(truthy, S).complete).toBe(true);
  });

  it("ignored lists grammar-valid unknown names, sorted; hostile keys never appear", () => {
    const values = JSON.parse(
      '{"__proto__": 5, "zz": 1, "Bad Key": 2, "aa_1": 3, "é": 4, "constructor": 6}',
    ) as Record<string, number>;
    const r = score(lineOf("O", values), S);
    expect(r.ignored).toEqual(["aa_1", "constructor", "zz"]);
    expect(r.points).toBe(0);
  });

  it("unmapped lists settings ids with no canonical", () => {
    const s = sampleSettings({
      add_rules: [{ platform_id: "999", name: "Tackle Solo", position_types: ["D"], modifier: 1 }],
    });
    expect(score(lineOf("D", { idp_tkl: 5 }), s).unmapped).toEqual(["999"]);
  });
});

describe("score — hostile lines", () => {
  it.each<[string, unknown]>([
    ["null line", null],
    ["string line", "pass_yd=300"],
    ["unknown position type", { ...lineOf("O", {}), position_type: "QB" }],
    ["null values", { ...lineOf("O", {}), values: null }],
    ["array-less string values", { ...lineOf("O", {}), values: "x" }],
    ["NaN", lineOf("O", { pass_yd: NaN })],
    ["Infinity", lineOf("O", { pass_yd: Infinity })],
    ["-Infinity in an ignored stat", lineOf("O", { zz: -Infinity })],
    ["absurd magnitude", lineOf("O", { pass_yd: 1e10 })],
    ["string value", { ...lineOf("O", {}), values: { pass_yd: "300" } }],
    ["bigint value", { ...lineOf("O", {}), values: { pass_yd: 300n } }],
  ])("%s → invalid_line", (_, line) => {
    expect(errorOf(() => score(line as StatLine, S)).code).toBe("invalid_line");
  });

  it("accepts negatives and the largest allowed magnitudes with a finite total", () => {
    expect(score(lineOf("O", { rush_yd: -12 }), S).points).toBe(-1.2);
    const big = score(lineOf("O", { pass_yd: 1e9, rush_yd: -1e9, rec: 1e9 }), S);
    expect(Number.isFinite(big.points)).toBe(true);
    expect(big.points).toBe(4e7 - 1e8 + 5e8);
  });

  it("an empty values object with unicode/emoji keys is fine", () => {
    expect(score(lineOf("O", { "🏈": 1 }), S)).toMatchObject({ points: 0, ignored: [] });
  });
});

describe("score — hand-built settings the normaliser would refuse", () => {
  it.each<[string, Partial<ScoringSettings>]>([
    [
      "Infinity modifier",
      {
        rules: [
          {
            canonical: "rec",
            platform_id: "1",
            name: "",
            position_types: ["O"],
            modifier: Infinity,
            bonuses: [],
          },
        ],
      },
    ],
    [
      "NaN bonus target",
      {
        rules: [
          {
            canonical: "rec",
            platform_id: "1",
            name: "",
            position_types: ["O"],
            modifier: 1,
            bonuses: [{ target: NaN, points: 1 }],
          },
        ],
      },
    ],
    [
      "huge bonus points",
      {
        rules: [
          {
            canonical: "rec",
            platform_id: "1",
            name: "",
            position_types: ["O"],
            modifier: 1,
            bonuses: [{ target: 1, points: 1e12 }],
          },
        ],
      },
    ],
    [
      "empty family",
      {
        brackets: [
          { family: "dst_points_allowed", position_type: "DT", members: [], kind: "indicator" },
        ],
      },
    ],
  ])("%s → invalid_settings", (_, over) => {
    expect(errorOf(() => score(lineOf("O", {}), handBuilt(over))).code).toBe("invalid_settings");
  });

  it("an indicator family without a scalar or member rules scores nothing and stays absent", () => {
    const s = handBuilt({
      rules: [],
      brackets: [
        {
          family: "custom",
          position_type: "O",
          kind: "indicator",
          members: [
            { canonical: "c_a", platform_id: "a", lower: 0, upper: 4 },
            { canonical: "c_b", platform_id: "b", lower: 5, upper: null },
          ],
        },
      ],
    });
    expect(score(lineOf("O", { c_a: 1 }), s)).toMatchObject({ points: 0, contributions: [] });
    expect(score(lineOf("O", { custom: 7 }, true), s)).toMatchObject({
      points: 0,
      complete: true,
      ignored: ["custom"],
    });
  });

  it("compiles each settings object once (memo) and a fresh copy identically", () => {
    const l = lineOf("O", { rec: 3 });
    expect(score(l, S)).toEqual(score(l, normalizeSettings(S)));
  });
});

describe("negative floor and rounding (plan 08 §4.4, E4, P8/P9)", () => {
  const noNeg = sampleSettings({ set: { uses_negative_points: false } });
  const neg = { pass_yd: 10, pass_int: 3 };

  it("floors the player-week total when negatives are off (scope player_week_total), verified or not", () => {
    expect(floorApplies(noNeg)).toBe(true);
    expect(score(lineOf("O", neg), noNeg)).toMatchObject({ points: 0, points_exact: -2.6 });
    expect(score(lineOf("O", { pass_yd: 100 }), noNeg).points).toBe(4);
    expect(noNeg.negative_floor.verified).toBe(false);
  });

  it("does not floor with negatives on, or with an unknown/none scope", () => {
    expect(floorApplies(S)).toBe(false);
    expect(score(lineOf("O", neg), S).points).toBe(-2.6);
    const noneScope = sampleSettings({
      set: { uses_negative_points: false, negative_floor: { scope: "none", verified: true } },
    });
    expect(floorApplies(noneScope)).toBe(false);
    expect(score(lineOf("O", neg), noneScope).points).toBe(-2.6);
    const negOnScoped = sampleSettings({
      set: {
        uses_negative_points: true,
        negative_floor: { scope: "player_week_total", verified: true },
      },
    });
    expect(floorApplies(negOnScoped)).toBe(false);
    expect(score(lineOf("O", neg), negOnScoped).points).toBe(-2.6);
    const perStat = sampleSettings({
      set: { uses_negative_points: false, negative_floor: { scope: "per_stat", verified: true } },
    });
    expect(score(lineOf("O", neg), perStat).points).toBe(-2.6);
  });

  it("applies a rounding mode only once verified, and never an unknown mode", () => {
    const line = lineOf("O", { pass_yd: 262, rush_yd: 3 }); // 10.48 + 0.3 = 10.78
    const mk = (mode: string, verified: boolean) =>
      sampleSettings({ set: { rounding: { mode, verified } } });
    expect(score(line, mk("round_half_up_total", false)).points).toBe(10.78);
    expect(score(line, mk("round_half_up_total", true)).points).toBe(11);
    expect(score(line, mk("floor_total", true)).points).toBe(10);
    expect(score(line, mk("banker", true)).points).toBe(10.78);
    expect(appliedRounding(mk("round_half_up_total", false))).toBe("exact");
    expect(appliedRounding(mk("round_half_up_total", true))).toBe("round_half_up_total");
    expect(appliedRounding(mk("floor_total", true))).toBe("floor_total");
    expect(appliedRounding(mk("floor_total", false))).toBe("exact");
    expect(appliedRounding(mk("banker", true))).toBe("exact");
  });

  it("applyPolicy: half-up at .5, negatives, -0 never escapes", () => {
    const half = sampleSettings({
      set: { rounding: { mode: "round_half_up_total", verified: true } },
    });
    expect(applyPolicy(2.5, half)).toBe(3);
    expect(applyPolicy(-2.5, half)).toBe(-2);
    expect(Object.is(applyPolicy(-0.4, half), 0)).toBe(true);
    const fl = sampleSettings({ set: { rounding: { mode: "floor_total", verified: true } } });
    expect(applyPolicy(-0.4, fl)).toBe(-1);
    expect(Object.is(applyPolicy(-0, S), 0)).toBe(true);
    const both = sampleSettings({
      set: { uses_negative_points: false, rounding: { mode: "floor_total", verified: true } },
    });
    expect(applyPolicy(-3.7, both)).toBe(0);
    expect(applyPolicy(3.7, both)).toBe(3);
  });
});
