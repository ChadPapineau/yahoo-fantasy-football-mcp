// metrics.ts — the retrospective's scoring rules (research 05 §12.1 Brier + Murphy decomposition,
// CRPS, pinball, 80 % coverage; §12.2 Spearman + accuracy gap; plan 07 E13; plan 10 A9/T10: 100 %).
// Pure numerics: every function validates its input and throws RangeError rather than return NaN.

import type { BrierDecomposition, BrierValue } from "./types.js";

/**
 * The largest |value| a metric accepts (points, samples, outcomes). Fantasy scores are bounded far
 * below this; the bound keeps every difference and square finite (no Infinity from `x − y`).
 */
export const MAX_ABS_VALUE = 1e6;

/** The Dist quantile levels (plan 07 legend `Dist`: p10 / p25 / p50 / p75 / p90). */
export const DIST_LEVELS = Object.freeze([0.1, 0.25, 0.5, 0.75, 0.9] as const);

/** Reliability-diagram bins for the Brier decomposition: deciles (research 05 §12.1). */
export const RELIABILITY_BINS = 10;

/**
 * `xs[i]`, checked: throws RangeError when `i` is outside the array (the noUncheckedIndexedAccess
 * accessor every module here uses instead of a non-null assertion).
 */
export function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new RangeError(`metrics: index ${String(i)} out of range`);
  return v;
}

function fail(msg: string): never {
  throw new RangeError(`metrics: ${msg}`);
}

function assertValue(x: number, what: string): void {
  if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > MAX_ABS_VALUE)
    fail(`${what} must be a finite number with |x| <= ${String(MAX_ABS_VALUE)}`);
}

function assertValues(xs: readonly number[], what: string): void {
  for (const x of xs) assertValue(x, what);
}

// --- stable summation --------------------------------------------------------------------------

/**
 * Neumaier-compensated sum (Kahan's improvement that also handles a term larger than the running
 * sum). Finite inputs only — the callers validate first.
 */
export function stableSum(values: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const v of values) {
    const t = sum + v;
    c += Math.abs(sum) >= Math.abs(v) ? sum - t + v : v - t + sum;
    sum = t;
  }
  return sum + c;
}

/** The compensated mean, or null for an empty list. */
export function stableMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : stableSum(values) / values.length;
}

// --- Brier score + Murphy decomposition (research 05 §12.1) ---------------------------------------

/** One probability forecast and what happened. */
export interface ProbabilityOutcome {
  /** The forecast probability, 0..1. */
  readonly p: number;
  /** Whether the event happened. */
  readonly outcome: boolean;
}

function assertPairs(pairs: readonly ProbabilityOutcome[]): void {
  if (pairs.length === 0) fail("brier needs at least one forecast");
  for (const { p, outcome } of pairs) {
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)
      fail("a probability must be a finite number in [0, 1]");
    if (typeof outcome !== "boolean") fail("an outcome must be a boolean");
  }
}

/** The Brier score: mean squared difference between forecast and outcome (0 best, 1 worst). */
export function brierScore(pairs: readonly ProbabilityOutcome[]): number {
  assertPairs(pairs);
  return stableSum(pairs.map(({ p, outcome }) => (p - (outcome ? 1 : 0)) ** 2)) / pairs.length;
}

/** The reliability bin of a probability: [k/bins, (k+1)/bins), with p = 1 in the last bin. */
export function binIndex(p: number, bins: number = RELIABILITY_BINS): number {
  return Math.min(bins - 1, Math.floor(p * bins));
}

/**
 * The Brier score with Murphy's decomposition BS = reliability − resolution + uncertainty, binned by
 * forecast decile. The identity is exact when the forecasts inside each bin are equal (the synthetic
 * tests); with spread inside a bin it holds up to the within-bin variance terms (Stephenson et al.
 * 2008), and `value` is always the exact Brier score, never the reassembled sum.
 */
export function brierWithDecomposition(
  pairs: readonly ProbabilityOutcome[],
  bins: number = RELIABILITY_BINS,
): BrierValue {
  if (!Number.isInteger(bins) || bins < 1 || bins > 1000) fail("bins must be an integer 1..1000");
  const value = brierScore(pairs);
  const n = pairs.length;
  const outcomes = pairs.map(({ outcome }) => (outcome ? 1 : 0));
  const base = stableSum(outcomes) / n;
  const groups: { p: number[]; o: number[] }[] = Array.from({ length: bins }, () => ({
    p: [],
    o: [],
  }));
  for (const { p, outcome } of pairs) {
    const g = at(groups, binIndex(p, bins));
    g.p.push(p);
    g.o.push(outcome ? 1 : 0);
  }
  const rel: number[] = [];
  const res: number[] = [];
  for (const g of groups) {
    const nk = g.p.length;
    if (nk === 0) continue;
    const fk = stableSum(g.p) / nk;
    const ok = stableSum(g.o) / nk;
    rel.push(nk * (fk - ok) ** 2);
    res.push(nk * (ok - base) ** 2);
  }
  const decomposition: BrierDecomposition = {
    reliability: stableSum(rel) / n,
    resolution: stableSum(res) / n,
    uncertainty: base * (1 - base),
  };
  return { value, n, decomposition };
}

// --- CRPS (research 05 §12.1: the integral of Brier over all thresholds) ---------------------------

/**
 * CRPS of the empirical distribution of `samples` at outcome `y`, computed as the exact integral
 * ∫ (F(x) − 1{x ≥ y})² dx of the sample CDF — a sum of non-negative terms, so the result can never
 * be negative from cancellation (the E|X−y| − ½E|X−X′| form can). 0 iff every sample equals `y`.
 */
export function crpsFromSamples(samples: readonly number[], y: number): number {
  if (samples.length === 0) fail("crps needs at least one sample");
  assertValues(samples, "a sample");
  assertValue(y, "the outcome");
  const xs = [...samples].sort((a, b) => a - b);
  const m = xs.length;
  const pts = [...xs, y].sort((a, b) => a - b);
  const terms: number[] = [];
  let j = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const z = at(pts, k);
    const width = at(pts, k + 1) - z;
    if (width === 0) continue;
    while (j < m && at(xs, j) <= z) j++;
    const diff = j / m - (z >= y ? 1 : 0);
    terms.push(diff * diff * width);
  }
  return stableSum(terms);
}

/** One known quantile of a forecast distribution. */
export interface QuantileKnot {
  /** The level τ, strictly inside (0, 1). */
  readonly level: number;
  readonly value: number;
}

function assertKnots(knots: readonly QuantileKnot[]): void {
  if (knots.length === 0) fail("crps needs at least one quantile");
  let prev: QuantileKnot | null = null;
  for (const k of knots) {
    if (typeof k.level !== "number" || !(k.level > 0 && k.level < 1))
      fail("a quantile level must lie strictly inside (0, 1)");
    assertValue(k.value, "a quantile");
    if (prev !== null) {
      if (!(k.level > prev.level)) fail("quantile levels must be strictly increasing");
      if (k.value < prev.value) fail("quantiles must be non-decreasing");
    }
    prev = k;
  }
}

/** 2·(1{y < q} − τ)(q − y): the pinball integrand of CRPS = 2∫₀¹ QS_τ(q(τ), y) dτ. */
function crpsIntegrand(indicator: number, tau: number, q: number, y: number): number {
  return 2 * (indicator - tau) * (q - y);
}

/**
 * CRPS of the distribution whose quantile function is piecewise linear through `knots`, extended
 * to τ = 0 and τ = 1 with the slope of the outermost segment (flat for a single knot), at outcome
 * `y`. Computed exactly: CRPS = 2∫₀¹ ρ_τ(y − q(τ)) dτ, split where q(τ) crosses `y`; each piece
 * is a quadratic in τ, which Simpson's rule integrates exactly. 0 iff every quantile equals `y`.
 * `Dist.p_zero` is not used: the quantiles already carry any mass at zero (decision recorded).
 */
export function crpsFromQuantiles(knots: readonly QuantileKnot[], y: number): number {
  assertKnots(knots);
  assertValue(y, "the outcome");
  const first = at(knots, 0);
  const last = at(knots, knots.length - 1);
  let lowSlope = 0;
  let highSlope = 0;
  if (knots.length > 1) {
    const second = at(knots, 1);
    const penult = at(knots, knots.length - 2);
    lowSlope = (second.value - first.value) / (second.level - first.level);
    highSlope = (last.value - penult.value) / (last.level - penult.level);
  }
  const full: QuantileKnot[] = [
    { level: 0, value: first.value - lowSlope * first.level },
    ...knots,
    { level: 1, value: last.value + highSlope * (1 - last.level) },
  ];
  const pieces: number[] = [];
  const integrate = (a: number, qa: number, b: number, qb: number): void => {
    const mid = (a + b) / 2;
    const qm = (qa + qb) / 2;
    const ind = qm > y ? 1 : 0;
    const f =
      crpsIntegrand(ind, a, qa, y) +
      4 * crpsIntegrand(ind, mid, qm, y) +
      crpsIntegrand(ind, b, qb, y);
    pieces.push(((b - a) / 6) * f);
  };
  for (let i = 0; i + 1 < full.length; i++) {
    const { level: a, value: qa } = at(full, i);
    const { level: b, value: qb } = at(full, i + 1);
    if ((qa - y) * (qb - y) < 0) {
      const t = a + ((y - qa) * (b - a)) / (qb - qa);
      integrate(a, qa, t, y);
      integrate(t, y, b, qb);
    } else {
      integrate(a, qa, b, qb);
    }
  }
  return Math.max(0, stableSum(pieces));
}

/** A Dist's five quantiles as knots. */
export interface DistQuantiles {
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
}

/** The knots of a Dist (levels DIST_LEVELS). */
export function distKnots(d: DistQuantiles): QuantileKnot[] {
  return [
    { level: 0.1, value: d.p10 },
    { level: 0.25, value: d.p25 },
    { level: 0.5, value: d.p50 },
    { level: 0.75, value: d.p75 },
    { level: 0.9, value: d.p90 },
  ];
}

/** CRPS of a Dist from its quantiles (crpsFromQuantiles over DIST_LEVELS). */
export function crpsFromDist(d: DistQuantiles, y: number): number {
  return crpsFromQuantiles(distKnots(d), y);
}

// --- pinball loss + interval coverage (research 05 §12.1) ----------------------------------------

/** Pinball (quantile) loss of forecast quantile `q` at level `tau` for outcome `y`; ≥ 0. */
export function pinballLoss(q: number, y: number, tau: number): number {
  assertValue(q, "a quantile");
  assertValue(y, "the outcome");
  if (typeof tau !== "number" || !(tau > 0 && tau < 1)) fail("tau must lie strictly inside (0, 1)");
  return y >= q ? tau * (y - q) : (1 - tau) * (q - y);
}

function assertSameLength(a: readonly unknown[], b: readonly unknown[], what: string): void {
  if (a.length !== b.length)
    fail(`${what}: lengths differ (${String(a.length)} vs ${String(b.length)})`);
  if (a.length === 0) fail(`${what}: needs at least one pair`);
}

/** Mean pinball loss over paired quantiles and outcomes. */
export function meanPinball(qs: readonly number[], ys: readonly number[], tau: number): number {
  assertSameLength(qs, ys, "pinball");
  return stableSum(qs.map((q, i) => pinballLoss(q, at(ys, i), tau))) / qs.length;
}

/** A closed interval [lo, hi]. */
export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Share of outcomes inside their interval, both ends inclusive (an outcome of exactly 0 inside a
 * [0, x] band counts — the Dist puts real mass at 0).
 */
export function intervalCoverage(intervals: readonly Interval[], ys: readonly number[]): number {
  assertSameLength(intervals, ys, "coverage");
  let inside = 0;
  intervals.forEach(({ lo, hi }, i) => {
    assertValue(lo, "an interval end");
    assertValue(hi, "an interval end");
    if (lo > hi) fail("an interval must have lo <= hi");
    const y = at(ys, i);
    assertValue(y, "the outcome");
    if (y >= lo && y <= hi) inside++;
  });
  return inside / intervals.length;
}

// --- ranks: Spearman + accuracy gap (research 05 §12.2) ------------------------------------------

/** 1-based ranks in ascending order, ties given the average of the ranks they span. */
export function averageRanks(values: readonly number[]): number[] {
  assertValues(values, "a ranked value");
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && at(order, end + 1).v === at(order, start).v) end++;
    const avg = (start + end) / 2 + 1;
    for (let k = start; k <= end; k++) ranks[at(order, k).i] = avg;
    start = end + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation (Pearson on average ranks, so ties are handled), in [−1, 1]. Null when
 * it is undefined: fewer than 2 pairs, or either side constant. Lengths must match.
 */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length)
    fail(`spearman: lengths differ (${String(x.length)} vs ${String(y.length)})`);
  const rx = averageRanks(x);
  const ry = averageRanks(y);
  if (x.length < 2) return null;
  const mx = stableSum(rx) / rx.length;
  const my = stableSum(ry) / ry.length;
  const dx = rx.map((r) => r - mx);
  const dy = ry.map((r) => r - my);
  const sxy = stableSum(dx.map((d, i) => d * at(dy, i)));
  const sxx = stableSum(dx.map((d) => d * d));
  const syy = stableSum(dy.map((d) => d * d));
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * The FantasyPros-style accuracy gap for one group (one position-week): for each player, the points
 * of the rank slot the projection put him in (the realised points of whoever actually finished at
 * that rank) minus his realised points, in absolute value, summed. Tied projections share the mean
 * of the slots they span, so the result does not depend on input order. 0 when the projection
 * orders the group exactly as it finished. Returns the SUM (callers average over player-weeks).
 */
export function accuracyGapSum(projected: readonly number[], realised: readonly number[]): number {
  assertSameLength(projected, realised, "accuracy gap");
  assertValues(projected, "a projection");
  assertValues(realised, "the outcome");
  const slots = [...realised].sort((a, b) => b - a);
  const order = projected.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p || a.i - b.i);
  const terms: number[] = [];
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && at(order, end + 1).p === at(order, start).p) end++;
    const slotValue = stableSum(slots.slice(start, end + 1)) / (end - start + 1);
    for (let k = start; k <= end; k++)
      terms.push(Math.abs(slotValue - at(realised, at(order, k).i)));
    start = end + 1;
  }
  return stableSum(terms);
}
