// matchup.test.ts — E3 `pre` (plan 07 E3; research 05 §11.1): normal vs Monte Carlo agreement, the
// NOT_FOUND no-opponent path (never a guess), actionable slots, determinism, the Dist inverse CDF
// and the Cholesky factor, and the correlation-aware totals.
import { describe, expect, it } from "vitest";
import {
  analyzeMatchupPre,
  cholesky,
  distQuantile,
  type MatchupRequest,
} from "../../../src/domain/analytics/matchup.js";
import {
  lineupCov,
  lineupMoments,
  pWinInterval,
  pWinNormal,
  rho,
} from "../../../src/domain/analytics/totals.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { MANUAL_NO_OPPONENT_HINT } from "../../../src/providers/platform.js";
import { dist, LEAGUE_SLOTS, NOW, PAST, player, SUN_1PM } from "./helpers.js";

const clock = fixedClock(NOW);
const mine = [
  player("QB", 22, { slot: "QB", nfl_team: "DET" }),
  player("WR", 15, { slot: "WR", nfl_team: "DET" }),
  player("RB", 13, { slot: "RB", lock_at: PAST }),
  player("TE", 9, { slot: "TE" }),
  player("K", 8, { slot: "BN" }),
];
const theirs = [
  player("QB", 18, { slot: "BN", nfl_team: "KC" }),
  player("WR", 14, { slot: "WR", nfl_team: "KC" }),
  player("RB", 12, { slot: "RB", nfl_team: "SF" }),
];
const req = (over: Partial<MatchupRequest> = {}): MatchupRequest => ({
  slots: LEAGUE_SLOTS,
  players: mine,
  opponent: theirs,
  clock,
  rng: seededRng(3),
  ...over,
});

describe("analyzeMatchupPre", () => {
  it("normal and mc agree within MC error; mc is deterministic for a seed", () => {
    const n = analyzeMatchupPre(req({ method: "normal" }));
    const m = analyzeMatchupPre(req({ method: "mc", n_sims: 20000 }));
    expect(Math.abs(n.p_win - m.p_win)).toBeLessThan(0.03);
    expect(analyzeMatchupPre(req())).toEqual(analyzeMatchupPre(req()));
    expect(m.method).toBe("mc");
    expect(n.mu_m).toBe(59);
    expect(n.mu_o).toBe(44); // the opponent's best lineup starts his bench QB
    expect(n.interval[0]).toBeLessThanOrEqual(n.p_win);
    expect(n.interval[1]).toBeGreaterThanOrEqual(n.p_win);
    expect(n.live).toBeNull();
    expect(n.season).toBeNull();
    expect(n.yahoo_cross_check).toBeNull();
    expect(n.rec.no_move).toBe(true);
    expect(n.rec.decision_metric).toBe("p_win");
    expect(n.rec.distribution.basis).toBe("position_cv");
  });

  it("actionable slots are my unlocked starters", () => {
    const r = analyzeMatchupPre(req({ method: "normal" }));
    expect(r.actionable_slots).toEqual([
      { slot: "QB", lock_at: SUN_1PM },
      { slot: "TE", lock_at: SUN_1PM },
      { slot: "WR", lock_at: SUN_1PM },
    ]);
  });

  it("no opponent → NOT_FOUND with the manual hint, never a guess", () => {
    for (const opponent of [null, []]) {
      expect(() => analyzeMatchupPre(req({ opponent }))).toThrow(
        expect.objectContaining({ code: "no_opponent", ffHint: MANUAL_NO_OPPONENT_HINT }),
      );
    }
  });

  it("refuses bad sizes", () => {
    expect(() => analyzeMatchupPre(req({ n_sims: 10 }))).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => analyzeMatchupPre(req({ n_sims: 1500.5 }))).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => analyzeMatchupPre(req({ players: [] }))).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    const huge = Array.from({ length: 61 }, (_, i) => player("WR", i));
    expect(() => analyzeMatchupPre(req({ opponent: huge }))).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
  });

  it("the yahoo cross-check passes through (1b)", () => {
    const cc = { win_probability: 0.6, team_projected_points: { me: 100, opp: 90 } };
    expect(
      analyzeMatchupPre(req({ method: "normal", yahoo_cross_check: cc })).yahoo_cross_check,
    ).toEqual(cc);
  });
});

describe("totals", () => {
  it("same-team QB–WR adds variance; cov across rosters counts shared teams", () => {
    const qb = player("QB", 20, { nfl_team: "DET", points: dist(20, 10) });
    const wr = player("WR", 15, { nfl_team: "DET", points: dist(15, 10) });
    const other = player("WR", 15, { nfl_team: "KC", points: dist(15, 10) });
    const m = (p: typeof qb) => ({
      player_key: p.player_key,
      position: p.positions[0] ?? "",
      nfl_team: p.nfl_team,
      points: p.points,
    });
    expect(rho(m(qb), m(wr))).toBe(0.31);
    expect(rho(m(wr), m(qb))).toBe(0.31);
    expect(rho(m(qb), m(other))).toBe(0);
    expect(rho(m(qb), m(qb))).toBe(1);
    expect(rho({ ...m(qb), nfl_team: null }, { ...m(wr), nfl_team: null })).toBe(0);
    const stacked = lineupMoments([m(qb), m(wr)]).v;
    const apart = lineupMoments([m(qb), m(other)]).v;
    expect(stacked).toBeGreaterThan(apart);
    expect(lineupCov([m(qb)], [m(wr)])).toBeGreaterThan(0);
    expect(lineupCov([m({ ...qb, points: dist(0, 0) })], [m(wr)])).toBe(0);
  });
  it("degenerate spreads give 1 / 0 / ½ and a point interval", () => {
    const at = (mu_m: number, mu_o: number) => ({ mu_m, mu_o, v_m: 0, v_o: 0, cov: 0 });
    expect(pWinNormal(at(2, 1))).toBe(1);
    expect(pWinNormal(at(1, 2))).toBe(0);
    expect(pWinNormal(at(1, 1))).toBe(0.5);
    expect(pWinInterval(at(1, 1), 4)).toEqual([0, 1]);
    expect(pWinInterval(at(1, 1), 0)).toEqual([0.5, 0.5]);
    const iv = pWinInterval({ mu_m: 100, mu_o: 90, v_m: 100, v_o: 100, cov: 0 }, 18);
    expect(iv[0]).toBeLessThan(iv[1]);
  });
});

describe("distQuantile / cholesky", () => {
  it("interpolates through the knots and honours the zero mass", () => {
    const d = { ...dist(10, 5), p_zero: 0.05 };
    expect(distQuantile(d, 0.01)).toBe(0);
    expect(distQuantile(d, 0.1)).toBe(5);
    expect(distQuantile(d, 0.5)).toBe(10);
    expect(distQuantile(d, 0.9)).toBe(15);
    expect(distQuantile(d, 1)).toBeGreaterThan(15);
    expect(distQuantile(d, 2)).toBeGreaterThan(15);
    expect(distQuantile({ ...d, p_zero: 0 }, 0)).toBeLessThanOrEqual(5);
    let prev = -Infinity;
    for (let u = 0.06; u <= 1; u += 0.01) {
      const x = distQuantile(d, u);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = x;
    }
  });
  it("factors a correlation matrix and survives a non-PD one", () => {
    const l = cholesky([
      [1, 0.5],
      [0.5, 1],
    ]);
    expect(l[0]?.[0]).toBe(1);
    expect(l[1]?.[0]).toBe(0.5);
    expect(l[1]?.[1]).toBeCloseTo(Math.sqrt(0.75), 12);
    const bad = cholesky([
      [1, 1],
      [1, 1],
    ]);
    expect(bad.flat().every(Number.isFinite)).toBe(true);
  });
});
