// constants.ts — every tuning constant of the P0 analytics in ONE place (plan 07 E1/E2/E3/E5;
// research 05 §1 steps 1/4/8/9, §3.2–§3.5, §8, §11.1). Values marked [U] are unverified starting
// points to be tuned against the retrospective (research 05 §1 Evaluation); nothing here is inline.
import type { Canonical } from "../scoring/types.js";

/** The projection model this module implements (plan 07 E1). */
export const MODEL_VERSION = "v1-trailing" as const;

/** Positions the v1 projection knows (nflverse position → league position). */
export const PROJECTABLE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;
/** A projectable position. */
export type ProjectablePosition = (typeof PROJECTABLE_POSITIONS)[number];

/** Trailing-window construction (research 05 §1 step 2: exponentially weighted, h ≈ 3 games). */
export const WINDOW = Object.freeze({
  /** Most games kept in the trailing window. */
  maxGames: 8,
  /** Half-life of the exponential weights, in games. */
  halfLifeGames: 3,
  /** Weight multiplier for a game of the previous season (role and team may have changed) [U]. */
  priorSeasonWeight: 0.5,
  /** Last regular-season week read from the previous season. */
  priorSeasonLastWeek: 18,
});

/**
 * Per-game positional priors (research 05 §1 step 4: shrink toward the positional mean) — a
 * fantasy-relevant starter at the position, per game played [U]. Stats a position never records are
 * absent (prior 0 when a player's own window has them).
 */
export const PRIOR_LINES: Readonly<
  Record<ProjectablePosition, Readonly<Record<Canonical, number>>>
> = Object.freeze({
  QB: Object.freeze({
    pass_yd: 225,
    pass_td: 1.45,
    pass_int: 0.8,
    pass_1d: 11,
    rush_att: 3.8,
    rush_yd: 17,
    rush_td: 0.15,
    rush_1d: 1.2,
    fum: 0.35,
    fum_lost: 0.2,
    two_pt: 0.05,
  }),
  RB: Object.freeze({
    rush_att: 13,
    rush_yd: 55,
    rush_td: 0.38,
    rush_1d: 3,
    targets: 3.3,
    rec: 2.6,
    rec_yd: 20,
    rec_td: 0.1,
    rec_1d: 1,
    fum: 0.12,
    fum_lost: 0.07,
    two_pt: 0.02,
  }),
  WR: Object.freeze({
    targets: 6.8,
    rec: 4.4,
    rec_yd: 55,
    rec_td: 0.33,
    rec_1d: 2.6,
    rush_att: 0.3,
    rush_yd: 2,
    rush_td: 0.01,
    fum: 0.06,
    fum_lost: 0.04,
    two_pt: 0.02,
  }),
  TE: Object.freeze({
    targets: 5,
    rec: 3.5,
    rec_yd: 38,
    rec_td: 0.27,
    rec_1d: 1.9,
    fum: 0.05,
    fum_lost: 0.03,
    two_pt: 0.02,
  }),
  K: Object.freeze({
    fg_0_19: 0.02,
    fg_20_29: 0.45,
    fg_30_39: 0.5,
    fg_40_49: 0.5,
    fg_50p: 0.3,
    fg_miss_0_19: 0,
    fg_miss_20_29: 0.02,
    fg_miss_30_39: 0.05,
    fg_miss_40_49: 0.12,
    fg_miss_50p: 0.15,
    pat_made: 2.3,
    pat_miss: 0.1,
  }),
  DEF: Object.freeze({
    dst_sack: 2.4,
    dst_int: 0.75,
    dst_fum_rec: 0.55,
    dst_td: 0.12,
    dst_ret_td: 0.05,
    dst_safety: 0.03,
    dst_blk: 0.07,
    dst_pa: 22,
    dst_ya: 330,
  }),
});

/**
 * Shrinkage strength `k` (games-equivalent) per canonical (research 05 §1 step 4: volume is sticky,
 * TD rate is noise — R² 0.008 — and misses/turnovers carry little forward value; rare DST events are
 * a constant, research 05 §8.2) [U].
 */
export const SHRINK_K = Object.freeze({
  volume: 2,
  touchdown: 5,
  turnover: 6,
  miss: 8,
  defense_rate: 4,
  defense_rare: 50,
  points_allowed: 3,
  default: 3,
});

const TD_STATS = new Set([
  "pass_td",
  "rush_td",
  "rec_td",
  "two_pt",
  "ret_td_off",
  "off_fum_ret_td",
]);
const TURNOVER_STATS = new Set(["pass_int", "fum", "fum_lost"]);
const DEF_RATE_STATS = new Set(["dst_sack", "dst_int", "dst_fum_rec"]);
const DEF_RARE_STATS = new Set(["dst_td", "dst_ret_td", "dst_safety", "dst_blk", "dst_xpr"]);

/** The shrinkage `k` for one canonical stat. */
export function shrinkKFor(canonical: Canonical): number {
  if (TD_STATS.has(canonical)) return SHRINK_K.touchdown;
  if (TURNOVER_STATS.has(canonical)) return SHRINK_K.turnover;
  if (canonical === "pat_miss" || canonical.startsWith("fg_miss")) return SHRINK_K.miss;
  if (DEF_RATE_STATS.has(canonical)) return SHRINK_K.defense_rate;
  if (DEF_RARE_STATS.has(canonical)) return SHRINK_K.defense_rare;
  if (canonical === "dst_pa" || canonical === "dst_ya") return SHRINK_K.points_allowed;
  return SHRINK_K.volume;
}

/** Whether the implied-total multiplier scales a stat (volume and scoring; never turnovers/misses). */
export function isMarketScaled(canonical: Canonical): boolean {
  if (TURNOVER_STATS.has(canonical)) return false;
  if (canonical === "pat_miss" || canonical.startsWith("fg_miss")) return false;
  return !canonical.startsWith("dst_");
}

/**
 * Market scaling (research 05 §1 step 1: implied totals correlate strongly with QB scoring,
 * moderately with WR/TE, noisily with RB): multiplier = (implied / window-average implied)^β,
 * clamped [U].
 */
const MARKET_BETA: Readonly<Record<ProjectablePosition, number>> = Object.freeze({
  QB: 0.9,
  RB: 0.5,
  WR: 0.6,
  TE: 0.6,
  K: 0.8,
  DEF: 0,
});

export const MARKET = Object.freeze({
  beta: MARKET_BETA,
  minMultiplier: 0.75,
  maxMultiplier: 1.3,
  /** League-average implied team total when a window game has no line [U]. */
  leagueAverageImplied: 22.5,
});

/**
 * Position CVs of weekly fantasy points (research 05 §1 step 9, half-PPR 2015–2021 [V Underdog]:
 * QB 0.36–0.39, RB 0.54–0.63, WR 0.58–0.67, TE 0.63–0.70 — midpoints used). K has no cited figure
 * [U]. DEF is simulated per component (points allowed gamma, counts Poisson), not by one CV.
 */
export const POSITION_CV: Readonly<Record<Exclude<ProjectablePosition, "DEF">, number>> =
  Object.freeze({ QB: 0.375, RB: 0.585, WR: 0.625, TE: 0.665, K: 0.55 });

/** DEF simulation widths (research 05 §8.2: points allowed around the opponent's implied total) [U]. */
export const DEF_SIM = Object.freeze({
  pointsAllowedCv: 0.42,
  yardsAllowedCv: 0.2,
  /** Weight of the defence's own sack/takeaway rate vs the opponent's rate allowed. */
  ownRateWeight: 0.5,
});

/**
 * P(active) (research 05 §3.5: Questionable on the final report played 71 % of the time, 2017–2023
 * [V Footballguys]; Doubtful 5.9 % per the brief; the practice trend refines Questionable — the
 * per-trend values are [U] starting points).
 */
export const P_ACTIVE = Object.freeze({
  out: 0,
  doubtful: 0.059,
  questionable: 0.71,
  questionableByPractice: Object.freeze({ full: 0.9, limited: 0.72, dnp: 0.4 }),
  /** No designation on the final report, or not on the report: cleared to play. */
  noDesignation: 1,
});

/** Platform status codes that mean "will not play" (plan 07 D2: `O`/`IR`/`NA`/`SUSP` → 0). */
export const INACTIVE_STATUS_CODES: readonly string[] = Object.freeze([
  "O",
  "OUT",
  "IR",
  "NA",
  "SUSP",
  "PUP",
  "PUP-R",
  "NFI-R",
  "NFI-A",
]);

/**
 * nflverse `roster_weekly.status` codes that mean "will not play" from that week on (QA-1-030): RES
 * (reserve: injured reserve, PUP, NFI), CUT, RET (retired), SUS (suspended), UFA (unsigned). A player
 * on a reserve list never appears on the weekly injury report.
 */
export const ROSTER_OUT_STATUSES: readonly string[] = Object.freeze([
  "RES",
  "CUT",
  "RET",
  "SUS",
  "UFA",
]);
/** `roster_weekly.status` INA: a game-day inactive — only for that week's game. */
export const ROSTER_INACTIVE_THIS_WEEK = "INA";

/** Within this long before kickoff a provider-stamped status is game-day (plan 07 D2, OBJ-16). */
export const GAME_DAY_WINDOW_MS = 3 * 60 * 60 * 1000;

/** Inactives are published about 90 minutes before kickoff (plan 07 D2) — conditionals' `decided_by`. */
export const INACTIVES_LEAD_MS = 90 * 60 * 1000;

/**
 * Simulation sizes (plan 07 E1 `n_sims`: 1000..20000, default 4000). `stored`: the samples kept per
 * stored projection (plan 08 §5) — a prefix of the iid draws; the retrospective, the only reader,
 * scores at most 500 (`RETRO_SAMPLE_CAP`). Storing all n_sims made the never-pruned table grow by
 * megabytes per call and cost E1 a third of its A15 latency.
 */
export const SIMS = Object.freeze({
  min: 1000,
  max: 20000,
  default: 4000,
  /** = RETRO_SAMPLE_CAP (src/mcp/tools/reclog.ts), the only reader's cap (QA-1-031/081). */
  stored: 500,
  /**
   * The most lines one call simulates (QA-1-079): n_sims is shared down evenly over the call's
   * player-weeks past this (never below `min`), so the worst in-bounds request — 50 players × 6 weeks
   * × 20 000 — stays near A15's 128 000-line E1 case × 4 (≈ 2 s) instead of stalling the stdio loop
   * for ~17 s past the 10 s shutdown ceiling.
   */
  maxTotalLines: 512_000,
});

/**
 * The deterministic expectation behind every Dist `mean` (QA-1-024): equal-probability quadrature
 * nodes of the same gamma width the samples are drawn from. 128 nodes put a bonus/bracket threshold's
 * probability on a 1/128 grid; a linear score is reproduced exactly.
 */
export const EXPECTATION = Object.freeze({ nodes: 128 });

/**
 * Same-team weekly correlations (research 05 §3.3, 2022–2025 full-PPR [V RotoWire]): QB–WR +0.31,
 * QB–TE +0.27, QB–RB +0.07, WR–WR −0.02; every other pair 0 (game stacks are folk practice [F]).
 */
const SAME_TEAM_RHO: Readonly<Record<string, number>> = Object.freeze({
  "QB|WR": 0.31,
  "QB|TE": 0.27,
  "QB|RB": 0.07,
  "WR|WR": -0.02,
});

export const CORRELATION = Object.freeze({ sameTeam: SAME_TEAM_RHO });

/** z of the 90th percentile (p10/p90 = μ ∓ z·σ under the normal approximation). */
export const Z90 = 1.2815515655446004;

/** Lineup solver constants (research 05 §3.1/§3.2). */
export const LINEUP = Object.freeze({
  /** Added to every legal (player, starting slot) weight so filling slots dominates the mean. */
  fillBonus: 1e4,
  /** Tie-break: a player already in a slot keeps it when the values tie (no churn swaps). */
  stayBonus: 1e-6,
  /** Forced starters (`force_start`, locked starters) dominate the fill bonus. */
  forceBonus: 1e7,
  /** |μ_m − μ_o| below this share of σ(M − O) reads `neutral` (near even → maximise the mean). */
  neutralZ: 0.1,
  /** Variance weights λ searched for `pwin` (maximise Σ μ + λ Σ σ² over the mean-variance hull). */
  lambdaGrid: Object.freeze([0, 0.002, 0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.32]),
  /** Projection-mean error per started player (points, sd) behind the P(win) interval [U]. */
  muErrorSdPerPlayer: 1.5,
  /** Default blend weight on the pwin term for `objective: blend`. */
  blendWeight: 0.5,
});

const WIND_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  fg_40_49: 0.9,
  fg_50p: 0.75,
});

/** K/DEF streaming (research 05 §8) [U]. */
export const KDEF = Object.freeze({
  /** Look-ahead default for K/DEF (plan 07 E5: `look_ahead` default 2 for K/DEF). */
  lookAheadDefault: 2,
  lookAheadMax: 2,
  /** Outdoor wind at or above this reduces long-FG volume (research 05 §1 step 7, §8.1). */
  windMph: 15,
  windFactor: WIND_FACTOR,
  /** Hold the current starter unless the best candidate beats him by more than this (points). */
  holdMargin: 1,
  /** Candidates returned per position. */
  maxCandidatesPerPosition: 10,
  /** E5 samples for the decision week (a ranking needs means, not tails — A15 < 500 ms). */
  nSims: 400,
  /** E5 samples for each look-ahead week (only its mean is reported). */
  nSimsLookAhead: 150,
  /** The smallest E5 sample size accepted. */
  minSims: 100,
  /** E5 pass 1 (this week only) sample size that shortlists each position. */
  shortlistSims: 150,
  /** Candidates per position kept for pass 2 (≥ maxCandidatesPerPosition). */
  shortlistPerPosition: 12,
});

/** Roof values under which weather is irrelevant. */
export const INDOOR_ROOFS: readonly string[] = Object.freeze(["dome", "closed"]);

/** Request bounds the engines enforce themselves (the tools' zod schemas are stricter). */
export const LIMITS = Object.freeze({
  /** Players projected in one call (E1 selector ≤ 25 or pool top ≤ 50; rosters ≤ 60). */
  maxTargets: 64,
  /** Weeks projected in one call (a ROS horizon). */
  maxWeeks: 18,
  /** Players considered by one lineup solve (MAX_ROSTER_SIZE in src/domain/league/slots.ts). */
  maxLineupPlayers: 60,
  /** K/DEF candidates scored in one call (32 defences + a kicker per team, with spares). */
  maxKdefCandidates: 96,
});
