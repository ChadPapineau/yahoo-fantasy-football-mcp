// no-move.test.ts — QA-1-060: research 05 §14.4 (plan 07 E2 method; research 06 row 14.4 puts it in
// the tool): "a recommendation whose Δ interval includes 0 is reported as no move". The tools now say
// so themselves, so the logged rec agrees with the Skill's rendered "No move" and the retrospective
// scores a user who keeps his lineup as having followed the call. "Includes 0" means the move could
// lose points (p10 < 0 < p90); filling an empty seat cannot, so it stays a move.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeKdef, type KdefCandidateInput } from "../../../src/domain/analytics/kdef.js";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";
import { dist, LEAGUE_SLOTS, NOW, player, recTextsFit, slotsOf } from "./helpers.js";

const clock = fixedClock(NOW);
const straddles = (d: { p10: number; p90: number }): boolean => d.p10 < 0 && d.p90 > 0;

describe("QA-1-060 — E2: a lineup change whose Δ interval straddles 0 is no move", () => {
  it("a coin-flip QB swap: no_move, keep, the current lineup as the rec, the swap still shown", () => {
    const start = player("QB", 12, { slot: "QB" });
    const bench = player("QB", 14, { slot: "BN" });
    const r = analyzeLineup({
      slots: slotsOf([
        { name: "QB", count: 1 },
        { name: "BN", count: 4 },
      ]),
      players: [start, bench],
      opponent: null,
      clock,
    });
    expect(r.recommended_lineup.find((a) => a.slot === "QB")?.player_key).toBe(bench.player_key);
    expect(straddles(r.rec.delta_vs_next)).toBe(true);
    expect(r.no_move).toBe(true);
    expect(r.rec.no_move).toBe(true);
    expect(r.rec.action).toBe("keep the current lineup");
    expect(r.rec.latest_execution_time).toBeNull();
    expect(r.rec.lineup).toEqual([{ slot: "QB", player_key: start.player_key }]);
    expect(r.rec.subjects).toEqual([
      expect.objectContaining({ player_key: start.player_key, role: "start", slot: "QB" }),
    ]);
    expect(r.swaps).toEqual([
      expect.objectContaining({ out: start.player_key, in: bench.player_key, coin_flip: true }),
    ]);
    expect(
      r.rec.assumptions.some((a) => a.text.startsWith("the best lineup change is a coin flip")),
    ).toBe(true);
  });

  it("a decisive swap stays a move", () => {
    const start = player("QB", 6, { slot: "QB", points: dist(6, 1) });
    const bench = player("QB", 22, { slot: "BN", points: dist(22, 4) });
    const r = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [start, bench],
      opponent: null,
      clock,
    });
    expect(r.rec.delta_vs_next.p10).toBeGreaterThan(0);
    expect([r.no_move, r.rec.no_move, r.rec.action]).toEqual([
      false,
      false,
      "make 1 lineup change",
    ]);
  });

  it("filling an empty seat with a Questionable player (p10 = 0) is still a move", () => {
    const q = player("RB", 9, {
      slot: "BN",
      p_active: 0.71,
      points: { ...dist(9, 8), p10: 0, p25: 0, p_zero: 0.29 },
    });
    const r = analyzeLineup({
      slots: slotsOf([
        { name: "RB", count: 1 },
        { name: "BN", count: 4 },
      ]),
      players: [q],
      opponent: null,
      clock,
    });
    expect(r.rec.delta_vs_next.p10).toBeGreaterThanOrEqual(0);
    expect(r.rec.no_move).toBe(false);
  });

  it("property: a move's Δ interval never straddles 0; no move keeps the current starters", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pos: fc.constantFrom("QB", "WR", "RB", "TE"),
            mean: fc.integer({ min: 1, max: 30 }),
            w: fc.double({ min: 0.05, max: 0.9, noNaN: true }),
            start: fc.boolean(),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        (specs) => {
          const taken = new Map<string, number>();
          const cap: Record<string, number> = { QB: 1, WR: 2, RB: 2, TE: 1 };
          const players = specs.map((s) => {
            const ok = s.start && (taken.get(s.pos) ?? 0) < (cap[s.pos] ?? 0);
            if (ok) taken.set(s.pos, (taken.get(s.pos) ?? 0) + 1);
            return player(s.pos, s.mean, {
              slot: ok ? s.pos : "BN",
              points: dist(s.mean, s.mean * s.w),
            });
          });
          const r = analyzeLineup({ slots: LEAGUE_SLOTS, players, opponent: null, clock });
          if (!r.rec.no_move) expect(straddles(r.rec.delta_vs_next)).toBe(false);
          expect(r.no_move).toBe(r.rec.no_move);
          expect(recTextsFit(r.rec)).toBe(true);
          if (r.rec.no_move) {
            const cur = r.current_lineup
              .filter((a) => a.slot !== "BN" && a.slot !== "IR")
              .map((a) => a.player_key)
              .sort();
            const starts = r.rec.subjects
              .filter((s) => s.role === "start")
              .map((s) => s.player_key ?? "")
              .sort();
            expect(starts).toEqual(cur);
            expect(r.rec.subjects.some((s) => s.role === "sit")).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("QA-1-060 — E5: a stream whose Δ interval straddles 0 is a hold", () => {
  let data: FixtureData;
  let settings: ScoringSettings;
  let universe: KdefCandidateInput[];
  beforeAll(async () => {
    data = await loadFixtureData();
    settings = (await fixtureLeague()).settings;
    universe = kdefUniverse(data);
  });
  const run = (week: number, current: KdefCandidateInput[], positions: string[]) =>
    analyzeKdef({
      positions,
      season: 2026,
      week,
      look_ahead: 0,
      universe,
      current,
      availability_known: false,
      settings,
      readers: fixtureReaders(data),
      clock: fixedClock(beforeWeek(data, 3)),
      rng: seededRng(5),
    }).analysis;

  it("an ordinary current kicker: the best stream is a coin flip → hold, rec agrees", () => {
    const k = universe.find((u) => u.position === "K");
    if (k === undefined) throw new Error("no K");
    const a = run(3, [k], ["K"]);
    expect(straddles(a.rec.delta_vs_next) || a.rec.no_move).toBe(true);
    if (a.rec.no_move) {
      expect(a.rec.action).toBe("hold the current K");
      expect(a.rec.subjects).toEqual([
        expect.objectContaining({ player_key: k.player_key, role: "start" }),
      ]);
      expect(a.rec.latest_execution_time).toBeNull();
    }
  });

  it("every K and DEF starter: a stream is called only when its Δ interval excludes 0", () => {
    for (const cur of universe.filter((u) => u.nfl_team === "BUF" || u.nfl_team === "DET")) {
      const a = run(3, [cur], [cur.position]);
      expect(recTextsFit(a.rec)).toBe(true);
      if (!a.rec.no_move) expect(straddles(a.rec.delta_vs_next)).toBe(false);
    }
  });

  it("a current DEF on bye (0 points): streaming is decisive", () => {
    const playing = new Set(
      data.games.filter((g) => g.season === 2026 && g.week === 5).flatMap((g) => [g.home, g.away]),
    );
    const bye = universe.find((u) => u.position === "DEF" && !playing.has(u.nfl_team));
    if (bye === undefined) throw new Error("no week-5 bye");
    const a = run(5, [bye], ["DEF"]);
    expect(a.rec.no_move).toBe(false);
    expect(a.rec.subjects.map((s) => s.role)).toEqual(["stream", "drop"]);
    expect(a.rec.delta_vs_next.p10).toBeGreaterThan(0);
  });
});
