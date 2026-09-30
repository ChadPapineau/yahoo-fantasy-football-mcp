// numeric.test.ts — src/domain/scoring/{numeric,errors,policy}.ts: float hygiene (plan 08 §4.4,
// A-3), wire-scalar coercion (§4.5, P11), the error type, the golden comparison constants (§6).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  at,
  coerceScalar,
  denoise,
  denoiseReference,
  MAX_ABS_STAT,
  stableSum,
} from "../../../src/domain/scoring/numeric.js";
import {
  isLeagueWideMismatch,
  LEAGUE_MISMATCH_SHARE,
  MATCH_TOLERANCE,
  pointsMatch,
} from "../../../src/domain/scoring/policy.js";

describe("denoise", () => {
  it("removes binary noise and maps -0 to 0", () => {
    expect(0.07 * 100).not.toBe(7);
    expect(denoise(0.07 * 100)).toBe(7);
    expect(denoise(0.1 + 0.2)).toBe(0.3);
    expect(Object.is(denoise(-0), 0)).toBe(true);
    expect(denoise(0)).toBe(0);
    expect(denoise(-4.6)).toBe(-4.6);
    expect(denoise(123456789.123456789)).toBe(123456789.123457); // 15 significant digits
  });

  // A15 (plan 10): the string-free fast path must return the reference value bit for bit — the
  // golden tests and every stored total depend on it. Object.is also separates 0 from −0.
  const same = (x: number): void => {
    const got = denoise(x);
    const want = x === 0 ? 0 : denoiseReference(x);
    if (!Object.is(got, want) && !(Number.isNaN(got) && Number.isNaN(want)))
      throw new Error(`denoise(${String(x)}) = ${String(got)}, reference ${String(want)}`);
  };

  it("equals Number(x.toPrecision(15)) for every double (property, all bit patterns)", () => {
    fc.assert(
      fc.property(fc.double(), (x) => {
        same(x);
      }),
      { numRuns: 20_000 },
    );
  });

  it("equals the reference for engine-shaped products (modifier × sampled stat)", () => {
    const mods = [0.04, 0.1, 0.5, 6, 4, -2, -1, 0.05, 1.5, 0.25, 2, 0.2, 1 / 3];
    fc.assert(
      fc.property(
        fc.constantFrom(...mods),
        fc.double({ min: 0, max: 600, noNaN: true }),
        (m, v) => {
          same(m * v);
        },
      ),
      { numRuns: 20_000 },
    );
  });

  it("equals the reference on the hard cases: ties, near-ties, powers of ten, range edges", () => {
    const cases: number[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.EPSILON,
      1e15,
      999999999999999.4,
      999999999999999.6,
      1e-8,
      9.99999999999999e-9,
      9.999999999999994e-8, // log10 rounds up to −7: a mis-estimated exponent must be refused
      9.999999999999993e-7,
      0.1 + 0.2,
    ];
    for (let e = -12; e <= 16; e++) {
      const p = Number(`1e${String(e)}`);
      for (const f of [
        1,
        1 + Number.EPSILON,
        1 - Number.EPSILON / 2,
        9.999999999999995,
        9.999999999999994,
        1.000000000000005,
        1.234567890123455, // a 16th-digit 5: exact ties and their neighbours
        1.2345678901234549,
        1.2345678901234551,
        4.5e-15,
      ])
        cases.push(p * f, -p * f);
    }
    // x ≈ (m + ½)·10^−k: the doubles within 12 ulps either side of each decimal midpoint — where
    // t = x·10^k can round across the tie (the guard's whole reason to exist)
    const bits = new Float64Array(1);
    const word = new BigInt64Array(bits.buffer);
    const step = (x: number, n: number): number => {
      bits[0] = x;
      word[0] = (word[0] ?? 0n) + BigInt(n);
      return bits[0];
    };
    for (let i = 0; i < 400; i++) {
      const m = 1e14 + i * 2_249_999_999_999;
      for (const k of [0, 3, 7, 12, 14, 18, 22]) {
        const x = (m + 0.5) / Number(`1e${String(k)}`);
        for (let n = -12; n <= 12; n++) cases.push(step(x, n), -step(x, n));
      }
    }
    for (const x of cases) same(x);
  });
});

describe("stableSum", () => {
  it("sums with compensation in both magnitude orders", () => {
    expect(stableSum([])).toBe(0);
    expect(stableSum([1e16, 1, -1e16])).toBe(1);
    expect(stableSum([1, 1e16, -1e16])).toBe(1);
    const tenths = Array.from({ length: 1000 }, () => 0.1);
    expect(stableSum(tenths)).toBe(100);
  });
});

describe("coerceScalar (plan 08 P11 inputs)", () => {
  it.each([
    ["112.82", 112.82],
    [" 3 ", 3],
    ["0", 0],
    ["-0", 0],
    ["-5", -5],
    ["+7", 7],
    [".5", 0.5],
    ["5.", 5],
    [42, 42],
    [-0, 0],
    [12n, 12],
  ])("%s → %s", (raw, want) => {
    const got = coerceScalar(raw);
    expect(got).toBe(want);
    expect(Object.is(got, -0)).toBe(false);
  });

  it.each([
    [""],
    ["   "],
    ["1e2"],
    ["0x10"],
    ["NaN"],
    ["Infinity"],
    ["١٢"],
    ["１２"],
    ["1,000"],
    ["12abc"],
    ["9".repeat(40)],
    [NaN],
    [Infinity],
    [-Infinity],
    [MAX_ABS_STAT * 10],
    [10n ** 30n],
    [null],
    [undefined],
    [true],
    [{}],
    [[3]],
  ])("%s → null (not present)", (raw) => {
    expect(coerceScalar(raw)).toBeNull();
  });
});

describe("at", () => {
  it("returns in-range elements and throws RangeError otherwise", () => {
    expect(at([1, 2, 3], 2)).toBe(3);
    expect(() => at([1], 1)).toThrow(RangeError);
    expect(() => at([1], -1)).toThrow(RangeError);
    expect(() => at([1], 0.5)).toThrow(RangeError);
  });
});

describe("ScoringError", () => {
  it("keeps the code, truncates detail to 10 entries of 80 chars, names itself", () => {
    const long = "x".repeat(500);
    const e = new ScoringError("bracket_bounds", "bad", [
      ...Array.from({ length: 15 }, () => long),
    ]);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ScoringError");
    expect(e.code).toBe("bracket_bounds");
    expect(e.detail).toHaveLength(10);
    expect(e.detail.every((d) => d.length === 80)).toBe(true);
    expect(Object.isFrozen(e.detail)).toBe(true);
    expect(e.message.startsWith("bad: ")).toBe(true);
    const plain = new ScoringError("invalid_line", "no detail");
    expect(plain.message).toBe("no detail");
    expect(plain.detail).toEqual([]);
  });
});

describe("policy (plan 08 §6)", () => {
  it("matches within 0.01 and never on non-finite", () => {
    expect(MATCH_TOLERANCE).toBe(0.01);
    expect(pointsMatch(12.48, 12.49)).toBe(true);
    expect(pointsMatch(12.48, 12.5)).toBe(false);
    expect(pointsMatch(0.1 + 0.2, 0.31)).toBe(true);
    expect(pointsMatch(NaN, 1)).toBe(false);
    expect(pointsMatch(1, Infinity)).toBe(false);
  });

  it("is league-wide only strictly above 10 %", () => {
    expect(LEAGUE_MISMATCH_SHARE).toBe(0.1);
    expect(isLeagueWideMismatch(10, 100)).toBe(false);
    expect(isLeagueWideMismatch(11, 100)).toBe(true);
    expect(isLeagueWideMismatch(0, 0)).toBe(false);
    expect(isLeagueWideMismatch(1, -5)).toBe(false);
    expect(isLeagueWideMismatch(-1, 5)).toBe(false);
    expect(isLeagueWideMismatch(1.5, 5)).toBe(false);
    expect(isLeagueWideMismatch(1, 5.5)).toBe(false);
  });
});
