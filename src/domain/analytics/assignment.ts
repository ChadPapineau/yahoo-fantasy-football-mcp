// assignment.ts — the exact assignment solve behind start/sit (research 05 §3.1: "assignment, not a
// sorted list"; a small assignment solve covers flex/superflex): the Hungarian algorithm (Kuhn–
// Munkres, O(n²m)) on a rectangular cost matrix. Pure and deterministic.

/** Cost of a forbidden cell: large and finite, so the arithmetic never meets Infinity/NaN. */
export const FORBIDDEN = 1e12;

/**
 * Minimum-cost assignment of every row to a distinct column (`rows ≤ cols`). Returns, per row, the
 * column index it was given. Throws RangeError on a ragged, non-finite or too-wide matrix.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0]?.length ?? 0;
  if (m < n) throw new RangeError("assignment: needs at least as many columns as rows");
  for (const row of cost) {
    if (row.length !== m || row.some((c) => !Number.isFinite(c))) {
      throw new RangeError("assignment: matrix must be rectangular and finite");
    }
  }
  const at = (i: number, j: number): number => cost[i]?.[j] ?? FORBIDDEN;
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
      const i0 = p[j0] ?? 0;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j] === true) continue;
        const cur = at(i0 - 1, j - 1) - (u[i0] ?? 0) - (v[j] ?? 0);
        if (cur < (minv[j] ?? Infinity)) {
          minv[j] = cur;
          way[j] = j0;
        }
        if ((minv[j] ?? Infinity) < delta) {
          delta = minv[j] ?? Infinity;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j] === true) {
          const pj = p[j] ?? 0;
          u[pj] = (u[pj] ?? 0) + delta;
          v[j] = (v[j] ?? 0) - delta;
        } else {
          minv[j] = (minv[j] ?? Infinity) - delta;
        }
      }
      j0 = j1;
    } while ((p[j0] ?? 0) !== 0);
    do {
      const j1 = way[j0] ?? 0;
      p[j0] = p[j1] ?? 0;
      j0 = j1;
    } while (j0 !== 0);
  }
  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const row = p[j] ?? 0;
    if (row > 0) ans[row - 1] = j - 1;
  }
  return ans;
}
