// numeric.ts — float hygiene for the engine: plan 08 §4.4 (exact arithmetic, no cumulative drift —
// A-3), §4.5 / P11 (translators coerce "112.82" → 112.82, "" → not present, "1e2" rejected).

/** The largest |stat value| the engine accepts (a season of anything is far below it). */
export const MAX_ABS_STAT = 1e9;
/** The largest |modifier| or |bonus points| the engine accepts. */
export const MAX_ABS_MODIFIER = 1e6;

/**
 * Removes binary-float noise by rounding to 15 significant digits (`0.04 × 312` = 12.48, not
 * 12.480000000000002). Never changes a value by more than 1 part in 10^15; maps −0 to 0.
 */
export function denoise(x: number): number {
  if (x === 0) return 0;
  const fast = denoiseFast(x);
  return fast ?? denoiseReference(x);
}

/** The definition: `Number(x.toPrecision(15))` (string round trip — correct, but slow). */
export function denoiseReference(x: number): number {
  return Number(x.toPrecision(15)); // −0 prints "0.000…" → 0
}

/** 10^k for k = 0..22, parsed (every one is exactly representable; `10 ** k` need not be exact). */
const POW10: readonly number[] = Array.from({ length: 23 }, (_, k) => Number(`1e${String(k)}`));

/**
 * The same value as `denoiseReference` without a string, or null when it cannot be proved equal
 * (the caller then takes the reference path). For |x| in [1e-8, 1e15), k = 14 − ⌊log10|x|⌋ and
 * t = |x|·10^k (10^k exact, t < 2^50, so every multiple of ½ is a double). Correct rounding is
 * monotone and fixes representable points, so t lies on the same side of every half-integer as the
 * exact product — only t landing exactly ON a half is undecidable (the exact value may be a tie,
 * which toPrecision rounds up, or just below one). Otherwise m = ⌊t⌉ is the exact 15-digit mantissa
 * and m / 10^k (both exact, one correctly rounded division) is the double nearest m·10^−k — what
 * `Number(x.toPrecision(15))` parses to. A mis-estimated exponent (log10 near a power of ten) puts
 * m outside (1e14, 1e15) — or exactly on 1e14 after rounding up — and is refused.
 */
function denoiseFast(x: number): number | null {
  const a = Math.abs(x);
  const k = 14 - Math.floor(Math.log10(a));
  const s = POW10[k];
  if (s === undefined) return null; // |x| ≥ 1e15, |x| < 1e-8, or not finite
  const t = a * s;
  const floor = Math.floor(t);
  const frac = t - floor;
  if (frac === 0.5) return null; // on a half: a tie or not, undecidable from t
  const m = frac < 0.5 ? floor : floor + 1;
  if (m <= 1e14 || m >= 1e15) return null; // 1e14 itself may be a rounded-up mis-estimate
  const y = m / s;
  return x < 0 ? -y : y;
}

/** Neumaier-compensated sum (Kahan–Babuška): order-robust, no cumulative drift. */
export function stableSum(xs: readonly number[]): number {
  let sum = 0;
  let c = 0;
  for (const x of xs) {
    const t = sum + x;
    if (Math.abs(sum) >= Math.abs(x)) c += sum - t + x;
    else c += x - t + sum;
    sum = t;
  }
  return sum + c;
}

/** Plain decimal only: optional sign, digits with an optional fraction (no exponent, no hex). */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
/** Longest scalar string considered (anything longer is not a stat). */
const MAX_SCALAR_LEN = 32;

/**
 * Coerces a wire scalar to a stat value (plan 08 §4.5, research 03 §B.6): a finite number within
 * ±MAX_ABS_STAT passes; a decimal string (surrounding whitespace allowed) is parsed; a safe bigint
 * is converted; everything else — `""`, `null`, `"1e2"`, `"0x10"`, `"NaN"`, non-ASCII digits,
 * out-of-range magnitudes — is `null`, meaning NOT PRESENT (never 0, never NaN).
 */
export function coerceScalar(raw: unknown): number | null {
  let v: number;
  if (typeof raw === "number") v = raw;
  else if (typeof raw === "bigint") v = Number(raw);
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (s.length > MAX_SCALAR_LEN || !DECIMAL_RE.test(s)) return null;
    v = Number(s);
  } else return null;
  if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS_STAT) return null;
  return v === 0 ? 0 : v;
}

/**
 * `xs[i]` for an index the caller has already bounded — throws RangeError instead of yielding
 * `undefined`, so an index bug surfaces loudly (and the engine needs no non-null assertions).
 */
export function at<T>(xs: readonly T[], i: number): T {
  if (!Number.isInteger(i) || i < 0 || i >= xs.length) throw new RangeError("index out of range");
  return xs[i] as T;
}
