// lineup.test.ts — E2 (plan 07 E2/C11; plan 10 A7 (c)/(e)): the properties the brief names —
// lineups always legal, locked players never moved, with `mean` a strictly higher projection never
// sits behind a lower one in the same eligible slot set, deterministic, ΔP(win) never a bare number
// under position_cv, mode = sign(μ_m − μ_o) — plus pwin/blend, option value, conditionals, stacks,
// only_unlocked and the refusal paths.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AnalyticsError } from "../../../src/domain/analytics/errors.js";
import {
  analyzeLineup,
  bestLineup,
  type LineupPlayer,
  type LineupRequest,
} from "../../../src/domain/analytics/lineup.js";
import { fixedClock } from "../../../src/domain/clock.js";
import { canOccupy, slotByName } from "../../../src/domain/league/slots.js";
import type { NflTeam } from "../../../src/config/schema.js";
import {
  dist,
  LEAGUE_SLOTS,
  MON,
  NOW,
  PAST,
  player,
  SUN_1PM,
  SUN_425,
  THU,
  TUESDAY,
} from "./helpers.js";

const clock = fixedClock(NOW);
const START = new Set(["QB", "WR", "RB", "TE", "W/R/T", "K", "DEF"]);

interface Spec {
  pos: string;
  mean: number;
  w: number;
  lock: "past" | "future" | "none";
  team: NflTeam;
  out: boolean;
  wantStart: boolean;
}

const arbSpec: fc.Arbitrary<Spec> = fc.record({
  pos: fc.constantFrom("QB", "RB", "WR", "TE", "K", "DEF"),
  mean: fc.integer({ min: 0, max: 300 }).map((x) => x / 10),
  w: fc.integer({ min: 0, max: 150 }).map((x) => x / 10),
  lock: fc.constantFrom("past" as const, "future" as const, "none" as const),
  team: fc.constantFrom<NflTeam>("BUF", "DET", "KC"),
  out: fc.boolean(),
  wantStart: fc.boolean(),
});

/** A roster whose current slots are legal (greedy fill of wanted starters; O players to IR first). */
function build(specs: readonly Spec[], prefix = "1"): LineupPlayer[] {
  const free = new Map<string, number>(LEAGUE_SLOTS.slots.map((s) => [s.name, s.count]));
  return specs.map((s, i) => {
    const key = `manual.p.0${prefix}-${String(i).padStart(7, "0")}`;
    let slot = "BN";
    const status = s.out ? "O" : null;
    if (s.out && (free.get("IR") ?? 0) > 0) {
      slot = "IR";
    } else if (s.wantStart) {
      for (const sl of LEAGUE_SLOTS.slots) {
        if (!START.has(sl.name) || (free.get(sl.name) ?? 0) <= 0) continue;
        if (canOccupy(sl, { positions: [s.pos], status })) {
          slot = sl.name;
          break;
        }
      }
    }
    free.set(slot, (free.get(slot) ?? 0) - 1);
    return {
      player_key: key,
      name: `P${String(i)}`,
      positions: [s.pos],
      status,
      nfl_team: s.team,
      gsis_id: null,
      slot,
      lock_at: s.lock === "past" ? PAST : s.lock === "future" ? SUN_1PM : null,
      points: dist(s.mean, Math.min(s.w, s.mean + 5)),
      p_active: 1,
      role_games: 2,
    };
  });
}

const arbRoster = fc.array(arbSpec, { minLength: 4, maxLength: 18 }).map((s) => build(s));
const arbOpp = fc.array(arbSpec, { minLength: 4, maxLength: 16 }).map((s) => build(s, "2"));

const isLockedNow = (p: LineupPlayer): boolean => p.lock_at === PAST;

function assertLegal(req: LineupRequest, rec: ReturnType<typeof analyzeLineup>): void {
  const count = new Map<string, number>();
  const byKey = new Map(req.players.map((p) => [p.player_key, p]));
  expect(rec.recommended_lineup).toHaveLength(req.players.length);
  expect(new Set(rec.recommended_lineup.map((s) => s.player_key)).size).toBe(req.players.length);
  for (const s of rec.recommended_lineup) {
    const p = byKey.get(s.player_key);
    expect(p).toBeDefined();
    if (p === undefined) continue;
    count.set(s.slot, (count.get(s.slot) ?? 0) + 1);
    if (p.slot === "IR") expect(s.slot).toBe("IR");
    if (START.has(s.slot)) {
      const slot = slotByName(LEAGUE_SLOTS, s.slot);
      const lockedInPlace = isLockedNow(p) && p.slot === s.slot;
      expect(
        lockedInPlace ||
          (slot !== null && canOccupy(slot, { positions: p.positions, status: p.status })),
      ).toBe(true);
    }
  }
  for (const sl of LEAGUE_SLOTS.slots) {
    if (START.has(sl.name)) expect(count.get(sl.name) ?? 0).toBeLessThanOrEqual(sl.count);
  }
}

describe("analyzeLineup — properties", () => {
  it("recommended lineups are always legal and locked players never move (mean and pwin)", () => {
    fc.assert(
      fc.property(
        arbRoster,
        arbOpp,
        fc.constantFrom("mean" as const, "pwin" as const),
        (players, opp, objective) => {
          const req: LineupRequest = {
            slots: LEAGUE_SLOTS,
            players,
            opponent: opp,
            objective,
            clock,
          };
          const rec = analyzeLineup(req);
          assertLegal(req, rec);
          const after = new Map(rec.recommended_lineup.map((s) => [s.player_key, s.slot]));
          for (const p of players) {
            if (!isLockedNow(p)) continue;
            const now = after.get(p.player_key);
            if (START.has(p.slot)) expect(now).toBe(p.slot);
            else expect(START.has(now ?? "")).toBe(false);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("objective mean: a strictly higher projection never sits behind a lower one it could replace", () => {
    fc.assert(
      fc.property(arbRoster, (players) => {
        const rec = analyzeLineup({ slots: LEAGUE_SLOTS, players, opponent: null, clock });
        const at = new Map(rec.recommended_lineup.map((s) => [s.player_key, s.slot]));
        const movable = players.filter((p) => !isLockedNow(p) && p.slot !== "IR");
        for (const a of movable) {
          if (START.has(at.get(a.player_key) ?? "")) continue; // a sits
          for (const b of movable) {
            const slotName = at.get(b.player_key) ?? "";
            if (!START.has(slotName)) continue; // b starts
            const slot = slotByName(LEAGUE_SLOTS, slotName);
            if (slot === null || !canOccupy(slot, { positions: a.positions, status: a.status }))
              continue;
            expect(a.points.mean).toBeLessThanOrEqual(b.points.mean + 1e-5);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic, and ΔP(win) is never a bare number under position_cv", () => {
    fc.assert(
      fc.property(arbRoster, arbOpp, (players, opp) => {
        const req: LineupRequest = {
          slots: LEAGUE_SLOTS,
          players,
          opponent: opp,
          objective: "pwin",
          clock,
        };
        const a = analyzeLineup(req);
        const b = analyzeLineup(req);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        expect(a.dist_basis).toBe("position_cv");
        for (const s of a.swaps) {
          expect(typeof s.delta_pwin).toBe("object");
          expect(Object.keys(s.delta_pwin).sort()).toEqual(["band", "sign"]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("mode follows the sign of μ_m − μ_o of the mode basis (A7 (c))", () => {
    fc.assert(
      fc.property(arbRoster, arbOpp, (players, opp) => {
        const rec = analyzeLineup({
          slots: LEAGUE_SLOTS,
          players,
          opponent: opp,
          objective: "pwin",
          clock,
        });
        const d = rec.mode_basis.mu_m - rec.mode_basis.mu_o;
        if (rec.mode === "protect") expect(d).toBeGreaterThan(0);
        if (rec.mode === "chase") expect(d).toBeLessThan(0);
        if (rec.mode === "neutral") {
          const s = Math.sqrt(rec.mode_basis.sigma_m ** 2 + rec.mode_basis.sigma_o ** 2);
          expect(Math.abs(d)).toBeLessThanOrEqual(0.1 * s * 2 + 1e-3);
        }
        if (rec.p_win_after !== null && rec.p_win_before !== null) {
          expect(rec.p_win_after).toBeGreaterThanOrEqual(0);
          expect(rec.p_win_after).toBeLessThanOrEqual(1);
          const [lo, hi] = rec.p_win_interval ?? [0, 1];
          expect(lo).toBeLessThanOrEqual(hi);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe("analyzeLineup — objectives", () => {
  const core = (): LineupPlayer[] => [
    player("QB", 20, { slot: "QB" }),
    player("RB", 12, { slot: "RB" }),
    player("RB", 11, { slot: "RB" }),
    player("WR", 13, { slot: "WR" }),
    player("WR", 12, { slot: "WR" }),
    player("TE", 8, { slot: "TE" }),
    player("K", 8, { slot: "K" }),
    player("DEF", 7, { slot: "DEF" }),
  ];
  const flexOptions = (): LineupPlayer[] => [
    player("WR", 10, { slot: "W/R/T", points: dist(10, 1) }), // steady
    player("WR", 9.8, { slot: "BN", points: dist(9.8, 14) }), // boom/bust
  ];
  const opponentOf = (mean: number): LineupPlayer[] => [
    player("QB", mean, { slot: "QB", nfl_team: "KC", points: dist(mean, 1) }),
  ];

  it("pwin prefers variance when chasing and the mean lineup when protecting", () => {
    const mine = [...core(), ...flexOptions()];
    const steady = mine[8]?.player_key;
    const boom = mine[9]?.player_key;
    const chase = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: mine,
      opponent: opponentOf(140),
      objective: "pwin",
      clock,
    });
    expect(chase.mode).toBe("chase");
    expect(chase.recommended_lineup.find((s) => s.player_key === boom)?.slot).toBe("W/R/T");
    const protect = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: mine,
      opponent: opponentOf(60),
      objective: "pwin",
      clock,
    });
    expect(protect.mode).toBe("protect");
    expect(protect.recommended_lineup.find((s) => s.player_key === steady)?.slot).toBe("W/R/T");
    expect(protect.no_move).toBe(true);
    expect(chase.p_win_after ?? 0).toBeGreaterThanOrEqual(chase.p_win_before ?? 1);
    expect(chase.rec.decision_metric).toBe("p_win");
    // mean ignores the variance: the steady player keeps the flex
    const mean = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: mine,
      opponent: opponentOf(140),
      clock,
    });
    expect(mean.objective_used).toBe("mean");
    expect(mean.no_move).toBe(true);
    expect(mean.rec.decision_metric).toBe("expected_points");
  });

  it("blend interpolates between the two (weight 0 = mean, 1 = pwin)", () => {
    const mine = [...core(), ...flexOptions()];
    const boom = mine[9]?.player_key;
    const at = (w: number): string | undefined =>
      analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: opponentOf(140),
        objective: "blend",
        blend_weight: w,
        clock,
      }).recommended_lineup.find((s) => s.player_key === boom)?.slot;
    expect(at(0)).toBe("BN");
    expect(at(1)).toBe("W/R/T");
    expect(
      analyzeLineup({
        slots: LEAGUE_SLOTS,
        players: mine,
        opponent: opponentOf(140),
        objective: "blend",
        clock,
      }).rec.decision_metric,
    ).toBe("blend");
  });

  it("no opponent: mean works (P(win) null, neutral), pwin/blend refuse with NOT_FOUND", () => {
    const mine = [...core(), ...flexOptions()];
    const rec = analyzeLineup({ slots: LEAGUE_SLOTS, players: mine, opponent: null, clock });
    expect(rec.p_win_before).toBeNull();
    expect(rec.p_win_interval).toBeNull();
    expect(rec.mode).toBe("neutral");
    expect(rec.mode_basis.mu_o).toBe(0);
    for (const objective of ["pwin", "blend"] as const) {
      expect(() =>
        analyzeLineup({ slots: LEAGUE_SLOTS, players: mine, opponent: [], objective, clock }),
      ).toThrow(expect.objectContaining({ code: "no_opponent", ffCode: "NOT_FOUND" }));
    }
  });

  it("refuses an empty, duplicated or oversized roster and a bad blend weight", () => {
    const p = player("QB", 10);
    const bad =
      (over: Partial<LineupRequest>): (() => unknown) =>
      () =>
        analyzeLineup({ slots: LEAGUE_SLOTS, players: [p], opponent: null, clock, ...over });
    expect(bad({ players: [] })).toThrow(AnalyticsError);
    expect(bad({ players: [p, p] })).toThrow(AnalyticsError);
    expect(bad({ players: Array.from({ length: 61 }, (_, i) => player("WR", i)) })).toThrow(
      AnalyticsError,
    );
    expect(bad({ blend_weight: 1.5 })).toThrow(AnalyticsError);
    expect(bad({ blend_weight: Number.NaN })).toThrow(AnalyticsError);
  });

  it("player_sim Dists report ΔP(win) as a number", () => {
    const mine = [
      player("QB", 20, { slot: "BN", points: dist(20, 8, "player_sim") }),
      player("QB", 10, { slot: "QB", points: dist(10, 8, "player_sim") }),
    ];
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: mine,
      opponent: opponentOf(20),
      clock,
    });
    expect(rec.dist_basis).toBe("player_sim");
    expect(rec.swaps).toHaveLength(1);
    expect(typeof rec.swaps[0]?.delta_pwin).toBe("number");
  });
});

describe("analyzeLineup — swaps, conditionals, option value, stacks", () => {
  it("a better bench player produces one swap with the coarse ΔP(win), interval and Rec", () => {
    const qbBench = player("QB", 25, { slot: "BN", lock_at: SUN_425 });
    const qbStart = player("QB", 12, { slot: "QB" });
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qbStart, qbBench],
      opponent: null,
      clock,
    });
    expect(rec.swaps).toHaveLength(1);
    expect(rec.swaps[0]).toMatchObject({
      out: qbStart.player_key,
      in: qbBench.player_key,
      slot: "QB",
      delta_e: 13,
    });
    expect(rec.dist_basis === "position_cv" && rec.swaps[0]?.delta_pwin.sign).toBe("+");
    const s = rec.swaps[0];
    expect(s?.interval[0]).toBeLessThan(s?.interval[1] ?? 0);
    expect(rec.no_move).toBe(false);
    expect(rec.rec.action).toBe("make 1 lineup change");
    expect(rec.rec.lineup).toEqual([{ slot: "QB", player_key: qbBench.player_key }]);
    expect(rec.rec.subjects.map((x) => x.role).sort()).toEqual(["sit", "start"]);
    expect(rec.rec.latest_execution_time).toBe(SUN_1PM);
    expect(rec.latest_execution_time).toBe(SUN_1PM);
    expect(rec.lock_schedule.map((e) => e.lock_at)).toEqual([SUN_1PM, SUN_425]);
    expect(rec.rec.delta_vs_next.value).toBe(13);
    expect(rec.rec.drivers).toEqual([{ name: `swap:QB:${qbBench.player_key}`, contribution: 13 }]);
  });

  it("compare pairs are evaluated (≤ 5, unknown or identical keys ignored)", () => {
    const a = player("WR", 10, { slot: "WR" });
    const b = player("WR", 9, { slot: "BN" });
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [a, b],
      opponent: null,
      compare: [
        { out: a.player_key, in: b.player_key },
        { out: a.player_key, in: "manual.p.00-9999999" },
        { out: a.player_key, in: a.player_key },
      ],
      clock,
    });
    expect(rec.no_move).toBe(true);
    expect(rec.swaps).toHaveLength(1);
    expect(rec.swaps[0]?.delta_e).toBe(-1);
    expect(rec.swaps[0]?.coin_flip).toBe(true);
    expect(rec.rec.action).toBe("keep the current lineup");
    expect(rec.rec.latest_execution_time).toBeNull();
  });

  it("exclude keeps a player out; force_start puts one in", () => {
    const a = player("WR", 20, { slot: "WR" });
    const b = player("WR", 5, { slot: "BN" });
    const ex = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [a, b],
      opponent: null,
      exclude: [a.player_key],
      clock,
    });
    expect(ex.recommended_lineup.find((s) => s.player_key === a.player_key)?.slot).toBe("BN");
    const c = player("WR", 30, { slot: "BN" });
    const d = player("WR", 25, { slot: "BN" });
    const e = player("WR", 22, { slot: "BN" });
    const fs = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [a, b, c, d, e],
      opponent: null,
      force_start: [b.player_key],
      clock,
    });
    expect(fs.recommended_lineup.find((s) => s.player_key === b.player_key)?.slot).not.toBe("BN");
  });

  it("if a questionable starter is ruled out, start the best later-locking reserve", () => {
    const q = player("QB", 15, { slot: "QB", p_active: 0.71, lock_at: SUN_425 });
    const alt = player("QB", 8, { slot: "BN", lock_at: SUN_425 });
    const early = player("QB", 9, { slot: "BN", lock_at: SUN_1PM }); // locked before the inactives
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [q, alt, early],
      opponent: null,
      clock,
    });
    expect(rec.conditionals).toEqual([
      {
        if: { player_key: q.player_key, event: "inactive", decided_by: "2026-09-27T18:55:00.000Z" },
        then: { slot: "QB", in: alt.player_key },
      },
    ]);
    // once the inactives are out there is nothing left to condition on
    const late = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [q, alt],
      opponent: null,
      clock: fixedClock("2026-09-27T19:00:00Z"),
    });
    expect(late.conditionals).toEqual([]);
  });

  it("Thursday and Monday option value (research 05 §3.4)", () => {
    const tue = fixedClock(TUESDAY);
    const thu = player("QB", 12, { slot: "BN", lock_at: THU });
    const sun = player("QB", 11, { slot: "QB", lock_at: SUN_1PM, p_active: 0.71 });
    const reserve = player("QB", 9, { slot: "BN", lock_at: SUN_425 });
    const a = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [thu, sun, reserve],
      opponent: null,
      clock: tue,
    });
    const s = a.swaps.find((x) => x.in === thu.player_key);
    expect(s?.option_value?.kind).toBe("thursday");
    expect(s?.option_value?.value).toBeCloseTo(0.29 * 9, 3);
    expect(s?.option_value?.verdict.startsWith("hold")).toBe(true);
    const mon = player("K", 12, { slot: "BN", lock_at: MON });
    const sunTe = player("K", 8, { slot: "K", lock_at: SUN_1PM });
    const b = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [mon, sunTe],
      opponent: null,
      clock: tue,
    });
    expect(b.swaps[0]?.option_value?.kind).toBe("monday");
    expect(b.swaps[0]?.option_value?.verdict.startsWith("commit")).toBe(true);
    // same kickoff → no option value; a certain later player on a Sunday → none either
    const x = player("K", 9, { slot: "BN", lock_at: SUN_1PM });
    const y = player("K", 7, { slot: "K", lock_at: SUN_1PM });
    expect(
      analyzeLineup({ slots: LEAGUE_SLOTS, players: [x, y], opponent: null, clock: tue }).swaps[0]
        ?.option_value,
    ).toBeNull();
    const x2 = player("K", 9, { slot: "BN", lock_at: SUN_1PM });
    const y2 = player("K", 7, { slot: "K", lock_at: SUN_425 });
    expect(
      analyzeLineup({ slots: LEAGUE_SLOTS, players: [x2, y2], opponent: null, clock: tue }).swaps[0]
        ?.option_value,
    ).toBeNull();
    const x3 = player("K", 9, { slot: "BN", lock_at: SUN_1PM, p_active: 1 });
    const y3 = player("K", 7, { slot: "K", lock_at: SUN_425, p_active: 0.5 });
    expect(
      analyzeLineup({ slots: LEAGUE_SLOTS, players: [x3, y3], opponent: null, clock: tue }).swaps[0]
        ?.option_value?.kind,
    ).toBe("late_game");
  });

  it("a QB–WR stack is flagged ceiling+ (floor- when protecting)", () => {
    const qb = player("QB", 20, { slot: "QB", nfl_team: "DET" });
    const wr = player("WR", 15, { slot: "WR", nfl_team: "DET" });
    const rb = player("RB", 15, { slot: "RB", nfl_team: "DET" });
    const k = player("K", 8, { slot: "K", nfl_team: "KC" });
    const neutral = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, wr, rb, k],
      opponent: null,
      clock,
    });
    expect(neutral.stack_flags).toEqual([
      { players: [qb.player_key, rb.player_key, wr.player_key].sort(), effect: "ceiling+" },
    ]);
    const weak = [player("QB", 5, { slot: "QB", nfl_team: "KC" })];
    const prot = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [qb, wr, rb, k],
      opponent: weak,
      clock,
    });
    expect(prot.mode).toBe("protect");
    expect(prot.stack_flags[0]?.effect).toBe("floor-");
    expect(prot.mode_basis.rho_lineup).toBe(0);
  });

  it("only_unlocked lists only the slots still actionable; locks are always honoured", () => {
    const locked = player("QB", 5, { slot: "QB", lock_at: PAST });
    const better = player("QB", 25, { slot: "BN" });
    const view = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [locked, better],
      opponent: null,
      only_unlocked: true,
      clock,
    });
    expect(view.current_lineup.map((s) => s.player_key)).toEqual([better.player_key]);
    expect(view.no_move).toBe(true);
    const full = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [locked, better],
      opponent: null,
      clock,
    });
    expect(full.current_lineup).toHaveLength(2);
    expect(full.recommended_lineup.find((s) => s.player_key === locked.player_key)?.slot).toBe(
      "QB",
    );
  });

  it("bestLineup fills every slot it can and keeps IR", () => {
    const ir = player("WR", 30, { slot: "IR", status: "O" });
    const wr = player("WR", 3, { slot: "BN" });
    const starters = bestLineup(LEAGUE_SLOTS, [ir, wr], NOW);
    expect(starters.map((p) => p.player_key)).toEqual([wr.player_key]);
  });
});
