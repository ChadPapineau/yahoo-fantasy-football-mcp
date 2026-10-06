// lineup-unscored.test.ts — QA-2-039: a starting seat held by a rostered player the engine cannot
// project (his league.yaml line matches no NFL player) is NOT empty. E2 used to see it as empty and
// advise "filling" it (`out: null`), which in the fantasy app benches the very player who holds it.
// Such a seat is kept as it is: never filled, left out of the totals, and P(win) is withheld (my
// total is unknown), said so in an assumption.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeLineup, type LineupPlayer } from "../../../src/domain/analytics/lineup.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { complete, dist, LEAGUE_SLOTS, NOW, player, recTextsFit } from "./helpers.js";

const clock = fixedClock(NOW);
const STARTING = (slot: string): boolean => slot !== "BN" && slot !== "IR";

/** One player per starting seat of LEAGUE_SLOTS (every seat held), in seat order. */
const SEATS: readonly [string, string][] = [
  ["QB", "QB"],
  ["WR", "WR"],
  ["WR", "WR"],
  ["RB", "RB"],
  ["RB", "RB"],
  ["TE", "TE"],
  ["W/R/T", "WR"],
  ["K", "K"],
  ["DEF", "DEF"],
];

describe("QA-2-039 — a seat held by an unmatched starter is not empty", () => {
  it("the W/R/T starter is unmatched: no fill, no move there, P(win) withheld", () => {
    const starters = SEATS.map(([slot, pos]) =>
      player(pos, 12, { slot, points: dist(12, 3), nfl_team: "BUF" }),
    );
    const flexIdx = 6;
    const held = starters.filter((_, i) => i !== flexIdx);
    const bench = player("RB", 11, { slot: "BN", points: dist(11, 3) });
    const opponent = complete([player("QB", 18, { slot: "QB", nfl_team: "KC" })]);
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [...held, bench],
      opponent,
      objective: "pwin",
      unscored_seats: ["W/R/T"],
      clock,
      fills_in_swaps: true,
    });
    expect(r.swaps.filter((s) => s.out === null)).toEqual([]);
    expect(r.recommended_lineup.find((a) => a.player_key === bench.player_key)?.slot).toBe("BN");
    expect([r.no_move, r.rec.action]).toEqual([true, "keep the current lineup"]);
    expect(r.objective_used).toBe("mean");
    expect([r.p_win_before, r.p_win_after]).toEqual([null, null]);
    const a = r.rec.assumptions.find((x) => x.text.includes("NFL data does not match"));
    expect(a?.text).toContain("W/R/T");
    expect(recTextsFit(r.rec)).toBe(true);
    // the control: the same roster with the seat treated as empty is "filled" — the bug
    const c = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [...held, bench],
      opponent: null,
      clock,
      fills_in_swaps: true,
    });
    expect(c.swaps.filter((s) => s.out === null).map((s) => s.slot)).toEqual(["W/R/T"]);
  });

  it("property: with every seat held, no swap ever fills a seat, whichever starters are unmatched", () => {
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: SEATS.length, maxLength: SEATS.length }),
        fc.array(
          fc.record({
            pos: fc.constantFrom("QB", "WR", "RB", "TE", "K", "DEF"),
            mean: fc.integer({ min: 1, max: 40 }),
          }),
          { maxLength: 6 },
        ),
        fc.array(fc.integer({ min: 1, max: 30 }), {
          minLength: SEATS.length,
          maxLength: SEATS.length,
        }),
        (unmatched, benchSpecs, means) => {
          const starters = SEATS.map(([slot, pos], i) =>
            player(pos, means[i] ?? 10, { slot, points: dist(means[i] ?? 10, 2) }),
          );
          const gone = new Set<LineupPlayer>(starters.filter((_, i) => unmatched[i] === true));
          const bench = benchSpecs.map((b) =>
            player(b.pos, b.mean, { slot: "BN", points: dist(b.mean, 2) }),
          );
          const players = [...starters.filter((p) => !gone.has(p)), ...bench];
          if (players.length === 0) return;
          const r = analyzeLineup({
            slots: LEAGUE_SLOTS,
            players,
            opponent: null,
            unscored_seats: [...gone].map((p) => p.slot),
            clock,
            fills_in_swaps: true,
          });
          expect(r.swaps.filter((s) => s.out === null)).toEqual([]);
          const started = r.recommended_lineup.filter((a) => STARTING(a.slot)).length;
          expect(started).toBeLessThanOrEqual(SEATS.length - gone.size);
          expect((r.rec.lineup ?? []).length).toBeLessThanOrEqual(SEATS.length - gone.size);
          expect(recTextsFit(r.rec)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
