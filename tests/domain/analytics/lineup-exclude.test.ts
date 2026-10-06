// lineup-exclude.test.ts — QA-2-038: `exclude` says a player will not play (the start-sit Skill
// passes it once the app shows him inactive), so he scores 0 this week. Every swap that benches
// him, its interval, coin_flip, the no-move rule and the logged rec are measured against him at 0 —
// the same answer as a `status: O` player. The rule (plan 07 E2; research 05 §14.4, "every move is
// compared against doing nothing"): a seat that scores a known 0 now — empty, or held by a player
// who will not play — is priced exactly (Δ is the entrant's own points, his quantiles, never a
// symmetric approximation) and is filled whenever the entrant's expected points are above 0, so a
// player who will not play is never started while a replacement who can score exists. A
// replacement who scores 0 too (on bye) gains nothing: no move, worded as such (never a coin flip),
// and the seat is left out of rec.lineup with an assumption that names it — it scores 0 whoever
// holds it.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { zeroDist } from "../../../src/domain/analytics/math.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { canOccupy, slotByName } from "../../../src/domain/league/slots.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import { dist, LEAGUE_SLOTS, NOW, player, recTextsFit, slotsOf } from "./helpers.js";

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

/**
 * A right-skewed Dist with a zero mass, as a Questionable player's (p_zero ≥ 0.1 puts p10 at 0): the
 * mean sits below the p10–p90 midpoint, so a symmetric approximation around the mean pushes p10
 * below 0.
 */
function skewed(mean: number, p90: number, pZero: number): Dist {
  return {
    mean,
    p10: 0,
    p25: pZero >= 0.25 ? 0 : mean * 0.5,
    p50: mean * 0.9,
    p75: (mean + p90) / 2,
    p90,
    p_zero: pZero,
    basis: "position_cv",
  };
}

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

  it("a Questionable replacement (skewed, p10 0): priced by his own quantiles, the change is made", () => {
    // the verifier's domain probe: an excluded 15-point RB, a bench RB with mean 7, p10 0, p90 17,
    // P(active) 0.7 — the symmetric approximation gave [-1.7, 15.7] and "keep the current lineup"
    const rb1 = player("RB", 15, { slot: "RB", points: dist(15, 7) });
    const rb2 = player("RB", 12, { slot: "RB", points: dist(12, 6) });
    const q = player("RB", 7, {
      slot: "BN",
      status: "Q",
      points: skewed(7, 17, 0.3),
      p_active: 0.7,
    });
    for (const variant of ["exclude", "status O"] as const) {
      const r = analyzeLineup({
        slots: RB2,
        players: variant === "exclude" ? [rb1, rb2, q] : [asOut(rb1), rb2, q],
        opponent: null,
        ...(variant === "exclude" ? { exclude: [rb1.player_key] } : {}),
        clock,
      });
      expect(r.swaps, variant).toEqual([
        expect.objectContaining({
          out: rb1.player_key,
          in: q.player_key,
          delta_e: 7,
          interval: [0, 17],
          coin_flip: false,
        }),
      ]);
      expect([r.no_move, r.rec.no_move, r.rec.action], variant).toEqual([
        false,
        false,
        "make 1 lineup change",
      ]);
      expect(startersOf(r.rec.lineup).sort(), variant).toEqual(
        [rb2.player_key, q.player_key].sort(),
      );
      expect(r.rec.delta_vs_next, variant).toEqual({ value: 7, p10: 0, p90: 17 });
      expect(r.rec.subjects, variant).toContainEqual(
        expect.objectContaining({ player_key: rb1.player_key, role: "sit" }),
      );
    }
  });

  it("an empty seat and an excluded starter's seat are the same thing: both filled, both exact", () => {
    const rb2 = player("RB", 12, { slot: "RB", points: dist(12, 6) });
    const q = player("RB", 7, { slot: "BN", points: skewed(7, 17, 0.3), p_active: 0.7 });
    const empty = analyzeLineup({
      slots: RB2,
      players: [rb2, q],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    const ex = player("RB", 15, { slot: "RB" });
    const excluded = analyzeLineup({
      slots: RB2,
      players: [ex, rb2, q],
      opponent: null,
      exclude: [ex.player_key],
      clock,
      fills_in_swaps: true,
    });
    expect(empty.swaps[0]?.interval).toEqual([0, 17]);
    expect(excluded.swaps[0]?.interval).toEqual(empty.swaps[0]?.interval);
    expect(excluded.rec.delta_vs_next).toEqual(empty.rec.delta_vs_next);
    expect(excluded.rec.lineup).toEqual(empty.rec.lineup);
  });

  it("a compare with an entrant who scores a known 0 (on bye): Δ is minus the starter's own quantiles", () => {
    const rb1 = player("RB", 15, { slot: "RB", points: skewed(15, 30, 0.1) });
    const rb2 = player("RB", 12, { slot: "RB", points: dist(12, 6) });
    const bye = player("RB", 0, { slot: "BN", points: zeroDist("position_cv"), p_active: 0 });
    const r = analyzeLineup({
      slots: RB2,
      players: [rb1, rb2, bye],
      opponent: null,
      compare: [{ out: rb1.player_key, in: bye.player_key }],
      clock,
    });
    expect(r.rec.action).toBe("keep the current lineup");
    expect(r.swaps).toEqual([
      expect.objectContaining({ out: rb1.player_key, in: bye.player_key, delta_e: -15 }),
    ]);
    // exact: [0 − p90, 0 − p10] of the starter, never a symmetric band around −15
    expect(r.swaps[0]?.interval).toEqual([-30, 0]);
  });

  it("a replacement with a negative p10 (a defence): the seat that scores 0 is still filled", () => {
    const slots = slotsOf([
      { name: "DEF", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const cur = player("DEF", 8, { slot: "DEF", nfl_team: "DET" });
    const alt = player("DEF", 6, {
      slot: "BN",
      nfl_team: "BUF",
      points: { ...dist(6, 7), p10: -1, p25: 2 },
    });
    const r = analyzeLineup({
      slots,
      players: [cur, alt],
      opponent: null,
      exclude: [cur.player_key],
      clock,
    });
    expect(r.swaps[0]).toMatchObject({ out: cur.player_key, in: alt.player_key, coin_flip: false });
    expect(r.swaps[0]?.interval).toEqual([-1, 13]);
    expect(r.rec.no_move).toBe(false);
    expect(startersOf(r.rec.lineup)).toEqual([alt.player_key]);
  });

  it("his only replacement is on bye (0 points): gains nothing — no move, never called a coin flip", () => {
    const slots = slotsOf([
      { name: "RB", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const rb = player("RB", 20.6, { slot: "RB" });
    const bye = player("RB", 0, { slot: "BN", points: zeroDist("position_cv"), p_active: 0 });
    for (const variant of ["exclude", "status O"] as const) {
      const r = analyzeLineup({
        slots,
        players: variant === "exclude" ? [rb, bye] : [asOut(rb), bye],
        opponent: null,
        ...(variant === "exclude" ? { exclude: [rb.player_key] } : {}),
        clock,
        fills_in_swaps: true,
      });
      for (const s of r.swaps)
        expect(s, variant).toMatchObject({ delta_e: 0, interval: [0, 0], coin_flip: true });
      expect([r.no_move, r.rec.no_move, r.rec.action], variant).toEqual([
        true,
        true,
        "keep the current lineup",
      ]);
      expect(r.rec.delta_vs_next, variant).toEqual({ value: 0, p10: 0, p90: 0 });
      expect(r.rec.latest_execution_time, variant).toBeNull();
      // the player who will not play is never listed as a starter: his seat scores 0 whoever holds it
      expect(startersOf(r.rec.lineup), variant).toEqual([]);
      expect(r.rec.subjects, variant).toEqual([]);
      const texts = r.rec.assumptions.map((a) => a.text);
      expect(
        texts.some((t) => t.startsWith("1 starting seat (RB) scores 0")),
        variant,
      ).toBe(true);
      expect(
        texts.some((t) => t.includes(rb.player_key)),
        variant,
      ).toBe(true);
      expect(
        texts.some((t) => t.includes("coin flip")),
        variant,
      ).toBe(false);
      expect(recTextsFit(r.rec), variant).toBe(true);
      if (variant === "exclude")
        expect(texts.some((t) => t.startsWith("the best lineup change gains nothing"))).toBe(true);
    }
  });

  it("an excluded kicker with no kicker on the bench, beside decisive changes: those are made", () => {
    // the verifier's week-6 repro: exclude Boswell with no bench K gave "make 3 lineup changes",
    // rec.lineup K = Boswell, and an assumption calling the held change a coin flip
    const qb = player("QB", 10, { slot: "QB", points: dist(10, 2) });
    const qbIn = player("QB", 22, { slot: "BN", points: dist(22, 3) });
    const k = player("K", 8, { slot: "K", nfl_team: "PIT" });
    const wr = player("WR", 4, { slot: "WR", points: dist(4, 1) });
    const wrIn = player("WR", 15, { slot: "BN", points: dist(15, 2) });
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, qbIn, k, wr, wrIn],
      opponent: null,
      exclude: [k.player_key],
      clock,
      fills_in_swaps: true,
    });
    expect(r.rec.action).toBe("make 2 lineup changes");
    expect(r.rec.no_move).toBe(false);
    expect(startersOf(r.rec.lineup).sort()).toEqual(
      [qbIn.player_key, wr.player_key, wrIn.player_key].sort(),
    );
    expect(r.rec.lineup?.some((x) => x.slot === "K")).toBe(false);
    const texts = r.rec.assumptions.map((a) => a.text);
    expect(texts.some((t) => /coin flip|includes 0/.test(t))).toBe(false);
    const seat = r.rec.assumptions.find((a) => a.text.startsWith("1 starting seat (K) scores 0"));
    expect(seat?.text).toContain(k.player_key);
    expect(seat?.revisit_trigger).toMatch(/ff_analyze_waivers/);
    expect(recTextsFit(r.rec)).toBe(true);
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

  it("property: never started while a replacement who can score exists; exclude ≡ status O", () => {
    const POS = ["QB", "WR", "RB", "TE"] as const;
    const cap: Record<string, number> = { QB: 1, WR: 2, RB: 2, TE: 1 };
    const shape = fc.constantFrom("symmetric", "skewed", "negative", "bye");
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pos: fc.constantFrom(...POS),
            mean: fc.integer({ min: 1, max: 30 }),
            w: fc.double({ min: 0.05, max: 1.2, noNaN: true }),
            shape,
            pZero: fc.constantFrom(0.1, 0.27, 0.4),
            start: fc.boolean(),
            out: fc.boolean(),
          }),
          { minLength: 2, maxLength: 12 },
        ),
        (specs) => {
          const taken = new Map<string, number>();
          const players = specs.map((s, i) => {
            const ok = s.start && (taken.get(s.pos) ?? 0) < (cap[s.pos] ?? 0);
            if (ok) taken.set(s.pos, (taken.get(s.pos) ?? 0) + 1);
            // distinct projections: between equal ones the solve's pick is arbitrary, and the two
            // runs below may pick differently without either being wrong
            const mean = s.mean + i * 0.0173;
            const points: Dist =
              s.shape === "skewed"
                ? skewed(mean, mean * (1 + s.w * 2), s.pZero)
                : s.shape === "negative"
                  ? { ...dist(mean, mean * s.w), p10: -1 }
                  : s.shape === "bye"
                    ? zeroDist("position_cv")
                    : dist(mean, mean * s.w);
            return player(s.pos, mean, {
              slot: ok ? s.pos : "BN",
              points,
              p_active: s.shape === "bye" ? 0 : 1,
            });
          });
          const ex = new Set(
            players.filter((_, i) => specs[i]?.out === true).map((p) => p.player_key),
          );
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
          const sits = new Set(
            r.rec.subjects.filter((s) => s.role === "sit").map((s) => s.player_key),
          );
          // never started by the recommendation, nor by what is logged and scored
          for (const k of ex) {
            expect(startersOf(r.recommended_lineup)).not.toContain(k);
            expect(recStarts.has(k)).toBe(false);
          }
          for (const s of r.swaps) {
            if (s.out === null || !ex.has(s.out)) continue;
            const inn = byKey.get(s.in);
            if (inn === undefined) throw new Error("unknown entrant");
            // priced against 0: the entrant's own projection and quantiles, never a loss
            expect(s.delta_e).toBeCloseTo(inn.points.mean, 3);
            expect(s.interval[0]).toBeCloseTo(inn.points.p10, 2);
            expect(s.interval[1]).toBeCloseTo(inn.points.p90, 2);
            // a replacement who can score benches him in what is logged and scored
            if (inn.points.mean > 0) {
              expect(recStarts.has(s.in)).toBe(true);
              expect(sits.has(s.out)).toBe(true);
            }
          }
          // an excluded starter with an unused bench player who could take his seat and score is
          // always benched for someone (the solve fills his seat; the change is made)
          for (const k of ex) {
            const x = byKey.get(k);
            if (x === undefined || !STARTING(x.slot)) continue;
            const slot = slotByName(LEAGUE_SLOTS, x.slot);
            if (slot === null) throw new Error("unknown slot");
            const free = players.some(
              (y) =>
                !ex.has(y.player_key) &&
                !recStarts.has(y.player_key) &&
                y.points.mean > 0 &&
                canOccupy(slot, { positions: y.positions, status: y.status }),
            );
            if (free) expect(sits.has(k), `${k} is benched`).toBe(true);
          }
          // a move is never priced at the excluded players' projections: a made change straddles 0
          // only when it fills a seat that scores 0 with an entrant whose p10 is below 0
          const negativeFill = r.swaps.some(
            (s) =>
              s.interval[0] < 0 &&
              recStarts.has(s.in) &&
              (s.out === null || ex.has(s.out) || byKey.get(s.out)?.points.p90 === 0),
          );
          if (!r.rec.no_move && !negativeFill)
            expect(r.rec.delta_vs_next.p10 < 0 && r.rec.delta_vs_next.p90 > 0).toBe(false);
          // the zero-points equivalent (status O) decides the same (restored: QA-2-038 / be1eb6b)
          const o = analyzeLineup({
            slots: LEAGUE_SLOTS,
            players: players.map((p) => (ex.has(p.player_key) ? asOut(p) : p)),
            opponent: null,
            clock,
            fills_in_swaps: true,
          });
          // (the Δ's value exactly; its p10–p90 up to how the solve seats equal-total arrangements —
          // a seat filled is priced by quantiles, a swap by the normal approximation)
          expect(o.rec.delta_vs_next.value).toBeCloseTo(r.rec.delta_vs_next.value, 3);
          const straddling = (x: typeof r) =>
            x.rec.delta_vs_next.p10 < 0 && x.rec.delta_vs_next.p90 > 0;
          expect(straddling(o)).toBe(straddling(r));
          expect(o.rec.no_move).toBe(r.rec.no_move);
          // the same starters, logged and scored — up to players of equal projection, whom the solve
          // may pick either way — in any order and seat: a status O player can keep a seat an
          // excluded one cannot, so an entrant may take another seat he can fill; a sit may differ
          // the same way (listed nowhere, his seat named as scoring 0)
          const meansOf = (rows: readonly { player_key: string | null }[] | null) =>
            (rows ?? [])
              .map((x) => byKey.get(String(x.player_key))?.points.mean ?? Number.NaN)
              .sort((a, b) => a - b);
          const startsOf = (x: typeof r) => x.rec.subjects.filter((s) => s.role === "start");
          expect(meansOf(o.rec.lineup)).toEqual(meansOf(r.rec.lineup));
          expect(meansOf(startsOf(o))).toEqual(meansOf(startsOf(r)));
          expect(o.rec.point_estimate).toBe(r.rec.point_estimate);
          expect(recTextsFit(r.rec)).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });
});
