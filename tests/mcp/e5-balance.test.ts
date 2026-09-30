// e5-balance.test.ts — plan 07 E5 "10 candidates compact" + C8 (10 000 chars by construction): the
// served K/DEF list is an even, rank-interleaved share of E5_CANDIDATES_OUT, so neither the budget
// nor C8's halving can drop a whole position (A8: ≥ 3 per position).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { balancedCandidates, E5_CANDIDATES_OUT } from "../../src/mcp/tools/analytics.js";

const c = (position: string, rank: number) => ({ position, rank });
const ranked = (k: number, d: number) => [
  ...Array.from({ length: k }, (_, i) => c("K", i)),
  ...Array.from({ length: d }, (_, i) => c("DEF", i)),
];

describe("balancedCandidates", () => {
  it("two positions: an even share, interleaved by rank, best first", () => {
    const out = balancedCandidates(ranked(10, 10), false);
    expect(out.map((x) => `${x.position}${String(x.rank)}`)).toEqual([
      "K0",
      "DEF0",
      "K1",
      "DEF1",
      "K2",
      "DEF2",
      "K3",
      "DEF3",
      "K4",
      "DEF4",
    ]);
    expect(balancedCandidates(ranked(10, 10), true)).toHaveLength(E5_CANDIDATES_OUT.full);
  });
  it("one position keeps the whole allowance", () => {
    expect(balancedCandidates(ranked(10, 0), false)).toHaveLength(E5_CANDIDATES_OUT.compact);
    expect(balancedCandidates(ranked(0, 10), true)).toHaveLength(E5_CANDIDATES_OUT.full);
  });
  it("a short position does not take the other's share; empty in, empty out", () => {
    const out = balancedCandidates(ranked(2, 10), false);
    expect(out.filter((x) => x.position === "K")).toHaveLength(2);
    expect(out.filter((x) => x.position === "DEF")).toHaveLength(5);
    expect(balancedCandidates([], false)).toEqual([]);
  });
  it("more positions than the allowance still keeps one of each", () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`P${String(i)}`, 0));
    expect(balancedCandidates(many, true)).toHaveLength(12);
  });
  it("property: every prefix C8's halving can keep is balanced within one; ranks stay ordered", () => {
    fc.assert(
      fc.property(fc.nat(40), fc.nat(40), fc.boolean(), (k, d, full) => {
        const out = balancedCandidates(ranked(k, d), full);
        const cap = full ? E5_CANDIDATES_OUT.full : E5_CANDIDATES_OUT.compact;
        expect(out.length).toBeLessThanOrEqual(Math.max(cap, 2));
        for (let n = out.length; n > 0; n = Math.floor(n / 2)) {
          const p = out.slice(0, n);
          const nk = p.filter((x) => x.position === "K").length;
          const nd = p.length - nk;
          if (k > 0 && d > 0 && n <= 2 * Math.min(k, d, cap / 2))
            expect(Math.abs(nk - nd)).toBeLessThanOrEqual(1);
        }
        for (const pos of ["K", "DEF"]) {
          const r = out.filter((x) => x.position === pos).map((x) => x.rank);
          expect(r).toEqual(r.map((_, i) => i));
        }
      }),
    );
  });
});
