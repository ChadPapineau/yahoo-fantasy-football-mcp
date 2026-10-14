// lineup-seat-invariance.test.ts — QA-2-062: E2's decision is a function of the players and their
// Dists alone. Which entrant takes which freed seat is a free choice among lineups of the same total,
// and each change is priced on its own pairing (a seat that scores 0 by the entrant's quantiles, a
// swap by the normal approximation), so a pairing picked by the solve's tie-breaks — the input
// order, or a row that differs only for a player who will not play — moved `delta_vs_next`'s
// interval across 0 (the exclude ≡ status O property, fc seed 784013146 path "150"). Permuting the
// input, renaming the keys in the same order, and writing an excluded player as `status: O` must
// leave Δ (value, p10, p90), no_move, the made changes and rec.lineup's starters unchanged.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  analyzeLineup,
  type LineupPlayer,
  type LineupRequest,
} from "../../../src/domain/analytics/lineup.js";
import { zeroDist } from "../../../src/domain/analytics/math.js";
import { fixedClock } from "../../../src/domain/clock.js";
import type { LineupRecommendation } from "../../../src/domain/analytics/types.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import { canOccupy, slotByName } from "../../../src/domain/league/slots.js";
import type { RosterSlots } from "../../../src/domain/league/types.js";
import { dist, LEAGUE_SLOTS, NOW, PAST, player, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
const STARTING = (slot: string): boolean => slot !== "BN" && slot !== "IR";

/** The fixture league's slots, and a superflex league's (Q/W/R/T takes a QB too). */
const TABLES = [
  { slots: LEAGUE_SLOTS, flex: ["W/R/T"] },
  {
    slots: slotsOf([
      { name: "QB", count: 1 },
      { name: "WR", count: 2 },
      { name: "RB", count: 2 },
      { name: "TE", count: 1 },
      { name: "W/R/T", count: 1 },
      { name: "Q/W/R/T", count: 1 },
      { name: "BN", count: 6 },
      { name: "IR", count: 2 },
    ]),
    flex: ["W/R/T", "Q/W/R/T"],
  },
] as const;
type Table = (typeof TABLES)[number];

/** √ of distinct primes: no two different sets of players project the same total. */
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43];

type Shape = "symmetric" | "skewed" | "negative" | "bye";

interface Spec {
  readonly pos: "QB" | "WR" | "RB" | "TE";
  /** A second position (a multi-position player), or none. */
  readonly alt: "WR" | "RB" | "TE" | null;
  readonly mean: number;
  readonly w: number;
  readonly shape: Shape;
  readonly seat: "own" | "flex" | "bench";
  readonly out: boolean;
  readonly locked: boolean;
}

function pointsOf(shape: Shape, mean: number, w: number): Dist {
  if (shape === "bye") return zeroDist("position_cv");
  if (shape === "skewed")
    return {
      mean,
      p10: 0,
      p25: mean * 0.4,
      p50: mean * 0.9,
      p75: mean * (1.5 + w),
      p90: mean * (2 + 2 * w),
      p_zero: 0.27,
      basis: "position_cv",
    };
  if (shape === "negative") return { ...dist(mean, mean * w), p10: -1 };
  return dist(mean, mean * w);
}

function rosterOf(specs: readonly Spec[], table: Table): LineupPlayer[] {
  const taken = new Map<string, number>();
  const room = (name: string): boolean =>
    (taken.get(name) ?? 0) < (slotByName(table.slots, name)?.count ?? 0);
  return specs.map((s, i) => {
    const positions = s.alt === null || s.alt === s.pos ? [s.pos] : [s.pos, s.alt];
    const fitsSeat = (name: string): boolean => {
      const slot = slotByName(table.slots, name);
      return slot !== null && canOccupy(slot, { positions, status: null });
    };
    const want =
      s.seat === "own"
        ? s.pos
        : s.seat === "flex"
          ? (table.flex.find((f) => fitsSeat(f) && room(f)) ?? "BN")
          : "BN";
    const ok = want !== "BN" && room(want);
    if (ok) taken.set(want, (taken.get(want) ?? 0) + 1);
    const mean = s.mean + 0.01 * Math.sqrt(PRIMES[i] ?? 47);
    return player(s.pos, mean, {
      positions,
      slot: ok ? want : "BN",
      points: pointsOf(s.shape, mean, s.w),
      p_active: s.shape === "bye" ? 0 : 1,
      ...(s.locked ? { lock_at: PAST } : {}),
    });
  });
}

/** What is logged and scored is a legal lineup: every starter fits his seat, no seat over count. */
function legal(r: LineupRecommendation, players: readonly LineupPlayer[], slots: RosterSlots) {
  const byKey = new Map(players.map((p) => [p.player_key, p]));
  for (const rows of [r.rec.lineup ?? [], r.recommended_lineup]) {
    const count = new Map<string, number>();
    for (const x of rows) {
      if (!STARTING(x.slot)) continue;
      const slot = slotByName(slots, x.slot);
      const p = byKey.get(x.player_key);
      if (slot === null || p === undefined) throw new Error("unknown seat or player");
      expect(canOccupy(slot, { positions: p.positions, status: p.status })).toBe(true);
      count.set(x.slot, (count.get(x.slot) ?? 0) + 1);
    }
    for (const [name, n] of count)
      expect(n).toBeLessThanOrEqual(slotByName(slots, name)?.count ?? 0);
  }
}

/** At most this many rostered players per case. */
const MAX_PLAYERS = 12;

const SPECS = fc.array(
  fc.record({
    pos: fc.constantFrom("QB", "WR", "RB", "TE"),
    alt: fc.constantFrom(null, null, null, "WR", "RB", "TE"),
    mean: fc.integer({ min: 1, max: 30 }),
    w: fc.double({ min: 0.05, max: 1.2, noNaN: true }),
    shape: fc.constantFrom("symmetric", "symmetric", "skewed", "negative", "bye"),
    seat: fc.constantFrom("own", "own", "flex", "bench", "bench"),
    out: fc.boolean(),
    locked: fc.constantFrom(false, false, false, false, true),
  }),
  { minLength: 2, maxLength: MAX_PLAYERS },
) as fc.Arbitrary<Spec[]>;

/** The same player written as `status: O`: a zero Dist, P(active) 0. */
const asOut = (p: LineupPlayer): LineupPlayer => ({
  ...p,
  points: zeroDist(p.points.basis),
  p_active: 0,
});

/**
 * The decision of one run, in the base run's player keys: Δ, no_move, the made changes (entrant →
 * the scoring starter he benches, or "0" for a seat that scores 0 now: empty, or held by a player
 * who will not play) with the scoring starters benched outright, and rec.lineup's starters.
 * `players` are the run's players as the engine prices them (an excluded one at 0).
 */
function decision(
  r: LineupRecommendation,
  players: readonly LineupPlayer[],
  back: (k: string) => string,
) {
  const byKey = new Map(players.map((p) => [p.player_key, p]));
  const scores = (k: string | null): boolean => {
    const p = k === null ? undefined : byKey.get(k);
    return p !== undefined && !(p.points.mean === 0 && p.points.p10 === 0 && p.points.p90 === 0);
  };
  const recStarters = (r.rec.lineup ?? []).filter((x) => STARTING(x.slot)).map((x) => x.player_key);
  const kept = new Set(recStarters);
  const madeSwaps = r.swaps.filter((s) => kept.has(s.in));
  const made = madeSwaps.map(
    (s) => `${back(s.in)}>${s.out !== null && scores(s.out) ? back(s.out) : "0"}`,
  );
  const paired = new Set(madeSwaps.map((s) => s.out));
  const benched = r.rec.subjects
    .flatMap((s) => (s.role === "sit" && s.player_key !== null ? [s.player_key] : []))
    .filter((k) => !paired.has(k) && scores(k))
    .map((k) => `sit:${back(k)}`);
  return {
    delta_vs_next: r.rec.delta_vs_next,
    no_move: [r.no_move, r.rec.no_move],
    made: [...made, ...benched].sort(),
    starters: recStarters.map(back).sort(),
    point_estimate: r.rec.point_estimate,
  };
}

describe("QA-2-062 — the lineup decision never depends on a tie-break", () => {
  it("property: input order, key names (order kept) and exclude ↔ status O never change the decision", () => {
    fc.assert(
      fc.property(
        SPECS,
        fc.array(fc.nat({ max: 1000 }), { minLength: MAX_PLAYERS, maxLength: MAX_PLAYERS }),
        fc.array(fc.boolean(), { minLength: MAX_PLAYERS, maxLength: MAX_PLAYERS }),
        fc.boolean(),
        fc.constantFrom(...TABLES),
        (specs, order, asStatusO, rename, table) => {
          const players = rosterOf(specs, table);
          const excluded = new Set(players.filter((_, i) => specs[i]?.out === true));
          const base: LineupRequest = {
            slots: table.slots,
            players,
            opponent: null,
            exclude: [...excluded].map((p) => p.player_key),
            clock,
            fills_in_swaps: true,
          };
          const r = analyzeLineup(base);
          // each run's players as the engine prices them: an excluded player scores 0
          const priced = (ps: readonly LineupPlayer[], ex: ReadonlySet<string>) =>
            ps.map((p) => (ex.has(p.player_key) ? asOut(p) : p));
          const exR = new Set([...excluded].map((p) => p.player_key));
          const want = decision(r, priced(players, exR), (k) => k);
          legal(r, players, table.slots);
          /** The same roster in `inOrder`, the players in `toO` written as status O, keys renamed. */
          const variant = (
            inOrder: readonly LineupPlayer[],
            toO: ReadonlySet<LineupPlayer>,
            renamed: boolean,
          ): void => {
            const fwd = (k: string): string => (renamed ? k.replace("manual.p.", "manual.q.") : k);
            const back = (k: string): string => (renamed ? k.replace("manual.q.", "manual.p.") : k);
            const vPlayers = inOrder.map((p) => {
              const q = toO.has(p) ? asOut(p) : p;
              return { ...q, player_key: fwd(q.player_key) };
            });
            const still = inOrder.filter((p) => excluded.has(p) && !toO.has(p));
            const v = analyzeLineup({
              ...base,
              players: vPlayers,
              exclude: still.map((p) => fwd(p.player_key)),
            });
            const exV = new Set(still.map((p) => fwd(p.player_key)));
            expect(decision(v, priced(vPlayers, exV), back)).toEqual(want);
            legal(v, vPlayers, table.slots);
          };
          // the input reversed with every excluded player written as status O; and some excluded
          // players as status O, the input shuffled, (half the time) the keys renamed
          variant([...players].reverse(), excluded, false);
          const rank = new Map(players.map((p, i) => [p, (order[i] ?? 0) * MAX_PLAYERS + i]));
          variant(
            [...players].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
            new Set(players.filter((p, i) => excluded.has(p) && asStatusO[i] === true)),
            rename,
          );
        },
      ),
      { numRuns: 400 },
    );
  });

  it("a starter who must change slots to make room: the move that lets the better change be made", () => {
    // the property's shrunk case: a QB/WR starting at QB, two 1-point WRs, three 1-point QBs on
    // the bench (one also a WR), the flex empty. The best lineup starts the best bench QB at QB
    // and the QB/WR elsewhere: at WR (benching a WR, a coin flip), the bench QB/WR then filling the
    // flex — or at the flex, the bench QB's change filling a seat that scored 0 (made) and the bench
    // QB/WR's swap for the WR held. The solve's seating decided which; the better is made.
    const qbWr = player("QB", 2.0141, { positions: ["QB", "WR"], slot: "QB" });
    const wrA = player("WR", 1.0173, { slot: "WR", points: dist(1.0173, 0.05) });
    const wrB = player("WR", 1.0224, { slot: "WR", points: dist(1.0224, 0.05) });
    const benchQbWr = player("QB", 1.0265, { positions: ["QB", "WR"], points: dist(1.0265, 0.05) });
    const qbC = player("QB", 1.0332, { points: dist(1.0332, 0.05) });
    const qbD = player("QB", 1.0361, { points: dist(1.0361, 0.05) });
    const roster = [qbWr, wrA, wrB, benchQbWr, qbC, qbD];
    const runs = [roster, [...roster].reverse(), [wrB, qbD, qbWr, benchQbWr, wrA, qbC]].map(
      (players) =>
        analyzeLineup({
          slots: LEAGUE_SLOTS,
          players,
          opponent: null,
          clock,
          fills_in_swaps: true,
        }),
    );
    for (const r of runs) {
      const starters = (r.rec.lineup ?? []).map((x) => x.player_key).sort();
      expect(starters).toEqual([qbWr, wrA, wrB, qbD].map((p) => p.player_key).sort());
      expect(r.rec.delta_vs_next).toEqual({ value: 1.0361, p10: 0.9861, p90: 1.0861 });
      expect(r.rec.action).toBe("make 1 lineup change and hold 1 coin flip");
      expect(r.recommended_lineup.find((x) => x.player_key === qbWr.player_key)?.slot).toBe(
        "W/R/T",
      );
      legal(r, roster, LEAGUE_SLOTS);
    }
  });

  it("two WR entrants for a WR starter's seat and an empty flex: the pairing follows the players", () => {
    // equal gain either way (both changes are made); the strong WR's swap is decisive and the weak
    // one fills the flex, or the weak WR's swap with the strong one at the flex — whatever the
    // input order, the same pairing, Δ and starters
    const slots = slotsOf([
      { name: "WR", count: 1 },
      { name: "W/R/T", count: 1 },
      { name: "BN", count: 5 },
    ]);
    const cur = player("WR", 7, { slot: "WR", points: { ...dist(7, 0.35), p10: -1 } });
    const strong = player("WR", 18, { points: { ...dist(18, 0.9), p10: -1 } });
    const weak = player("WR", 12, { points: dist(12, 0.6) });
    const runs = [
      [cur, strong, weak],
      [weak, strong, cur],
      [strong, cur, weak],
    ].map((players) =>
      analyzeLineup({ slots, players, opponent: null, clock, fills_in_swaps: true }),
    );
    for (const r of runs) {
      expect(r.swaps.find((s) => s.out === cur.player_key)?.in).toBe(
        runs[0]?.swaps.find((s) => s.out === cur.player_key)?.in,
      );
      expect(r.rec.delta_vs_next).toEqual(runs[0]?.rec.delta_vs_next);
      expect(r.rec.no_move).toBe(false);
    }
  });
});
