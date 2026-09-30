// numeric.test.ts — src/domain/scoring/{numeric,errors,policy}.ts: float hygiene (plan 08 §4.4,
// A-3), wire-scalar coercion (§4.5, P11), the error type, the golden comparison constants (§6).
import { describe, expect, it } from "vitest";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  at,
  coerceScalar,
  denoise,
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
