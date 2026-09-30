// lineup.ts — E2 `ff_analyze_lineup` (plan 07 E2, C11; research 05 §3.1–§3.5, §11.1, §14.2): the exact
// assignment under the league's slots (flex eligibility, bench, IR kept), locked players fixed,
// `objective: mean` by default and `pwin`/`blend` opt-in (a mean-variance search whose candidates are
// scored by the normal-approximation P(win) with the same-team correlation table), protect/chase from
// the sign of μ_m − μ_o, swaps with ΔP(win) in {sign, band} form under `position_cv` (plan 10 A7(e)),
// coin_flip, Thursday/Monday option value, "if X is inactive, start Y" conditionals, and the
// `only_unlocked` game-day view. Pure.
import type { Clock } from "../clock.js";
import type { NflTeam } from "../../config/schema.js";
import { canOccupy } from "../league/slots.js";
import { isLocked, kickoffMs, latestExecutionTime } from "../league/schedule.js";
import type {
  IsoInstant,
  LockScheduleEntry,
  PlayerKey,
  RosterSlot,
  RosterSlots,
} from "../league/types.js";
import type { Dist, DistBasis } from "../scoring/types.js";
import { at } from "../scoring/numeric.js";
import { FORBIDDEN, solveAssignment } from "./assignment.js";
import { INACTIVES_LEAD_MS, LIMITS, LINEUP, Z90 } from "./constants.js";
import { AnalyticsError } from "./errors.js";
import { newestAsOf } from "./inputs.js";
import { normalDist, round, sigmaOf } from "./math.js";
import {
  diffSd,
  lineupMoments,
  lineupCov,
  type PairMoments,
  pairMoments,
  pWinInterval,
  pWinNormal,
  rho,
  type TotalMember,
} from "./totals.js";
import {
  type Assumption,
  type CoarseDelta,
  type InputFreshness,
  isCoinFlip,
  type LineupConditional,
  type LineupRecommendation,
  type LineupSlotAssignment,
  type MatchupMode,
  type ModeBasis,
  type Objective,
  type OptionValue,
  type Rec,
  type RecSubject,
  type StackFlag,
  type SwapOf,
  toCoarseDelta,
} from "./types.js";

/** One rostered player as the lineup engines see them (built by the tool from B1 + E1). */
export interface LineupPlayer {
  readonly player_key: PlayerKey;
  /** Raw name (path-listed on output). */
  readonly name: string;
  /** The player's positions (a multi-position player lists several); [0] is the primary one. */
  readonly positions: readonly string[];
  /** Short status code (IR eligibility), or null. */
  readonly status: string | null;
  readonly nfl_team: NflTeam | null;
  readonly gsis_id?: string | null;
  /** The player's current slot (`QB`, `W/R/T`, `BN`, `IR`). */
  readonly slot: string;
  /** Lock instant this week (plan 07 B1); null = no game / unknown kickoff. */
  readonly lock_at: IsoInstant | null;
  readonly points: Dist;
  readonly p_active: number | null;
  /** Games of evidence for the player's role (E1 `role_confidence_games`). */
  readonly role_games?: number;
}

/** An E2 request. */
export interface LineupRequest {
  readonly slots: RosterSlots;
  readonly players: readonly LineupPlayer[];
  /** The opponent's roster (their slots too), or null when unknown (manual league without one). */
  readonly opponent: readonly LineupPlayer[] | null;
  readonly objective?: Objective;
  readonly blend_weight?: number;
  readonly only_unlocked?: boolean;
  readonly exclude?: readonly PlayerKey[];
  readonly force_start?: readonly PlayerKey[];
  readonly compare?: readonly { readonly out: PlayerKey; readonly in: PlayerKey }[];
  readonly clock: Clock;
  readonly inputs?: readonly InputFreshness[];
}

// --- the solve ---------------------------------------------------------------------------------------

interface Instance {
  readonly slot: RosterSlot;
  readonly ord: number;
}

const isStartClass = (s: RosterSlot | undefined): boolean =>
  s !== undefined && (s.class === "starter" || s.class === "flex");

function startInstances(slots: RosterSlots): Instance[] {
  const out: Instance[] = [];
  let ord = 0;
  for (const s of slots.slots) {
    if (!isStartClass(s)) continue;
    for (let i = 0; i < s.count; i++) out.push({ slot: s, ord: ord++ });
  }
  return out;
}

const slotOf = (slots: RosterSlots, name: string): RosterSlot | undefined =>
  slots.slots.find((s) => s.name === name);

/** Assignment result: player key → slot name (a start slot, `BN`, or the player's own IR slot). */
type Assignment = ReadonlyMap<PlayerKey, string>;

interface SolveInput {
  readonly slots: RosterSlots;
  readonly players: readonly LineupPlayer[];
  readonly value: (p: LineupPlayer) => number;
  readonly nowMs: number;
  readonly exclude: ReadonlySet<PlayerKey>;
  readonly force: ReadonlySet<PlayerKey>;
}

const BENCH = "BN";

/**
 * The exact best lineup: maximise (number of filled starting slots, then Σ value) subject to slot
 * eligibility, locks (a locked starter keeps his slot, a locked reserve stays out), IR kept, and
 * `exclude`/`force_start`.
 */
function solve(input: SolveInput): Assignment {
  const { slots, players, nowMs } = input;
  const inst = startInstances(slots);
  const out = new Map<PlayerKey, string>();
  const rows: LineupPlayer[] = [];
  for (const p of players) {
    const s = slotOf(slots, p.slot);
    if (s?.class === "ir") out.set(p.player_key, p.slot);
    else rows.push(p);
  }
  // reserve an instance for every locked starter, in slot order
  const reserved = new Map<PlayerKey, number>();
  const taken = new Set<number>();
  for (const p of rows) {
    if (!isLocked(p.lock_at, nowMs) || !isStartClass(slotOf(slots, p.slot))) continue;
    const idx = inst.findIndex((x, i) => x.slot.name === p.slot && !taken.has(i));
    if (idx >= 0) {
      reserved.set(p.player_key, idx);
      taken.add(idx);
    }
  }
  const m = inst.length + rows.length;
  const cost = rows.map((p) => {
    const locked = isLocked(p.lock_at, nowMs);
    const res = reserved.get(p.player_key);
    const row = new Array<number>(m).fill(0);
    const v = input.value(p);
    inst.forEach((x, j) => {
      let c = FORBIDDEN;
      if (res !== undefined) {
        if (j === res) c = -(LINEUP.forceBonus * 10 + v);
      } else if (!locked && !input.exclude.has(p.player_key) && !taken.has(j)) {
        if (canOccupy(x.slot, { positions: p.positions, status: p.status })) {
          c = -(
            LINEUP.fillBonus +
            v +
            (input.force.has(p.player_key) ? LINEUP.forceBonus : 0) +
            (p.slot === x.slot.name ? LINEUP.stayBonus : 0)
          );
        }
      }
      row[j] = c;
    });
    for (let j = inst.length; j < m; j++) row[j] = res !== undefined ? FORBIDDEN : 0;
    return row;
  });
  const ans = solveAssignment(cost);
  rows.forEach((p, i) => {
    const j = at(ans, i);
    // a bench column, or (never, while the bench columns stay open) a forbidden start cell
    const starts = j < inst.length && at(at(cost, i), j) < FORBIDDEN / 2;
    out.set(p.player_key, starts ? at(inst, j).slot.name : BENCH);
  });
  return out;
}

/**
 * The best-by-mean legal lineup's starters (locks respected at `nowMs`, IR kept) — the opponent's
 * assumed lineup in E2/E3, and the hindsight-best lineup in the backtests (means = realised points).
 */
export function bestLineup(
  slots: RosterSlots,
  players: readonly LineupPlayer[],
  nowMs: number,
): LineupPlayer[] {
  const a = solve({
    slots,
    players,
    value: (p) => p.points.mean,
    nowMs,
    exclude: new Set(),
    force: new Set(),
  });
  return startersOf(a, players, slots);
}

// --- helpers -------------------------------------------------------------------------------------------

function member(p: LineupPlayer): TotalMember {
  return {
    player_key: p.player_key,
    position: p.positions[0] ?? "",
    nfl_team: p.nfl_team,
    points: p.points,
  };
}

function startersOf(
  a: Assignment,
  players: readonly LineupPlayer[],
  slots: RosterSlots,
): LineupPlayer[] {
  return players.filter((p) => isStartClass(slotOf(slots, slotIn(a, p.player_key))));
}

function currentAssignment(players: readonly LineupPlayer[]): Assignment {
  return new Map(players.map((p) => [p.player_key, p.slot]));
}

const lineupId = (a: Assignment, starters: readonly LineupPlayer[]): string =>
  starters
    .map((p) => `${p.player_key}@${slotIn(a, p.player_key)}`)
    .sort()
    .join(",");

const ET_WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});

/** The Eastern-time weekday (`Thu`, `Mon`) of an epoch instant. */
const etWeekday = (ms: number): string => ET_WEEKDAY.format(ms);

/** Plain code-unit string order (keys are ASCII codes; never locale-dependent). */
export const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a player is still unlocked at `t` (no lock, or a lock after it). */
function opensAfter(p: LineupPlayer, t: number): boolean {
  const k = kickoffMs(p.lock_at);
  return k === null || k > t;
}

/** The slot an assignment gives a player (bench when it names none). */
const slotIn = (a: Assignment, key: PlayerKey): string => a.get(key) ?? BENCH;

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

const roundPair = (x: readonly [number, number]): readonly [number, number] => [
  round(x[0]),
  round(x[1]),
];

function slotOrder(slots: RosterSlots, name: string): number {
  const i = slots.slots.findIndex((s) => s.name === name);
  return i < 0 ? slots.slots.length : i;
}

function assignments(
  a: Assignment,
  players: readonly LineupPlayer[],
  slots: RosterSlots,
): LineupSlotAssignment[] {
  return players
    .map((p) => ({
      slot: slotIn(a, p.player_key),
      player_key: p.player_key,
      name: p.name,
      points: p.points,
      lock_at: p.lock_at,
    }))
    .sort(
      (x, y) =>
        slotOrder(slots, x.slot) - slotOrder(slots, y.slot) || cmpStr(x.player_key, y.player_key),
    );
}

function lockGroups(players: readonly LineupPlayer[]): LockScheduleEntry[] {
  const by = new Map<number, Set<PlayerKey>>();
  for (const p of players) {
    const at = kickoffMs(p.lock_at);
    if (at === null) continue;
    const set = by.get(at) ?? new Set<PlayerKey>();
    set.add(p.player_key);
    by.set(at, set);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, keys]) => ({ lock_at: new Date(at).toISOString(), player_keys: [...keys].sort() }));
}

function basisOf(players: readonly LineupPlayer[]): DistBasis {
  return players.length > 0 && players.every((p) => p.points.basis === "player_sim")
    ? "player_sim"
    : "position_cv";
}

// --- the engine ------------------------------------------------------------------------------------------

interface Evaluated {
  readonly a: Assignment;
  readonly starters: LineupPlayer[];
  readonly moments: PairMoments;
  readonly pwin: number;
}

/**
 * E2. Throws AnalyticsError `no_opponent` for `objective: pwin | blend` without an opponent roster
 * (NOT_FOUND + MANUAL_NO_OPPONENT_HINT), `invalid_request` for bounds / an empty roster.
 */
export function analyzeLineup(req: LineupRequest): LineupRecommendation {
  const objective: Objective = req.objective ?? "mean";
  const { slots, clock } = req;
  if (req.players.length === 0 || req.players.length > LIMITS.maxLineupPlayers) {
    throw new AnalyticsError("invalid_request", "roster size out of range", ["players"]);
  }
  if (new Set(req.players.map((p) => p.player_key)).size !== req.players.length) {
    throw new AnalyticsError("invalid_request", "duplicate player key", ["players"]);
  }
  const blendW = req.blend_weight ?? LINEUP.blendWeight;
  if (!(blendW >= 0 && blendW <= 1)) {
    throw new AnalyticsError("invalid_request", "blend_weight must be in 0..1", ["blend_weight"]);
  }
  const opponent = req.opponent !== null && req.opponent.length > 0 ? req.opponent : null;
  if (objective !== "mean" && opponent === null) {
    throw new AnalyticsError("no_opponent", "no opponent roster for this week");
  }
  const nowMs = clock.nowMs();
  const exclude = new Set(req.exclude ?? []);
  const force = new Set(req.force_start ?? []);
  const basis = basisOf(req.players);
  const assumptions: Assumption[] = [
    A(
      "each player's spread is read from his p10–p90 (normal approximation); same-team correlations from the research 05 §3.3 table",
      "basis player_sim carries per-player variance",
    ),
    A("locked players are never moved", "never"),
  ];

  // the opponent's best-by-mean lineup (locks respected): what the matchup is played against
  let oppStarters: LineupPlayer[] = [];
  if (opponent !== null) {
    oppStarters = bestLineup(slots, opponent, nowMs);
    assumptions.push(
      A(
        "the opponent starts his highest-projected legal lineup",
        "the opponent's set lineup differs",
      ),
    );
  }
  const oppMembers = oppStarters.map(member);

  const meanA = solve({
    slots,
    players: req.players,
    value: (p) => p.points.mean,
    nowMs,
    exclude,
    force,
  });
  const meanStarters = startersOf(meanA, req.players, slots);
  const meanM = lineupMoments(meanStarters.map(member));
  const moments = (st: readonly LineupPlayer[]): PairMoments => {
    const mem = st.map(member);
    if (opponent !== null) return pairMoments(mem, oppMembers);
    const m = lineupMoments(mem);
    // no opponent: ΔP(win) is measured against an evenly matched opponent (the best mean lineup)
    return { mu_m: m.mu, v_m: m.v, mu_o: meanM.mu, v_o: meanM.v, cov: 0 };
  };
  if (opponent === null) {
    assumptions.push(
      A(
        "no opponent roster: P(win) is not reported and ΔP(win) is measured against an evenly matched opponent",
        "the opponent's roster is added to league.yaml",
      ),
    );
  }
  const evaluate = (a: Assignment): Evaluated => {
    const starters = startersOf(a, req.players, slots);
    const mo = moments(starters);
    return { a, starters, moments: mo, pwin: pWinNormal(mo) };
  };

  const meanEval = evaluate(meanA);
  let chosen = meanEval;
  if (objective !== "mean") {
    const seen = new Map<string, Evaluated>([[lineupId(meanA, meanEval.starters), meanEval]]);
    for (const lam of LINEUP.lambdaGrid) {
      for (const sign of [1, -1]) {
        if (lam === 0 && sign === -1) continue;
        const a = solve({
          slots,
          players: req.players,
          value: (p) => p.points.mean + sign * lam * sigmaOf(p.points) ** 2,
          nowMs,
          exclude,
          force,
        });
        const id = lineupId(a, startersOf(a, req.players, slots));
        if (!seen.has(id)) seen.set(id, evaluate(a));
      }
    }
    const cands = [...seen.values()];
    if (objective === "pwin") {
      for (const c of cands) if (c.pwin > chosen.pwin + 1e-12) chosen = c;
    } else {
      const mus = cands.map((c) => c.moments.mu_m);
      const pws = cands.map((c) => c.pwin);
      const norm = (x: number, xs: number[]): number => {
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        return hi > lo ? (x - lo) / (hi - lo) : 1;
      };
      let best = -Infinity;
      for (const c of cands) {
        const u = (1 - blendW) * norm(c.moments.mu_m, mus) + blendW * norm(c.pwin, pws);
        if (u > best + 1e-12) {
          best = u;
          chosen = c;
        }
      }
    }
  }

  // mode from the sign of μ_m − μ_o of the best-mean lineup (research 05 §3.2)
  const mm = meanEval.moments;
  const sdMode = diffSd(mm);
  const d = mm.mu_m - mm.mu_o;
  const mode: MatchupMode =
    opponent === null || Math.abs(d) <= LINEUP.neutralZ * sdMode
      ? "neutral"
      : d > 0
        ? "protect"
        : "chase";
  const sm = Math.sqrt(mm.v_m);
  const so = Math.sqrt(mm.v_o);
  const modeBasis: ModeBasis =
    opponent === null
      ? { mu_m: round(mm.mu_m), mu_o: 0, sigma_m: round(sm), sigma_o: 0, rho_lineup: 0 }
      : {
          mu_m: round(mm.mu_m),
          mu_o: round(mm.mu_o),
          sigma_m: round(sm),
          sigma_o: round(so),
          rho_lineup: sm > 0 && so > 0 ? round(mm.cov / (sm * so)) : 0,
        };

  // current lineup and swaps
  const curA = currentAssignment(req.players);
  const curEval = evaluate(curA);
  const curStarters = curEval.starters;
  const recStarters = chosen.starters;
  const curKeys = new Set(curStarters.map((p) => p.player_key));
  const recKeys = new Set(recStarters.map((p) => p.player_key));
  const leaving = curStarters.filter((p) => !recKeys.has(p.player_key));
  const entering = recStarters
    .filter((p) => !curKeys.has(p.player_key))
    .sort(
      (x, y) =>
        slotOrder(slots, slotIn(chosen.a, x.player_key)) -
          slotOrder(slots, slotIn(chosen.a, y.player_key)) || cmpStr(x.player_key, y.player_key),
    );
  const pairs: { out: LineupPlayer; in: LineupPlayer; slot: string }[] = [];
  const left = [...leaving];
  for (const e of entering) {
    const slot = slotIn(chosen.a, e.player_key);
    let i = left.findIndex((l) => l.slot === slot);
    if (i < 0) i = 0;
    const o = left[i];
    if (o === undefined) continue;
    left.splice(i, 1);
    pairs.push({ out: o, in: e, slot });
  }
  const byKey = new Map(req.players.map((p) => [p.player_key, p]));
  const comparePairs: { out: LineupPlayer; in: LineupPlayer; slot: string }[] = [];
  for (const c of (req.compare ?? []).slice(0, 5)) {
    const o = byKey.get(c.out);
    const i = byKey.get(c.in);
    if (o === undefined || i === undefined || o === i) continue;
    if (pairs.some((p) => p.out === o && p.in === i)) continue;
    comparePairs.push({ out: o, in: i, slot: o.slot });
  }

  const recMembers = recStarters.map(member);
  const swapRaw = [...pairs, ...comparePairs].map((pr) => {
    const after = curStarters.filter((p) => p !== pr.out);
    if (!after.includes(pr.in)) after.push(pr.in);
    const dp = pWinNormal(moments(after)) - curEval.pwin;
    const de = pr.in.points.mean - pr.out.points.mean;
    const si = sigmaOf(pr.in.points);
    const so2 = sigmaOf(pr.out.points);
    const sd = Math.sqrt(
      Math.max(0, si * si + so2 * so2 - 2 * rho(member(pr.in), member(pr.out)) * si * so2),
    );
    const interval: readonly [number, number] = [round(de - Z90 * sd), round(de + Z90 * sd)];
    return {
      out: pr.out.player_key,
      in: pr.in.player_key,
      slot: pr.slot,
      delta_e: round(de),
      dp,
      interval,
      coin_flip: isCoinFlip(basis, dp, interval),
      option_value: optionValue(pr, recStarters, req.players, slots, chosen.a),
    };
  });

  // conditionals: if a starter with 0 < P(active) < 1 is ruled out, the best eligible reserve
  const conditionals: LineupConditional[] = [];
  for (const x of recStarters) {
    if (x.p_active === null || x.p_active <= 0 || x.p_active >= 1) continue;
    const lockMs = kickoffMs(x.lock_at);
    if (lockMs === null) continue;
    const decided = lockMs - INACTIVES_LEAD_MS;
    if (decided <= nowMs) continue;
    const slotName = slotIn(chosen.a, x.player_key);
    const slot = slotOf(slots, slotName);
    if (slot === undefined) continue;
    const alt = req.players
      .filter(
        (y) =>
          !recKeys.has(y.player_key) &&
          slotOf(slots, slotIn(chosen.a, y.player_key))?.class !== "ir" &&
          !exclude.has(y.player_key) &&
          (y.p_active ?? 1) > 0 &&
          y.points.mean > 0 &&
          opensAfter(y, decided) &&
          canOccupy(slot, { positions: y.positions, status: y.status }),
      )
      .sort((a, b) => b.points.mean - a.points.mean || cmpStr(a.player_key, b.player_key))[0];
    if (alt === undefined) continue;
    conditionals.push({
      if: {
        player_key: x.player_key,
        event: "inactive",
        decided_by: new Date(decided).toISOString(),
      },
      then: { slot: slotName, in: alt.player_key },
    });
  }

  // stack flags: recommended starters sharing an NFL team with a positive-ρ pair
  const stackFlags: StackFlag[] = [];
  const teams = new Map<string, LineupPlayer[]>();
  for (const p of recStarters) {
    if (p.nfl_team === null) continue;
    const list = teams.get(p.nfl_team) ?? [];
    list.push(p);
    teams.set(p.nfl_team, list);
  }
  for (const group of [...teams.values()]) {
    const positive = group.some((a, i) =>
      group.some((b, j) => j > i && rho(member(a), member(b)) > 0),
    );
    if (!positive) continue;
    stackFlags.push({
      players: group.map((p) => p.player_key).sort(),
      effect: mode === "protect" ? "floor-" : "ceiling+",
    });
  }
  stackFlags.sort((a, b) => cmpStr(a.players.join(","), b.players.join(",")));

  const schedule = lockGroups(req.players);
  const latest = latestExecutionTime(schedule, nowMs);
  const swapPlayers = req.players.filter((p) => pairs.some((s) => s.in === p || s.out === p));
  const recLatest = latestExecutionTime(lockGroups(swapPlayers), nowMs);
  const noMove = pairs.length === 0;
  const inputs = [...(req.inputs ?? [])];

  // the Rec
  const recM = lineupMoments(recMembers);
  const curMembers = curStarters.map(member);
  const curM = lineupMoments(curMembers);
  const covRC = lineupCov(recMembers, curMembers);
  const sdDelta = Math.sqrt(Math.max(0, recM.v + curM.v - 2 * covRC));
  const dMu = recM.mu - curM.mu;
  const subjects: RecSubject[] = [];
  for (const p of recStarters) {
    subjects.push({
      player_key: p.player_key,
      gsis_id: p.gsis_id ?? null,
      nfl_team: p.positions.includes("DEF") ? p.nfl_team : null,
      role: "start",
      slot: slotIn(chosen.a, p.player_key),
    });
  }
  for (const pr of pairs) {
    subjects.push({
      player_key: pr.out.player_key,
      gsis_id: pr.out.gsis_id ?? null,
      nfl_team: pr.out.positions.includes("DEF") ? pr.out.nfl_team : null,
      role: "sit",
      slot: pr.slot,
    });
  }
  const roleGames = recStarters.map((p) => p.role_games ?? 0);
  const rec: Rec = {
    action: noMove
      ? "keep the current lineup"
      : `make ${String(pairs.length)} lineup change${pairs.length === 1 ? "" : "s"}`,
    subjects,
    lineup: assignments(chosen.a, recStarters, slots).map((s) => ({
      slot: s.slot,
      player_key: s.player_key,
    })),
    point_estimate: round(recM.mu),
    distribution: normalDist(recM.mu, Math.sqrt(recM.v), basis),
    delta_vs_next: {
      value: round(dMu),
      p10: round(dMu - Z90 * sdDelta),
      p90: round(dMu + Z90 * sdDelta),
    },
    decision_metric:
      objective === "mean" ? "expected_points" : objective === "pwin" ? "p_win" : "blend",
    drivers: swapRaw
      .slice(0, pairs.length)
      .map((s) => ({ name: `swap:${s.slot}:${s.in}`, contribution: s.delta_e })),
    assumptions,
    confidence: {
      role_games: roleGames.length === 0 ? 0 : Math.min(...roleGames),
      inputs,
    },
    as_of: newestAsOf(inputs, clock.nowIso()),
    latest_execution_time: noMove ? null : recLatest,
    no_move: noMove,
    log_id: null,
  };

  const view = (a: Assignment): LineupSlotAssignment[] => {
    const all = assignments(a, req.players, slots);
    return req.only_unlocked === true ? all.filter((s) => !isLocked(s.lock_at, nowMs)) : all;
  };
  const hasOpp = opponent !== null;
  const base = {
    objective_used: objective,
    current_lineup: view(curA),
    recommended_lineup: view(chosen.a),
    mode,
    mode_basis: modeBasis,
    p_win_before: hasOpp ? round(curEval.pwin) : null,
    p_win_after: hasOpp ? round(chosen.pwin) : null,
    p_win_interval: hasOpp
      ? roundPair(pWinInterval(chosen.moments, recStarters.length + oppStarters.length))
      : null,
    conditionals,
    stack_flags: stackFlags,
    lock_schedule: schedule,
    latest_execution_time: latest,
    no_move: noMove,
    rec,
    inputs,
  };
  if (basis === "position_cv") {
    const swaps: SwapOf<CoarseDelta>[] = swapRaw.map((s) => ({
      out: s.out,
      in: s.in,
      slot: s.slot,
      delta_e: s.delta_e,
      delta_pwin: toCoarseDelta(s.dp),
      interval: s.interval,
      coin_flip: s.coin_flip,
      option_value: s.option_value,
    }));
    return { ...base, dist_basis: "position_cv", swaps };
  }
  const swaps: SwapOf<number>[] = swapRaw.map((s) => ({
    out: s.out,
    in: s.in,
    slot: s.slot,
    delta_e: s.delta_e,
    delta_pwin: round(s.dp, 3),
    interval: s.interval,
    coin_flip: s.coin_flip,
    option_value: s.option_value,
  }));
  return { ...base, dist_basis: "player_sim", swaps };
}

/**
 * Thursday / Monday / late-game option value of a swap (research 05 §3.4/§3.5): when the two players
 * kick off at different times, keeping the later player keeps the option to react if he is ruled out
 * — worth (1 − P(active of the later player)) × E[best reserve still unlocked then]. `commit` when
 * the swap's ΔE covers it, else `hold`. Null when the kickoffs are equal/unknown, or neither game is
 * Thursday/Monday and the later player is certain to play.
 */
function optionValue(
  pr: { out: LineupPlayer; in: LineupPlayer; slot: string },
  recStarters: readonly LineupPlayer[],
  players: readonly LineupPlayer[],
  slots: RosterSlots,
  a: Assignment,
): OptionValue | null {
  const ki = kickoffMs(pr.in.lock_at);
  const ko = kickoffMs(pr.out.lock_at);
  if (ki === null || ko === null || ki === ko) return null;
  const inFirst = ki < ko;
  const later = inFirst ? pr.out : pr.in;
  const pLater = later.p_active ?? 1;
  const kind: OptionValue["kind"] | null =
    etWeekday(Math.min(ki, ko)) === "Thu"
      ? "thursday"
      : etWeekday(Math.max(ki, ko)) === "Mon"
        ? "monday"
        : pLater < 1
          ? "late_game"
          : null;
  if (kind === null) return null;
  const decided = Math.max(ki, ko) - INACTIVES_LEAD_MS;
  const slot = slotOf(slots, pr.slot);
  const recKeys = new Set(recStarters.map((p) => p.player_key));
  const reserve = players
    .filter(
      (y) =>
        y !== pr.in &&
        y !== pr.out &&
        !recKeys.has(y.player_key) &&
        slotOf(slots, slotIn(a, y.player_key))?.class !== "ir" &&
        opensAfter(y, decided) &&
        (slot === undefined || canOccupy(slot, { positions: y.positions, status: y.status })),
    )
    .reduce((best, y) => Math.max(best, y.points.mean), 0);
  const value = round((1 - pLater) * reserve, 3);
  const gain = pr.in.points.mean - pr.out.points.mean;
  const verdict = inFirst
    ? gain >= value
      ? "commit: the gain covers the option value of waiting"
      : "hold: the gain does not cover the option value of the later game"
    : "commit: starting the later player keeps the option open";
  return { kind, value, verdict };
}
