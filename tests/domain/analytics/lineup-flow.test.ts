// lineup-flow.test.ts — QA-1-020, QA-1-040: E2's swaps follow the actual slot flow. A current lineup
// with an empty starting seat (a starter moved to IR, dropped, or omitted as unmatched) is a lineup
// change when the recommendation fills it: no_move false, the fill reported as a swap with `out: null`
// and its own deadline. Every entrant is reported, paired with the starter he actually replaces —
// following the chain of starters who only change slots — never with whoever is first in a list.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { dist, LEAGUE_SLOTS, NOW, player, SUN_1PM, SUN_425, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
const tight = (m: number) => dist(m, m * 0.2);

describe("QA-1-020/040 — filling an empty starting seat is a move", () => {
  it("QB + RB slots, RB seat empty, the RB on the bench: start him (out: null)", () => {
    const slots = slotsOf([
      { name: "QB", count: 1 },
      { name: "RB", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const qb = player("QB", 20, { slot: "QB" });
    const rb = player("RB", 15, { slot: "BN", lock_at: SUN_425 });
    const r = analyzeLineup({
      slots,
      players: [qb, rb],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    expect(r.recommended_lineup.find((a) => a.player_key === rb.player_key)?.slot).toBe("RB");
    expect(r.no_move).toBe(false);
    expect(r.rec.no_move).toBe(false);
    expect(r.rec.action).toBe("make 1 lineup change");
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]).toMatchObject({ out: null, in: rb.player_key, slot: "RB", delta_e: 15 });
    expect(r.rec.latest_execution_time).toBe(SUN_425);
    expect(r.rec.subjects.find((s) => s.player_key === rb.player_key)).toMatchObject({
      role: "start",
      slot: "RB",
    });
    expect(r.rec.subjects.some((s) => s.role === "sit")).toBe(false);
    // until the tool's schema takes a null `out`, the default leaves the fill out of swaps only
    const d = analyzeLineup({ slots, players: [qb, rb], opponent: null, clock });
    expect(d.swaps).toEqual([]);
    expect([d.no_move, d.rec.action, d.rec.latest_execution_time]).toEqual([
      false,
      "fill 1 empty starting slot",
      SUN_425,
    ]);
  });

  it("a WR starter moved to IR: the flex WR slides to WR and the bench RB takes the flex", () => {
    const qb = player("QB", 20, { slot: "QB" });
    const wr1 = player("WR", 14, { slot: "WR", points: tight(14) });
    const ir = player("WR", 15, { slot: "IR", status: "O", points: tight(0), p_active: 0 });
    const flex = player("WR", 13, { slot: "W/R/T", points: tight(13) });
    const rb1 = player("RB", 12, { slot: "RB", points: tight(12) });
    const rb2 = player("RB", 11, { slot: "RB", points: tight(11) });
    const bench = player("RB", 10, { slot: "BN", points: tight(10), lock_at: SUN_425 });
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, wr1, ir, flex, rb1, rb2, bench],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    const seat = (p: LineupPlayer) =>
      r.recommended_lineup.find((a) => a.player_key === p.player_key)?.slot;
    expect([seat(flex), seat(bench)]).toEqual(["WR", "W/R/T"]);
    expect(r.no_move).toBe(false);
    expect(r.rec.action).toBe("make 1 lineup change");
    expect(r.swaps).toEqual([
      expect.objectContaining({ out: null, in: bench.player_key, slot: "W/R/T", delta_e: 10 }),
    ]);
    // the deadline is the earliest lock among everyone who moves (the flex WR moves too)
    expect(r.rec.latest_execution_time).toBe(SUN_1PM);
    expect(r.rec.subjects.find((s) => s.player_key === flex.player_key)?.slot).toBe("WR");
  });

  it("one leaver, two entrants: each entrant paired with the starter he really replaces", () => {
    // RB seat empty; the WR starter is benched for a better WR who takes the flex while the flex
    // WR slides to WR; a bench RB fills the empty RB seat
    const qb = player("QB", 20, { slot: "QB", points: tight(20) });
    const wrA = player("WR", 14, { slot: "WR", points: tight(14) });
    const wrOut = player("WR", 3, { slot: "WR", points: tight(3) });
    const flexWr = player("WR", 12, { slot: "W/R/T", points: tight(12) });
    const rb1 = player("RB", 12, { slot: "RB", points: tight(12) });
    const rbIn = player("RB", 9, { slot: "BN", points: tight(9) });
    const wrIn = player("WR", 11, { slot: "BN", points: tight(11) });
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, wrA, wrOut, flexWr, rb1, rbIn, wrIn],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    const starters = new Set(
      r.recommended_lineup
        .filter((a) => a.slot !== "BN" && a.slot !== "IR")
        .map((a) => a.player_key),
    );
    expect(starters.has(rbIn.player_key) && starters.has(wrIn.player_key)).toBe(true);
    expect(starters.has(wrOut.player_key)).toBe(false);
    const byIn = new Map(r.swaps.map((s) => [s.in, s]));
    expect(byIn.get(rbIn.player_key)?.out).toBeNull(); // the empty RB seat
    expect(byIn.get(wrIn.player_key)?.out).toBe(wrOut.player_key);
    expect(r.swaps).toHaveLength(2);
    expect(r.rec.action).toBe("make 2 lineup changes");
    // retrospective pairing: the k-th start subject goes with the k-th sit subject
    const starts = r.rec.subjects.filter((s) => s.role === "start");
    const sits = r.rec.subjects.filter((s) => s.role === "sit");
    expect(sits.map((s) => s.player_key)).toEqual([wrOut.player_key]);
    expect(starts[0]?.player_key).toBe(wrIn.player_key);
  });

  it("property: every entrant from the bench appears in swaps exactly once; no_move ⇔ same seats", () => {
    const POS = ["QB", "WR", "RB", "TE", "K", "DEF"] as const;
    const SLOTS = ["QB", "WR", "RB", "TE", "W/R/T", "K", "DEF", "BN"] as const;
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pos: fc.constantFrom(...POS),
            mean: fc.integer({ min: 1, max: 30 }),
            slot: fc.constantFrom(...SLOTS),
          }),
          { minLength: 1, maxLength: 14 },
        ),
        (specs) => {
          // keep the current lineup legal-by-count (≤ the slot's count) — extras sit on the bench
          const used = new Map<string, number>();
          const cap: Record<string, number> = {
            QB: 1,
            WR: 2,
            RB: 2,
            TE: 1,
            "W/R/T": 1,
            K: 1,
            DEF: 1,
          };
          const players = specs.map((s) => {
            const ok =
              s.slot !== "BN" &&
              (used.get(s.slot) ?? 0) < (cap[s.slot] ?? 0) &&
              (s.slot === s.pos || (s.slot === "W/R/T" && ["WR", "RB", "TE"].includes(s.pos)));
            if (ok) used.set(s.slot, (used.get(s.slot) ?? 0) + 1);
            return player(s.pos, s.mean, { slot: ok ? s.slot : "BN", points: tight(s.mean) });
          });
          const r = analyzeLineup({
            slots: LEAGUE_SLOTS,
            players,
            opponent: null,
            clock,
            fills_in_swaps: true,
          });
          const startOf = (xs: readonly { slot: string; player_key: string }[]) =>
            new Map(
              xs
                .filter((a) => a.slot !== "BN" && a.slot !== "IR")
                .map((a) => [a.player_key, a.slot]),
            );
          const cur = startOf(r.current_lineup);
          const rec = startOf(r.recommended_lineup);
          const entrants = [...rec.keys()].filter((k) => !cur.has(k)).sort();
          const ins = r.swaps.map((s) => s.in).sort();
          expect(ins).toEqual(entrants);
          const same = cur.size === rec.size && [...cur].every(([k, v]) => rec.get(k) === v);
          if (same) expect(r.no_move).toBe(true);
          if (entrants.length > 0) expect(r.rec.action).not.toBe("keep the current lineup");
          for (const s of r.swaps) {
            if (s.out !== null) expect(cur.has(s.out) && !rec.has(s.out)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
