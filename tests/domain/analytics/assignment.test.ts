// assignment.test.ts — the Hungarian solve behind E2 (research 05 §3.1): optimal against brute force
// on random rectangular matrices (fast-check), a distinct column per row, and hostile matrices.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FORBIDDEN, solveAssignment } from "../../../src/domain/analytics/assignment.js";

function bruteMin(cost: number[][]): number {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  let best = Infinity;
  const used = new Array<boolean>(m).fill(false);
  const go = (i: number, acc: number): void => {
    if (i === n) {
      best = Math.min(best, acc);
      return;
    }
    for (let j = 0; j < m; j++) {
      if (used[j]) continue;
      used[j] = true;
      go(i + 1, acc + (cost[i]?.[j] ?? 0));
      used[j] = false;
    }
  };
  go(0, 0);
  return best;
}

describe("solveAssignment", () => {
  it("solves a known 3×3", () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const ans = solveAssignment(cost);
    expect(ans.reduce((s, j, i) => s + (cost[i]?.[j] ?? 0), 0)).toBe(5);
    expect(new Set(ans).size).toBe(3);
  });
  it("is optimal and assigns distinct columns (property vs brute force)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((n) =>
          fc.integer({ min: n, max: 7 }).chain((m) =>
            fc.array(fc.array(fc.integer({ min: -50, max: 50 }), { minLength: m, maxLength: m }), {
              minLength: n,
              maxLength: n,
            }),
          ),
        ),
        (cost) => {
          const ans = solveAssignment(cost);
          expect(ans).toHaveLength(cost.length);
          expect(new Set(ans).size).toBe(cost.length);
          expect(ans.every((j) => j >= 0 && j < (cost[0]?.length ?? 0))).toBe(true);
          const got = ans.reduce((s, j, i) => s + (cost[i]?.[j] ?? 0), 0);
          expect(got).toBe(bruteMin(cost));
        },
      ),
      { numRuns: 300 },
    );
  });
  it("avoids forbidden cells when a feasible assignment exists", () => {
    const cost = [
      [FORBIDDEN, 0],
      [0, FORBIDDEN],
    ];
    expect(solveAssignment(cost)).toEqual([1, 0]);
  });
  it("empty, too wide, ragged and non-finite matrices", () => {
    expect(solveAssignment([])).toEqual([]);
    expect(() => solveAssignment([[1], [2]])).toThrow(RangeError);
    expect(() => solveAssignment([[1, 2], [3]])).toThrow(RangeError);
    expect(() => solveAssignment([[Number.NaN, 1]])).toThrow(RangeError);
    expect(() => solveAssignment([[Infinity, 1]])).toThrow(RangeError);
  });
});
