// retrospective.ts — joins logged calls to what happened and assembles the v1 retrospective (plan 07
// E13 + C12; research 05 §12.1–12.6; plan 10 §2.1 n-per-metric, A9; OBJ-05: no parameter proposals;
// OBJ-15: `recommended`/`best_alternative` are the model's own text, path-listed by the tool).
// Pure: the tool gathers the week's records, realised points, roster and forecasts and passes them in.

import type { NflTeam } from "../../config/schema.js";
import type { InputFreshness, Rec, RecSubject, SubjectRole } from "../analytics/types.js";
import { parseIso, type Clock } from "../clock.js";
import { POSITION_RE, type IsoInstant, type Week } from "../league/types.js";
import type { Dist } from "../scoring/types.js";
import {
  MAX_ABS_VALUE,
  accuracyGapSum,
  at,
  brierWithDecomposition,
  crpsFromDist,
  crpsFromSamples,
  intervalCoverage,
  meanPinball,
  spearman,
  stableMean,
  stableSum,
  type ProbabilityOutcome,
} from "./metrics.js";
import { isIsoInstant } from "./record.js";
import {
  DEFAULT_MIN_N,
  nTooSmall,
  type BrierMetric,
  type MetricName,
  type NByMetric,
  type PerPlayerMetrics,
  type RecommendationKind,
  type RecommendationListItem,
  type RecommendationOutcome,
  type RecommendationRecord,
  type Retrospective,
  type RetrospectiveCall,
  type SwapRegret,
} from "./types.js";

// --- inputs --------------------------------------------------------------------------------------

/** Who a realised/roster row is about: any id it shares with a RecSubject joins them. */
export interface SubjectIdentity {
  readonly player_key: string | null;
  readonly gsis_id: string | null;
  readonly nfl_team: NflTeam | null;
}

/** A subject's realised league-scored points for the week (null when not known yet). */
export interface SubjectPoints extends SubjectIdentity {
  readonly points: number | null;
}

/** One player on the user's roster for the scored week, and whether he was in a starting slot. */
export interface RosterPresence extends SubjectIdentity {
  /** In a starter or flex slot (RosterEntry.slot_class `starter`/`flex`). */
  readonly started: boolean;
}

/** The user's head-to-head result for the week (for `decisive`). */
export interface TeamResult {
  readonly my_points: number;
  readonly opponent_points: number;
}

/**
 * One scored player-week projection: the pre-lock forecast (ProjectionRepository.getAsOf — never a
 * post-kickoff run) and the realised points. `samples` are scored simulation points (`player_sim`);
 * without them CRPS comes from the Dist's quantiles.
 */
export interface PlayerForecast {
  /** POSITION_RE code; rows with anything else are excluded. */
  readonly position: string;
  readonly dist: Dist;
  readonly samples: readonly number[] | null;
  readonly outcome: number;
}

/** The probability forecasts to score, POOLED over whatever window the caller chose (season-to-date). */
export interface ProbabilityForecasts {
  readonly p_active: readonly ProbabilityOutcome[];
  readonly p_win: readonly ProbabilityOutcome[];
  readonly p_win_given_bid: readonly ProbabilityOutcome[];
  readonly p_role_holds: readonly ProbabilityOutcome[];
}

/** Everything the retrospective scores (plan 07 E13 data: recommendation_log, B2, A4, A5). */
export interface RetrospectiveInput {
  readonly week: Week;
  /** The week's stats are final (research 03 §D.2); outcomes scored on provisional stats are re-scored. */
  readonly final: boolean;
  /** The logged calls of the week (other weeks are skipped with a warning). */
  readonly records: readonly RecommendationRecord[];
  /** Kinds to score; null = all. */
  readonly kinds: readonly RecommendationKind[] | null;
  readonly realised: readonly SubjectPoints[];
  /** The user's roster for the week; null when unknown (then `followed_hint` decides). */
  readonly roster: readonly RosterPresence[] | null;
  readonly team_result: TeamResult | null;
  readonly player_forecasts: readonly PlayerForecast[];
  readonly probabilities: ProbabilityForecasts;
  /** E13 `min_n` (1..10 000, default 30). */
  readonly min_n: number;
  /** Every contributing input with its freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
}

/** The assembled retrospective plus the outcome rows to persist and fixed-vocabulary warnings. */
export interface RetrospectiveResult {
  readonly retrospective: Retrospective;
  /** One per scored call, for RecommendationLogRepository.recordOutcome. */
  readonly outcomes: readonly RecommendationOutcome[];
  /** Envelope warnings (counts only; never third-party or model-authored text). */
  readonly warnings: readonly string[];
}

// --- joining a call to what happened ---------------------------------------------------------------

/** Roles whose realised points the recommended move gains. */
const GAIN_ROLES: ReadonlySet<SubjectRole> = new Set<SubjectRole>([
  "start",
  "add",
  "stream",
  "trade_in",
]);
/** Kinds whose realised points land in this week's matchup (so `decisive` is defined). */
const DECISIVE_KINDS: ReadonlySet<RecommendationKind> = new Set<RecommendationKind>([
  "lineup",
  "stream",
]);

/** An index from subject ids to values; an id seen twice with different values is ambiguous (null). */
export class SubjectIndex<T> {
  private readonly byKey = new Map<string, T | null>();
  private readonly byGsis = new Map<string, T | null>();
  private readonly byTeam = new Map<string, T | null>();

  constructor(rows: readonly (SubjectIdentity & { readonly value: T })[]) {
    const put = (m: Map<string, T | null>, k: string | null, v: T): void => {
      if (k === null) return;
      m.set(k, m.has(k) && m.get(k) !== v ? null : v);
    };
    for (const r of rows) {
      put(this.byKey, r.player_key, r.value);
      put(this.byGsis, r.gsis_id, r.value);
      put(this.byTeam, r.nfl_team, r.value);
    }
  }

  /** The value for a subject (player_key, then gsis_id, then nfl_team); undefined when absent. */
  get(s: SubjectIdentity): T | null | undefined {
    if (s.player_key !== null && this.byKey.has(s.player_key)) return this.byKey.get(s.player_key);
    if (s.gsis_id !== null && this.byGsis.has(s.gsis_id)) return this.byGsis.get(s.gsis_id);
    if (s.nfl_team !== null && this.byTeam.has(s.nfl_team)) return this.byTeam.get(s.nfl_team);
    return undefined;
  }
}

/** Builds the realised-points index; non-finite or out-of-range points read as unknown (null). */
export function pointsIndex(rows: readonly SubjectPoints[]): SubjectIndex<number | null> {
  return new SubjectIndex(
    rows.map((r) => ({
      player_key: r.player_key,
      gsis_id: r.gsis_id,
      nfl_team: r.nfl_team,
      value:
        typeof r.points === "number" &&
        Number.isFinite(r.points) &&
        Math.abs(r.points) <= MAX_ABS_VALUE
          ? r.points
          : null,
    })),
  );
}

/**
 * Realised points of a move: Σ points of its gain subjects (start/add/stream/trade_in) − Σ points of
 * its trade_out subjects; sit/drop subjects gain nothing. Null when the move has no gain or trade_out
 * subject (nothing to score) or any counted subject's points are unknown.
 */
export function realisedOf(
  subjects: readonly RecSubject[],
  points: SubjectIndex<number | null>,
): number | null {
  const terms: number[] = [];
  for (const s of subjects) {
    const gain = GAIN_ROLES.has(s.role);
    if (!gain && s.role !== "trade_out") continue;
    const p = points.get(s);
    if (p === undefined || p === null) return null;
    terms.push(gain ? p : -p);
  }
  return terms.length === 0 ? null : stableSum(terms);
}

/**
 * Whether the user followed a call, from the week's roster: every subject must hold — start →
 * rostered in a starting slot; sit → not started; add/stream/trade_in → rostered; drop/trade_out →
 * not rostered. With no roster (or no subjects) the model's `followed_hint` decides; `unknown` → null.
 */
export function followedOf(
  record: RecommendationRecord,
  roster: SubjectIndex<boolean> | null,
): boolean | null {
  const subjects = record.rec.subjects;
  if (roster === null || subjects.length === 0) {
    if (record.followed_hint === "user_said_yes") return true;
    if (record.followed_hint === "user_said_no") return false;
    return null;
  }
  return subjects.every((s) => {
    const started = roster.get(s);
    const present = started !== undefined;
    switch (s.role) {
      case "start":
        return started === true;
      case "sit":
        return started !== true;
      case "drop":
      case "trade_out":
        return !present;
      default:
        return present;
    }
  });
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** The scored view of one call, before it is split into the E13 row and the persisted outcome. */
export interface ScoredCall {
  readonly call: RetrospectiveCall;
  readonly swaps: readonly number[];
}

/**
 * Scores one call: `realised` of the recommendation; `regret` = realised(best alternative in
 * hindsight) − realised(recommended), signed (negative = the call beat every alternative), null when
 * no alternative is scorable; `decisive` = following the best alternative instead would have changed
 * the H2H result (win/tie/loss) — defined only for followed lineup/stream calls with a known result.
 * Swap regrets (lineup calls): the k-th start subject paired with the k-th sit subject, each
 * max(0, points(sit) − points(start)).
 */
export function scoreCall(
  record: RecommendationRecord,
  points: SubjectIndex<number | null>,
  roster: SubjectIndex<boolean> | null,
  team: TeamResult | null,
): ScoredCall {
  const realised = realisedOf(record.rec.subjects, points);
  let best: { action: string; value: number } | null = null;
  for (const alt of record.alternatives) {
    const v = realisedOf(alt.subjects, points);
    if (v !== null && (best === null || v > best.value)) best = { action: alt.action, value: v };
  }
  const regret = realised !== null && best !== null ? best.value - realised : null;
  const followed = followedOf(record, roster);
  let decisive: boolean | null = null;
  if (
    regret !== null &&
    followed === true &&
    team !== null &&
    Number.isFinite(team.my_points) &&
    Number.isFinite(team.opponent_points) &&
    DECISIVE_KINDS.has(record.kind)
  ) {
    const margin = team.my_points - team.opponent_points;
    decisive = sign(margin) !== sign(margin + regret);
  }
  const swaps: number[] = [];
  if (record.kind === "lineup") {
    const starts = record.rec.subjects.filter((s) => s.role === "start");
    const sits = record.rec.subjects.filter((s) => s.role === "sit");
    for (let k = 0; k < Math.min(starts.length, sits.length); k++) {
      const a = points.get(at(starts, k));
      const b = points.get(at(sits, k));
      if (typeof a === "number" && typeof b === "number") swaps.push(Math.max(0, b - a));
    }
  }
  return {
    call: {
      log_id: record.log_id,
      kind: record.kind,
      followed,
      regret,
      decisive,
      recommended: record.rec.action,
      best_alternative: best === null ? null : best.action,
      realised,
    },
    swaps,
  };
}

/** The persisted outcome row of a scored call (plan 07 E14 `followed` reads it; critic C-02b). */
export function outcomeOf(
  call: RetrospectiveCall,
  scoredAt: IsoInstant,
  weekFinal: boolean,
): RecommendationOutcome {
  return {
    log_id: call.log_id,
    followed: call.followed,
    realised: call.realised,
    regret: call.regret,
    decisive: call.decisive,
    scored_at: scoredAt,
    week_final: weekFinal,
  };
}

/** The E14 list item of a record (`followed` from its persisted outcome, null until scored). */
export function toListItem(
  record: RecommendationRecord,
  outcome: RecommendationOutcome | null,
): RecommendationListItem {
  return {
    log_id: record.log_id,
    kind: record.kind,
    season: record.season,
    week: record.week,
    recorded_at: record.recorded_at,
    action_summary: record.rec.action,
    followed: outcome === null ? null : outcome.followed,
  };
}

// --- metric blocks -------------------------------------------------------------------------------

function validForecast(f: PlayerForecast): boolean {
  const d = f.dist;
  const fin = (x: unknown): boolean =>
    typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= MAX_ABS_VALUE;
  return (
    typeof f.position === "string" &&
    POSITION_RE.test(f.position) &&
    fin(d.mean) &&
    fin(d.p10) &&
    fin(d.p25) &&
    fin(d.p50) &&
    fin(d.p75) &&
    fin(d.p90) &&
    d.p10 <= d.p25 &&
    d.p25 <= d.p50 &&
    d.p50 <= d.p75 &&
    d.p75 <= d.p90 &&
    fin(f.outcome) &&
    (f.samples === null || (f.samples.length > 0 && f.samples.every(fin)))
  );
}

/** Caveat line for a metric under its minimum n. */
export function caveat(metric: string, n: number, minN: number): string {
  return `${metric}: ${nTooSmall(n, minN)}`;
}

/**
 * Per-player projection metrics (research 05 §12.1–12.2). Every value is null while
 * n_player_weeks < min_n (05 §12.6: no conclusion under n); Spearman is per position and needs
 * min_n player-weeks of that position. `accuracy_gap` = mean over player-weeks of the within-position
 * rank-slot gap (metrics.accuracyGapSum).
 */
export function perPlayerMetrics(
  forecasts: readonly PlayerForecast[],
  minN: number,
): { metrics: PerPlayerMetrics; accuracy_gap: number | null; caveats: string[] } {
  const n = forecasts.length;
  const byPos = new Map<string, PlayerForecast[]>();
  for (const f of forecasts) {
    const list = byPos.get(f.position);
    if (list === undefined) byPos.set(f.position, [f]);
    else list.push(f);
  }
  const groups = [...byPos.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const caveats: string[] = [];
  const spearmanByPos: Record<string, number | null> = {};
  for (const [pos, list] of groups) {
    if (list.length >= minN)
      spearmanByPos[pos] = spearman(
        list.map((f) => f.dist.mean),
        list.map((f) => f.outcome),
      );
    else {
      spearmanByPos[pos] = null;
      caveats.push(caveat(`per_player.spearman_by_position.${pos}`, list.length, minN));
    }
  }
  if (n < minN) {
    return {
      metrics: {
        crps: null,
        pinball: { p10: null, p50: null, p90: null },
        coverage_80: null,
        spearman_by_position: spearmanByPos,
        n_player_weeks: n,
      },
      accuracy_gap: null,
      caveats,
    };
  }
  const ys = forecasts.map((f) => f.outcome);
  const crps = stableMean(
    forecasts.map((f) =>
      f.samples === null ? crpsFromDist(f.dist, f.outcome) : crpsFromSamples(f.samples, f.outcome),
    ),
  );
  const gap =
    stableSum(
      groups.map(([, list]) =>
        accuracyGapSum(
          list.map((f) => f.dist.mean),
          list.map((f) => f.outcome),
        ),
      ),
    ) / n;
  return {
    metrics: {
      crps,
      pinball: {
        p10: meanPinball(
          forecasts.map((f) => f.dist.p10),
          ys,
          0.1,
        ),
        p50: meanPinball(
          forecasts.map((f) => f.dist.p50),
          ys,
          0.5,
        ),
        p90: meanPinball(
          forecasts.map((f) => f.dist.p90),
          ys,
          0.9,
        ),
      },
      coverage_80: intervalCoverage(
        forecasts.map((f) => ({ lo: f.dist.p10, hi: f.dist.p90 })),
        ys,
      ),
      spearman_by_position: spearmanByPos,
      n_player_weeks: n,
    },
    accuracy_gap: gap,
    caveats,
  };
}

/** A Brier metric: the value (with decomposition) at n ≥ min_n, else "n too small (k of min_n)". */
export function brierMetric(pairs: readonly ProbabilityOutcome[], minN: number): BrierMetric {
  return pairs.length >= minN && pairs.length > 0
    ? brierWithDecomposition(pairs)
    : nTooSmall(pairs.length, minN);
}

/** Swap regret over the scored lineup calls; `per_call_mean` is null while n_swaps < min_n. */
export function swapRegretOf(scored: readonly ScoredCall[], minN: number): SwapRegret {
  const all = scored.flatMap((s) => s.swaps);
  const calls = scored.filter((s) => s.swaps.length > 0).length;
  const total = stableSum(all);
  return {
    total,
    per_call_mean: all.length >= minN && calls > 0 ? total / calls : null,
    n_swaps: all.length,
  };
}

function validPair(p: ProbabilityOutcome): boolean {
  return (
    typeof p.p === "number" &&
    Number.isFinite(p.p) &&
    p.p >= 0 &&
    p.p <= 1 &&
    typeof p.outcome === "boolean"
  );
}

// --- the retrospective's own Rec -------------------------------------------------------------------

/**
 * The retrospective's `rec` (plan 07 E13 `rec: Rec`): always a no-move — v1 reports and never tunes
 * (OBJ-05; parameter proposals are Phase 3). point_estimate = mean call regret; the distribution is the
 * empirical spread of the per-call regrets (linear-interpolated quantiles; `as_of` = the newest valid
 * input instant, else the clock; `basis` is `position_cv`
 * because DistBasis has no "empirical" value — needs_from_others).
 */
export function retroRec(
  calls: readonly RetrospectiveCall[],
  swap: SwapRegret,
  inputs: readonly InputFreshness[],
  clock: Clock,
): Rec {
  const regrets = calls.flatMap((c) => (c.regret === null ? [] : [c.regret])).sort((a, b) => a - b);
  const q = (tau: number): number => {
    if (regrets.length === 0) return 0;
    const h = (regrets.length - 1) * tau;
    const lo = Math.floor(h);
    const a = at(regrets, lo);
    const b = at(regrets, Math.min(lo + 1, regrets.length - 1));
    return a + (h - lo) * (b - a);
  };
  const mean = stableMean(regrets) ?? 0;
  const zero = regrets.filter((r) => r === 0).length;
  let asOf: IsoInstant | null = null;
  for (const i of inputs)
    if (isIsoInstant(i.as_of) && (asOf === null || parseIso(i.as_of) > parseIso(asOf)))
      asOf = i.as_of;
  return {
    action: "Keep the model unchanged: v1 retrospectives report calibration, they do not tune it",
    subjects: [],
    lineup: null,
    point_estimate: mean,
    distribution: {
      mean,
      p10: q(0.1),
      p25: q(0.25),
      p50: q(0.5),
      p75: q(0.75),
      p90: q(0.9),
      p_zero: regrets.length === 0 ? 0 : zero / regrets.length,
      basis: "position_cv",
    },
    delta_vs_next: { value: 0, p10: 0, p90: 0 },
    decision_metric: "regret",
    drivers: [
      { name: "mean call regret", contribution: mean },
      { name: "total swap regret", contribution: swap.total },
    ],
    assumptions: [
      {
        text: "One week is one draw; a metric under its minimum n supports no conclusion",
        revisit_trigger: "each metric reaching its min_n in n_by_metric",
      },
      {
        text: "The distribution is the empirical spread of this week's per-call regrets",
        revisit_trigger: "Phase 3 held-out seasons",
      },
    ],
    confidence: { role_games: regrets.length, inputs: inputs.slice(0, 25) },
    as_of: asOf ?? clock.nowIso(),
    latest_execution_time: null,
    no_move: true,
    log_id: null,
  };
}

// --- assembly --------------------------------------------------------------------------------------

/**
 * Call order: by `recorded_at` (the store's canonical `toISOString()` form, so string order is time
 * order), then by `log_id`.
 */
export function compareRecords(a: RecommendationRecord, b: RecommendationRecord): number {
  if (a.recorded_at !== b.recorded_at) return a.recorded_at < b.recorded_at ? -1 : 1;
  if (a.log_id === b.log_id) return 0;
  return a.log_id < b.log_id ? -1 : 1;
}

/** The n_by_metric rows, in the plan 10 §2.1 order. */
export const METRIC_ORDER: readonly MetricName[] = Object.freeze([
  "per_player",
  "swap_regret",
  "brier.p_active",
  "brier.p_win",
  "brier.p_win_given_bid",
  "brier.p_role_holds",
]);

/**
 * Scores a week (plan 07 E13): the calls with followed/regret/decisive/realised, per-player
 * projection metrics, swap regret, the Brier suite (each a value or "n too small (k of min_n)"),
 * n_by_metric, one caveat per metric under min_n, attribution null (Phase 3), and the outcome rows to
 * persist. Throws RangeError on an invalid week or min_n; bad rows are excluded and counted in
 * `warnings`, never fatal. The output has NO `parameter_changes_proposed` (OBJ-05).
 */
export function buildRetrospective(input: RetrospectiveInput, clock: Clock): RetrospectiveResult {
  const { week, min_n: minN } = input;
  if (!Number.isInteger(week) || week < 1 || week > 22)
    throw new RangeError("reclog: week must be an integer 1..22");
  if (!Number.isInteger(minN) || minN < 1 || minN > 10_000)
    throw new RangeError("reclog: min_n must be an integer 1..10000");
  const warnings: string[] = [];
  const kinds = input.kinds === null ? null : new Set(input.kinds);
  const records = input.records
    .filter((r) => kinds === null || kinds.has(r.kind))
    .slice()
    .sort(compareRecords);
  const thisWeek = records.filter((r) => r.week === week);
  if (thisWeek.length < records.length)
    warnings.push(
      `retrospective: ${String(records.length - thisWeek.length)} records from other weeks skipped`,
    );

  const points = pointsIndex(input.realised);
  const roster =
    input.roster === null
      ? null
      : new SubjectIndex(input.roster.map((r) => ({ ...r, value: r.started })));
  const scored = thisWeek.map((r) => scoreCall(r, points, roster, input.team_result));
  const calls = scored.map((s) => s.call);

  const forecasts = input.player_forecasts.filter(validForecast);
  if (forecasts.length < input.player_forecasts.length)
    warnings.push(
      `retrospective: ${String(input.player_forecasts.length - forecasts.length)} player forecasts excluded (invalid position, dist, samples or outcome)`,
    );
  const pp = perPlayerMetrics(forecasts, minN);
  const swap = swapRegretOf(scored, minN);

  const probs = input.probabilities;
  const clean = (name: string, pairs: readonly ProbabilityOutcome[]): ProbabilityOutcome[] => {
    const ok = pairs.filter(validPair);
    if (ok.length < pairs.length)
      warnings.push(
        `retrospective: ${String(pairs.length - ok.length)} ${name} forecasts excluded (invalid probability or outcome)`,
      );
    return ok;
  };
  const pActive = clean("p_active", probs.p_active);
  const pWin = clean("p_win", probs.p_win);
  const pBid = clean("p_win_given_bid", probs.p_win_given_bid);
  const pRole = clean("p_role_holds", probs.p_role_holds);

  const ns: Record<MetricName, number> = {
    per_player: pp.metrics.n_player_weeks,
    swap_regret: swap.n_swaps,
    "brier.p_active": pActive.length,
    "brier.p_win": pWin.length,
    "brier.p_win_given_bid": pBid.length,
    "brier.p_role_holds": pRole.length,
  };
  const nByMetric: NByMetric[] = METRIC_ORDER.map((metric) => ({
    metric,
    n: ns[metric],
    min_n: minN,
    reached: ns[metric] >= minN,
  }));
  const caveats = [
    ...nByMetric.filter((r) => !r.reached).map((r) => caveat(r.metric, r.n, minN)),
    ...pp.caveats,
  ];

  const retrospective: Retrospective = {
    week,
    final: input.final,
    calls,
    metrics: {
      per_player: pp.metrics,
      swap_regret: swap,
      brier: {
        p_active: brierMetric(pActive, minN),
        p_win: brierMetric(pWin, minN),
        p_win_given_bid: brierMetric(pBid, minN),
        p_role_holds: brierMetric(pRole, minN),
      },
      accuracy_gap: pp.accuracy_gap,
    },
    n_by_metric: nByMetric,
    attribution: null,
    sample_size_caveats: caveats,
    rec: retroRec(calls, swap, input.inputs, clock),
    inputs: input.inputs,
  };
  const scoredAt = clock.nowIso();
  return {
    retrospective,
    outcomes: calls.map((c) => outcomeOf(c, scoredAt, input.final)),
    warnings,
  };
}

/** E13's default `min_n` (re-exported for the tool). */
export { DEFAULT_MIN_N };
