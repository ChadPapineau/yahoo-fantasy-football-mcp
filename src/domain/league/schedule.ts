// schedule.ts — what the NFL schedule implies for a fantasy league (plan 07 B1 `bye_week`,
// `kickoff`, `lock_at`, `lock_schedule[]`, `latest_execution_time`; plan 05 §14.2; research 05 §3.4
// Thursday/Monday locking and §14 item 2 "every action carries its latest execution time"; research
// 03 §D.2 default lock = the player's own kickoff, weekly-lock leagues lock everyone at once):
// bye weeks, per-player and weekly lock instants, the lock schedule, and the current/next week from
// the schedule and a Clock. Pure: time comes in as epoch ms, never from Date.now().
import type { NflTeam } from "../../config/schema.js";
import type { NflGame } from "../analytics/types.js";
import type { IsoInstant, LeagueWeek, LockScheduleEntry, PlayerKey, Week } from "./types.js";

/** How a league locks lineups (research 03 §D.2): at each player's kickoff, or once for the week. */
export type LockMode = "per_game" | "weekly";

/** After a week's last kickoff, how long until the week counts as over (a game plus overtime). */
export const GAME_WINDOW_MS = 4 * 60 * 60 * 1000;

/** Epoch ms of an ISO instant, or null when it is missing or not a valid instant. */
export function kickoffMs(kickoff: IsoInstant | null): number | null {
  if (kickoff === null) return null;
  const ms = Date.parse(kickoff);
  return Number.isFinite(ms) ? ms : null;
}

/** Canonical ISO string for epoch ms. */
function iso(ms: number): IsoInstant {
  return new Date(ms).toISOString();
}

/** The games of one season-week. */
export function gamesOfWeek(games: readonly NflGame[], season: number, week: Week): NflGame[] {
  return games.filter((g) => g.season === season && g.week === week);
}

/** The sorted distinct weeks that have at least one game in `season`. */
export function scheduledWeeks(games: readonly NflGame[], season: number): Week[] {
  const s = new Set<Week>();
  for (const g of games) if (g.season === season) s.add(g.week);
  return [...s].sort((a, b) => a - b);
}

/**
 * Bye weeks per team: for every week the schedule has games in, each of `teams` with no game that
 * week is on bye. Weeks with no games at all are not byes (the schedule simply does not cover them).
 */
export function byeWeeks(
  games: readonly NflGame[],
  season: number,
  teams: readonly NflTeam[],
): ReadonlyMap<NflTeam, readonly Week[]> {
  const out = new Map<NflTeam, Week[]>();
  for (const t of teams) out.set(t, []);
  for (const w of scheduledWeeks(games, season)) {
    const playing = new Set<string>();
    for (const g of gamesOfWeek(games, season, w)) {
      playing.add(g.away);
      playing.add(g.home);
    }
    for (const t of teams) if (!playing.has(t)) out.get(t)?.push(w);
  }
  return out;
}

/** A team's first bye week, or null (no bye in the covered weeks). */
export function byeWeekOf(team: NflTeam, byes: ReadonlyMap<NflTeam, readonly Week[]>): Week | null {
  return byes.get(team)?.[0] ?? null;
}

/**
 * A team's game in the given week's games (the earliest by kickoff if the data ever holds two);
 * null on bye. A game whose kickoff is unknown still counts as the team's game.
 */
export function teamGame(team: NflTeam, weekGames: readonly NflGame[]): NflGame | null {
  let best: NflGame | null = null;
  for (const g of weekGames) {
    if (g.away !== team && g.home !== team) continue;
    if (best === null) best = g;
    else {
      const a = kickoffMs(g.kickoff);
      const b = kickoffMs(best.kickoff);
      if (a !== null && (b === null || a < b)) best = g;
    }
  }
  return best;
}

/** The opponent of `team` in `game`. */
export function opponentOf(team: NflTeam, game: NflGame): NflTeam {
  return game.away === team ? game.home : game.away;
}

/** The earliest known kickoff among the games (ISO), or null. */
export function firstKickoff(weekGames: readonly NflGame[]): IsoInstant | null {
  let min: number | null = null;
  for (const g of weekGames) {
    const k = kickoffMs(g.kickoff);
    if (k !== null && (min === null || k < min)) min = k;
  }
  return min === null ? null : iso(min);
}

/** The latest known kickoff among the games (ISO), or null. */
export function lastKickoff(weekGames: readonly NflGame[]): IsoInstant | null {
  let max: number | null = null;
  for (const g of weekGames) {
    const k = kickoffMs(g.kickoff);
    if (k !== null && (max === null || k > max)) max = k;
  }
  return max === null ? null : iso(max);
}

/**
 * When a player on `team` locks for the week. `per_game`: at their own game's kickoff (null on bye
 * or when the kickoff is unknown — nothing to lock against). `weekly`: at the week's first known
 * kickoff for every player, bye or not (the lineup as a whole locks then). A null team (free agent)
 * locks only under `weekly`.
 */
export function lockAtFor(
  team: NflTeam | null,
  weekGames: readonly NflGame[],
  mode: LockMode,
): IsoInstant | null {
  if (mode === "weekly") return firstKickoff(weekGames);
  if (team === null) return null;
  const g = teamGame(team, weekGames);
  if (g === null) return null;
  const k = kickoffMs(g.kickoff);
  return k === null ? null : iso(k);
}

/** One subject of a lock schedule. */
export interface LockSubject {
  readonly player_key: PlayerKey;
  readonly nfl_team: NflTeam | null;
}

/**
 * The lock schedule (plan 07 B1): one entry per distinct lock instant, ascending, each with its
 * player keys sorted; players with no lock instant (bye, unknown kickoff) are omitted.
 */
export function lockSchedule(
  subjects: readonly LockSubject[],
  weekGames: readonly NflGame[],
  mode: LockMode,
): LockScheduleEntry[] {
  const by = new Map<number, Set<PlayerKey>>();
  for (const s of subjects) {
    const at = kickoffMs(lockAtFor(s.nfl_team, weekGames, mode));
    if (at === null) continue;
    const set = by.get(at) ?? new Set<PlayerKey>();
    set.add(s.player_key);
    by.set(at, set);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([at, keys]) =>
      Object.freeze({ lock_at: iso(at), player_keys: Object.freeze([...keys].sort()) }),
    );
}

/** Whether a lock instant has passed at `nowMs` (a null lock never locks). Lock is inclusive. */
export function isLocked(lockAt: IsoInstant | null, nowMs: number): boolean {
  const at = kickoffMs(lockAt);
  return at !== null && nowMs >= at;
}

/**
 * The latest time a recommendation on this roster can still be executed (plan 07 B1
 * `latest_execution_time`; research 05 §14 item 2): the earliest lock instant still in the future,
 * or null when every scheduled lock has passed (or none exists).
 */
export function latestExecutionTime(
  schedule: readonly LockScheduleEntry[],
  nowMs: number,
): IsoInstant | null {
  let best: number | null = null;
  for (const e of schedule) {
    const at = kickoffMs(e.lock_at);
    if (at !== null && at > nowMs && (best === null || at < best)) best = at;
  }
  return best === null ? null : iso(best);
}

// --- league weeks -----------------------------------------------------------------------------------

/** A league's week range. */
export interface WeekRange {
  readonly start_week: Week;
  readonly end_week: Week;
}

/** Where the league is in its season at an instant. */
export interface WeekPosition {
  /** The week lineups currently apply to (the first in range not yet over; the last when finished). */
  readonly current: Week;
  /** The next scheduled week in range after `current`, or null. */
  readonly next: Week | null;
  /** Every scheduled week in range is over. */
  readonly is_finished: boolean;
}

/** The instant a week counts as over: its last known kickoff plus GAME_WINDOW_MS; null if none. */
export function weekEndsAt(weekGames: readonly NflGame[]): number | null {
  const last = kickoffMs(lastKickoff(weekGames));
  return last === null ? null : last + GAME_WINDOW_MS;
}

/**
 * The current and next week from the schedule and an instant (the Clock's `nowMs()`): the current
 * week is the first scheduled week in range whose last game is not yet over — so it advances once
 * Monday night's game ends. Before the season it is the first week; after, the last (finished).
 * Null when the schedule has no week with a known kickoff in range (the caller falls back).
 */
export function weekPosition(
  games: readonly NflGame[],
  season: number,
  range: WeekRange,
  nowMs: number,
): WeekPosition | null {
  const weeks = scheduledWeeks(games, season).filter(
    (w) =>
      w >= range.start_week &&
      w <= range.end_week &&
      weekEndsAt(gamesOfWeek(games, season, w)) !== null,
  );
  if (weeks.length === 0) return null;
  let idx = weeks.findIndex((w) => nowMs < (weekEndsAt(gamesOfWeek(games, season, w)) ?? 0));
  const finished = idx === -1;
  if (finished) idx = weeks.length - 1;
  return Object.freeze({
    current: weeks[idx] ?? range.start_week,
    next: finished ? null : (weeks[idx + 1] ?? null),
    is_finished: finished,
  });
}

/** The US-Eastern calendar date (YYYY-MM-DD) of an instant — NFL weeks are Eastern-time weeks. */
export function easternDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** A YYYY-MM-DD date shifted by whole days (UTC calendar arithmetic, so no DST drift). */
export function shiftDate(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The league calendar (plan 07 A2 `weeks[]`): one row per scheduled week in range. `end` is the
 * Eastern date of the week's last kickoff and `start` the six days before it (a Tuesday for a
 * Monday-night week); `is_current` from `weekPosition`; `provisional` while any game of the week is
 * not final.
 */
export function leagueWeeks(
  games: readonly NflGame[],
  season: number,
  range: WeekRange,
  nowMs: number,
): LeagueWeek[] {
  const pos = weekPosition(games, season, range, nowMs);
  const out: LeagueWeek[] = [];
  for (const w of scheduledWeeks(games, season)) {
    if (w < range.start_week || w > range.end_week) continue;
    const wg = gamesOfWeek(games, season, w);
    const last = kickoffMs(lastKickoff(wg));
    if (last === null) continue;
    const end = easternDate(last);
    out.push(
      Object.freeze({
        week: w,
        start: shiftDate(end, -6),
        end,
        is_current: pos !== null && pos.current === w && !pos.is_finished,
        provisional: wg.some((g) => !g.is_final),
      }),
    );
  }
  return out;
}
