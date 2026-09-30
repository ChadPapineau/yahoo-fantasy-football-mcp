// math.ts — the numeric kernels the P0 analytics share (research 05 §1 step 9 gamma/Poisson draws,
// §11.1 normal approximation Φ, §1 Evaluation Spearman): all driven by the injected seeded Rng
// (src/domain/clock.ts), never Math.random. Pure.
import type { Rng } from "../clock.js";
import type { Dist, DistBasis } from "../scoring/types.js";
import { Z90 } from "./constants.js";

/** Clamps x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Rounds to `digits` decimals, normalising −0 to 0 (output hygiene). */
export function round(x: number, digits = 4): number {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * The standard normal CDF Φ(x) (W. J. Cody-style rational erfc approximation, |error| < 1.2e-7).
 * Φ(±∞) = 1/0; NaN → 0.5 (a non-number never reads as certainty).
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return 0.5;
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  const p = 0.5 * erfc;
  return x >= 0 ? 1 - p : p;
}

/** One standard normal draw (Box–Muller; `u1` kept away from 0). */
export function normalDraw(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-300);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * A Gamma(shape, 1) draw (Marsaglia & Tsang 2000; shape < 1 boosted by U^(1/shape)). Throws
 * RangeError for a non-positive or non-finite shape.
 */
export function gammaDraw(rng: Rng, shape: number): number {
  if (!Number.isFinite(shape) || shape <= 0) throw new RangeError("math: gamma shape must be > 0");
  if (shape < 1) {
    const u = Math.max(rng.next(), 1e-300);
    return gammaDraw(rng, shape + 1) * u ** (1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalDraw(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng.next();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/**
 * A mean-1 gamma multiplier with coefficient of variation `cv` (shape 1/cv², scale cv²) — the v1
 * `position_cv` width (research 05 §1 step 9's parametric fallback). cv ≤ 0 → exactly 1.
 */
export function gammaMultiplier(rng: Rng, cv: number): number {
  if (!(cv > 0)) return 1;
  const shape = 1 / (cv * cv);
  return gammaDraw(rng, shape) / shape;
}

/** A Poisson(λ) draw: Knuth for λ ≤ 30, else a rounded normal approximation floored at 0. */
export function poissonDraw(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) {
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normalDraw(rng)));
  }
  const l = Math.exp(-lambda);
  let k = 0;
  let p = rng.next();
  while (p > l) {
    k += 1;
    p *= rng.next();
  }
  return k;
}

/** Hyndman–Fan type-7 quantile of an ASCENDING array (the engine's definition); [] → 0. */
export function quantileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const h = (n - 1) * clamp(q, 0, 1);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (h - lo) * (b - a);
}

/** A Dist over raw sample points (the same quantile rule as scoreSamples). */
export function distFromSamples(points: readonly number[], basis: DistBasis): Dist {
  const sorted = [...points].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n === 0 ? 0 : sorted.reduce((s, x) => s + x, 0) / n;
  return {
    mean: round(mean),
    p10: round(quantileSorted(sorted, 0.1)),
    p25: round(quantileSorted(sorted, 0.25)),
    p50: round(quantileSorted(sorted, 0.5)),
    p75: round(quantileSorted(sorted, 0.75)),
    p90: round(quantileSorted(sorted, 0.9)),
    p_zero: n === 0 ? 1 : round(sorted.filter((x) => x === 0).length / n),
    basis,
  };
}

/** A point mass at zero (bye, ruled out): mean 0, every quantile 0, p_zero 1. */
export function zeroDist(basis: DistBasis): Dist {
  return { mean: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p_zero: 1, basis };
}

/** A Dist of a normal N(μ, σ²) (team totals; research 05 §11.1). p_zero 0 unless σ = μ = 0. */
export function normalDist(mu: number, sigma: number, basis: DistBasis): Dist {
  const s = Math.max(0, sigma);
  const q = (z: number): number => round(mu + z * s);
  const zero = mu === 0 && s === 0 ? 1 : 0;
  return {
    mean: round(mu),
    p10: q(-Z90),
    p25: q(-0.6744897501960817),
    p50: round(mu),
    p75: q(0.6744897501960817),
    p90: q(Z90),
    p_zero: zero,
    basis,
  };
}

/**
 * σ of a Dist from its 10–90 spread (normal approximation: (p90 − p10) / 2·z90). A Dist carries no
 * variance field (plan 07 legend), so every consumer uses this one estimator. Never negative.
 */
export function sigmaOf(d: Dist): number {
  const s = (d.p90 - d.p10) / (2 * Z90);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** Average ranks (1-based; ties share their mean rank). */
export function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const out = new Array<number>(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]?.x === idx[i]?.x) j += 1;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]?.i ?? 0] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation of two equal-length series; null when n < 2 or a series is constant. */
export function spearman(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const n = ra.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (ra[i] ?? 0) - ma;
    const y = (rb[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}
