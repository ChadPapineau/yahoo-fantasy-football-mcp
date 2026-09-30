// assignment.ts — the exact assignment solve behind start/sit (research 05 §3.1: "assignment, not a
// sorted list"; a small assignment solve covers flex/superflex): the Hungarian algorithm (Kuhn–
// Munkres, O(n²m)) on a rectangular cost matrix. Pure and deterministic.
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
  return ans;
}
