// projection.ts — E1 `v1-trailing` (plan 07 E1; research 05 §1 steps 1, 4, 8, 9 and §19.1): trailing
// nflverse stat lines → an exponentially weighted, shrunk expected canonical line; scaled by the
// implied team total; P(active) from the injury report (or a game-day status); a `position_cv`
// gamma width around the mean (DEF: points allowed around the opponent's implied total, counts
// Poisson) → simulated canonical lines → engine.scoreSamples → Dist (basis "position_cv").
// Stored format-agnostically (plan 08 §5) through the injected repository. Pure: readers, engine,
// clock, rng and repository are injected.
import type { Clock, Rng } from "../clock.js";
import { freshnessClass, stampState } from "../../config/freshness.js";
import { NFL_TEAMS, type NflTeam } from "../../config/schema.js";
import { GAME_WINDOW_MS, kickoffMs, opponentOf, teamGame } from "../league/schedule.js";
import type { PlayerKey, Week } from "../league/types.js";
import { scoringEngine } from "../scoring/engine.js";
import { at } from "../scoring/numeric.js";
import type {
  Canonical,
  Dist,
  PositionType,
  ProjectionSubject,
  ScoreSamplesResult,
  ScoringEngine,
  ScoringSettings,
  StatLine,
} from "../scoring/types.js";
import { isRosterOut, pActive, type Availability } from "./availability.js";
import type { NflRosterPlayer, RosterWeeklyReader } from "../crosswalk/types.js";
import {
  DEF_SIM,
  EXPECTATION,
  INDOOR_ROOFS,
  isMarketScaled,
  KDEF,
  LIMITS,
  MARKET,
  MODEL_VERSION,
  POSITION_CV,
  PRIOR_LINES,
  type ProjectablePosition,
  shrinkKFor,
  SIMS,
  WINDOW,
} from "./constants.js";
import { AnalyticsError } from "./errors.js";
import { type AnyStamp, collectInputs, newestAsOf } from "./inputs.js";
import { denoise } from "../scoring/numeric.js";
import {
  clamp,
  gammaMultiplier,
  gammaNodes,
  normalDist,
  poissonDraw,
  round,
  sigmaOf,
  zeroDist,
} from "./math.js";
import type {
  Assumption,
  DatasetStamp,
  Driver,
  InjuryReport,
  NflGame,
  PActiveBasis,
  PlayerWeekLine,
  Projection,
  ProjectionRepository,
  ProjectionResult,
  ProjectionWeek,
  Shrinkage,
  TeamDefenseWeekLine,
  WeatherObservation,
  WeatherReader,
  InjuryReader,
  PlayerWeekReader,
  ScheduleReader,
} from "./types.js";

/** Who to project. */
export interface ProjectionTarget {
  readonly player_key: PlayerKey | null;
  readonly subject: ProjectionSubject;
  /** Raw name (the tool path-lists it). */
  readonly name: string;
  /** League position: QB | RB | WR | TE | K | DEF (a defence subject is always DEF). */
  readonly position: string;
  /** Current NFL team; null → the team of the newest trailing line (or no game). */
  readonly nfl_team: NflTeam | null;
  /** The provider's roster status code (league.yaml / Yahoo `status`), if any. */
  readonly platform_status?: string | null;
  /** A provider-stamped game-day status (Yahoo only; undefined under the manual league). */
  readonly game_day_status?: { readonly status: string | null };
}

/** The readers E1 needs (weather optional: only long-FG volume uses it). */
export interface ProjectionReaders {
  readonly schedules: ScheduleReader;
  readonly injuries: InjuryReader;
  readonly playerWeeks: PlayerWeekReader;
  readonly weather?: WeatherReader;
  /** nflverse roster_weekly (newest row per player): reserve/cut/inactive statuses (QA-1-030). */
  readonly rosters?: Pick<RosterWeeklyReader, "latest">;
}

/** An E1 request (already validated by the tool's zod schema; re-checked here). */
export interface ProjectionRequest {
  readonly targets: readonly ProjectionTarget[];
  readonly season: number;
  /** Target weeks (the first one is the as-of: no line of it or later is read). */
  readonly weeks: readonly Week[];
  readonly settings: ScoringSettings;
  readonly readers: ProjectionReaders;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly n_sims?: number;
  readonly include_stat_line?: boolean;
  readonly engine?: ScoringEngine;
  /** Best-effort store of every projection (plan 08 §5); omitted → nothing is stored. */
  readonly repository?: ProjectionRepository;
  /** Platform stamps to cite in `inputs[]` (the league file, the roster read). */
  readonly extra_stamps?: readonly AnyStamp[];
  /**
   * The as-of of the input that set the targets' platform status (the league file's mtime, a Yahoo
   * response time): it changes p_active, so a stored projection's `inputs_as_of` must move with it
   * or the store collapses a status edit into the earlier run (QA-1-031).
   */
  readonly status_as_of?: string;
}

/** What the other engines need from one projected week (beyond the public Dist). */
export interface ProjectedWeek {
  readonly week: Week;
  readonly dist: Dist;
  readonly p_active: number | null;
  readonly p_active_basis: PActiveBasis;
  readonly game: NflGame | null;
  readonly kickoff_ms: number | null;
  readonly team: NflTeam | null;
  readonly opponent: NflTeam | null;
  readonly implied_total: number | null;
  readonly opp_implied_total: number | null;
  /** The expected line the samples were drawn around (after market/weather). */
  readonly expectation: Readonly<Record<Canonical, number>>;
  /** scoreSamples output (bracket/bonus probabilities); null on a zero week. */
  readonly samples: ScoreSamplesResult | null;
  /**
   * Expected points if active, before and after the market multiplier — the model's expectation
   * (deterministic quadrature over the gamma width, never a sample mean; QA-1-024).
   */
  readonly e_active_base: number;
  readonly e_active: number;
  /** The expected bracket points if active (deterministic); null on a zero week. */
  readonly brackets_e: number | null;
  readonly market_multiplier: number | null;
  readonly weather_factor: number | null;
}

/** One target's projection and the per-week detail. */
export interface ProjectedPlayer {
  readonly target: ProjectionTarget;
  readonly projection: Projection;
  readonly weeks: readonly ProjectedWeek[];
  readonly role_games: number;
}

/** E1 output: the tool's `data` plus the detail other engines consume. */
export interface ProjectionOutcome {
  readonly result: ProjectionResult;
  readonly players: readonly ProjectedPlayer[];
  /** Best-effort store outcome counts. */
  readonly stored: { readonly written: number; readonly busy: number };
  /** The target weeks' betting lines were past their hard limit and omitted (QA-1-004). */
  readonly lines_omitted: boolean;
}

// --- data loading ------------------------------------------------------------------------------------

interface WindowGame {
  readonly season: number;
  readonly week: Week;
  readonly weight: number;
  readonly team: NflTeam;
  readonly opponent: NflTeam | null;
  readonly line: StatLine;
}

interface Loaded {
  readonly games: Map<string, NflGame[]>;
  readonly playerLines: Map<string, WindowGame[]>;
  readonly defenseLines: WindowGame[];
  /** Report rows keyed `gsis:week` (the target weeks and each one's previous week). */
  readonly injuries: Map<string, InjuryReport>;
  /** Whether the injury dataset is loaded at all, per target week. */
  readonly injuriesLoaded: Map<Week, boolean>;
  /** Teams whose report for the week is published (any row), per week (QA-1-021). */
  readonly reportTeams: Map<Week, ReadonlySet<NflTeam>>;
  /** The target weeks' lines were dropped: the `lines` class is past its hard limit (QA-1-004). */
  readonly linesOmitted: boolean;
  /** Each target player's newest nflverse roster row this season (QA-1-030). */
  readonly rosterRows: Map<string, NflRosterPlayer>;
  readonly weather: Map<string, WeatherObservation>;
  readonly stamps: (DatasetStamp | null)[];
}

/** `r[k]`, or 0 when the stat is absent (the one "absent reads 0" rule of this module). */
export const statOf = (r: Readonly<Record<Canonical, number>>, k: Canonical): number => r[k] ?? 0;

const gameKey = (season: number, week: Week): string => `${String(season)}:${String(week)}`;

/** The loaded games of one season-week ([] when none). */
function gamesAt(games: ReadonlyMap<string, NflGame[]>, season: number, week: Week): NflGame[] {
  return games.get(gameKey(season, week)) ?? [];
}

/**
 * The trailing window's weeks (QA-1-012): the WINDOW.maxGames calendar weeks ending at `lastWeek` —
 * the latest played week before the first target week, never the week before the target itself — so
 * a projection three months out reads the games already played instead of an empty future window.
 * The rest of the window is filled from the previous season's last weeks.
 */
function windowWeeks(lastWeek: Week): { cur: Week[]; prev: Week[] } {
  const cur: Week[] = [];
  for (let w = Math.max(1, lastWeek - WINDOW.maxGames + 1); w <= lastWeek; w++) cur.push(w);
  const prev: Week[] = [];
  const need = WINDOW.maxGames - cur.length;
  for (let w = WINDOW.priorSeasonLastWeek - need + 1; w <= WINDOW.priorSeasonLastWeek; w++) {
    prev.push(w);
  }
  return { cur, prev };
}

/** Exponential weights over a player's games, newest first, capped at WINDOW.maxGames. */
function weightGames(
  rows: readonly {
    season: number;
    week: Week;
    team: NflTeam;
    opponent: NflTeam | null;
    line: StatLine;
  }[],
  season: number,
): WindowGame[] {
  const sorted = [...rows].sort((a, b) =>
    a.season !== b.season ? b.season - a.season : b.week - a.week,
  );
  const kept = sorted.slice(0, WINDOW.maxGames);
  return kept.map((r, i) => ({
    ...r,
    weight:
      0.5 ** (i / WINDOW.halfLifeGames) * (r.season === season ? 1 : WINDOW.priorSeasonWeight),
  }));
}

/**
 * The latest week before `first` with a played game (final, or past its game window at `nowMs`); 0
 * when none — the trailing window's anchor (QA-1-012).
 */
function lastPlayedWeek(
  rows: readonly NflGame[],
  season: number,
  first: Week,
  nowMs: number,
): Week {
  let last = 0;
  for (const g of rows) {
    if (g.season !== season || g.week >= first || g.week <= last) continue;
    const k = kickoffMs(g.kickoff);
    if (g.is_final || (k !== null && k + GAME_WINDOW_MS <= nowMs)) last = g.week;
  }
  return last;
}

function load(req: ProjectionRequest, needDefense: boolean): Loaded {
  const { season } = req;
  const first = Math.min(...req.weeks);
  const stamps: (DatasetStamp | null)[] = [];
  const games = new Map<string, NflGame[]>();

  const before: Week[] = [];
  for (let w = 1; w < first; w++) before.push(w);
  const sched = req.readers.schedules.games(season, [...new Set([...before, ...req.weeks])]);
  if (sched.stamp === null) {
    throw new AnalyticsError("dataset_never_loaded", "schedules never loaded", [
      "nflverse:schedules",
    ]);
  }
  stamps.push(sched.stamp);
  const { cur, prev } = windowWeeks(lastPlayedWeek(sched.rows, season, first, req.clock.nowMs()));
  // betting lines ride in the schedules release but age by their own class (plan 01 §5.4: 24 h →
  // "omitted driver"): past it, the target weeks' lines are dropped and the omission is named. A
  // window game's closing line is history and stays (QA-1-004).
  const linesOmitted =
    stampState(freshnessClass("lines"), sched.stamp, req.clock.nowMs()).state === "expired";
  const addGames = (rows: readonly NflGame[]): void => {
    for (const raw of rows) {
      const g =
        linesOmitted && raw.season === season && req.weeks.includes(raw.week) && raw.lines !== null
          ? { ...raw, lines: null }
          : raw;
      const k = gameKey(g.season, g.week);
      const list = games.get(k) ?? [];
      list.push(g);
      games.set(k, list);
    }
  };
  addGames(sched.rows);
  if (prev.length > 0) {
    const ps = req.readers.schedules.games(season - 1, prev);
    if (ps.stamp !== null) addGames(ps.rows);
  }

  const gsisIds = [
    ...new Set(
      req.targets.flatMap((t) => (t.subject.kind === "player" ? [t.subject.gsis_id] : [])),
    ),
  ].sort();
  const raw = new Map<string, PlayerWeekLine[]>();
  const addLines = (rows: readonly PlayerWeekLine[]): void => {
    for (const r of rows) {
      if (r.week >= first && r.season === season) continue; // never read the as-of week or later
      const list = raw.get(r.gsis_id) ?? [];
      list.push(r);
      raw.set(r.gsis_id, list);
    }
  };
  if (gsisIds.length > 0 && cur.length > 0) {
    const r = req.readers.playerWeeks.lines(gsisIds, season, cur);
    if (r.stamp === null) {
      throw new AnalyticsError("dataset_never_loaded", "player stats never loaded", [
        "nflverse:stats_player_week",
      ]);
    }
    stamps.push(r.stamp);
    addLines(r.rows);
  }
  if (gsisIds.length > 0 && prev.length > 0) {
    const r = req.readers.playerWeeks.lines(gsisIds, season - 1, prev);
    if (r.stamp !== null) {
      stamps.push(r.stamp);
      addLines(r.rows);
    }
  }
  const playerLines = new Map<string, WindowGame[]>();
  for (const [id, rows] of raw) {
    playerLines.set(
      id,
      weightGames(
        rows.map((r) => ({
          season: r.season,
          week: r.week,
          team: r.nfl_team,
          opponent: r.opponent,
          line: r.line,
        })),
        season,
      ),
    );
  }

  const defenseLines: WindowGame[] = [];
  if (needDefense) {
    const addDef = (rows: readonly TeamDefenseWeekLine[]): void => {
      for (const r of rows) {
        if (r.season === season && r.week >= first) continue;
        defenseLines.push({
          season: r.season,
          week: r.week,
          weight: 1,
          team: r.nfl_team,
          opponent: r.opponent,
          line: r.line,
        });
      }
    };
    if (cur.length > 0) {
      const r = req.readers.playerWeeks.defenseLines(NFL_TEAMS, season, cur);
      if (r.stamp === null) {
        throw new AnalyticsError("dataset_never_loaded", "team defence lines never loaded", [
          "nflverse:stats_player_week",
        ]);
      }
      stamps.push(r.stamp);
      addDef(r.rows);
    }
    if (prev.length > 0) {
      const r = req.readers.playerWeeks.defenseLines(NFL_TEAMS, season - 1, prev);
      if (r.stamp !== null) {
        stamps.push(r.stamp);
        addDef(r.rows);
      }
    }
  }

  // the whole week's report (every team), so "not listed" can be told from "not published yet":
  // a team's report exists once it has any row for the week (QA-1-021)
  const injuries = new Map<string, InjuryReport>();
  const injuriesLoaded = new Map<Week, boolean>();
  const reportTeams = new Map<Week, ReadonlySet<NflTeam>>();
  const wanted = new Set(gsisIds);
  const reportWeeks = [...new Set(req.weeks.flatMap((w) => (w > 1 ? [w - 1, w] : [w])))].sort(
    (a, b) => a - b,
  );
  for (const w of reportWeeks) {
    const target = req.weeks.includes(w);
    if (gsisIds.length === 0) {
      if (target) injuriesLoaded.set(w, false);
      continue;
    }
    const r = req.readers.injuries.reports(season, w, null);
    if (target) injuriesLoaded.set(w, r.stamp !== null);
    if (r.stamp === null) continue;
    if (target) stamps.push(r.stamp);
    const teams = new Set<NflTeam>();
    for (const rep of r.rows) {
      if (rep.season !== season || rep.week !== w) continue;
      teams.add(rep.nfl_team);
      if (wanted.has(rep.gsis_id)) injuries.set(`${rep.gsis_id}:${String(w)}`, rep);
    }
    reportTeams.set(w, teams);
  }

  const rosterRows = new Map<string, NflRosterPlayer>();
  if (req.readers.rosters !== undefined && gsisIds.length > 0) {
    const r = req.readers.rosters.latest(season);
    if (r.stamp !== null) {
      stamps.push(r.stamp);
      for (const row of r.rows) {
        if (row.season === season && wanted.has(row.gsis_id)) rosterRows.set(row.gsis_id, row);
      }
    }
  }

  const weather = new Map<string, WeatherObservation>();
  const kickerWeeks = req.targets.some((t) => t.subject.kind === "player" && t.position === "K");
  if (kickerWeeks && req.readers.weather !== undefined) {
    const ids = req.weeks.flatMap((w) => gamesAt(games, season, w).map((g) => g.game_id));
    if (ids.length > 0) {
      const r = req.readers.weather.forGames([...new Set(ids)].sort());
      if (r.stamp !== null) stamps.push(r.stamp);
      for (const o of r.rows) weather.set(o.game_id, o);
    }
  }
  return {
    games,
    playerLines,
    defenseLines,
    injuries,
    injuriesLoaded,
    reportTeams,
    rosterRows,
    linesOmitted,
    weather,
    stamps,
  };
}

// --- expectation --------------------------------------------------------------------------------------

function impliedFor(team: NflTeam, game: NflGame | null): number | null {
  const lines = game?.lines ?? null;
  if (game === null || lines === null) return null;
  const v = game.home === team ? lines.implied.home : lines.implied.away;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

interface Weighted {
  readonly mean: Readonly<Record<Canonical, number>>;
  readonly n: number;
}

/** Weighted mean of each stat over window lines (a stat absent from a line counts 0 there). */
function weightedMeans(games: readonly WindowGame[]): Weighted {
  const sumW = games.reduce((s, g) => s + g.weight, 0);
  const acc: Record<Canonical, number> = {};
  for (const g of games) {
    for (const [k, v] of Object.entries(g.line.values)) {
      acc[k] = statOf(acc, k) + g.weight * v;
    }
  }
  const mean: Record<Canonical, number> = {};
  // every weight is > 0, so a stat in `acc` implies sumW > 0
  for (const [k, s] of Object.entries(acc)) mean[k] = s / sumW;
  return { mean, n: sumW };
}

/** Bayesian shrinkage (research 05 §1 step 4): (n·obs + k·prior) / (n + k), per stat. */
function shrink(
  obs: Weighted,
  prior: Readonly<Record<Canonical, number>>,
  keep: (c: Canonical) => boolean,
): { line: Record<Canonical, number>; shrinkage: Shrinkage[] } {
  const keys = [...new Set([...Object.keys(prior), ...Object.keys(obs.mean)])].filter(keep).sort();
  const line: Record<Canonical, number> = {};
  const shrinkage: Shrinkage[] = [];
  for (const k of keys) {
    const kk = shrinkKFor(k);
    const p = statOf(prior, k);
    const o = statOf(obs.mean, k);
    line[k] = (obs.n * o + kk * p) / (obs.n + kk);
    shrinkage.push({ rate: k, n: round(obs.n, 2), k: kk });
  }
  return { line, shrinkage };
}

const PLAYER_STAT = (pt: PositionType) => (c: Canonical) =>
  pt === "K"
    ? c.startsWith("fg_") || c.startsWith("pat_")
    : !c.startsWith("dst_") && !c.startsWith("fg_") && !c.startsWith("pat_");

function positionOf(t: ProjectionTarget): ProjectablePosition | null {
  if (t.subject.kind === "defense") return "DEF";
  const p = t.position.trim().toUpperCase();
  return p === "QB" || p === "RB" || p === "WR" || p === "TE" || p === "K" ? p : null;
}

function positionTypeOf(pos: ProjectablePosition): PositionType {
  return pos === "K" ? "K" : pos === "DEF" ? "DT" : "O";
}

/** Window-average implied total of the player's team in its window games (the market base). */
function windowImplied(games: readonly WindowGame[], loaded: Loaded): number {
  let s = 0;
  let w = 0;
  for (const g of games) {
    const game = teamGame(g.team, gamesAt(loaded.games, g.season, g.week));
    const imp = impliedFor(g.team, game);
    if (imp !== null) {
      s += g.weight * imp;
      w += g.weight;
    }
  }
  return w > 0 ? s / w : MARKET.leagueAverageImplied;
}

// --- simulation ---------------------------------------------------------------------------------------

const SOURCE = `projection:${MODEL_VERSION}`;

function lineOf(values: Record<Canonical, number>, pt: PositionType): StatLine {
  return {
    values,
    present: Object.keys(values).sort(),
    position_type: pt,
    provisional: false,
    source: SOURCE,
  };
}

function simulatePlayer(
  expectation: Readonly<Record<Canonical, number>>,
  pos: Exclude<ProjectablePosition, "DEF">,
  p: number,
  n: number,
  rng: Rng,
): StatLine[] {
  const pt = positionTypeOf(pos);
  const keys = Object.keys(expectation)
    .filter((k) => statOf(expectation, k) > 0)
    .sort();
  const present = Object.freeze(keys);
  const empty: StatLine = Object.freeze({
    values: Object.freeze({}),
    present: Object.freeze([]),
    position_type: pt,
    provisional: false,
    source: SOURCE,
  });
  const cv = POSITION_CV[pos];
  const means = keys.map((k) => statOf(expectation, k));
  const out: StatLine[] = [];
  for (let i = 0; i < n; i++) {
    if (rng.next() >= p) {
      out.push(empty);
      continue;
    }
    const g = gammaMultiplier(rng, cv);
    const values: Record<Canonical, number> = {};
    for (const [j, k] of keys.entries()) values[k] = (means[j] ?? 0) * g;
    out.push({ values, present, position_type: pt, provisional: false, source: SOURCE });
  }
  return out;
}

function simulateDefense(
  expectation: Readonly<Record<Canonical, number>>,
  n: number,
  rng: Rng,
): StatLine[] {
  const out: StatLine[] = [];
  // both are always present: the DEF prior carries them and shrinkage keeps every prior key
  const pa = statOf(expectation, "dst_pa");
  const ya = statOf(expectation, "dst_ya");
  const counts = Object.keys(expectation)
    .filter((k) => k !== "dst_pa" && k !== "dst_ya")
    .sort();
  for (let i = 0; i < n; i++) {
    const values: Record<Canonical, number> = {};
    values.dst_pa = Math.round(pa * gammaMultiplier(rng, DEF_SIM.pointsAllowedCv));
    values.dst_ya = Math.round(ya * gammaMultiplier(rng, DEF_SIM.yardsAllowedCv));
    for (const k of counts) values[k] = poissonDraw(rng, statOf(expectation, k));
    out.push(lineOf(values, "DT"));
  }
  return out;
}

// --- the model's expectation (QA-1-024) ----------------------------------------------------------------

/** Expected points (league FINAL points, as a Dist's quantiles) and, for a defence, its brackets. */
interface Expected {
  readonly points: number;
  readonly brackets: number;
}

/**
 * E[points | active] of a player: the stat line scaled by each equal-probability node of the same
 * mean-1 gamma multiplier `simulatePlayer` samples from, scored by the league's own engine, averaged.
 * Deterministic; exact for linear scoring, bonuses and brackets on a 1/EXPECTATION.nodes grid.
 */
function expectPlayer(
  expectation: Readonly<Record<Canonical, number>>,
  pos: Exclude<ProjectablePosition, "DEF">,
  engine: ScoringEngine,
  settings: ScoringSettings,
): Expected {
  const pt = positionTypeOf(pos);
  const keys = Object.keys(expectation)
    .filter((k) => statOf(expectation, k) > 0)
    .sort();
  if (keys.length === 0) return { points: 0, brackets: 0 };
  const nodes = gammaNodes(POSITION_CV[pos], EXPECTATION.nodes);
  let total = 0;
  let brackets = 0;
  for (const g of nodes) {
    const values: Record<Canonical, number> = {};
    for (const k of keys) values[k] = statOf(expectation, k) * g;
    const r = engine.score(lineOf(values, pt), settings);
    total += r.points;
    for (const c of r.contributions) if (c.kind === "bracket") brackets += c.points;
  }
  return { points: denoise(total / nodes.length), brackets: denoise(brackets / nodes.length) };
}

/**
 * E[points] of a defence: points and yards allowed at each equal-probability node of the gamma
 * widths `simulateDefense` samples from (rounded as the samples are), the Poisson counts at their
 * expectation (linear), scored by the engine and averaged; `brackets` = the bracket share.
 */
function expectDefense(
  expectation: Readonly<Record<Canonical, number>>,
  engine: ScoringEngine,
  settings: ScoringSettings,
): Expected {
  const pa = statOf(expectation, "dst_pa");
  const ya = statOf(expectation, "dst_ya");
  const nPa = gammaNodes(DEF_SIM.pointsAllowedCv, EXPECTATION.nodes);
  const nYa = gammaNodes(DEF_SIM.yardsAllowedCv, EXPECTATION.nodes);
  const counts = Object.keys(expectation)
    .filter((k) => k !== "dst_pa" && k !== "dst_ya")
    .sort();
  let total = 0;
  let brackets = 0;
  for (const [i, gPa] of nPa.entries()) {
    const values: Record<Canonical, number> = {};
    values.dst_pa = Math.round(pa * gPa);
    values.dst_ya = Math.round(ya * at(nYa, i));
    for (const k of counts) values[k] = statOf(expectation, k);
    const r = engine.score(lineOf(values, "DT"), settings);
    total += r.points;
    for (const c of r.contributions) if (c.kind === "bracket") brackets += c.points;
  }
  return { points: denoise(total / nPa.length), brackets: denoise(brackets / nPa.length) };
}

// --- per-target projection ------------------------------------------------------------------------------

const A = (text: string, revisit_trigger: string): Assumption => ({ text, revisit_trigger });

/** The omitted-driver assumption when the target weeks' lines are too old (QA-1-004). */
export const LINES_OMITTED: Assumption = Object.freeze(
  A(
    "betting lines omitted: the schedules release that carries them was last checked more than 24 h ago",
    "a successful ff refresh nflverse",
  ),
);

const BASE_ASSUMPTIONS: readonly Assumption[] = Object.freeze([
  A(
    "points width is a position-level CV table around the trailing mean (basis position_cv), not a per-player simulation",
    "v2-opportunity (basis player_sim) replaces it",
  ),
  A(
    "role unchanged over the trailing window (no change-point or depth-chart conditioning in v1)",
    "a depth-chart, snap-share or team change",
  ),
  A(
    "opponent adjustment not applied: the implied team total is the only matchup signal",
    "v2-opportunity adds the regressed opponent term",
  ),
]);

/**
 * Expected points from a position type's bracket families (indicator: Σ P(member) × points; count:
 * Σ E[count] × points) — read off scoreSamples' `bracket_probability` (plan 08 §2).
 */
export function bracketPoints(
  settings: ScoringSettings,
  pt: PositionType,
  s: ScoreSamplesResult,
): number {
  let total = 0;
  for (const fam of settings.brackets) {
    if (fam.position_type !== pt) continue;
    const probs = s.bracket_probability[fam.family];
    if (probs === undefined) continue;
    fam.members.forEach((m, i) => {
      const rule = settings.rules.find(
        (r) => r.canonical === m.canonical && r.position_types.includes(pt),
      );
      if (rule?.modifier != null) total += at(probs, i) * rule.modifier;
    });
  }
  return total;
}

interface Ctx {
  readonly req: ProjectionRequest;
  readonly loaded: Loaded;
  readonly engine: ScoringEngine;
  readonly n: number;
  /** The newest as_of among the loaded datasets (a stored projection's `inputs_as_of`). */
  readonly inputsAsOf: string;
  readonly written: { count: number; busy: number };
  /** Samples for weeks after the first (E5 look-ahead); equals `n` for E1. */
  readonly nLater: number;
  /** The requested n_sims when the line budget reduced it (QA-1-079), else null. */
  readonly reducedFrom: number | null;
}

function projectTarget(t: ProjectionTarget, ctx: Ctx): ProjectedPlayer {
  const { req, loaded, engine, n } = ctx;
  const pos = positionOf(t);
  const assumptions: Assumption[] = [...BASE_ASSUMPTIONS];
  const subjectId = t.subject.kind === "player" ? t.subject.gsis_id : `def-${t.subject.nfl_team}`;
  const windowGames =
    t.subject.kind === "player"
      ? (loaded.playerLines.get(t.subject.gsis_id) ?? [])
      : weightGames(
          loaded.defenseLines.filter(
            (g) => t.subject.kind === "defense" && g.team === t.subject.nfl_team,
          ),
          req.season,
        );
  const team: NflTeam | null =
    t.subject.kind === "defense"
      ? t.subject.nfl_team
      : (t.nfl_team ?? windowGames[0]?.team ?? null);
  const roleGames = windowGames.filter((g) => g.season === req.season && g.team === team).length;
  if (loaded.linesOmitted) assumptions.push(LINES_OMITTED);
  if (ctx.reducedFrom !== null) {
    assumptions.push(
      A(
        `n_sims reduced to ${String(n)} per player-week (from ${String(ctx.reducedFrom)}) to bound one call's simulation work`,
        "ask for fewer players or weeks",
      ),
    );
  }
  if (windowGames.length === 0) {
    assumptions.push(
      A(
        "no trailing games in the window: the projection is the positional prior",
        "after the player's first game",
      ),
    );
  }

  const weeks: ProjectedWeek[] = [];
  const shrinkage: Shrinkage[] = [];
  let firstExpectation: Readonly<Record<Canonical, number>> | null = null;
  let firstMarket: number | null = null;
  let firstWeather: number | null = null;
  const drivers: Driver[] = [];

  for (const [wi, week] of req.weeks.entries()) {
    const nWeek = wi === 0 ? n : ctx.nLater;
    const weekGames = gamesAt(loaded.games, req.season, week);
    const game = team === null ? null : teamGame(team, weekGames);
    const rng = req.rng.fork(`projection:${subjectId}:${String(week)}`);
    const pt: PositionType = pos === null ? "O" : positionTypeOf(pos);
    if (pos === null || team === null || game === null) {
      const why =
        pos === null
          ? A("position not projected by v1-trailing: zero points", "a supported position")
          : team === null
            ? A("no NFL team known: zero points", "the player joins a team")
            : weekGames.length > 0 && week <= WINDOW.priorSeasonLastWeek
              ? A(`bye in week ${String(week)}: zero points`, "never — the schedule is fixed")
              : A(
                  `no game scheduled in week ${String(week)}: zero points`,
                  "the week's games are scheduled (postseason pairings)",
                );
      if (!assumptions.some((a) => a.text === why.text)) assumptions.push(why);
      weeks.push({
        week,
        dist: zeroDist("position_cv"),
        p_active: 0,
        p_active_basis: "none",
        game,
        kickoff_ms: null,
        team,
        opponent: null,
        implied_total: null,
        opp_implied_total: null,
        expectation: Object.freeze({}),
        samples: null,
        e_active_base: 0,
        e_active: 0,
        brackets_e: null,
        market_multiplier: null,
        weather_factor: null,
      });
      continue;
    }
    const opponent = opponentOf(team, game);
    const implied = impliedFor(team, game);
    const oppImplied = impliedFor(opponent, game);
    const ko = kickoffMs(game.kickoff);

    let expectation: Record<Canonical, number>;
    let base: Record<Canonical, number>;
    let marketMult: number | null = null;
    let weatherFactor: number | null = null;
    let availability: Availability;
    if (pos === "DEF") {
      const own = weightedMeans(windowGames);
      const prior = PRIOR_LINES.DEF;
      const sh = shrink(own, prior, (c) => c.startsWith("dst_"));
      if (shrinkage.length === 0) shrinkage.push(...sh.shrinkage);
      // the opponent's rates allowed: every defence line whose opponent was this week's opponent
      const allowed = weightGames(
        loaded.defenseLines.filter((g) => g.opponent === opponent),
        req.season,
      );
      const oppSh = shrink(weightedMeans(allowed), prior, (c) => c.startsWith("dst_"));
      base = { ...sh.line };
      for (const c of ["dst_sack", "dst_int", "dst_fum_rec"]) {
        base[c] =
          DEF_SIM.ownRateWeight * statOf(sh.line, c) +
          (1 - DEF_SIM.ownRateWeight) * statOf(oppSh.line, c);
      }
      if (oppImplied !== null) base.dst_pa = oppImplied;
      else
        assumptions.push(
          A(
            "no betting line: points allowed from the defence's own trailing mean",
            "lines published",
          ),
        );
      expectation = { ...base };
      availability = { p: 1, basis: "none" };
    } else {
      const own = weightedMeans(windowGames);
      const sh = shrink(own, PRIOR_LINES[pos], PLAYER_STAT(pt));
      if (shrinkage.length === 0) shrinkage.push(...sh.shrinkage);
      base = sh.line;
      expectation = { ...base };
      if (implied !== null) {
        const beta = MARKET.beta[pos];
        marketMult = clamp(
          (implied / windowImplied(windowGames, loaded)) ** beta,
          MARKET.minMultiplier,
          MARKET.maxMultiplier,
        );
        for (const k of Object.keys(expectation)) {
          if (isMarketScaled(k)) expectation[k] = statOf(expectation, k) * marketMult;
        }
      } else if (!assumptions.some((a) => a.text.startsWith("no betting line"))) {
        assumptions.push(
          A("no betting line: implied-total scaling not applied", "lines published"),
        );
      }
      if (pos === "K") {
        const wx = loaded.weather.get(game.game_id);
        const roof = (game.roof ?? "").toLowerCase();
        if (
          wx !== undefined &&
          wx.wind_mph !== null &&
          wx.wind_mph >= KDEF.windMph &&
          !INDOOR_ROOFS.includes(roof)
        ) {
          weatherFactor = statOf(KDEF.windFactor, "fg_50p");
          for (const [k, f] of Object.entries(KDEF.windFactor)) {
            if (expectation[k] !== undefined) expectation[k] = statOf(expectation, k) * f;
          }
        }
      }
      const loadedInj = loaded.injuriesLoaded.get(week) === true;
      const rowOf = (w: Week): InjuryReport | null =>
        t.subject.kind === "player"
          ? (loaded.injuries.get(`${t.subject.gsis_id}:${String(w)}`) ?? null)
          : null;
      const prior = week - 1;
      const rosterRow =
        t.subject.kind === "player" ? loaded.rosterRows.get(t.subject.gsis_id) : undefined;
      // the newest roster status at or before this week (never a later week's); INA only that week
      const rosterStatus =
        rosterRow === undefined ||
        rosterRow.week > week ||
        (rosterRow.status?.trim().toUpperCase() === "INA" && rosterRow.week !== week)
          ? null
          : rosterRow.status;
      availability = pActive({
        rosterStatus,
        report: rowOf(week),
        injuriesLoaded: loadedInj,
        reportPublished: loadedInj && loaded.reportTeams.get(week)?.has(team) === true,
        priorPublished: prior >= 1 && loaded.reportTeams.get(prior)?.has(team) === true,
        priorReport: prior >= 1 ? rowOf(prior) : null,
        platformStatus: t.platform_status ?? null,
        gameDayStatus: t.game_day_status,
        kickoffMs: ko,
        nowMs: req.clock.nowMs(),
      });
      if (rosterStatus !== null && isRosterOut(rosterStatus) && availability.p === 0) {
        const why = A(
          `NFL roster status ${rosterStatus.trim().toUpperCase()} (week ${String(rosterRow?.week ?? week)}): not available, zero points`,
          "he returns to the active roster",
        );
        if (!assumptions.some((a) => a.text === why.text)) assumptions.push(why);
      }
      if (availability.carried_from !== undefined) {
        assumptions.push(
          A(
            `week ${String(week)} injury report not published yet for ${team}: the week ${String(availability.carried_from)} designation is carried forward`,
            `${team}'s week ${String(week)} injury report is published (Wednesday–Friday)`,
          ),
        );
      }
      if (availability.p === null) {
        assumptions.push(
          A(
            "availability unknown (injury report not loaded): treated as active",
            "run ff refresh nflverse",
          ),
        );
      }
    }
    for (const k of Object.keys(expectation)) {
      const v = statOf(expectation, k);
      expectation[k] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    const p = availability.p ?? 1;
    const lines =
      pos === "DEF"
        ? simulateDefense(expectation, nWeek, rng)
        : simulatePlayer(expectation, pos, p, nWeek, rng);
    const samples = engine.scoreSamples(lines, req.settings, "position_cv");
    // the model's expectation (QA-1-024): the samples give the spread, never the mean
    const exp =
      pos === "DEF"
        ? expectDefense(expectation, engine, req.settings)
        : expectPlayer(expectation, pos, engine, req.settings);
    const eActive = exp.points;
    const eBase = pos === "DEF" ? eActive : expectPlayer(base, pos, engine, req.settings).points;
    const mean = denoise(p * eActive);
    const dist: Dist = { ...samples.dist, mean };

    if (firstExpectation === null) {
      firstExpectation = Object.freeze(
        Object.fromEntries(Object.entries(expectation).map(([k, v]) => [k, round(v, 3)])),
      );
      firstMarket = marketMult;
      firstWeather = weatherFactor;
      // the drivers decompose the mean exactly (QA-1-025): availability = (p − 1) × E[active]
      if (pos === "DEF") {
        const br = exp.brackets;
        drivers.push({ name: "points_allowed_brackets", contribution: round(br, 3) });
        drivers.push({ name: "counts_and_rare_events", contribution: round(mean - br, 3) });
      } else {
        drivers.push({ name: "trailing_mean", contribution: round(eBase, 3) });
        drivers.push({ name: "implied_total", contribution: round(eActive - eBase, 3) });
        drivers.push({ name: "availability", contribution: round(mean - eActive, 3) });
      }
    }
    if (req.repository !== undefined) {
      const out = req.repository.put({
        subject: t.subject,
        season: req.season,
        week,
        model_version: MODEL_VERSION,
        made_at: req.clock.nowIso(),
        inputs_as_of: ctx.inputsAsOf,
        expectation: Object.freeze({ ...expectation }),
        samples: lines.length > SIMS.stored ? lines.slice(0, SIMS.stored) : lines,
      });
      if (out.written) ctx.written.count += 1;
      else ctx.written.busy += 1;
    }
    weeks.push({
      week,
      dist,
      p_active: availability.p,
      p_active_basis: availability.basis,
      game,
      kickoff_ms: ko,
      team,
      opponent,
      implied_total: implied,
      opp_implied_total: oppImplied,
      expectation: Object.freeze(expectation),
      samples,
      e_active_base: eBase,
      e_active: eActive,
      brackets_e: exp.brackets,
      market_multiplier: marketMult,
      weather_factor: weatherFactor,
    });
  }

  const pubWeeks: ProjectionWeek[] = weeks.map((w) => ({
    week: w.week,
    points: w.dist,
    p_active: w.p_active,
    opponent: w.opponent,
    implied_total: w.implied_total === null ? null : round(w.implied_total, 2),
    p_active_basis: w.p_active_basis,
  }));
  const projection: Projection = {
    player_key: t.player_key,
    gsis_id: t.subject.kind === "player" ? t.subject.gsis_id : null,
    name: t.name,
    position: pos ?? t.position,
    model_version: MODEL_VERSION,
    weeks: pubWeeks,
    ros_total: rosTotal(weeks),
    stat_line_expectation: req.include_stat_line === true ? firstExpectation : null,
    opportunity: null,
    shrinkage,
    multipliers: {
      matchup: firstMarket === null ? null : round(firstMarket, 4),
      weather: firstWeather,
    },
    drivers,
    role_confidence_games: roleGames,
    assumptions,
  };
  return { target: t, projection, weeks, role_games: roleGames };
}

/**
 * The horizon total (plan 07 E1 `ros_total`): null for a one-week horizon; else the sum of the
 * weekly means with the weekly spreads added in quadrature (weeks independent — each week draws
 * from its own stream), as a normal-approximation Dist.
 */
function rosTotal(weeks: readonly ProjectedWeek[]): Dist | null {
  if (weeks.length < 2) return null;
  let mu = 0;
  let v = 0;
  for (const w of weeks) {
    mu += w.dist.mean;
    v += sigmaOf(w.dist) ** 2;
  }
  const d = normalDist(mu, Math.sqrt(v), "position_cv");
  return weeks.every((w) => w.dist.p_zero === 1) ? zeroDist("position_cv") : d;
}

// --- entry point ------------------------------------------------------------------------------------------

function validate(
  req: ProjectionRequest,
  minSims: number,
  maxTargets: number = LIMITS.maxTargets,
): number {
  const n = req.n_sims ?? SIMS.default;
  if (!Number.isInteger(n) || n < minSims || n > SIMS.max) {
    throw new AnalyticsError("invalid_request", "n_sims out of range", ["n_sims"]);
  }
  if (!Number.isInteger(req.season) || req.season < 1999 || req.season > 2100) {
    throw new AnalyticsError("invalid_request", "season out of range", ["season"]);
  }
  if (
    req.weeks.length === 0 ||
    req.weeks.length > LIMITS.maxWeeks ||
    req.weeks.some((w) => !Number.isInteger(w) || w < 1 || w > 22) ||
    new Set(req.weeks).size !== req.weeks.length
  ) {
    throw new AnalyticsError("invalid_request", "weeks must be distinct integers 1..22", ["weeks"]);
  }
  if (req.targets.length > maxTargets) {
    throw new AnalyticsError("invalid_request", "too many players", ["targets"]);
  }
  return n;
}

/**
 * E1 `ff_project_players` (v1-trailing). Deterministic for a fixed Rng seed: every subject-week
 * draws from its own forked stream (`projection:<gsis|def-TEAM>:<week>`), so adding a player never
 * shifts another's numbers. Throws AnalyticsError `invalid_request` (bounds) or
 * `dataset_never_loaded` (schedules / current-season stats never loaded → STALE_ONLY).
 */
export function projectPlayers(req: ProjectionRequest): ProjectionOutcome {
  return run(req, validate(req, SIMS.min), null, SIMS.min);
}

/**
 * The E5 path: the same projection with engine-internal sample sizes below E1's public floor — a
 * ranking needs means, not tails (A15 latency) — and a smaller size for the look-ahead weeks. Its
 * target bound is E5's own (LIMITS.maxKdefCandidates: 32 defences + every team's kicker + mine),
 * not E1's selector bound — the real universe is 64 before my roster's K/DEF join it.
 */
export function projectForRanking(req: ProjectionRequest, nLater: number): ProjectionOutcome {
  const n = validate(req, KDEF.minSims, LIMITS.maxKdefCandidates);
  if (!Number.isInteger(nLater) || nLater < KDEF.minSims || nLater > n) {
    throw new AnalyticsError("invalid_request", "look-ahead n_sims out of range", ["n_sims"]);
  }
  return run(req, n, nLater, KDEF.minSims);
}

/**
 * The per-player-week sample size under the call's line budget (QA-1-079): the requested `n` when
 * all player-weeks fit SIMS.maxTotalLines, else an even share of it, never below `floor`.
 */
function budgeted(n: number, playerWeeks: number, floor: number): number {
  if (playerWeeks === 0 || n * playerWeeks <= SIMS.maxTotalLines) return n;
  return Math.max(floor, Math.min(n, Math.floor(SIMS.maxTotalLines / playerWeeks)));
}

function run(
  req: ProjectionRequest,
  requested: number,
  nLaterReq: number | null,
  floor: number,
): ProjectionOutcome {
  const weeks = [...req.weeks].sort((a, b) => a - b);
  const sorted: ProjectionRequest = { ...req, weeks };
  const needDefense = req.targets.some((t) => t.subject.kind === "defense");
  const loaded = load(sorted, needDefense);
  const written = { count: 0, busy: 0 };
  const n = budgeted(requested, req.targets.length * weeks.length, floor);
  const nLater = Math.min(nLaterReq ?? n, n);
  const ctx: Ctx = {
    req: sorted,
    loaded,
    engine: req.engine ?? scoringEngine,
    n,
    nLater,
    reducedFrom: n < requested ? requested : null,
    // every input that changes the distribution: datasets (weather included), extra stamps, and the
    // platform status source — so the store's repeat-collapse is exact (QA-1-031)
    inputsAsOf: newestAsOf(
      [
        ...loaded.stamps.flatMap((st) => (st === null ? [] : [{ as_of: st.as_of }])),
        ...(req.extra_stamps ?? []).map((st) => ({ as_of: st.as_of })),
        ...(req.status_as_of === undefined ? [] : [{ as_of: req.status_as_of }]),
      ],
      req.clock.nowIso(),
    ),
    written,
  };
  const players = req.targets.map((t) => projectTarget(t, ctx));
  const inputs = collectInputs([...loaded.stamps, ...(req.extra_stamps ?? [])], req.clock);
  return {
    result: { model_version: MODEL_VERSION, projections: players.map((p) => p.projection), inputs },
    players,
    stored: { written: written.count, busy: written.busy },
    lines_omitted: loaded.linesOmitted,
  };
}
