// calendar.ts — the game calendar and the schedule view built from the schedules reader
// (season-fresh spec §2.1, §2.2, §3.2): every kickoff instant (a TBD game as 00:00 and 23:59 ET of
// its gameday), the outdoor subset, the per-season facts and the season phase. `scheduleView` never
// throws — a missing, unreadable or expired schedule degrades to the "everything hot" fallback
// calendar, so the refresh policy and the TTL rule never under-refresh. The file read is memoised
// per (reader, file_version); the phase and tentative weeks are recomputed per instant.
import { freshnessClass, isExpired } from "../../config/freshness.js";
import {
  fallbackCalendar,
  scheduleCalendar,
  type GameCalendar,
} from "../../config/game-calendar.js";
import { ALL_WEEK_INDEXES } from "../../config/weeks.js";
import type { DatasetStamp, NflGame, ScheduleReader } from "../analytics/types.js";
import { tentativeWeeks, type TentativeWeek } from "./kickoff-status.js";
import {
  bootstrapSeason,
  gameInstantsMs,
  seasonPhaseAt,
  seasonSchedule,
  type SeasonPhase,
  type SeasonSchedule,
} from "./season.js";

/** The schedule as every consumer sees it at one instant. */
export interface ScheduleView {
  readonly stamp: DatasetStamp | null;
  readonly calendar: GameCalendar;
  /** Ascending by season; only seasons with at least one game. */
  readonly seasons: readonly SeasonSchedule[];
  readonly phase: SeasonPhase;
  /** Tentative weeks of the phase season from the current week on (≤ 3). */
  readonly tentative: readonly TentativeWeek[];
  /** The loaded games of a season ([] when not loaded). */
  games(season: number): readonly NflGame[];
  schedule(season: number): SeasonSchedule | null;
}

/** At most this many tentative weeks in a view (G1 `schedule.tentative_weeks`). */
export const VIEW_TENTATIVE_MAX = 3;

const ROOFS_INDOOR = new Set(["dome", "closed"]);

/** Whether a game is played outdoors (weather matters): its roof is not dome/closed. */
export function isOutdoorGame(g: NflGame): boolean {
  return g.roof === null || !ROOFS_INDOOR.has(g.roof.toLowerCase());
}

/**
 * The calendar of a set of games: each game's kickoff (a TBD game contributes 00:00 and 23:59 ET of
 * its gameday); outdoor games also feed `outdoor_kickoffs`. No usable instant at all → the
 * `no_kickoffs` fallback.
 */
export function gameCalendarFromGames(
  games: readonly NflGame[],
  fileVersion: string,
): GameCalendar {
  const kickoffs: number[] = [];
  const outdoor: number[] = [];
  for (const g of games) {
    const at = gameInstantsMs(g);
    if (at === null) continue;
    const ks = at.lo === at.hi ? [at.lo] : [at.lo, at.hi];
    kickoffs.push(...ks);
    if (isOutdoorGame(g)) outdoor.push(...ks);
  }
  return scheduleCalendar({ kickoffs, outdoorKickoffs: outdoor, fileVersion });
}

/** What is read once per schedules file version. */
interface FileData {
  readonly fileVersion: string;
  readonly bySeason: ReadonlyMap<number, readonly NflGame[]>;
  readonly seasons: readonly SeasonSchedule[];
  readonly calendar: GameCalendar;
}

const memo = new WeakMap<ScheduleReader, FileData>();
const NO_GAMES: readonly NflGame[] = Object.freeze([]);

function readFile(reader: ScheduleReader, stamp: DatasetStamp, nowMs: number): FileData {
  const b = bootstrapSeason(nowMs);
  const wanted =
    stamp.seasons !== undefined && stamp.seasons.length > 0 ? stamp.seasons : [b - 1, b, b + 1];
  const bySeason = new Map<number, readonly NflGame[]>();
  const all: NflGame[] = [];
  for (const s of [...new Set(wanted)].sort((x, y) => x - y)) {
    const rows = reader.games(s, ALL_WEEK_INDEXES).rows.filter((g) => g.season === s);
    if (rows.length === 0) continue;
    bySeason.set(s, Object.freeze([...rows]));
    all.push(...rows);
  }
  return {
    fileVersion: stamp.file_version,
    bySeason,
    seasons: Object.freeze([...bySeason.keys()].map((s) => seasonSchedule(all, s))),
    calendar: gameCalendarFromGames(all, stamp.file_version),
  };
}

function viewOf(
  stamp: DatasetStamp | null,
  calendar: GameCalendar,
  data: FileData | null,
  nowMs: number,
): ScheduleView {
  const seasons = data?.seasons ?? [];
  const phase = seasonPhaseAt(nowMs, seasons);
  const games = (season: number): readonly NflGame[] => data?.bySeason.get(season) ?? NO_GAMES;
  const schedule = (season: number): SeasonSchedule | null =>
    seasons.find((s) => s.season === season) ?? null;
  const tentative = Object.freeze(
    tentativeWeeks({ games, schedule, phase }, nowMs, VIEW_TENTATIVE_MAX),
  );
  return Object.freeze({ stamp, calendar, seasons, phase, tentative, games, schedule });
}

/**
 * The schedule view at `nowMs`. Never throws: no stamp → fallback `never_loaded` + bootstrap phase;
 * the reader throws → `unreadable` (bootstrap phase; the stamp when it was read); the schedules file past its hard limit → calendar fallback
 * `expired` (seasons and phase still from the file). Seasons read = `stamp.seasons`, else the
 * bootstrap season ± 1. Memoised per (reader, file_version): a republish re-reads.
 */
export function scheduleView(reader: ScheduleReader, nowMs: number): ScheduleView {
  let stamp: DatasetStamp | null = null;
  let data: FileData;
  try {
    stamp = reader.games(bootstrapSeason(nowMs), [1]).stamp;
    if (stamp === null) return viewOf(null, fallbackCalendar("never_loaded"), null, nowMs);
    const cached = memo.get(reader);
    if (cached?.fileVersion === stamp.file_version) data = cached;
    else {
      data = readFile(reader, stamp, nowMs);
      memo.set(reader, data);
    }
  } catch {
    return viewOf(stamp, fallbackCalendar("unreadable"), null, nowMs);
  }
  let expired: boolean;
  try {
    expired = isExpired(freshnessClass("nflverse_schedules"), stamp, nowMs);
  } catch {
    expired = true; // a stamp with unparseable instants is never trusted as fresh
  }
  return viewOf(stamp, expired ? fallbackCalendar("expired") : data.calendar, data, nowMs);
}
