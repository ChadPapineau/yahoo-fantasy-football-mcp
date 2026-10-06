// lineup-exclude.test.ts — QA-2-038: `exclude` says a player will not play (the start-sit Skill
// passes it once the app shows him inactive), so he scores 0 this week. Every swap that benches
// him, its interval, coin_flip, the no-move rule and the logged rec are measured against him at 0 —
// the same answer as a `status: O` player — and the rec never starts him while a replacement gains
// points. A replacement who scores 0 as well gains nothing: no move, not a loss priced at his
// full projection.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { zeroDist } from "../../../src/domain/analytics/math.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { dist, LEAGUE_SLOTS, NOW, player, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
/** Two RB seats and a bench, no flex: a 0-point player is never seated by the fill rule alone. */
const RB2 = slotsOf([
  { name: "RB", count: 2 },
  { name: "BN", count: 4 },
]);
const STARTING = (slot: string): boolean => slot !== "BN" && slot !== "IR";
const startersOf = (rows: readonly { slot: string; player_key: string }[] | null): string[] =>
  (rows ?? []).filter((r) => STARTING(r.slot)).map((r) => r.player_key);

/** The same player written as `status: O` (out): a zero Dist, P(active) 0. */
const asOut = (p: LineupPlayer): LineupPlayer => ({
  ...p,
  points: zeroDist(p.points.basis),
  p_active: 0,
});

describe("QA-2-038 — an excluded starter scores 0", () => {
  it("a starter excluded for a weaker bench player: the swap gains the bench player's points", () => {
    const rb1 = player("RB", 20.6, { slot: "RB", points: dist(20.6, 9) });
    const rb2 = player("RB", 15, { slot: "RB", points: dist(15, 7) });
    const bench = player("RB", 13.5, { slot: "BN", points: dist(13.5, 8) });
    const r = analyzeLineup({
      slots: RB2,
      players: [rb1, rb2, bench],
      opponent: null,
      exclude: [rb1.player_key],
      clock,
    });
    expect(r.swaps).toEqual([
      expect.objectContaining({
        out: rb1.player_key,
        in: bench.player_key,
        delta_e: 13.5,
        interval: [5.5, 21.5],
        coin_flip: false,
      }),
    ]);
    expect([r.no_move, r.rec.no_move, r.rec.action]).toEqual([
      false,
      false,
      "make 1 lineup change",
    ]);
    expect(startersOf(r.rec.lineup)).toEqual(
      expect.arrayContaining([rb2.player_key, bench.player_key]),
    );
    expect(startersOf(r.rec.lineup)).not.toContain(rb1.player_key);
    expect(r.rec.delta_vs_next).toEqual({ value: 13.5, p10: 5.5, p90: 21.5 });
    // the same call with him written as `status: O` gives the same decision and numbers
    const o = analyzeLineup({
      slots: RB2,
      players: [asOut(rb1), rb2, bench],
      opponent: null,
      clock,
    });
    expect(o.swaps).toEqual(r.swaps);
    expect(o.rec.delta_vs_next).toEqual(r.rec.delta_vs_next);
    expect(o.rec.lineup).toEqual(r.rec.lineup);
  });

  it("his only replacement is on bye (0 points): Δ 0, no move — never a −20 'change'", () => {
    const slots = slotsOf([
      { name: "RB", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const rb = player("RB", 20.6, { slot: "RB" });
    const bye = player("RB", 0, { slot: "BN", points: zeroDist("position_cv"), p_active: 1 });
    const r = analyzeLineup({
      slots,
      players: [rb, bye],
      opponent: null,
      exclude: [rb.player_key],
      clock,
      fills_in_swaps: true,
    });
    expect(r.swaps).toEqual([
      expect.objectContaining({
        out: rb.player_key,
        in: bye.player_key,
        delta_e: 0,
        interval: [0, 0],
        coin_flip: true,
      }),
    ]);
    expect([r.no_move, r.rec.no_move, r.rec.action]).toEqual([
      true,
      true,
      "keep the current lineup",
    ]);
    expect(r.rec.delta_vs_next).toEqual({ value: 0, p10: 0, p90: 0 });
    expect(r.rec.latest_execution_time).toBeNull();
    expect(
      r.rec.assumptions.some((a) => a.text.startsWith("the best lineup change gains nothing")),
    ).toBe(true);
  });

  it("an excluded starter with a forced replacement: the forced start is made", () => {
    const qb = player("QB", 22, { slot: "QB", points: dist(22, 10) });
    const backup = player("QB", 3, { slot: "BN", points: dist(3, 6) });
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, backup],
      opponent: null,
      exclude: [qb.player_key],
      force_start: [backup.player_key],
      clock,
    });
    expect(r.rec.no_move).toBe(false);
    expect(startersOf(r.rec.lineup)).toEqual([backup.player_key]);
  });

  it("property: a swap benching an excluded player is priced against 0, and a gain is made", () => {
    const POS = ["QB", "WR", "RB", "TE"] as const;
    const cap: Record<string, number> = { QB: 1, WR: 2, RB: 2, TE: 1 };
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pos: fc.constantFrom(...POS),
            mean: fc.integer({ min: 1, max: 30 }),
            w: fc.double({ min: 0.05, max: 1.2, noNaN: true }),
            start: fc.boolean(),
            out: fc.boolean(),
          }),
          { minLength: 2, maxLength: 12 },
        ),
        (specs) => {
          const taken = new Map<string, number>();
          const players = specs.map((s) => {
            const ok = s.start && (taken.get(s.pos) ?? 0) < (cap[s.pos] ?? 0);
            if (ok) taken.set(s.pos, (taken.get(s.pos) ?? 0) + 1);
            return player(s.pos, s.mean, {
              slot: ok ? s.pos : "BN",
              points: dist(s.mean, s.mean * s.w),
            });
          });
          const excluded = players.filter((_, i) => specs[i]?.out === true);
          const ex = new Set(excluded.map((p) => p.player_key));
          const r = analyzeLineup({
            slots: LEAGUE_SLOTS,
            players,
            opponent: null,
            exclude: [...ex],
            clock,
            fills_in_swaps: true,
          });
          const byKey = new Map(players.map((p) => [p.player_key, p]));
          const recStarts = new Set(startersOf(r.rec.lineup));
          // never started by the recommendation, whatever happens
          for (const k of ex) expect(startersOf(r.recommended_lineup)).not.toContain(k);
          for (const s of r.swaps) {
            if (s.out === null || !ex.has(s.out)) continue;
            const inn = byKey.get(s.in);
            if (inn === undefined) throw new Error("unknown entrant");
            // priced against 0: the gain is the entrant's own projection, never a loss
            expect(s.delta_e).toBeCloseTo(inn.points.mean, 3);
            // a replacement that cannot lose points benches him in what is logged and scored
            if (s.interval[0] >= 0 && s.delta_e > 0) {
              expect(recStarts.has(s.out)).toBe(false);
              expect(recStarts.has(s.in)).toBe(true);
            }
          }
          // a move is never priced at the excluded players' projections
          if (!r.rec.no_move)
            expect(r.rec.delta_vs_next.p10 < 0 && r.rec.delta_vs_next.p90 > 0).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});
