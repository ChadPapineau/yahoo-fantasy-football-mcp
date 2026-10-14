// reader.ts — in-memory ScheduleReaders for the season-model tests (season-fresh spec §12 B1
// helpers): a loaded file whose stamp carries `seasons`, a never-loaded file, and a throwing one.
// Read-only for other test files; every reader counts its `games` calls (memoisation checks).
import type { DatasetStamp, NflGame, ScheduleReader } from "../../../src/domain/analytics/types.js";
import type { Week } from "../../../src/domain/league/types.js";

/** A reader plus how many times `games` was called. */
export type CountingScheduleReader = ScheduleReader & { readonly calls: () => number };

/** Options of `scheduleReaderOf`. */
export interface ReaderOptions {
  readonly fileVersion?: string;
  /** The stamp's seasons; default = every season present; `null` = leave `seasons` off the stamp. */
  readonly seasons?: readonly number[] | null;
  readonly checkedAt?: string;
  readonly fetchedAt?: string;
  readonly asOf?: string;
}

/** The stamp an in-memory schedules file carries. */
export function scheduleStamp(games: readonly NflGame[], o: ReaderOptions = {}): DatasetStamp {
  const seasons =
    o.seasons === null
      ? undefined
      : (o.seasons ?? [...new Set(games.map((g) => g.season))].sort((a, b) => a - b));
  const checked = o.checkedAt ?? "2026-09-30T16:00:00.000Z";
  return {
    source: "nflverse:schedules",
    as_of: o.asOf ?? checked,
    fetched_at: o.fetchedAt ?? checked,
    checked_at: checked,
    freshness_class: "nflverse_schedules",
    file_version: o.fileVersion ?? "v1",
    ...(seasons === undefined ? {} : { seasons: Object.freeze([...seasons]) }),
  };
}

/** An in-memory schedules file over `games`. */
export function scheduleReaderOf(
  games: readonly NflGame[],
  o: ReaderOptions = {},
): CountingScheduleReader {
  const stamp = scheduleStamp(games, o);
  let calls = 0;
  return {
    games(season: number, weeks: readonly Week[]) {
      calls++;
      const ws = new Set(weeks);
      return { rows: games.filter((g) => g.season === season && ws.has(g.week)), stamp };
    },
    firstKickoff(season: number, week: Week) {
      let best: number | null = null;
      for (const g of games) {
        if (g.season !== season || g.week !== week || g.kickoff === null) continue;
        const k = Date.parse(g.kickoff);
        if (best === null || k < best) best = k;
      }
      return best === null ? null : new Date(best).toISOString();
    },
    calls: () => calls,
  };
}

/** A schedules file that was never loaded (stamp null). */
export function neverLoadedScheduleReader(): CountingScheduleReader {
  let calls = 0;
  return {
    games() {
      calls++;
      return { rows: [], stamp: null };
    },
    firstKickoff: () => null,
    calls: () => calls,
  };
}

/**
 * A schedules file whose reads throw — always, or (with `afterProbe`) only once a read asks for more
 * than one week (the store reader's week bound before WEEK_INDEX_MAX).
 */
export function throwingScheduleReader(
  o: { readonly afterProbe?: { readonly games: readonly NflGame[] } } = {},
): CountingScheduleReader {
  let calls = 0;
  const stamp = o.afterProbe === undefined ? null : scheduleStamp(o.afterProbe.games);
  return {
    games(_season: number, weeks: readonly Week[]) {
      calls++;
      if (stamp !== null && weeks.length === 1) return { rows: [], stamp };
      throw new RangeError("store: week must be an integer in 1..22");
    },
    firstKickoff: () => {
      throw new RangeError("unreadable");
    },
    calls: () => calls,
  };
}

/** A schedules file that can be republished in place (same reader object, a new file version). */
export function mutableScheduleReader(
  games: readonly NflGame[],
  o: ReaderOptions = {},
): CountingScheduleReader & { publish(next: readonly NflGame[], o?: ReaderOptions): void } {
  let current = scheduleReaderOf(games, o);
  let calls = 0;
  return {
    games(season: number, weeks: readonly Week[]) {
      calls++;
      return current.games(season, weeks);
    },
    firstKickoff: (season: number, week: Week) => current.firstKickoff(season, week),
    calls: () => calls,
    publish(next: readonly NflGame[], no: ReaderOptions = {}) {
      current = scheduleReaderOf(next, no);
    },
  };
}
