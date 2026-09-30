// metrics.test.ts — src/domain/reclog/metrics.ts: the 05 §12 "evaluation of the evaluator" (plan 10
// A9, T10: 100 % lines + branches) — known values, calibrated-vs-misspecified synthetic forecasters,
// fast-check invariants (CRPS ≥ 0 and = 0 iff degenerate at the outcome, Brier bounds, Spearman in
// [−1, 1]) and hostile inputs (NaN, ±Infinity, empty, mismatched lengths, out-of-range values).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { seededRng } from "../../../src/domain/clock.js";
import {
  DIST_LEVELS,
  MAX_ABS_VALUE,
  RELIABILITY_BINS,
  accuracyGapSum,
  at,
  averageRanks,
  binIndex,
  brierScore,
  brierWithDecomposition,
  crpsFromDist,
  crpsFromQuantiles,
  crpsFromSamples,
  distKnots,
  intervalCoverage,
  meanPinball,
  pinballLoss,
  spearman,
  stableMean,
  stableSum,
  type ProbabilityOutcome,
} from "../../../src/domain/reclog/metrics.js";
import { Z, normalDist, normals, pointDist } from "./helpers.js";

// multiples of 1/64 in ±1000: exact in binary, so no subnormal underflow blurs an equality property
const finite = fc.integer({ min: -64_000, max: 64_000 }).map((i) => i / 64);
const prob = fc.double({ min: 0, max: 1, noNaN: true });
const HOSTILE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, MAX_ABS_VALUE * 2];

/** Reference CRPS of an ECDF: E|X − y| − ½ E|X − X′| (the NRG form; exact for small inputs). */
function crpsNrg(xs: readonly number[], y: number): number {
  const m = xs.length;
  let a = 0;
  let b = 0;
  for (const x of xs) {
    a += Math.abs(x - y);
    for (const x2 of xs) b += Math.abs(x - x2);
  }
  return a / m - b / (2 * m * m);
}

/** Reference CRPS from a quantile function by fine midpoint integration of 2·pinball over τ. */
function crpsNumeric(q: (tau: number) => number, y: number, steps = 20_000): number {
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const tau = (i + 0.5) / steps;
    s += pinballLoss(q(tau), y, tau);
  }
  return (2 * s) / steps;
}

/** The piecewise-linear quantile function crpsFromQuantiles assumes, for the reference integral. */
function pwlQuantile(knots: { level: number; value: number }[]): (tau: number) => number {
  const first = knots[0]!;
  const last = knots[knots.length - 1]!;
  const lo =
    knots.length > 1 ? (knots[1]!.value - first.value) / (knots[1]!.level - first.level) : 0;
  const hiPrev = knots[knots.length - 2];
  const hi = hiPrev !== undefined ? (last.value - hiPrev.value) / (last.level - hiPrev.level) : 0;
  const full = [
    { level: 0, value: first.value - lo * first.level },
    ...knots,
    { level: 1, value: last.value + hi * (1 - last.level) },
  ];
  return (tau) => {
    for (let i = 0; i + 1 < full.length; i++) {
      const a = full[i]!;
      const b = full[i + 1]!;
      if (tau <= b.level)
        return a.value + ((b.value - a.value) * (tau - a.level)) / (b.level - a.level);
    }
    return last.value;
  };
}

describe("at", () => {
  it("returns an in-range element and throws outside the array", () => {
    expect(at([4, 5], 1)).toBe(5);
    expect(() => at([4, 5], 2)).toThrow(RangeError);
    expect(() => at([], 0)).toThrow(/out of range/);
    expect(() => at([1], -1)).toThrow(RangeError);
  });
});

describe("stable summation", () => {
  it("keeps the small terms a naive sum loses (Neumaier)", () => {
    expect([1e16, 1, -1e16].reduce((a, b) => a + b, 0)).toBe(0);
    expect(stableSum([1e16, 1, -1e16])).toBe(1);
    expect(stableSum([1, 1e100, 1, -1e100])).toBe(2);
    expect(stableSum(Array.from({ length: 10_000 }, () => 0.1))).toBeCloseTo(1000, 10);
    expect(stableSum([])).toBe(0);
  });

  it("means: null for empty, exact for one sample", () => {
    expect(stableMean([])).toBeNull();
    expect(stableMean([7.25])).toBe(7.25);
    expect(stableMean([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("Brier score", () => {
  it("scores known values and is bounded in [0, 1]", () => {
    expect(brierScore([{ p: 1, outcome: true }])).toBe(0);
    expect(brierScore([{ p: 0, outcome: true }])).toBe(1);
    expect(
      brierScore([
        { p: 0.7, outcome: true },
        { p: 0.2, outcome: false },
      ]),
    ).toBeCloseTo((0.09 + 0.04) / 2, 15);
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: prob, outcome: fc.boolean() }), { minLength: 1, maxLength: 200 }),
        (pairs) => {
          const b = brierScore(pairs);
          return b >= 0 && b <= 1;
        },
      ),
    );
  });

  it("rejects hostile input", () => {
    expect(() => brierScore([])).toThrow(/at least one/);
    for (const p of [...HOSTILE, -0.01, 1.01])
      expect(() => brierScore([{ p, outcome: true }])).toThrow(RangeError);
    expect(() => brierScore([{ p: "0.5" as unknown as number, outcome: true }])).toThrow(
      RangeError,
    );
    expect(() => brierScore([{ p: 0.5, outcome: 1 as unknown as boolean }])).toThrow(/boolean/);
  });

  it("bins forecasts by decile with p = 1 in the last bin", () => {
    expect(RELIABILITY_BINS).toBe(10);
    expect(binIndex(0)).toBe(0);
    expect(binIndex(0.0999)).toBe(0);
    expect(binIndex(0.1)).toBe(1);
    expect(binIndex(0.95)).toBe(9);
    expect(binIndex(1)).toBe(9);
    expect(binIndex(0.5, 2)).toBe(1);
    expect(binIndex(1, 1)).toBe(0);
  });

  it("rejects an invalid bin count", () => {
    const pairs = [{ p: 0.5, outcome: true }];
    for (const bins of [0, 1.5, 1001, Number.NaN])
      expect(() => brierWithDecomposition(pairs, bins)).toThrow(/bins/);
    expect(brierWithDecomposition(pairs, 1).n).toBe(1);
  });
});

describe("Murphy decomposition — the evaluator reproduces known quantities (05 §12, A9)", () => {
  const rng = seededRng(20260930);
  const n = 20_000;

  it("a climatological forecaster (always the base rate) scores Brier = uncertainty, reliability 0", () => {
    const outcomes = Array.from({ length: n }, () => rng.next() < 0.3);
    const base = outcomes.filter(Boolean).length / n;
    const pairs = outcomes.map((outcome) => ({ p: base, outcome }));
    const r = brierWithDecomposition(pairs);
    const d = r.decomposition!;
    expect(d.reliability).toBeCloseTo(0, 12);
    expect(d.resolution).toBeCloseTo(0, 12);
    expect(d.uncertainty).toBeCloseTo(base * (1 - base), 12);
    expect(r.value).toBeCloseTo(d.uncertainty, 12);
    expect(r.n).toBe(n);
  });

  it("a perfectly calibrated sharp forecaster: reliability ≈ 0, Brier = UNC − RES < UNC (identity exact)", () => {
    const levels = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
    const pairs: ProbabilityOutcome[] = Array.from({ length: n }, () => {
      const p = levels[Math.floor(rng.next() * levels.length)]!;
      return { p, outcome: rng.next() < p };
    });
    const r = brierWithDecomposition(pairs);
    const d = r.decomposition!;
    expect(d.reliability).toBeLessThan(0.001);
    expect(d.resolution).toBeGreaterThan(0.05);
    // one forecast value per decile bin → the decomposition is exact
    expect(d.reliability - d.resolution + d.uncertainty).toBeCloseTo(r.value, 12);
    expect(r.value).toBeLessThan(d.uncertainty);
  });

  it("a random forecaster (independent of the outcome) scores worse than the uncertainty term", () => {
    const pairs = Array.from({ length: n }, () => ({ p: rng.next(), outcome: rng.next() < 0.3 }));
    const r = brierWithDecomposition(pairs);
    expect(r.value).toBeGreaterThan(r.decomposition!.uncertainty + 0.05);
    expect(r.decomposition!.reliability).toBeGreaterThan(0.05);
  });

  it("an overconfident forecaster has positive reliability (miscalibration is detected)", () => {
    const pairs = Array.from({ length: n }, () => {
      const truth = rng.next() < 0.5 ? 0.3 : 0.7;
      return { p: truth === 0.3 ? 0.05 : 0.95, outcome: rng.next() < truth };
    });
    const d = brierWithDecomposition(pairs).decomposition!;
    expect(d.reliability).toBeGreaterThan(0.05);
  });

  it("property: components are in range and the identity is exact when forecasts repeat per bin", () => {
    const decile = fc.integer({ min: 0, max: 9 }).map((k) => (k + 0.5) / 10);
    fc.assert(
      fc.property(
        fc.array(fc.record({ p: decile, outcome: fc.boolean() }), { minLength: 1, maxLength: 300 }),
        (pairs) => {
          const r = brierWithDecomposition(pairs);
          const d = r.decomposition!;
          expect(d.reliability).toBeGreaterThanOrEqual(0);
          expect(d.resolution).toBeGreaterThanOrEqual(0);
          expect(d.uncertainty).toBeGreaterThanOrEqual(0);
          expect(d.uncertainty).toBeLessThanOrEqual(0.25);
          expect(d.reliability - d.resolution + d.uncertainty).toBeCloseTo(r.value, 10);
        },
      ),
    );
  });
});

describe("CRPS from samples", () => {
  it("matches known values", () => {
    expect(crpsFromSamples([0], 0)).toBe(0);
    expect(crpsFromSamples([0], 2)).toBe(2);
    expect(crpsFromSamples([2], -3)).toBe(5);
    expect(crpsFromSamples([0, 2], 1)).toBeCloseTo(0.5, 15);
    expect(crpsFromSamples([1, 1, 1], 1)).toBe(0);
    expect(crpsFromSamples([3, 1, 2], 2)).toBeCloseTo(crpsNrg([1, 2, 3], 2), 14);
  });

  it("property: equals the NRG form, is ≥ 0, and is 0 iff every sample equals the outcome", () => {
    fc.assert(
      fc.property(fc.array(finite, { minLength: 1, maxLength: 40 }), finite, (xs, y) => {
        const c = crpsFromSamples(xs, y);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeCloseTo(crpsNrg(xs, y), 6);
        expect(c === 0).toBe(xs.every((x) => x === y));
      }),
    );
    fc.assert(
      fc.property(
        finite,
        fc.integer({ min: 1, max: 50 }),
        (y, m) => crpsFromSamples(Array(m).fill(y), y) === 0,
      ),
    );
  });

  it("does not depend on sample order and handles 20 000 samples (n_sims max)", () => {
    const xs = normals(7, 20_000, 10, 5);
    const c1 = crpsFromSamples(xs, 12);
    const c2 = crpsFromSamples([...xs].reverse(), 12);
    expect(c1).toBeCloseTo(c2, 12);
    expect(c1).toBeGreaterThan(0);
  });

  it("rejects hostile input", () => {
    expect(() => crpsFromSamples([], 1)).toThrow(/at least one sample/);
    for (const bad of HOSTILE) {
      expect(() => crpsFromSamples([1, bad], 1)).toThrow(RangeError);
      expect(() => crpsFromSamples([1], bad)).toThrow(RangeError);
    }
  });
});

describe("CRPS from quantiles", () => {
  it("a single knot is a point mass: CRPS = |c − y|", () => {
    expect(crpsFromQuantiles([{ level: 0.5, value: 3 }], 3)).toBe(0);
    expect(crpsFromQuantiles([{ level: 0.5, value: 3 }], 7)).toBeCloseTo(4, 14);
    expect(crpsFromQuantiles([{ level: 0.5, value: 3 }], -1)).toBeCloseTo(4, 14);
  });

  it("a degenerate Dist scores |c − y|, and 0 at its own value", () => {
    expect(crpsFromDist(pointDist(10), 10)).toBe(0);
    expect(crpsFromDist(pointDist(10), 13.5)).toBeCloseTo(3.5, 12);
    expect(crpsFromDist(pointDist(0), 0)).toBe(0);
  });

  it("uses the five Dist levels", () => {
    expect([...DIST_LEVELS]).toEqual([0.1, 0.25, 0.5, 0.75, 0.9]);
    expect(distKnots(normalDist(0, 1)).map((k) => k.level)).toEqual([...DIST_LEVELS]);
  });

  it("matches a fine numerical integral of the same piecewise-linear quantile function", () => {
    const d = normalDist(10, 4);
    const q = pwlQuantile(distKnots(d));
    for (const y of [-20, 0, 4.9, 10, 10.0001, 13.3, 40])
      expect(crpsFromDist(d, y)).toBeCloseTo(crpsNumeric(q, y), 4);
    // a flat run of quantiles and an outcome exactly on a knot
    const flat = [
      { level: 0.1, value: 0 },
      { level: 0.25, value: 0 },
      { level: 0.5, value: 5 },
      { level: 0.9, value: 20 },
    ];
    for (const y of [0, 5, 20, 2.5])
      expect(crpsFromQuantiles(flat, y)).toBeCloseTo(crpsNumeric(pwlQuantile(flat), y), 4);
  });

  it("approximates the normal CRPS (σ(1/√π − 2φ(0) − …)): within 6 % at the median", () => {
    // closed form for N(0,1) at y = 0: 2φ(0) − 1/√π
    const exact = 2 / Math.sqrt(2 * Math.PI) - 1 / Math.sqrt(Math.PI);
    expect(Math.abs(crpsFromDist(normalDist(0, 1), 0) - exact) / exact).toBeLessThan(0.06);
  });

  it("property: ≥ 0, 0 iff every quantile equals the outcome, matches the numeric integral", () => {
    const knotsArb = fc
      .uniqueArray(fc.integer({ min: 1, max: 99 }), { minLength: 1, maxLength: 6 })
      .chain((lv) =>
        fc
          .array(fc.double({ min: -100, max: 100, noNaN: true }), {
            minLength: lv.length,
            maxLength: lv.length,
          })
          .map((vs) => {
            const levels = [...lv].sort((a, b) => a - b).map((l) => l / 100);
            const values = [...vs].sort((a, b) => a - b);
            return levels.map((level, i) => ({ level, value: values[i]! }));
          }),
      );
    fc.assert(
      fc.property(knotsArb, fc.double({ min: -150, max: 150, noNaN: true }), (knots, y) => {
        const c = crpsFromQuantiles(knots, y);
        expect(c).toBeGreaterThanOrEqual(0);
        if (knots.every((k) => k.value === y)) expect(c).toBe(0);
        // a positive CRPS is representable only when the spread is: a forecast within subnormal
        // distance of the outcome (e.g. knots 0 and 5e-324, y = 0) has an exact CRPS below
        // Number.MIN_VALUE, whose correctly rounded binary64 value IS 0
        else if (Math.max(...knots.map((k) => Math.abs(k.value - y))) > 1e-300)
          expect(c).toBeGreaterThan(0);
        expect(c).toBeCloseTo(crpsNumeric(pwlQuantile(knots), y, 4000), 1);
      }),
      { numRuns: 150 },
    );
  });

  it("a forecast within subnormal distance of the outcome scores the correctly rounded 0", () => {
    // the CI counterexample (fast-check seed 722633578): the exact CRPS is below Number.MIN_VALUE
    const tiny = [
      { level: 0.43, value: 0 },
      { level: 0.63, value: 5e-324 },
    ];
    expect(crpsFromQuantiles(tiny, 0)).toBe(0);
    // the same shape at a representable scale is strictly positive and scales linearly
    const s = 1e-300;
    const small = crpsFromQuantiles(
      [
        { level: 0.43, value: 0 },
        { level: 0.63, value: s },
      ],
      0,
    );
    expect(small).toBeGreaterThan(0);
    const unit = crpsFromQuantiles(
      [
        { level: 0.43, value: 0 },
        { level: 0.63, value: 1 },
      ],
      0,
    );
    expect(small / s).toBeCloseTo(unit, 10);
  });

  it("rejects hostile knots and outcomes", () => {
    expect(() => crpsFromQuantiles([], 0)).toThrow(/at least one quantile/);
    for (const level of [0, 1, -0.1, 1.5, Number.NaN])
      expect(() => crpsFromQuantiles([{ level, value: 1 }], 0)).toThrow(/strictly inside/);
    expect(() =>
      crpsFromQuantiles(
        [
          { level: 0.5, value: 1 },
          { level: 0.5, value: 2 },
        ],
        0,
      ),
    ).toThrow(/strictly increasing/);
    expect(() =>
      crpsFromQuantiles(
        [
          { level: 0.2, value: 3 },
          { level: 0.8, value: 2 },
        ],
        0,
      ),
    ).toThrow(/non-decreasing/);
    for (const bad of HOSTILE) {
      expect(() => crpsFromQuantiles([{ level: 0.5, value: bad }], 0)).toThrow(RangeError);
      expect(() => crpsFromQuantiles([{ level: 0.5, value: 0 }], bad)).toThrow(RangeError);
    }
    expect(() => crpsFromDist({ ...normalDist(0, 1), p25: 5 }, 0)).toThrow(/non-decreasing/);
  });
});

describe("CRPS rewards the true distribution over misspecified ones (05 §12, A9)", () => {
  const MU = 10;
  const SIGMA = 4;
  const ys = normals(42, 4000, MU, SIGMA);
  const avg = (f: (y: number) => number): number => stableSum(ys.map(f)) / ys.length;

  it("from quantiles: true < shifted, true < too narrow, true < too wide", () => {
    const truth = avg((y) => crpsFromDist(normalDist(MU, SIGMA), y));
    const shifted = avg((y) => crpsFromDist(normalDist(MU + 3, SIGMA), y));
    const narrow = avg((y) => crpsFromDist(normalDist(MU, SIGMA / 3), y));
    const wide = avg((y) => crpsFromDist(normalDist(MU, SIGMA * 2.5), y));
    expect(truth).toBeLessThan(shifted);
    expect(truth).toBeLessThan(narrow);
    expect(truth).toBeLessThan(wide);
  });

  it("from samples: true < shifted, true < too narrow", () => {
    const sub = ys.slice(0, 800);
    const mean = (gen: (i: number) => number[]): number =>
      stableSum(sub.map((y, i) => crpsFromSamples(gen(i), y))) / sub.length;
    const truth = mean((i) => normals(1000 + i, 400, MU, SIGMA));
    const shifted = mean((i) => normals(1000 + i, 400, MU + 3, SIGMA));
    const narrow = mean((i) => normals(1000 + i, 400, MU, SIGMA / 3));
    expect(truth).toBeLessThan(shifted);
    expect(truth).toBeLessThan(narrow);
  });
});

describe("pinball loss", () => {
  it("matches the definition", () => {
    expect(pinballLoss(10, 14, 0.9)).toBeCloseTo(3.6, 14);
    expect(pinballLoss(10, 6, 0.9)).toBeCloseTo(0.4, 14);
    expect(pinballLoss(10, 10, 0.5)).toBe(0);
    expect(meanPinball([10, 10], [14, 6], 0.9)).toBeCloseTo(2, 14);
  });

  it("property: ≥ 0 and 0 iff the quantile equals the outcome", () => {
    fc.assert(
      fc.property(finite, finite, fc.double({ min: 0.01, max: 0.99, noNaN: true }), (q, y, tau) => {
        const l = pinballLoss(q, y, tau);
        return l >= 0 && (l === 0) === (q === y);
      }),
    );
  });

  it("is minimised at the true quantile (05 §12, A9)", () => {
    const ys = normals(99, 5000);
    for (const [tau, z] of [
      [0.1, Z.p10],
      [0.5, 0],
      [0.9, Z.p90],
    ] as const) {
      const atTruth = meanPinball(Array(ys.length).fill(z), ys, tau);
      for (const d of [-0.5, -0.2, 0.2, 0.5])
        expect(atTruth).toBeLessThan(meanPinball(Array(ys.length).fill(z + d), ys, tau));
    }
  });

  it("over a sample, the minimiser is the ⌈nτ⌉-th order statistic", () => {
    const ys = normals(5, 101);
    const sorted = [...ys].sort((a, b) => a - b);
    const tau = 0.9;
    const losses = sorted.map((q) => meanPinball(Array(ys.length).fill(q), ys, tau));
    const best = losses.indexOf(Math.min(...losses));
    expect(best).toBe(Math.ceil(ys.length * tau) - 1);
  });

  it("rejects hostile input", () => {
    for (const tau of [0, 1, -1, Number.NaN]) expect(() => pinballLoss(1, 1, tau)).toThrow(/tau/);
    for (const bad of HOSTILE) {
      expect(() => pinballLoss(bad, 1, 0.5)).toThrow(RangeError);
      expect(() => pinballLoss(1, bad, 0.5)).toThrow(RangeError);
    }
    expect(() => meanPinball([1, 2], [1], 0.5)).toThrow(/lengths differ/);
    expect(() => meanPinball([], [], 0.5)).toThrow(/at least one pair/);
  });
});

describe("80 % interval coverage", () => {
  it("a calibrated 80 % interval covers ≈ 0.8 of seeded outcomes", () => {
    for (const seed of [1, 2, 3]) {
      const ys = normals(seed, 5000);
      const c = intervalCoverage(
        ys.map(() => ({ lo: Z.p10, hi: Z.p90 })),
        ys,
      );
      expect(Math.abs(c - 0.8)).toBeLessThan(0.025);
    }
  });

  it("an overconfident interval under-covers", () => {
    const ys = normals(4, 5000);
    expect(
      intervalCoverage(
        ys.map(() => ({ lo: -0.5, hi: 0.5 })),
        ys,
      ),
    ).toBeLessThan(0.5);
  });

  it("counts both ends as inside (an outcome of exactly 0 in a [0, x] band)", () => {
    expect(
      intervalCoverage(
        [
          { lo: 0, hi: 5 },
          { lo: 0, hi: 5 },
          { lo: 0, hi: 5 },
        ],
        [0, 5, 5.01],
      ),
    ).toBeCloseTo(2 / 3, 15);
    expect(intervalCoverage([{ lo: 1, hi: 1 }], [1])).toBe(1);
    expect(intervalCoverage([{ lo: 1, hi: 2 }], [0.5])).toBe(0);
  });

  it("rejects hostile input", () => {
    expect(() => intervalCoverage([{ lo: 2, hi: 1 }], [1])).toThrow(/lo <= hi/);
    expect(() => intervalCoverage([{ lo: 0, hi: 1 }], [1, 2])).toThrow(/lengths differ/);
    expect(() => intervalCoverage([], [])).toThrow(/at least one pair/);
    for (const bad of HOSTILE) {
      expect(() => intervalCoverage([{ lo: bad, hi: 1 }], [0])).toThrow(RangeError);
      expect(() => intervalCoverage([{ lo: 0, hi: bad }], [0])).toThrow(RangeError);
      expect(() => intervalCoverage([{ lo: 0, hi: 1 }], [bad])).toThrow(RangeError);
    }
  });
});

describe("Spearman", () => {
  it("average ranks share ties", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([3, 1, 2])).toEqual([3, 1, 2]);
    expect(averageRanks([5, 5, 5])).toEqual([2, 2, 2]);
    expect(averageRanks([])).toEqual([]);
  });

  it("scores known values", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 15);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 15);
    expect(spearman([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 15);
    // ties: Pearson on average ranks
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9486832980505138, 12);
  });

  it("is null when undefined: fewer than 2 pairs or a constant side", () => {
    expect(spearman([], [])).toBeNull();
    expect(spearman([1], [2])).toBeNull();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2, 3], [7, 7, 7])).toBeNull();
  });

  it("property: in [−1, 1], symmetric, 1 against itself, invariant under monotone maps", () => {
    const vec = fc.array(finite, { minLength: 2, maxLength: 60 });
    fc.assert(
      fc.property(vec, fc.array(finite, { minLength: 60, maxLength: 60 }), (x, pool) => {
        const y = pool.slice(0, x.length);
        const r = spearman(x, y);
        if (r !== null) {
          expect(r).toBeGreaterThanOrEqual(-1);
          expect(r).toBeLessThanOrEqual(1);
          expect(spearman(y, x)).toBeCloseTo(r, 12);
          expect(
            spearman(
              x.map((v) => v * 2 - 7),
              y.map((v) => v * 4 + 1),
            ),
          ).toBeCloseTo(r, 9);
        }
        const self = spearman(x, x);
        if (self !== null) expect(self).toBeCloseTo(1, 12);
      }),
    );
  });

  it("rejects hostile input", () => {
    expect(() => spearman([1, 2], [1])).toThrow(/lengths differ/);
    for (const bad of HOSTILE) expect(() => spearman([1, bad], [1, 2])).toThrow(RangeError);
  });
});

describe("accuracy gap", () => {
  it("is 0 when the projection orders the group as it finished", () => {
    expect(accuracyGapSum([30, 20, 10], [25, 14, 3])).toBe(0);
  });

  it("sums |slot points − realised| for a misordering", () => {
    // projected order: A(30) B(20) C(10); finished B 25, A 14, C 3
    // slots: 25, 14, 3 → A gets 25 (|25−14| = 11), B gets 14 (|14−25| = 11), C gets 3 (0)
    expect(accuracyGapSum([30, 20, 10], [14, 25, 3])).toBe(22);
  });

  it("tied projections share the mean of their slots (order-independent)", () => {
    // A and B tied on top: slot mean (25+14)/2 = 19.5 → |19.5−14| + |19.5−25| = 11
    expect(accuracyGapSum([30, 30, 10], [14, 25, 3])).toBe(11);
    expect(accuracyGapSum([30, 30, 10], [25, 14, 3])).toBe(11);
    fc.assert(
      fc.property(fc.array(fc.tuple(finite, finite), { minLength: 1, maxLength: 30 }), (rows) => {
        const g1 = accuracyGapSum(
          rows.map((r) => r[0]),
          rows.map((r) => r[1]),
        );
        const rev = [...rows].reverse();
        const g2 = accuracyGapSum(
          rev.map((r) => r[0]),
          rev.map((r) => r[1]),
        );
        expect(g1).toBeGreaterThanOrEqual(0);
        expect(g2).toBeCloseTo(g1, 6);
      }),
    );
  });

  it("rejects hostile input", () => {
    expect(() => accuracyGapSum([1], [1, 2])).toThrow(/lengths differ/);
    expect(() => accuracyGapSum([], [])).toThrow(/at least one pair/);
    for (const bad of HOSTILE) {
      expect(() => accuracyGapSum([bad], [1])).toThrow(RangeError);
      expect(() => accuracyGapSum([1], [bad])).toThrow(RangeError);
    }
  });
});
