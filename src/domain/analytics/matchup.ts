// matchup.ts — E3 `ff_analyze_matchup` mode `pre` (plan 07 E3 P0; research 05 §11.1): P(win) of my
// current lineup against the opponent's (his best-by-mean legal lineup), by the normal approximation
// or by Monte Carlo (each player drawn from his Dist through a Gaussian copula carrying the same-team
// correlation table; ties count half). No opponent roster → AnalyticsError `no_opponent` (NOT_FOUND +
// MANUAL_NO_OPPONENT_HINT — never a guess). Pure: clock and rng injected.
import type { Clock, Rng } from "../clock.js";
import { isLocked } from "../league/schedule.js";
import type { RosterSlots } from "../league/types.js";
import { at } from "../scoring/numeric.js";
import type { Dist } from "../scoring/types.js";
import { LIMITS, SIMS, Z90 } from "./constants.js";
import { AnalyticsError } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { type LineupPlayer, bestLineup } from "./lineup.js";
import { clamp, normalCdf, normalDraw, normalDist, round } from "./math.js";
import { diffSd, pairMoments, pWinInterval, pWinNormal, rho, type TotalMember } from "./totals.js";
import type {
  Assumption,
  InputFreshness,
  MatchupWinProb,
  Rec,
  RecSubject,
  WinProbMethod,
} from "./types.js";

/** An E3 `pre` request. */
export interface MatchupRequest {
  readonly slots: RosterSlots;
  /** My roster, in its current slots. */
  readonly players: readonly LineupPlayer[];
  /** The opponent's roster (their slots), or null when the league has none for the week. */
  readonly opponent: readonly LineupPlayer[] | null;
  readonly method?: WinProbMethod;
  readonly n_sims?: number;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly inputs?: readonly InputFreshness[];
  /** The platform's own numbers (Yahoo, 1b); null under the manual league. */
  readonly yahoo_cross_check?: MatchupWinProb["yahoo_cross_check"];
}

const member = (p: LineupPlayer): TotalMember => ({
  player_key: p.player_key,
  position: p.positions[0] ?? "",
  nfl_team: p.nfl_team,
  points: p.points,
});

/**
 * The inverse CDF of a Dist, piecewise linear through its knots (0 → a floor below p10, then
 * p10…p90, 1 → a cap above p90); the zero mass `p_zero` is honoured first.
 */
export function distQuantile(d: Dist, u: number): number {
  if (u < d.p_zero) return 0;
  const lo = Math.min(0, d.p10 - (d.p25 - d.p10));
  const hi = d.p90 + (d.p90 - d.p75) * 1.5;
  const knots: readonly (readonly [number, number])[] = [
    [0, Math.min(lo, d.p10)],
    [0.1, d.p10],
    [0.25, d.p25],
    [0.5, d.p50],
    [0.75, d.p75],
    [0.9, d.p90],
    [1, Math.max(hi, d.p90)],
  ];
  const x = clamp(u, 0, 1);
  // the first knot at or above x (the last knot is at u = 1, so one always exists)
  const i = Math.max(
    1,
    knots.findIndex(([k]) => x <= k),
  );
  const [u0, v0] = at(knots, i - 1);
  const [u1, v1] = at(knots, i);
  return v0 + ((x - u0) / (u1 - u0)) * (v1 - v0);
}

/** Lower-triangular Cholesky factor of a correlation matrix; a non-PD pivot falls back to 1e-9. */
export function cholesky(c: readonly (readonly number[])[]): number[][] {
  const n = c.length;
  const l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const li = at(l, i);
      const lj = at(l, j);
      let s = at(at(c, i), j);
      for (let k = 0; k < j; k++) s -= at(li, k) * at(lj, k);
      li[j] = i === j ? Math.sqrt(Math.max(s, 1e-9)) : s / at(lj, j);
    }
  }
  return l;
}

/** Monte Carlo P(win) (ties ½) over the Gaussian copula of both lineups. */
function pWinMc(
  me: readonly TotalMember[],
  opp: readonly TotalMember[],
  n: number,
  rng: Rng,
): number {
  const all = [...me, ...opp];
  const k = all.length;
  const corr = all.map((a) => all.map((b) => (a === b ? 1 : rho(a, b))));
  const l = cholesky(corr);
  const r = rng.fork("matchup:mc");
  let wins = 0;
  const eps = new Array<number>(k).fill(0);
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < k; i++) eps[i] = normalDraw(r);
    let m = 0;
    let o = 0;
    for (let i = 0; i < k; i++) {
      let z = 0;
      const row = at(l, i);
      for (let j = 0; j <= i; j++) z += at(row, j) * at(eps, j);
      const x = distQuantile(at(all, i).points, normalCdf(z));
      if (i < me.length) m += x;
      else o += x;
    }
    wins += m > o ? 1 : m === o ? 0.5 : 0;
  }
  return wins / n;
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/** E3 `pre`. Throws AnalyticsError `no_opponent` / `invalid_request`. */
export function analyzeMatchupPre(req: MatchupRequest): MatchupWinProb {
  if (req.opponent === null || req.opponent.length === 0) {
    throw new AnalyticsError("no_opponent", "no opponent roster for this week");
  }
  if (
    req.players.length === 0 ||
    req.players.length > LIMITS.maxLineupPlayers ||
    req.opponent.length > LIMITS.maxLineupPlayers
  ) {
    throw new AnalyticsError("invalid_request", "roster size out of range", ["players"]);
  }
  const method: WinProbMethod = req.method ?? "mc";
  const n = req.n_sims ?? SIMS.default;
  if (!Number.isInteger(n) || n < SIMS.min || n > SIMS.max) {
    throw new AnalyticsError("invalid_request", "n_sims out of range", ["n_sims"]);
  }
  const nowMs = req.clock.nowMs();
  const mine = req.players.filter((p) => {
    const s = req.slots.slots.find((x) => x.name === p.slot);
    return s !== undefined && (s.class === "starter" || s.class === "flex");
  });
  const theirs = bestLineup(req.slots, req.opponent, nowMs);
  const me = mine.map(member);
  const opp = theirs.map(member);
  const pm = pairMoments(me, opp);
  const pNormal = pWinNormal(pm);
  const pWin = method === "normal" ? pNormal : pWinMc(me, opp, n, req.rng);
  const iv = pWinInterval(pm, me.length + opp.length);
  // centre the model-error interval on the reported number
  const shift = pWin - pNormal;
  const interval: readonly [number, number] = [
    round(clamp(iv[0] + shift, 0, 1)),
    round(clamp(iv[1] + shift, 0, 1)),
  ];
  const sm = Math.sqrt(pm.v_m);
  const so = Math.sqrt(pm.v_o);
  const inputs = [...(req.inputs ?? [])];
  const basis =
    mine.length > 0 && mine.every((p) => p.points.basis === "player_sim")
      ? "player_sim"
      : "position_cv";
  const dMu = pm.mu_m - pm.mu_o;
  const sd = diffSd(pm);
  const subjects: RecSubject[] = mine.map((p) => ({
    player_key: p.player_key,
    gsis_id: p.gsis_id ?? null,
    nfl_team: p.positions.includes("DEF") ? p.nfl_team : null,
    role: "start",
    slot: p.slot,
  }));
  const rec: Rec = {
    action: "no lineup action: pre-week win probability of the current lineup",
    subjects,
    lineup: null,
    point_estimate: round(pm.mu_m),
    distribution: normalDist(pm.mu_m, sm, basis),
    delta_vs_next: {
      value: round(dMu),
      p10: round(dMu - Z90 * sd),
      p90: round(dMu + Z90 * sd),
    },
    decision_metric: "p_win",
    drivers: [{ name: "projected_margin", contribution: round(dMu) }],
    assumptions: [
      A(
        "the opponent starts his highest-projected legal lineup",
        "the opponent's set lineup differs",
      ),
      A(
        "player spreads from each Dist's p10–p90; same-team correlations from the research 05 §3.3 table",
        "basis player_sim carries per-player variance",
      ),
      A(
        "the interval reflects projection-mean error, not only sampling error",
        "the retrospective calibrates P(win)",
      ),
    ],
    confidence: {
      role_games: mine.length === 0 ? 0 : Math.min(...mine.map((p) => p.role_games ?? 0)),
      inputs,
    },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  };
  const actionable = mine
    .filter((p) => !isLocked(p.lock_at, nowMs))
    .map((p) => ({ slot: p.slot, lock_at: p.lock_at }))
    .sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  return {
    p_win: round(pWin),
    interval,
    mu_m: round(pm.mu_m),
    sigma_m: round(sm),
    mu_o: round(pm.mu_o),
    sigma_o: round(so),
    cov: round(pm.cov),
    method,
    live: null,
    yahoo_cross_check: req.yahoo_cross_check ?? null,
    actionable_slots: actionable,
    season: null,
    rec,
    inputs,
  };
}
