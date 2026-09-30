// kdef.ts — E5 `ff_analyze_waivers` for positions ⊆ {K, DEF} (plan 07 E5 P0, C5; research 05 §8):
// every candidate projected by E1 (kickers: implied team total, FG bins and wind; defences: the
// opponent's implied total through the league's own points-allowed brackets, sacks/takeaways from own
// and opponent rates, rare events as a constant), a 2-week look-ahead, hold-vs-stream against my
// current starter, and availability from the provider's FA pool — or "unknown" under the manual
// league, said plainly (plan 07 E5 manual block; changelog OBJ-29). Pure.
import type { Clock, Rng } from "../clock.js";
import type { NflTeam } from "../../config/schema.js";
import type { PlayerKey, Week } from "../league/types.js";
import type {
  Dist,
  PositionType,
  ProjectionSubject,
  ScoringEngine,
  ScoringSettings,
} from "../scoring/types.js";
import { KDEF, LIMITS, Z90 } from "./constants.js";
import { AnalyticsError } from "./errors.js";
import { type AnyStamp, newestAsOf } from "./inputs.js";
import { round, sigmaOf, zeroDist } from "./math.js";
import { at } from "../scoring/numeric.js";
import { cmpStr } from "./lineup.js";
import {
  bracketPoints,
  type ProjectedPlayer,
  type ProjectionReaders,
  type ProjectionTarget,
  projectForRanking,
  statOf,
} from "./projection.js";
import type {
  Assumption,
  Availability,
  KdefDetail,
  Rec,
  RecSubject,
  StreamingCandidate,
  WaiverAnalysis,
  WaiverSignal,
} from "./types.js";

/** A K/DEF position. */
export type KdefPosition = "K" | "DEF";

/** One member of the K/DEF universe (built by the tool: 32 defences + each team's kicker). */
export interface KdefCandidateInput {
  readonly player_key: PlayerKey;
  readonly subject: ProjectionSubject;
  /** Raw name (path-listed). */
  readonly name: string;
  readonly position: KdefPosition;
  readonly nfl_team: NflTeam;
  /** From the provider's FA pool; ignored (→ `unknown`) when `availability_known` is false. */
  readonly availability: Availability;
}

/** An E5 K/DEF request. */
export interface KdefRequest {
  /** Requested positions; anything outside {K, DEF} is refused (P0 — plan 07 E5). */
  readonly positions: readonly string[];
  readonly season: number;
  readonly week: Week;
  /** 0..2 weeks beyond `week` (plan 07 E5; K/DEF default 2). */
  readonly look_ahead?: number;
  readonly universe: readonly KdefCandidateInput[];
  /** My rostered K/DEF (the hold-vs-stream baseline); may be empty. */
  readonly current: readonly KdefCandidateInput[];
  /** Whether the provider has a platform FA pool (`read_features.free_agent_pool`). */
  readonly availability_known: boolean;
  readonly settings: ScoringSettings;
  readonly readers: ProjectionReaders;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly n_sims?: number;
  readonly engine?: ScoringEngine;
  readonly extra_stamps?: readonly AnyStamp[];
}

/** E5 output: the tool's `data` plus whether the manual-league availability warning applies. */
export interface KdefOutcome {
  readonly analysis: WaiverAnalysis;
  /** False → the tool adds the fixed "availability unknown" warning (plan 07 E5 manual block). */
  readonly availability_known: boolean;
}

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/** Fixed-vocabulary invalidators for a K/DEF call. */
const INVALIDATORS: readonly string[] = Object.freeze([
  "line_moves_before_kickoff",
  "weather_forecast_changes",
  "injury_news_for_the_offence",
]);

function modifierOf(settings: ScoringSettings, canonical: string, pt: PositionType): number {
  const r = settings.rules.find((x) => x.canonical === canonical && x.position_types.includes(pt));
  return r?.modifier ?? 0;
}

const round2OrNull = (x: number | null): number | null => (x === null ? null : round(x, 2));

function detail(settings: ScoringSettings, p: ProjectedPlayer, pos: KdefPosition): KdefDetail {
  const w = at(p.weeks, 0);
  const next = p.weeks[1];
  const pt: PositionType = pos === "K" ? "K" : "DT";
  const e = w.expectation;
  const pts = (c: string): number => statOf(e, c) * modifierOf(settings, c, pt);
  const isDef = pos === "DEF";
  return {
    implied_total: round2OrNull(w.implied_total),
    opp_implied_total: round2OrNull(w.opp_implied_total),
    brackets_e: w.samples === null ? null : round(bracketPoints(settings, pt, w.samples), 3),
    sacks_e: isDef ? round(pts("dst_sack"), 3) : null,
    takeaways_e: isDef ? round(pts("dst_int") + pts("dst_fum_rec"), 3) : null,
    rare_c: isDef
      ? round(pts("dst_td") + pts("dst_ret_td") + pts("dst_safety") + pts("dst_blk"), 3)
      : null,
    next_week:
      next === undefined
        ? null
        : {
            opponent: next.opponent,
            implied_total: round2OrNull(isDef ? next.opp_implied_total : next.implied_total),
            e: round(next.dist.mean, 3),
          },
  };
}

interface Scored {
  readonly cand: StreamingCandidate;
  readonly p: ProjectedPlayer;
  readonly cur: ProjectedPlayer | null;
  /** Gain over my current starter this week; null without one. */
  readonly delta: number | null;
}

const meanOf = (p: ProjectedPlayer, i: number): number => at(p.weeks, i).dist.mean;

/** A projected subject's key (E5 targets always carry one). */
const keyOf = (p: ProjectedPlayer): PlayerKey => p.target.player_key ?? "";

const shift = (d: Dist, by: number): Dist => ({
  ...d,
  mean: round(d.mean - by),
  p10: round(d.p10 - by),
  p25: round(d.p25 - by),
  p50: round(d.p50 - by),
  p75: round(d.p75 - by),
  p90: round(d.p90 - by),
  p_zero: by === 0 ? d.p_zero : 0,
});

/**
 * E5 for K/DEF. Ranks every non-rostered candidate of each requested position by this week's
 * expected points (ties: key order), keeps the top KDEF.maxCandidatesPerPosition per position, and
 * compares the best against my current starter over the look-ahead. Throws AnalyticsError
 * `invalid_request` (positions outside {K, DEF}, bounds) or `dataset_never_loaded`.
 */
export function analyzeKdef(req: KdefRequest): KdefOutcome {
  if (req.positions.length === 0 || req.positions.some((p) => p !== "K" && p !== "DEF")) {
    throw new AnalyticsError("invalid_request", "P0 streaming accepts only K and DEF", [
      "positions",
    ]);
  }
  const look = req.look_ahead ?? KDEF.lookAheadDefault;
  if (!Number.isInteger(look) || look < 0 || look > KDEF.lookAheadMax) {
    throw new AnalyticsError("invalid_request", "look_ahead must be 0..2", ["look_ahead"]);
  }
  if (req.universe.length + req.current.length > LIMITS.maxKdefCandidates) {
    throw new AnalyticsError("invalid_request", "too many candidates", ["universe"]);
  }
  const positions = [...new Set(req.positions)].filter(
    (p): p is KdefPosition => p === "K" || p === "DEF",
  );
  const weeks: Week[] = [];
  for (let w = req.week; w <= Math.min(22, req.week + look); w++) weeks.push(w);
  const mine = new Set(req.current.map((c) => c.player_key));
  // one entry per key (the first wins): a duplicated universe must not list a candidate twice
  const seen = new Set<PlayerKey>();
  const pool = req.universe.filter((c) => {
    if (!positions.includes(c.position) || mine.has(c.player_key) || seen.has(c.player_key)) {
      return false;
    }
    seen.add(c.player_key);
    return true;
  });
  const current = req.current.filter((c) => positions.includes(c.position));
  const all = [...current, ...pool];
  const uniq = new Map<PlayerKey, KdefCandidateInput>();
  for (const c of all) if (!uniq.has(c.player_key)) uniq.set(c.player_key, c);
  const targets: ProjectionTarget[] = [...uniq.values()].map((c) => ({
    player_key: c.player_key,
    subject: c.subject,
    name: c.name,
    position: c.position,
    nfl_team: c.nfl_team,
  }));
  const nFirst = req.n_sims ?? KDEF.nSims;
  const base = {
    season: req.season,
    settings: req.settings,
    readers: req.readers,
    clock: req.clock,
    rng: req.rng.fork("kdef"),
    ...(req.engine === undefined ? {} : { engine: req.engine }),
    ...(req.extra_stamps === undefined ? {} : { extra_stamps: req.extra_stamps }),
  };
  // pass 1: this week only, a small sample, to shortlist each position (A15 latency)
  const shortN = Math.min(nFirst, KDEF.shortlistSims);
  const first = projectForRanking({ ...base, targets, weeks: [req.week], n_sims: shortN }, shortN);
  const mineSet = new Set(current.map((c) => c.player_key));
  const keep = new Set<PlayerKey>(mineSet);
  for (const pos of positions) {
    first.players
      .filter((p) => p.target.position === pos && !mineSet.has(keyOf(p)))
      .sort((a, b) => meanOf(b, 0) - meanOf(a, 0) || cmpStr(keyOf(a), keyOf(b)))
      .slice(0, KDEF.shortlistPerPosition)
      .forEach((p) => keep.add(keyOf(p)));
  }
  // pass 2: the shortlist over the look-ahead at full ranking size
  const out = projectForRanking(
    {
      ...base,
      targets: targets.filter((t) => t.player_key !== null && keep.has(t.player_key)),
      weeks,
      n_sims: nFirst,
    },
    Math.min(nFirst, KDEF.nSimsLookAhead),
  );
  const byKey = new Map(out.players.map((p) => [keyOf(p), p]));
  const inputs = out.result.inputs;
  const assumptions: Assumption[] = [
    A(
      "K/DEF are dominated by this week's implied totals; the look-ahead reuses the published lines only",
      "lines for later weeks move",
    ),
    A(
      "defensive and return touchdowns, safeties and blocks are a league-average constant",
      "never — they are not predictable week to week",
    ),
  ];
  if (!req.availability_known) {
    assumptions.push(
      A(
        "availability unknown: no platform free-agent pool under the manual league, so this ranks the full nflverse K/DEF universe",
        "check the Yahoo waiver wire before claiming",
      ),
    );
  }

  const candidates: StreamingCandidate[] = [];
  let hold: { streamability: number; current_starter_delta: number } | null = null;
  const scored: Scored[] = [];

  for (const pos of positions) {
    const cur = current
      .filter((c) => c.position === pos)
      .map((c) => byKey.get(c.player_key))
      .filter((p): p is ProjectedPlayer => p !== undefined)
      .sort((a, b) => meanOf(b, 0) - meanOf(a, 0))[0];
    const ranked = pool
      .filter((c) => c.position === pos)
      .map((c) => ({ c, p: byKey.get(c.player_key) }))
      .filter((x): x is { c: KdefCandidateInput; p: ProjectedPlayer } => x.p !== undefined)
      .filter((x) => !req.availability_known || x.c.availability !== "T")
      .sort((a, b) => meanOf(b.p, 0) - meanOf(a.p, 0) || cmpStr(a.c.player_key, b.c.player_key))
      .slice(0, KDEF.maxCandidatesPerPosition);
    for (const { c, p } of ranked) {
      const w0 = at(p.weeks, 0);
      const kd = detail(req.settings, p, pos);
      const signals: WaiverSignal[] = [];
      const market = pos === "DEF" ? kd.opp_implied_total : kd.implied_total;
      if (market !== null) signals.push({ kind: "implied_total", value: market, evidence: market });
      const e = round(w0.dist.mean, 3);
      signals.push({ kind: "stream", value: e, evidence: e });
      const curE = cur === undefined ? null : meanOf(cur, 0);
      const cand: StreamingCandidate = {
        player_key: c.player_key,
        subject: c.subject,
        gsis_id: c.subject.kind === "player" ? c.subject.gsis_id : null,
        nfl_team: c.nfl_team,
        name: c.name,
        position: pos,
        availability: req.availability_known ? c.availability : "unknown",
        signals,
        weeks_of_value:
          cur === undefined ? null : p.weeks.filter((w, i) => w.dist.mean > meanOf(cur, i)).length,
        p_role_holds: [],
        marginal_value: shift(w0.dist, curE ?? 0),
        xfp_gap: null,
        competition: null,
        bid: null,
        claim_or_wait: null,
        drop: null,
        invalidators: INVALIDATORS,
        kdef: kd,
      };
      candidates.push(cand);
      scored.push({ cand, p, cur: cur ?? null, delta: curE === null ? null : w0.dist.mean - curE });
    }
    const leader = ranked[0];
    if (cur !== undefined && leader !== undefined) {
      const ratios: number[] = [];
      weeks.forEach((_, i) => {
        const c = meanOf(cur, i);
        if (c > 0) ratios.push(Math.max(...ranked.map((r) => meanOf(r.p, i))) / c);
      });
      const h = {
        streamability: round(
          ratios.length === 0 ? 0 : ratios.reduce((x, y) => x + y, 0) / ratios.length,
          3,
        ),
        current_starter_delta: round(meanOf(leader.p, 0) - meanOf(cur, 0), 3),
      };
      if (hold === null || h.current_starter_delta > hold.current_starter_delta) hold = h;
    }
  }

  // the call: the candidate with the largest gain over my starter (or the largest mean without one)
  const order = [...scored].sort(
    (a, b) =>
      (b.delta ?? meanOf(b.p, 0)) - (a.delta ?? meanOf(a.p, 0)) ||
      cmpStr(a.cand.player_key, b.cand.player_key),
  );
  const top = order[0] ?? null;
  const streamIt = top !== null && (top.delta === null || top.delta > KDEF.holdMargin);
  const subject = (p: ProjectedPlayer, role: RecSubject["role"]): RecSubject => ({
    player_key: p.target.player_key,
    gsis_id: p.target.subject.kind === "player" ? p.target.subject.gsis_id : null,
    nfl_team: p.target.subject.kind === "defense" ? p.target.subject.nfl_team : null,
    role,
    slot: null,
  });
  const lead: ProjectedPlayer | null = top === null ? null : streamIt ? top.p : (top.cur ?? top.p);
  const other: ProjectedPlayer | null =
    top === null ? null : streamIt ? (top.cur ?? order[1]?.p ?? null) : top.p;
  const leadDist = lead?.weeks[0]?.dist ?? zeroDist("position_cv");
  const otherDist = other?.weeks[0]?.dist ?? null;
  const dv = otherDist === null ? 0 : leadDist.mean - otherDist.mean;
  const sdv = Math.sqrt(
    sigmaOf(leadDist) ** 2 + (otherDist === null ? 0 : sigmaOf(otherDist) ** 2),
  );
  const kick = streamIt ? (top.p.weeks[0]?.kickoff_ms ?? null) : null;
  const nowMs = req.clock.nowMs();
  const rec: Rec = {
    action:
      top === null
        ? "no K/DEF candidate could be projected"
        : streamIt
          ? `stream ${top.cand.position} ${top.cand.player_key} for week ${String(req.week)}`
          : `hold the current ${top.cand.position}`,
    subjects:
      top === null
        ? []
        : streamIt
          ? [subject(top.p, "stream"), ...(top.cur === null ? [] : [subject(top.cur, "drop")])]
          : [subject(top.cur ?? top.p, "start")],
    lineup: null,
    point_estimate: round(leadDist.mean, 3),
    distribution: leadDist,
    delta_vs_next: {
      value: round(dv, 3),
      p10: round(dv - Z90 * sdv, 3),
      p90: round(dv + Z90 * sdv, 3),
    },
    decision_metric: "expected_points",
    drivers: lead === null ? [] : lead.projection.drivers.map((d) => ({ ...d })),
    assumptions,
    confidence: { role_games: lead?.role_games ?? 0, inputs },
    as_of: newestAsOf(inputs, req.clock.nowIso()),
    latest_execution_time: kick !== null && kick > nowMs ? new Date(kick).toISOString() : null,
    no_move: !streamIt,
    log_id: null,
  };
  return {
    analysis: {
      candidates,
      hold_vs_stream: hold,
      waiver_clearing_time: null,
      rec,
      inputs,
    },
    availability_known: req.availability_known,
  };
}
