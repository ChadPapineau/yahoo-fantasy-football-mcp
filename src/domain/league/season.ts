// season.ts — the season model derived from the loaded schedule (season-fresh spec §2.3, §2.4):
// per-season facts (first kickoff, regular and postseason weeks, when the regular season and the
// season end) and the phase at an instant (preseason / regular / postseason / offseason). One rule
// for "which season is it" everywhere — the schedule data — and a bootstrap rule (the September
// switch) only while no schedule is loaded. Pure: time comes in as epoch ms.
import type { DatasetSourceId } from "../../config/freshness.js";
import { easternWallTimeMs, GAME_WINDOW_MS, isIsoDate } from "../../config/game-calendar.js";
import type { NflGame } from "../analytics/types.js";
import type { IsoInstant, Week } from "./types.js";

const DAY_MS = 86_400_000;

/** The four season phases. */
export type SeasonPhaseName = "preseason" | "regular" | "postseason" | "offseason";

/** One week of a season: its kickoff span (a TBD game counts 00:00–23:59 ET of its gameday). */
export interface SeasonWeekSpan {
  readonly week: Week;
  /** A week of postseason games (their `game_type` is known and not `REG`). */
  readonly postseason: boolean;
  readonly first_ms: number;
  readonly last_ms: number;
}

/** Per-season facts from the loaded schedule. */
export interface SeasonSchedule {
  readonly season: number;
  /** The earliest REG kickoff (a TBD game counts at 00:00 ET of its gameday), or null. */
  readonly first_kickoff: IsoInstant | null;
  /** Weeks with regular-season games, ascending. */
  readonly reg_weeks: readonly Week[];
  readonly last_reg_week: Week | null;
  /** Weeks with postseason games, ascending. */
  readonly post_weeks: readonly Week[];
  readonly last_week: Week | null;
  /** The last REG kickoff + GAME_WINDOW_MS. */
  readonly last_reg_end: IsoInstant | null;
  /** The Super Bowl's kickoff + 4 h; else the last postseason kickoff + 4 h when later than
   *  `last_reg_end`; else null (not yet known). */
  readonly season_end: IsoInstant | null;
  /** The file holds the Super Bowl. */
  readonly has_final: boolean;
  /** Per-week kickoff spans, ascending (additive: the phase's week; absent → week null). */
  readonly week_spans?: readonly SeasonWeekSpan[];
  /** Every kickoff of the season, epoch ms ascending, TBD games at 00:00 ET (additive). */
  readonly kickoffs_ms?: readonly number[];
}

/** Where the NFL is at an instant. */
export interface SeasonPhase {
  readonly season: number;
  readonly phase: SeasonPhaseName;
  /** The current week (regular: week 1 before the opener; postseason: the current playoff week). */
  readonly week: Week | null;
  readonly next_kickoff: IsoInstant | null;
  /** Preseason: true; offseason: false (the next season's schedule is not loaded yet). */
  readonly next_season_published: boolean;
  readonly basis: "schedule" | "bootstrap";
}

/** The preseason ends (and the regular phase starts) this long before the first kickoff. */
export const PRESEASON_LEAD_MS = 7 * DAY_MS;
/** The postseason phase lasts this long after the season ends. */
export const POSTSEASON_TAIL_MS = 14 * DAY_MS;
/** A structural bound when the season end is not yet known: wild card to Super Bowl plus margin. */
export const POSTSEASON_MAX_MS = 42 * DAY_MS;

const iso = (ms: number): IsoInstant => new Date(ms).toISOString();

/** Whether a game is a regular-season game (an unknown `game_type` is judged REG). */
export function isRegularGame(g: NflGame): boolean {
  return typeof g.game_type !== "string" || g.game_type === "REG";
}

/**
 * A game's kickoff instants: [k, k] for a known kickoff; [00:00, 23:59] ET of its gameday for a TBD
 * game (DST-aware); null when neither is known.
 */
export function gameInstantsMs(g: NflGame): { readonly lo: number; readonly hi: number } | null {
  if (g.kickoff !== null) {
    const k = Date.parse(g.kickoff);
    if (Number.isFinite(k)) return { lo: k, hi: k };
  }
  const day = g.gameday;
  if (typeof day === "string" && isIsoDate(day))
    return { lo: easternWallTimeMs(day, 0, 0), hi: easternWallTimeMs(day, 23, 59) };
  return null;
}

const sortedWeeks = (s: ReadonlySet<Week>): Week[] => [...s].sort((a, b) => a - b);
const maxOf = (xs: Iterable<number>): number | null => {
  let m: number | null = null;
  for (const x of xs) if (m === null || x > m) m = x;
  return m;
};

/** The facts of one season from its games (games of other seasons are ignored). */
export function seasonSchedule(games: readonly NflGame[], season: number): SeasonSchedule {
  const reg = new Set<Week>();
  const post = new Set<Week>();
  const spans = new Map<Week, { post: boolean; lo: number; hi: number }>();
  const kickoffs = new Set<number>();
  let firstReg: number | null = null;
  let lastReg: number | null = null;
  let lastPost: number | null = null;
  let sbLast: number | null = null;
  let hasFinal = false;
  for (const g of games) {
    if (g.season !== season) continue;
    const isReg = isRegularGame(g);
    (isReg ? reg : post).add(g.week);
    if (g.game_type === "SB") hasFinal = true;
    const at = gameInstantsMs(g);
    const span = spans.get(g.week);
    if (span === undefined) {
      if (at !== null) spans.set(g.week, { post: !isReg, lo: at.lo, hi: at.hi });
    } else {
      span.post ||= !isReg;
      if (at !== null) {
        span.lo = Math.min(span.lo, at.lo);
        span.hi = Math.max(span.hi, at.hi);
      }
    }
    if (at === null) continue;
    kickoffs.add(at.lo);
    if (isReg) {
      firstReg = firstReg === null ? at.lo : Math.min(firstReg, at.lo);
      lastReg = lastReg === null ? at.hi : Math.max(lastReg, at.hi);
    } else {
      lastPost = lastPost === null ? at.hi : Math.max(lastPost, at.hi);
      if (g.game_type === "SB") sbLast = sbLast === null ? at.hi : Math.max(sbLast, at.hi);
    }
  }
  const lastRegEnd = lastReg === null ? null : lastReg + GAME_WINDOW_MS;
  const lastPostEnd = lastPost === null ? null : lastPost + GAME_WINDOW_MS;
  const seasonEnd =
    sbLast !== null
      ? sbLast + GAME_WINDOW_MS
      : lastPostEnd !== null && (lastRegEnd === null || lastPostEnd > lastRegEnd)
        ? lastPostEnd
        : null;
  const regWeeks = sortedWeeks(reg);
  const postWeeks = sortedWeeks(post);
  return Object.freeze({
    season,
    first_kickoff: firstReg === null ? null : iso(firstReg),
    reg_weeks: Object.freeze(regWeeks),
    last_reg_week: maxOf(regWeeks),
    post_weeks: Object.freeze(postWeeks),
    last_week: maxOf([...regWeeks, ...postWeeks]),
    last_reg_end: lastRegEnd === null ? null : iso(lastRegEnd),
    season_end: seasonEnd === null ? null : iso(seasonEnd),
    has_final: hasFinal,
    week_spans: Object.freeze(
      [...spans.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([week, s]) =>
          Object.freeze({ week, postseason: s.post, first_ms: s.lo, last_ms: s.hi }),
        ),
    ),
    kickoffs_ms: Object.freeze([...kickoffs].sort((a, b) => a - b)),
  });
}

/** The season's last regular-season week from the schedule; null when unknown (no schedule). */
export function lastRegularWeek(s: SeasonSchedule | null): Week | null {
  return s?.last_reg_week ?? null;
}

/**
 * The bootstrap season, used ONLY while no schedule is loaded: the calendar year from September
 * (UTC), the previous year through August.
 */
export function bootstrapSeason(nowMs: number): number {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 8 ? y : y - 1;
}

function bootstrapPhase(nowMs: number): SeasonPhase {
  const month = new Date(nowMs).getUTCMonth();
  const phase: SeasonPhaseName =
    month >= 8 || month === 0 ? "regular" : month === 1 ? "postseason" : "offseason";
  return Object.freeze({
    season: bootstrapSeason(nowMs),
    phase,
    week: null,
    next_kickoff: null,
    next_season_published: false,
    basis: "bootstrap",
  });
}

interface Bounds {
  readonly s: SeasonSchedule;
  readonly start: number;
  readonly regEnd: number;
  readonly tail: number;
}

function boundsOf(s: SeasonSchedule): Bounds | null {
  if (s.first_kickoff === null || s.last_reg_end === null) return null;
  const regEnd = Date.parse(s.last_reg_end);
  const end = s.season_end === null ? regEnd + POSTSEASON_MAX_MS : Date.parse(s.season_end);
  return {
    s,
    start: Date.parse(s.first_kickoff) - PRESEASON_LEAD_MS,
    regEnd,
    tail: end + POSTSEASON_TAIL_MS,
  };
}

/** The first week (of the given kind) not yet over at `nowMs`, or null. */
function currentWeek(s: SeasonSchedule, postseason: boolean, nowMs: number): Week | null {
  const spans = (s.week_spans ?? []).filter((w) => w.postseason === postseason);
  for (const w of spans) if (w.last_ms + GAME_WINDOW_MS > nowMs) return w.week;
  return null;
}

function nextKickoff(seasons: readonly SeasonSchedule[], nowMs: number): IsoInstant | null {
  let best: number | null = null;
  for (const s of seasons)
    for (const k of s.kickoffs_ms ?? []) if (k > nowMs && (best === null || k < best)) best = k;
  return best === null ? null : iso(best);
}

/**
 * The phase at `nowMs` (§2.3). Let X be the latest season whose regular phase has started
 * (`now ≥ first_kickoff − 7 d`): regular while `now ≤ last_reg_end`, postseason while `now ≤ end +
 * 14 d` (end = the season end, or `last_reg_end + 42 d` when not yet known); after that the next
 * loaded season's preseason, else X's offseason. Before every loaded season: the earliest's
 * preseason. No season with a known first kickoff → the bootstrap phase. Total; the season never
 * decreases as time passes.
 */
export function seasonPhaseAt(nowMs: number, seasons: readonly SeasonSchedule[]): SeasonPhase {
  const known = seasons
    .map(boundsOf)
    .filter((b): b is Bounds => b !== null)
    .sort((a, b) => a.s.season - b.s.season);
  const first = known[0];
  if (first === undefined) return bootstrapPhase(nowMs);
  // x = the latest season whose regular phase has started; after = the next loaded season
  let x: Bounds | null = null;
  let after: Bounds | null = null;
  for (const b of known) {
    if (nowMs >= b.start) {
      x = b;
      after = null;
    } else after ??= b;
  }
  const phase = (b: Bounds, name: SeasonPhaseName, week: Week | null): SeasonPhase =>
    Object.freeze({
      season: b.s.season,
      phase: name,
      week,
      next_kickoff: nextKickoff(seasons, nowMs),
      next_season_published:
        name === "preseason"
          ? true
          : name === "offseason"
            ? false
            : known.some((k) => k.s.season === b.s.season + 1),
      basis: "schedule",
    });
  if (x === null) return phase(first, "preseason", null);
  if (nowMs <= x.regEnd) {
    const w = currentWeek(x.s, false, nowMs);
    const fallbackWeek = x.s.week_spans === undefined ? null : x.s.last_reg_week;
    return phase(x, "regular", w ?? fallbackWeek);
  }
  if (nowMs <= x.tail) return phase(x, "postseason", currentWeek(x.s, true, nowMs));
  return after === null ? phase(x, "offseason", null) : phase(after, "preseason", null);
}

/**
 * The seasons a refresh of `source` should fetch in `phase` (§2.4): schedules S−1..S+1 always;
 * weekly stats S−1, S; injuries and weather S; weekly rosters S (regular/postseason), S−1, S
 * (preseason: S−1 for the crosswalk) or S, S+1 (offseason: upstream moves rosters to S+1 in March).
 * Any other source: [S]. Ascending.
 */
export function refreshSeasons(source: DatasetSourceId, phase: SeasonPhase): number[] {
  const s = phase.season;
  switch (source) {
    case "nflverse:schedules":
      return [s - 1, s, s + 1];
    case "nflverse:stats_player_week":
      return [s - 1, s];
    case "nflverse:roster_weekly":
      return phase.phase === "preseason"
        ? [s - 1, s]
        : phase.phase === "offseason"
          ? [s, s + 1]
          : [s];
    default:
      return [s];
  }
}
