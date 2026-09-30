// math.test.ts — the analytics numeric kernels (src/domain/analytics/math.ts): Φ against tabled
// values, gamma/Poisson draws against their moments, the type-7 quantile, Spearman with ties, and
// hostile inputs (NaN, ±∞, empty, zero width).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../src/domain/clock.js";
import {
  clamp,
  distFromSamples,
  gammaDraw,
  gammaMultiplier,
  normalCdf,
  normalDist,
  normalDraw,
  poissonDraw,
  quantileSorted,
  ranks,
  round,
  sigmaOf,
  spearman,
  zeroDist,
} from "../../../src/domain/analytics/math.js";

const moments = (xs: readonly number[]): { mean: number; sd: number } => {
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1);
  return { mean, sd: Math.sqrt(v) };
};

describe("normalCdf", () => {
  it.each([
    [0, 0.5],
    [1, 0.8413447],
    [-1, 0.1586553],
    [1.2815516, 0.9],
    [2.3263479, 0.99],
    [-3, 0.0013499],
    [6, 0.999999999],
  ])("Φ(%s) ≈ %s", (x, p) => {
    expect(normalCdf(x)).toBeCloseTo(p, 6);
  });
  it("handles NaN and infinities without claiming certainty from NaN", () => {
    expect(normalCdf(Number.NaN)).toBe(0.5);
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
  });
  it("is monotone and symmetric (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -8, max: 8, noNaN: true }),
        fc.double({ min: 0, max: 4, noNaN: true }),
        (x, d) => {
          expect(normalCdf(x + d)).toBeGreaterThanOrEqual(normalCdf(x) - 1e-12);
          expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 7);
        },
      ),
    );
  });
});

describe("draws", () => {
  it("gammaMultiplier has mean 1 and the requested CV", () => {
    const rng = seededRng(42);
    for (const cv of [0.375, 0.625, 1.3]) {
      const xs = Array.from({ length: 40000 }, () => gammaMultiplier(rng, cv));
      const m = moments(xs);
      expect(m.mean).toBeCloseTo(1, 1);
      expect(m.sd / m.mean).toBeGreaterThan(cv * 0.95);
      expect(m.sd / m.mean).toBeLessThan(cv * 1.05);
      expect(xs.every((x) => x > 0 && Number.isFinite(x))).toBe(true);
    }
  });
  it("gammaMultiplier with cv ≤ 0 or NaN is exactly 1", () => {
    const rng = seededRng(1);
    expect(gammaMultiplier(rng, 0)).toBe(1);
    expect(gammaMultiplier(rng, -1)).toBe(1);
    expect(gammaMultiplier(rng, Number.NaN)).toBe(1);
  });
  it("gammaDraw covers shape < 1 and refuses a bad shape", () => {
    const rng = seededRng(3);
    const xs = Array.from({ length: 20000 }, () => gammaDraw(rng, 0.5));
    expect(moments(xs).mean).toBeCloseTo(0.5, 1);
    expect(() => gammaDraw(rng, 0)).toThrow(RangeError);
    expect(() => gammaDraw(rng, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
  it("poissonDraw matches its mean in both regimes; λ ≤ 0 or NaN draws 0", () => {
    const rng = seededRng(9);
    for (const lambda of [0.3, 2.4, 55]) {
      const xs = Array.from({ length: 20000 }, () => poissonDraw(rng, lambda));
      expect(moments(xs).mean / lambda).toBeGreaterThan(0.97);
      expect(moments(xs).mean / lambda).toBeLessThan(1.03);
      expect(xs.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
    expect(poissonDraw(rng, 0)).toBe(0);
    expect(poissonDraw(rng, -3)).toBe(0);
    expect(poissonDraw(rng, Number.NaN)).toBe(0);
  });
  it("normalDraw is standard normal and finite even when the stream returns 0", () => {
    const zeroRng = { next: () => 0, fork: () => zeroRng };
    expect(Number.isFinite(normalDraw(zeroRng))).toBe(true);
    const rng = seededRng(5);
    const m = moments(Array.from({ length: 40000 }, () => normalDraw(rng)));
    expect(Math.abs(m.mean)).toBeLessThan(0.03);
    expect(m.sd).toBeCloseTo(1, 1);
  });
});

describe("quantiles and distributions", () => {
  it("quantileSorted is Hyndman–Fan type 7", () => {
    const xs = [1, 2, 3, 4, 10];
    expect(quantileSorted(xs, 0)).toBe(1);
    expect(quantileSorted(xs, 1)).toBe(10);
    expect(quantileSorted(xs, 0.5)).toBe(3);
    expect(quantileSorted(xs, 0.9)).toBeCloseTo(7.6, 10);
    expect(quantileSorted([], 0.5)).toBe(0);
    expect(quantileSorted([7], 0.3)).toBe(7);
    expect(quantileSorted(xs, 2)).toBe(10);
    expect(quantileSorted(xs, -1)).toBe(1);
  });
  it("distFromSamples orders its quantiles and counts exact zeros (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -50, max: 80, noNaN: true }), { minLength: 1, maxLength: 200 }),
        (xs) => {
          const d = distFromSamples(xs, "position_cv");
          expect(d.p10).toBeLessThanOrEqual(d.p25);
          expect(d.p25).toBeLessThanOrEqual(d.p50);
          expect(d.p50).toBeLessThanOrEqual(d.p75);
          expect(d.p75).toBeLessThanOrEqual(d.p90);
          expect(d.p_zero).toBeGreaterThanOrEqual(0);
          expect(d.p_zero).toBeLessThanOrEqual(1);
          expect(d.basis).toBe("position_cv");
        },
      ),
    );
    expect(distFromSamples([], "player_sim")).toMatchObject({ mean: 0, p_zero: 1 });
    expect(distFromSamples([0, 0, 4, 6], "position_cv").p_zero).toBe(0.5);
  });
  it("zeroDist / normalDist / sigmaOf", () => {
    expect(zeroDist("position_cv")).toEqual({
      mean: 0,
      p10: 0,
      p25: 0,
      p50: 0,
      p75: 0,
      p90: 0,
      p_zero: 1,
      basis: "position_cv",
    });
    const d = normalDist(100, 10, "position_cv");
    expect(d.p10).toBeCloseTo(87.18, 2);
    expect(d.p90).toBeCloseTo(112.82, 2);
    expect(d.p_zero).toBe(0);
    expect(sigmaOf(d)).toBeCloseTo(10, 3);
    expect(normalDist(0, 0, "position_cv").p_zero).toBe(1);
    expect(normalDist(5, -3, "position_cv").p90).toBe(5);
    expect(sigmaOf(zeroDist("position_cv"))).toBe(0);
    expect(sigmaOf({ ...d, p90: Number.NaN })).toBe(0);
    expect(sigmaOf({ ...d, p10: 200 })).toBe(0);
  });
  it("round normalises −0 and clamp bounds", () => {
    expect(Object.is(round(-0.00001, 3), 0)).toBe(true);
    expect(round(1.23456, 2)).toBe(1.23);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });
});

describe("ranks / spearman", () => {
  it("average ranks share ties", () => {
    expect(ranks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
    expect(ranks([])).toEqual([]);
  });
  it("spearman: perfect, inverse, ties, degenerate", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 2, 3], [1, 3, 2, 4])).toBeCloseTo(0.9487, 3);
    expect(spearman([1], [1])).toBeNull();
    expect(spearman([1, 2], [1])).toBeNull();
    expect(spearman([3, 3, 3], [1, 2, 3])).toBeNull();
  });
  it("spearman is in [-1, 1] (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: -9, max: 9 }), fc.integer({ min: -9, max: 9 })), {
          minLength: 2,
          maxLength: 40,
        }),
        (pairs) => {
          const r = spearman(
            pairs.map((p) => p[0]),
            pairs.map((p) => p[1]),
          );
          if (r !== null) {
            expect(r).toBeGreaterThanOrEqual(-1 - 1e-12);
            expect(r).toBeLessThanOrEqual(1 + 1e-12);
          }
        },
      ),
    );
  });
});
