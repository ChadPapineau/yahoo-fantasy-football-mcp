// assignment.ts — the exact assignment solve behind start/sit (research 05 §3.1: "assignment, not a
// sorted list"; a small assignment solve covers flex/superflex): the Hungarian algorithm (Kuhn–
// Munkres, O(n²m)) on a rectangular cost matrix, and its lexicographic form over integer cost
// vectors with a canonical choice among exact ties (QA-2-062). Pure and deterministic.
import { at } from "../scoring/numeric.js";

/** Cost of a forbidden cell: large and finite, so the arithmetic never meets Infinity/NaN. */
export const FORBIDDEN = 1e12;

/**
 * Minimum-cost assignment of every row to a distinct column (`rows ≤ cols`). Returns, per row, the
 * column index it was given. Throws RangeError on a ragged, non-finite or too-wide matrix.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = at(cost, 0).length;
  if (m < n) throw new RangeError("assignment: needs at least as many columns as rows");
  for (const row of cost) {
    if (row.length !== m || row.some((c) => !Number.isFinite(c))) {
      throw new RangeError("assignment: matrix must be rectangular and finite");
    }
  }
  return hungarian(cost).cols;
}

/** An optimal assignment with its dual potentials (`u` per row, `v` per column, both 1-based). */
interface Solved {
  readonly cols: number[];
  readonly u: readonly number[];
  readonly v: readonly number[];
}

/**
 * The Hungarian algorithm on a validated matrix (n ≤ m). At the end `cost[i][j] − u[i+1] − v[j+1]`
 * is ≥ 0 for every cell and 0 on the assignment, so an assignment is optimal exactly when it uses
 * only cells where that reduced cost is 0 (complementary slackness) — on integer costs the test is
 * exact, since every potential is a sum and difference of costs.
 */
function hungarian(cost: readonly (readonly number[])[]): Solved {
  const n = cost.length;
  const m = at(cost, 0).length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = at(p, j0);
      const row = at(cost, i0 - 1);
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (at(used, j)) continue;
        const cur = at(row, j - 1) - at(u, i0) - at(v, j);
        if (cur < at(minv, j)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (at(minv, j) < delta) {
          delta = at(minv, j);
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (at(used, j)) {
          const pj = at(p, j);
          u[pj] = at(u, pj) + delta;
          v[j] = at(v, j) - delta;
        } else {
          minv[j] = at(minv, j) - delta;
        }
      }
      j0 = j1;
    } while (at(p, j0) !== 0);
    do {
      const j1 = at(way, j0);
      p[j0] = at(p, j1);
      j0 = j1;
    } while (j0 !== 0);
  }
  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const row = at(p, j);
    if (row > 0) ans[row - 1] = j - 1;
  }
  return { cols: ans, u, v };
}

/**
 * The lexicographic minimum-cost assignment of a square matrix whose cells are integer cost vectors
 * of one length, or null for a forbidden cell: minimise the first cost; among the assignments that
 * tie on it, the second; and so on. Among those that tie on every cost, the first in row order —
 * row 0 takes the lowest column it can, then row 1, … — so the answer is a function of the matrix
 * alone, never of how the solve walks it. Returns, per row, its column; null when no complete
 * assignment uses only allowed cells. Throws RangeError on a ragged matrix, a non-integer cost, or
 * vectors of different lengths.
 */
export function solveAssignmentLex(
  cost: readonly (readonly (readonly number[] | null)[])[],
): number[] | null {
  const n = cost.length;
  if (n === 0) return [];
  let levels = -1;
  for (const row of cost) {
    if (row.length !== n) throw new RangeError("assignment: matrix must be square");
    for (const c of row) {
      if (c === null) continue;
      if (levels >= 0 && c.length !== levels)
        throw new RangeError("assignment: cost vectors must have one length");
      levels = c.length;
      // |cost| well below FORBIDDEN, so a forbidden cell is never part of an optimum
      if (c.some((x) => !Number.isSafeInteger(x) || Math.abs(x) >= FORBIDDEN / (4 * n)))
        throw new RangeError("assignment: costs must be small integers");
    }
  }
  let allowed = cost.map((row) => row.map((c) => c !== null));
  for (let k = 0; k < levels; k++) {
    const mat = cost.map((row, i) =>
      row.map((c, j) => (c !== null && at(at(allowed, i), j) ? at(c, k) : FORBIDDEN)),
    );
    const { cols, u, v } = hungarian(mat);
    if (cols.some((j, i) => !at(at(allowed, i), j))) return null;
    // keep only the cells some optimal assignment of this level can use
    allowed = allowed.map((row, i) =>
      row.map((ok, j) => ok && at(at(mat, i), j) - at(u, i + 1) - at(v, j + 1) === 0),
    );
  }
  return firstAssignment(allowed);
}

/** The first complete assignment over the allowed cells in row-then-column order, or null. */
function firstAssignment(allowed: readonly (readonly boolean[])[]): number[] | null {
  const n = allowed.length;
  const ans: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const row = at(allowed, i);
    let placed = false;
    for (let j = 0; j < n && !placed; j++) {
      if (!at(row, j) || at(used, j)) continue;
      used[j] = true;
      if (completes(allowed, i + 1, used)) {
        ans.push(j);
        placed = true;
      } else used[j] = false;
    }
    if (!placed) return null;
  }
  return ans;
}

/** Whether rows `from…` can each take a distinct unused allowed column (Kuhn's augmenting paths). */
function completes(
  allowed: readonly (readonly boolean[])[],
  from: number,
  used: readonly boolean[],
): boolean {
  const n = allowed.length;
  const owner = new Array<number>(n).fill(-1);
  const augment = (i: number, seen: boolean[]): boolean => {
    const row = at(allowed, i);
    for (let j = 0; j < n; j++) {
      if (!at(row, j) || at(used, j) || at(seen, j)) continue;
      seen[j] = true;
      const o = at(owner, j);
      if (o < 0 || augment(o, seen)) {
        owner[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = from; i < n; i++) {
    if (!augment(i, new Array<boolean>(n).fill(false))) return false;
  }
  return true;
}
