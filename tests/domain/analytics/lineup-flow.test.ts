// lineup-flow.test.ts — QA-1-020, QA-1-040: E2's swaps follow the actual slot flow. A current lineup
// with an empty starting seat (a starter moved to IR, dropped, or omitted as unmatched) is a lineup
// change when the recommendation fills it: no_move false, the fill reported as a swap with `out: null`
// and its own deadline. Every entrant is reported, paired with the starter he actually replaces —
// following the chain of starters who only change slots — never with whoever is first in a list.
// Reopened in round 2: the no-move rule (QA-1-060) is applied change by change, so a coin-flip swap
// elsewhere in the lineup never holds back a fill (or any change) whose own Δ interval excludes 0 —
// and, the other way round, a decisive change never carries a coin flip with it (the round-2
// verification): the changes touch disjoint seats, so each is decided on its own interval alone.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { zeroDist } from "../../../src/domain/analytics/math.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { canOccupy, slotByName } from "../../../src/domain/league/slots.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import { dist, LEAGUE_SLOTS, NOW, player, SUN_1PM, SUN_425, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
const tight = (m: number) => dist(m, m * 0.2);

/** A Dist of the property's shapes: symmetric, skewed (p10 0), negative p10 (a defence), a bye. */
function pointsOf(shape: string, mean: number, w: number): Dist {
  if (shape === "bye") return zeroDist("position_cv");
  if (shape === "skewed")
    return { ...dist(mean, mean * w), p10: 0, p25: mean * 0.4, p_zero: 0.27, p90: mean * 2.2 };
  if (shape === "negative") return { ...dist(mean, mean * w), p10: -2 };
  return dist(mean, mean * w);
}

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
            // tight and wide spreads: coin-flip swaps next to decisive ones; skewed ones (a
            // Questionable player's zero mass); a defence that can score below 0; byes
            w: fc.constantFrom(0.2, 0.2, 0.9),
            shape: fc.constantFrom("symmetric", "symmetric", "skewed", "negative", "bye"),
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
            return player(s.pos, s.mean, {
              slot: ok ? s.slot : "BN",
              points: pointsOf(s.shape, s.mean, s.w),
              p_active: s.shape === "bye" ? 0 : 1,
            });
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
          for (const s of r.swaps) {
            if (s.out !== null) expect(cur.has(s.out) && !rec.has(s.out)).toBe(true);
          }
          // each change decided on its own interval (QA-1-020/040; the round-2 verification): a
          // listed swap is made exactly when its own Δ interval excludes 0 — or, when it fills a seat
          // that scores a known 0 now (empty, or held by a player who will not play), when the
          // entrant is expected to score — whatever other changes sit next to it
          const byKey = new Map(players.map((p) => [p.player_key, p]));
          const kept = startOf(r.rec.lineup ?? []);
          let madeN = 0;
          let coinN = 0;
          let zeroN = 0;
          for (const s of r.swaps) {
            const out = s.out === null ? null : byKey.get(s.out);
            const zeroSeat = out === null || out?.points.p90 === 0;
            const nothing = zeroSeat ? s.delta_e <= 0 : s.interval[0] === 0 && s.interval[1] === 0;
            const coin = !zeroSeat && !nothing && s.interval[0] < 0 && s.interval[1] > 0;
            const made = !nothing && !coin;
            expect(kept.has(s.in), `${s.in} started iff its change is made`).toBe(made);
            if (s.out !== null && made) expect(kept.has(s.out), `${s.out} is benched`).toBe(false);
            if (made) madeN++;
            else if (coin) coinN++;
            else zeroN++;
            // a held change is flagged; a seat that scores 0 filled by a scorer is not a coin flip
            if (!made) expect(s.coin_flip).toBe(true);
            if (zeroSeat && made) expect(s.coin_flip).toBe(false);
          }
          // rec.action counts the listed swaps apart: made + coin flips held + gaining nothing
          const madeA = /make (\d+) lineup change/.exec(r.rec.action);
          const heldA = /hold (\d+) coin flip/.exec(r.rec.action);
          const zeroA = /skip (\d+) changes? that gains? nothing/.exec(r.rec.action);
          if (madeA !== null) {
            expect(Number(madeA[1])).toBe(madeN);
            expect(Number(heldA?.[1] ?? 0)).toBe(coinN);
            expect(Number(zeroA?.[1] ?? 0)).toBe(zeroN);
          }
          // no move ⇔ the rec keeps the current seats (a seat that scores 0 whoever holds it is
          // left out of rec.lineup, so compare the current starters who can score)
          const scoring = new Map([...cur].filter(([k]) => (byKey.get(k)?.points.p90 ?? 0) !== 0));
          const keepsSeats =
            scoring.size === kept.size && [...scoring].every(([k, v]) => kept.get(k) === v);
          expect(r.rec.no_move).toBe(keepsSeats);
          expect(r.no_move).toBe(r.rec.no_move);
          // the kept lineup is legal: every starter fits his seat, no seat over its count
          const count = new Map<string, number>();
          for (const [k, slotName] of kept) {
            const slot = slotByName(LEAGUE_SLOTS, slotName);
            const p = byKey.get(k);
            if (slot === null || p === undefined) throw new Error("unknown seat or player");
            expect(canOccupy(slot, { positions: p.positions, status: p.status })).toBe(true);
            count.set(slotName, (count.get(slotName) ?? 0) + 1);
          }
          for (const [slotName, n] of count)
            expect(n).toBeLessThanOrEqual(slotByName(LEAGUE_SLOTS, slotName)?.count ?? 0);
          // a move's Δ interval never straddles 0 when every change made has its own above 0
          // (QA-1-060); only a seat that scores 0 filled by an entrant whose p10 is below 0 can
          const d = r.rec.delta_vs_next;
          const negative = r.swaps.some((s) => kept.has(s.in) && s.interval[0] < 0);
          if (!r.rec.no_move && !negative) expect(d.p10 < 0 && d.p90 > 0).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });
  it("an empty RB seat next to a coin-flip WR swap: the fill is made, only the coin flip held", () => {
    const slots = slotsOf([
      { name: "QB", count: 1 },
      { name: "WR", count: 1 },
      { name: "RB", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const qb = player("QB", 20, { slot: "QB", points: tight(20) });
    const wr = player("WR", 10, { slot: "WR", points: dist(10, 2) });
    const wrBench = player("WR", 10.5, { slot: "BN", points: dist(10.5, 9) });
    const rb = player("RB", 6, { slot: "BN", points: dist(6, 2), lock_at: SUN_425 });
    for (const fills of [true, false]) {
      const r = analyzeLineup({
        slots,
        players: [qb, wr, wrBench, rb],
        opponent: null,
        clock,
        fills_in_swaps: fills,
      });
      const label = `fills_in_swaps ${String(fills)}`;
      expect(r.no_move, label).toBe(false);
      expect(r.rec.no_move, label).toBe(false);
      expect(r.rec.action, label).toBe(
        fills
          ? "make 1 lineup change and hold 1 coin flip"
          : "fill 1 empty starting slot and hold 1 coin flip",
      );
      expect(r.rec.lineup, label).toEqual([
        { slot: "QB", player_key: qb.player_key },
        { slot: "WR", player_key: wr.player_key },
        { slot: "RB", player_key: rb.player_key },
      ]);
      expect(r.rec.latest_execution_time, label).toBe(SUN_425);
      expect(r.rec.delta_vs_next, label).toEqual({ value: 6, p10: 4, p90: 8 });
      // the coin flip is still shown, flagged
      expect(r.swaps, label).toContainEqual(
        expect.objectContaining({ out: wr.player_key, in: wrBench.player_key, coin_flip: true }),
      );
      expect(
        r.rec.assumptions.some((a) => a.text.startsWith("1 change of the best lineup held")),
        label,
      ).toBe(true);
    }
  });

  it("a decisive fill beside a coin flip: the fill is made, the coin flip is held, never carried", () => {
    // the verifier's domain repro: a fill of dist(20, 5) [15, 25] next to a WR coin flip
    // [-8.76, 9.76] combine to an interval above 0, which used to make both
    const slots = slotsOf([
      { name: "QB", count: 1 },
      { name: "WR", count: 1 },
      { name: "RB", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const qb = player("QB", 20, { slot: "QB", points: tight(20) });
    const wr = player("WR", 10, { slot: "WR", points: dist(10, 5) });
    const wrBench = player("WR", 10.5, { slot: "BN", points: dist(10.5, 6) });
    const rb = player("RB", 20, { slot: "BN", points: dist(20, 5) });
    const r = analyzeLineup({
      slots,
      players: [qb, wr, wrBench, rb],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    const flip = r.swaps.find((s) => s.out === wr.player_key);
    expect(flip?.coin_flip).toBe(true);
    expect((flip?.interval[0] ?? 0) < 0 && (flip?.interval[1] ?? 0) > 0).toBe(true);
    expect(r.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    expect(r.rec.lineup).toEqual([
      { slot: "QB", player_key: qb.player_key },
      { slot: "WR", player_key: wr.player_key },
      { slot: "RB", player_key: rb.player_key },
    ]);
    expect(r.rec.delta_vs_next).toEqual({ value: 20, p10: 15, p90: 25 });
  });

  it("a decisive swap beside a coin flip: the decision on the coin flip does not depend on it", () => {
    const slots = slotsOf([
      { name: "QB", count: 1 },
      { name: "WR", count: 1 },
      { name: "BN", count: 4 },
    ]);
    const wr = player("WR", 10, { slot: "WR", points: dist(10, 5) });
    const wrBench = player("WR", 11, { slot: "BN", points: dist(11, 6) });
    const qbBench = player("QB", 30, { slot: "BN", points: dist(30, 3) });
    const decided = (qbMean: number) => {
      const qb = player("QB", qbMean, { slot: "QB", points: dist(qbMean, 3) });
      const r = analyzeLineup({
        slots,
        players: [qb, wr, wrBench, qbBench],
        opponent: null,
        clock,
      });
      return { r, qb };
    };
    // a QB 2 points worse (a coin flip), then 20 points worse (decisive): the WR call is the same
    for (const qbMean of [28, 10]) {
      const { r } = decided(qbMean);
      const kept = new Set(r.rec.lineup?.map((x) => x.player_key));
      expect(kept.has(wr.player_key), `QB ${String(qbMean)}`).toBe(true);
      expect(kept.has(wrBench.player_key), `QB ${String(qbMean)}`).toBe(false);
    }
    expect(decided(10).r.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
    expect(decided(28).r.rec.action).toBe("keep the current lineup");
  });

  it("two entrants, an empty seat and a coin flip: the stronger entrant takes the seat that is made", () => {
    // which entrant fills the empty RB seat and which faces the starter is a tie for the solve (same
    // total); decided change by change, the stronger one must fill — held behind the coin flip, he
    // would sit while the weaker one starts (the round-2 verification's exclude ≡ status O property)
    const slots = slotsOf([
      { name: "RB", count: 2 },
      { name: "BN", count: 4 },
    ]);
    for (const strongerFirst of [true, false]) {
      const label = `stronger entrant created ${strongerFirst ? "first" : "second"}`;
      const starter = player("RB", 10, { slot: "RB", points: dist(10, 8) });
      const make = (m: number) => player("RB", m, { slot: "BN", points: dist(m, 8) });
      const [strong, weak] = strongerFirst
        ? [make(12), make(11)]
        : (() => {
            const w = make(11);
            return [make(12), w] as const;
          })();
      const r = analyzeLineup({
        slots,
        players: [starter, strong, weak],
        opponent: null,
        clock,
        fills_in_swaps: true,
      });
      expect(r.rec.action, label).toBe("make 1 lineup change and hold 1 coin flip");
      expect(r.swaps.find((s) => s.out === null)?.in, label).toBe(strong.player_key);
      expect(r.swaps.find((s) => s.out === starter.player_key)?.in, label).toBe(weak.player_key);
      const kept = (r.rec.lineup ?? []).map((x) => x.player_key).sort();
      expect(kept, label).toEqual([starter.player_key, strong.player_key].sort());
      // the seats agree with what is shown as the recommendation
      const shown = r.recommended_lineup.filter((x) => x.slot === "RB").map((x) => x.player_key);
      expect(shown.sort(), label).toEqual([strong.player_key, weak.player_key].sort());
    }
  });
});
