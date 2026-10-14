// assignment.test.ts — the Hungarian solve behind E2 (research 05 §3.1): optimal against brute force
// on random rectangular matrices (fast-check), a distinct column per row, and hostile matrices.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN,
  solveAssignment,
  solveAssignmentLex,
} from "../../../src/domain/analytics/assignment.js";

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

/** Every permutation of 0..n−1, in lexicographic order. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const go = (prefix: number[]): void => {
    if (prefix.length === n) {
      out.push(prefix);
      return;
    }
    for (let j = 0; j < n; j++) if (!prefix.includes(j)) go([...prefix, j]);
  };
  go([]);
  return out;
}

const lexLess = (a: readonly number[], b: readonly number[]): boolean => {
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return (a[k] ?? 0) < (b[k] ?? 0);
  return false;
};

/** The lexicographic optimum by brute force: the least cost-vector sum, then the first permutation. */
function bruteLex(cost: readonly (readonly (readonly number[] | null)[])[]): number[] | null {
  let best: { perm: number[]; sum: number[] } | null = null;
  for (const perm of permutations(cost.length)) {
    const cells = perm.map((j, i) => cost[i]?.[j] ?? null);
    if (cells.some((c) => c === null)) continue;
    const sum = (cells[0] ?? []).map((_, k) => cells.reduce((s, c) => s + (c?.[k] ?? 0), 0));
    if (best === null || lexLess(sum, best.sum)) best = { perm, sum };
  }
  return best?.perm ?? null;
}

describe("solveAssignmentLex (QA-2-062)", () => {
  it("the least cost vector, then the first assignment in row order — against brute force", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 5 })
          .chain((n) =>
            fc.array(
              fc.array(
                fc.option(
                  fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 2, maxLength: 2 }),
                  { freq: 6, nil: null },
                ),
                { minLength: n, maxLength: n },
              ),
              { minLength: n, maxLength: n },
            ),
          ),
        (cost) => {
          // small integer costs: many exact ties on the first cost, and on both
          expect(solveAssignmentLex(cost)).toEqual(bruteLex(cost));
        },
      ),
      { numRuns: 400 },
    );
  });

  it("ties on every cost: the first assignment in row order, whatever the values", () => {
    const tie = [0, 0];
    expect(
      solveAssignmentLex([
        [tie, tie, tie],
        [tie, tie, tie],
        [tie, tie, tie],
      ]),
    ).toEqual([0, 1, 2]);
    // the first cost decides; the second only among its ties
    expect(
      solveAssignmentLex([
        [
          [0, 5],
          [0, 0],
        ],
        [
          [0, 0],
          [0, 5],
        ],
      ]),
    ).toEqual([1, 0]);
    expect(
      solveAssignmentLex([
        [
          [-1, 9],
          [0, 0],
        ],
        [
          [0, 0],
          [-1, 9],
        ],
      ]),
    ).toEqual([0, 1]);
  });

  it("no complete assignment over the allowed cells: null; bad matrices throw", () => {
    expect(solveAssignmentLex([])).toEqual([]);
    expect(
      solveAssignmentLex([
        [[0], null],
        [[0], null],
      ]),
    ).toBeNull();
    expect(() => solveAssignmentLex([[[0]], [[0]]])).toThrow(RangeError);
    expect(() => solveAssignmentLex([[[0.5]]])).toThrow(RangeError);
    expect(() => solveAssignmentLex([[[FORBIDDEN]]])).toThrow(RangeError);
    expect(() =>
      solveAssignmentLex([
        [[0], [0, 1]],
        [[0], [0]],
      ]),
    ).toThrow(RangeError);
  });
});
