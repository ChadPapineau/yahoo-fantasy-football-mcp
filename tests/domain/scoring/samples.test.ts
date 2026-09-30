// samples.test.ts — src/domain/scoring/engine.ts `scoreSamples`: plan 08 §2, §5, E5 (score the
// SAMPLES: E[bonus] ≠ bonus(E)), E8 (`basis` stamped on the Dist), bracket/bonus probabilities.
import { describe, expect, it } from "vitest";
import { score, scoreSamples } from "../../../src/domain/scoring/engine.js";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import type { DistBasis, StatLine } from "../../../src/domain/scoring/types.js";
import { lineOf, sampleSettings } from "./fixtures.js";

const S = sampleSettings();

describe("scoreSamples — Dist", () => {
  it("type-7 quantiles, mean and p_zero over the scored samples; basis copied", () => {
    const lines = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((y) =>
      lineOf("O", { rush_yd: y }),
    );
    const r = scoreSamples(lines, S, "position_cv");
    expect(r.dist).toEqual({
      mean: 5,
      p10: 1,
      p25: 2.5,
      p50: 5,
      p75: 7.5,
      p90: 9,
      p_zero: r.dist.p_zero,
      basis: "position_cv",
    });
    expect(r.dist.p_zero).toBeCloseTo(1 / 11, 12);
    expect(r.mean_of_exact).toBe(5);
    expect(scoreSamples(lines, S, "player_sim").dist.basis).toBe("player_sim");
  });

  it("interpolates between samples and handles a single sample", () => {
    const r = scoreSamples([lineOf("O", { rec: 1 }), lineOf("O", { rec: 4 })], S, "player_sim");
    expect(r.dist).toMatchObject({ p10: 0.65, p50: 1.25, p90: 1.85, mean: 1.25, p_zero: 0 });
    const one = scoreSamples([lineOf("O", { rec: 3 })], S, "player_sim").dist;
    expect([one.p10, one.p50, one.p90, one.mean]).toEqual([1.5, 1.5, 1.5, 1.5]);
  });

  it("quantiles use FINAL points (floor applied) while mean_of_exact stays exact", () => {
    const noNeg = sampleSettings({ set: { uses_negative_points: false } });
    const lines = [lineOf("O", { pass_int: 2 }), lineOf("O", { pass_td: 1 })];
    const r = scoreSamples(lines, noNeg, "position_cv");
    expect(r.dist.mean).toBe(2);
    expect(r.dist.p_zero).toBe(0.5);
    expect(r.mean_of_exact).toBe(1);
  });

  it.each<[string, unknown, unknown]>([
    ["empty batch", [], "position_cv"],
    ["not an array", { length: 1, 0: lineOf("O", {}) }, "position_cv"],
    ["unknown basis", [lineOf("O", {})], "gaussian"],
  ])("refuses %s", (_, lines, basis) => {
    expect(() => scoreSamples(lines as StatLine[], S, basis as DistBasis)).toThrow(ScoringError);
  });

  it("propagates a bad sample's error", () => {
    expect(() => scoreSamples([lineOf("O", { rec: NaN })], S, "position_cv")).toThrow(/finite/);
  });
});

describe("scoreSamples — E[bonus] from samples, never bonus(E) (plan 08 §4.2, E5)", () => {
  const s = sampleSettings({
    bonuses: {
      "9": [
        { target: 100, points: 10 },
        { target: 150, points: 20 },
      ],
    },
  });

  it("half the samples at 50 yards and half at 150 pay the bonus half the time", () => {
    const lines = [lineOf("O", { rush_yd: 50 }), lineOf("O", { rush_yd: 150 })];
    const r = scoreSamples(lines, s, "player_sim");
    // mean line (100 yd) would pay +10: bonus(E) = 10 + 10; E[bonus] = 0.5 × 30 = 15
    expect(score(lineOf("O", { rush_yd: 100 }), s).points).toBe(20);
    expect(r.mean_of_exact).toBe(10 + 15);
    expect(r.dist.mean).toBe(25);
    expect(r.bonus_probability).toEqual({ rush_yd: 0.5 });
  });

  it("keys every bonus stat the batch's position types can use, sorted, with 0 when never fired", () => {
    const multi = sampleSettings({
      bonuses: {
        "9": [{ target: 100, points: 1 }],
        "4": [{ target: 300, points: 2 }],
        "12": [{ target: 100, points: 1 }],
      },
    });
    const r = scoreSamples(
      [lineOf("O", { pass_yd: 310 }), lineOf("K", { pat_made: 1 })],
      multi,
      "player_sim",
    );
    expect(Object.keys(r.bonus_probability)).toEqual(["pass_yd", "rec_yd", "rush_yd"]);
    expect(r.bonus_probability).toEqual({ pass_yd: 0.5, rec_yd: 0, rush_yd: 0 });
  });

  it("sums hits for one canonical carried by rules in two position types", () => {
    const two = normalizeSettings({
      platform: "manual",
      uses_fractional_points: true,
      uses_negative_points: true,
      rules: [
        {
          platform_id: "a",
          name: "Rushing Yards",
          canonical: "rush_yd",
          position_types: ["O"],
          modifier: 0.1,
          bonuses: [{ target: 100, points: 1 }],
        },
        {
          platform_id: "b",
          name: "Rushing Yards",
          canonical: "rush_yd",
          position_types: ["D"],
          modifier: 0.1,
          bonuses: [{ target: 100, points: 1 }],
        },
      ],
    });
    const r = scoreSamples(
      [
        lineOf("O", { rush_yd: 120 }),
        lineOf("D", { rush_yd: 130 }),
        lineOf("D", { rush_yd: 0 }),
        lineOf("O", { rush_yd: 0 }),
      ],
      two,
      "player_sim",
    );
    expect(r.bonus_probability).toEqual({ rush_yd: 0.5 });
  });
});

describe("scoreSamples — bracket_probability", () => {
  it("indicator family: P(member); absent-family samples count as no member", () => {
    const lines = [
      lineOf("DT", { dst_pa: 0 }),
      lineOf("DT", { dst_pa: 10 }),
      lineOf("DT", { dst_pa: 10 }),
      lineOf("DT", {}),
    ];
    const r = scoreSamples(lines, S, "position_cv");
    expect(r.bracket_probability).toEqual({ dst_points_allowed: [0.25, 0, 0.5, 0, 0, 0, 0] });
    expect(r.mean_of_exact).toBe((10 + 4 + 4) / 4);
  });

  it("count family: E[count] per bin; keys for every family the batch's types can use, sorted", () => {
    const lines = [
      lineOf("K", { fg_40_49: 2, fg_50p: 1 }),
      lineOf("K", { fg_20_29: 1 }),
      lineOf("DT", { dst_pa: 3 }),
    ];
    const r = scoreSamples(lines, S, "player_sim");
    expect(Object.keys(r.bracket_probability)).toEqual(["dst_points_allowed", "fg_distance"]);
    const near = (got: readonly number[] | undefined, want: readonly number[]) => {
      expect(got).toHaveLength(want.length);
      want.forEach((w, k) => {
        expect(got![k]).toBeCloseTo(w, 12);
      });
    };
    near(r.bracket_probability.fg_distance, [0, 1 / 3, 0, 2 / 3, 1 / 3]);
    near(r.bracket_probability.dst_points_allowed, [0, 1 / 3, 0, 0, 0, 0, 0]);
  });

  it("orders three or more families by name", () => {
    const s = normalizeSettings({
      platform: "manual",
      uses_fractional_points: true,
      uses_negative_points: true,
      rules: [
        { platform_id: "1", name: "Yards Allowed 0-99", position_types: ["DT"], modifier: 5 },
        { platform_id: "2", name: "Yards Allowed 100+", position_types: ["DT"], modifier: 0 },
        { platform_id: "3", name: "Points Allowed 0-9", position_types: ["DT"], modifier: 5 },
        { platform_id: "4", name: "Points Allowed 10+", position_types: ["DT"], modifier: 0 },
        {
          platform_id: "5",
          canonical: "q_a",
          name: "Quux 0-1",
          position_types: ["DT"],
          modifier: 1,
        },
        {
          platform_id: "6",
          canonical: "q_b",
          name: "Quux 2+",
          position_types: ["DT"],
          modifier: 1,
        },
      ],
    });
    const r = scoreSamples([lineOf("DT", { dst_pa: 3, dst_ya: 150, q_a: 2 })], s, "player_sim");
    expect(Object.keys(r.bracket_probability)).toEqual([
      "dst_points_allowed",
      "dst_yards_allowed",
      "quux",
    ]);
    expect(r.bracket_probability).toEqual({
      dst_points_allowed: [1, 0],
      dst_yards_allowed: [0, 1],
      quux: [2, 0],
    });
    expect(r.mean_of_exact).toBe(5 + 0 + 2);
  });
});

describe("scoreSamples — volume", () => {
  it("scores 4000 samples deterministically and quickly (A15 budget)", () => {
    const lines = Array.from({ length: 4000 }, (_, i) =>
      lineOf("O", {
        pass_yd: (i * 37) % 400,
        pass_td: i % 4,
        rush_yd: (i * 13) % 60,
        fum_lost: i % 7 === 0 ? 1 : 0,
      }),
    );
    const t0 = performance.now();
    const a = scoreSamples(lines, S, "player_sim");
    const elapsed = performance.now() - t0;
    expect(JSON.stringify(scoreSamples(lines, S, "player_sim"))).toBe(JSON.stringify(a));
    expect(elapsed).toBeLessThan(1000);
    expect(Math.abs(a.dist.mean - a.mean_of_exact)).toBeLessThan(1e-9);
  });
});
