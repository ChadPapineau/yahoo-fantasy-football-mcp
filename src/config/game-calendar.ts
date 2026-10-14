// game-calendar.ts — kickoff-relative instant windows over a sorted kickoff list (season-fresh spec
// §2.2; QA-2-037: game days come from the schedule data, never from a weekday rule). Every window is
// an interval of epoch milliseconds around a kickoff instant, so every function here returns the same
// result in every time zone. Imports only src/config (the domain builds the calendar from ds_games;
// src/domain/league/calendar.ts).
//
// Windows per kickoff k: pregame [k−3h, k+4h), gameday [k−24h, k−3h), report [k−48h, k),
// postgame [k+4h, k+16h), in_season (a kickoff within ±7 d), else off_season. Hot = [k−24h, k+4h).
// A fallback calendar (no usable schedule) is hot everywhere: never under-refresh.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** After a kickoff, how long the game counts as in progress (a game plus overtime). */
export const GAME_WINDOW_MS = 4 * HOUR_MS;
/** The pregame window opens this long before a kickoff (inactives, final lines). */
export const PREGAME_MS = 3 * HOUR_MS;
/** The game-day (hot) window opens this long before a kickoff (lines move the day before). */
export const GAMEDAY_LEAD_MS = 24 * HOUR_MS;
/** The injury-report window opens this long before a kickoff. */
export const REPORT_LEAD_MS = 48 * HOUR_MS;
/** The post-game window (stats corrections) closes this long after a kickoff. */
export const POSTGAME_MS = 16 * HOUR_MS;
/** In season = a kickoff within ± this (equals SEASON_WINDOW_DAYS in src/sources/runner.ts). */
export const IN_SEASON_MS = 7 * DAY_MS;

/** Where a calendar came from: the loaded schedule, or the never-under-refresh fallback. */
export type CalendarBasis = "schedule" | "fallback";
/** Why a calendar is a fallback (`no_kickoffs` = the file holds no game with a kickoff or gameday). */
export type CalendarFallbackReason = "never_loaded" | "unreadable" | "expired" | "no_kickoffs";
/** The kickoff-relative phases an instant can be in (several at once; never none). */
export type CalendarPhase =
  "pregame" | "gameday" | "report" | "postgame" | "in_season" | "off_season";

/** The phases, tightest refresh first (the order `phasesAt` sets are documented in). */
export const CALENDAR_PHASES: readonly CalendarPhase[] = Object.freeze([
  "pregame",
  "gameday",
  "report",
  "postgame",
  "in_season",
  "off_season",
]);

/** The kickoff instants of the loaded schedule, or a fallback. */
export interface GameCalendar {
  readonly basis: CalendarBasis;
  /** null iff basis === "schedule". */
  readonly reason: CalendarFallbackReason | null;
  /** Epoch ms, ascending, unique. Empty for a fallback. */
  readonly kickoffs: readonly number[];
  /** The subset whose game roof is not dome/closed (weather matters). */
  readonly outdoor_kickoffs: readonly number[];
  /** The schedules file version the calendar was built from; null for a fallback. */
  readonly file_version: string | null;
}

const EMPTY: readonly number[] = Object.freeze([]);

/** A calendar for when no usable schedule exists: every instant is hot, phases = {pregame}. */
export function fallbackCalendar(reason: CalendarFallbackReason): GameCalendar {
  return Object.freeze({
    basis: "fallback",
    reason,
    kickoffs: EMPTY,
    outdoor_kickoffs: EMPTY,
    file_version: null,
  });
}

/** Sorted, unique, finite instants (input order and duplicates do not matter). */
function sortedUnique(xs: readonly number[]): readonly number[] {
  const out = [...new Set(xs.filter((x) => Number.isFinite(x)))].sort((a, b) => a - b);
  return Object.freeze(out);
}

/**
 * A calendar over the schedule's kickoff instants. With no finite kickoff at all it is the
 * `no_kickoffs` fallback (never under-refresh); a file whose kickoffs are all far from now
 * (off-season) is a schedule calendar.
 */
export function scheduleCalendar(i: {
  readonly kickoffs: readonly number[];
  readonly outdoorKickoffs: readonly number[];
  readonly fileVersion: string;
}): GameCalendar {
  const kickoffs = sortedUnique(i.kickoffs);
  if (kickoffs.length === 0) return fallbackCalendar("no_kickoffs");
  const all = new Set(kickoffs);
  return Object.freeze({
    basis: "schedule",
    reason: null,
    kickoffs,
    outdoor_kickoffs: sortedUnique(i.outdoorKickoffs.filter((k) => all.has(k))),
    file_version: i.fileVersion,
  });
}

/** Index of the first element > x (binary search over an ascending array). */
export function firstAfter(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = xs[mid];
    if (v !== undefined && v > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the first element ≥ x. */
function firstAtOrAfter(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const v = xs[mid];
    if (v !== undefined && v >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Whether some kickoff lies in [lo, hi] (inclusive) — the window test every rule reduces to. */
export function anyKickoffIn(xs: readonly number[], lo: number, hi: number): boolean {
  const k = xs[firstAtOrAfter(xs, lo)];
  return k !== undefined && k <= hi;
}

/** [k − GAMEDAY_LEAD_MS, k + GAME_WINDOW_MS) for some kickoff k; true for a fallback. */
export function inHotWindow(cal: GameCalendar, ms: number): boolean {
  if (cal.basis === "fallback") return true;
  // k − 24h ≤ ms < k + 4h  ⇔  ms − 4h < k ≤ ms + 24h
  const k = cal.kickoffs[firstAfter(cal.kickoffs, ms - GAME_WINDOW_MS)];
  return k !== undefined && k <= ms + GAMEDAY_LEAD_MS;
}

/** `ms` itself when hot; the next window start; null when none. A fallback returns `ms`. */
export function nextHotStart(cal: GameCalendar, ms: number): number | null {
  if (inHotWindow(cal, ms)) return ms;
  // not hot: every kickoff k > ms − 4h also has k > ms + 24h, so the next start is k − 24h of the
  // first kickoff after ms + 24h
  const i = firstAfter(cal.kickoffs, ms + GAMEDAY_LEAD_MS);
  const k = cal.kickoffs[i];
  return k === undefined ? null : k - GAMEDAY_LEAD_MS;
}

/** Never empty; a fallback gives {"pregame"}. */
export function phasesAt(cal: GameCalendar, ms: number): ReadonlySet<CalendarPhase> {
  const out = new Set<CalendarPhase>();
  if (cal.basis === "fallback") {
    out.add("pregame");
    return out;
  }
  const ks = cal.kickoffs;
  // Only kickoffs within ±7 d can put `ms` in any window (every window is inside k ± 48 h).
  for (let i = firstAtOrAfter(ks, ms - IN_SEASON_MS); ; i++) {
    const k = ks[i];
    if (k === undefined || k > ms + IN_SEASON_MS) break;
    out.add("in_season");
    if (ms >= k - PREGAME_MS && ms < k + GAME_WINDOW_MS) out.add("pregame");
    if (ms >= k - GAMEDAY_LEAD_MS && ms < k - PREGAME_MS) out.add("gameday");
    if (ms >= k - REPORT_LEAD_MS && ms < k) out.add("report");
    if (ms >= k + GAME_WINDOW_MS && ms < k + POSTGAME_MS) out.add("postgame");
  }
  if (out.size === 0) out.add("off_season");
  return out;
}

/** The first kickoff strictly after `ms`, or null (always null for a fallback). */
export function nextKickoffAfter(cal: GameCalendar, ms: number): number | null {
  return cal.kickoffs[firstAfter(cal.kickoffs, ms)] ?? null;
}

// --- America/New_York wall time (nflverse writes gameday + gametime in Eastern time) ----------------

/** The zone NFL schedules are written in. */
export const EASTERN_TZ = "America/New_York";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const EASTERN_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const EASTERN_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: EASTERN_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const EASTERN_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TZ,
  hourCycle: "h23",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** The parts of an instant formatted by `f`, keyed by part type. */
function partsOf(f: Intl.DateTimeFormat, ms: number): Readonly<Record<string, string>> {
  const rec: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) rec[p.type] = p.value;
  return rec;
}

/** America/New_York's offset from UTC at `utcMs`, in ms (wall − UTC). */
function easternOffsetMs(utcMs: number): number {
  const p = partsOf(EASTERN_PARTS, utcMs);
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** [year, month, day] of a real `YYYY-MM-DD` calendar date, or null. */
function ymdOf(date: string): readonly [number, number, number] | null {
  const m = DATE_RE.exec(date);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
    ? [y, mo, d]
    : null;
}

/** Whether `date` is a real `YYYY-MM-DD` calendar date. */
export function isIsoDate(date: string): boolean {
  return ymdOf(date) !== null;
}

/**
 * America/New_York wall time → epoch ms (DST-aware; Intl only, no local-zone Date methods). The
 * same two-pass rule as `kickoffUtcFromEastern` (src/store/datasets/derive.ts): a wall time inside
 * a spring-forward gap resolves with the pre-transition offset. Throws RangeError on a malformed
 * date or time (callers validate data first).
 */
export function easternWallTimeMs(date: string, hh: number, mm: number): number {
  const ymd = ymdOf(date);
  if (ymd === null) throw new RangeError("game-calendar: date must be YYYY-MM-DD");
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59)
    throw new RangeError("game-calendar: time must be 00:00..23:59");
  const naive = Date.UTC(ymd[0], ymd[1] - 1, ymd[2], hh, mm);
  const off1 = easternOffsetMs(naive);
  let utc = naive - off1;
  const off2 = easternOffsetMs(utc);
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

/** The Eastern calendar date (`YYYY-MM-DD`) of an instant. */
export function easternDateOf(ms: number): string {
  return EASTERN_DAY.format(new Date(ms));
}

/** An instant's Eastern wall clock: date, weekday, hour and minute (Intl only). */
export interface EasternClock {
  readonly date: string;
  readonly weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
  readonly hour: number;
  readonly minute: number;
}

/** The Eastern weekday and wall time of an instant (fixed English names; zone-independent). */
export function easternClockOf(ms: number): EasternClock {
  const p = partsOf(EASTERN_CLOCK, ms);
  return {
    date: easternDateOf(ms),
    weekday: p.weekday as EasternClock["weekday"],
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}
