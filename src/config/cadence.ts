// cadence.ts — the refresh policy, pure (season-fresh spec §4.2 tick decision, §6 answer-time
// decision, §1 item 7 backoff). One 15-minute tick asks `dueDecision` per source; a tool call asks
// `onDemandDecision`. Both read the game calendar (kickoff-relative windows from the schedule data,
// src/config/game-calendar.ts), the source's refresh_log state and the provider backoff, and never
// touch the network, the clock or the store themselves. The 14-minute floor between two attempts for
// one release is enforced across processes because `lastAttemptMs` comes from the store (refresh_log
// and season_check — a run that found its season unpublished writes only the latter), and a season
// upstream has not published yet is checked once per phase cadence, never every tick.
import {
  anyKickoffIn,
  firstAfter,
  phasesAt,
  type CalendarPhase,
  type GameCalendar,
} from "./game-calendar.js";
import {
  freshUntilMs,
  freshnessClass,
  type FreshnessClassId,
  type StampInstants,
} from "./freshness.js";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** The sources the tick and the answer-time refresh decide about. */
export const DUE_SOURCES = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "weather",
] as const;
/** One of `DUE_SOURCES` (`weather` = the configured weather provider). */
export type DueSource = (typeof DUE_SOURCES)[number];
/** The tick's order: schedules first, so later decisions see this tick's calendar. */
export const DUE_ORDER: readonly DueSource[] = Object.freeze([...DUE_SOURCES]);

/** The tick interval (launchd minutes 0/15/30/45). */
export const TICK_MS = 15 * MIN_MS;
/** launchd's firing tolerance, allowed on every interval. */
export const TICK_SLACK_MS = 2 * MIN_MS;
/** At most one attempt per release per 15 min, less the tick tolerance (plan 01 §6). */
export const MIN_RELEASE_GAP_MS = 14 * MIN_MS;
export const FAILURE_BACKOFF_BASE_MS = 15 * MIN_MS;
export const FAILURE_BACKOFF_CAP_MS = 60 * MIN_MS;
export const RATE_LIMIT_BACKOFF_CAP_MS = 2 * HOUR_MS;
/** Weather is fetched at most once per UTC hour bucket. */
export const WEATHER_CADENCE_MS = HOUR_MS;
/** Weather matters from an hour before a kickoff that already started (the window's lower edge). */
const WEATHER_LOOKBACK_MS = HOUR_MS;

/** The cadence table (§4.2): per source, the interval in each calendar phase; tightest wins. */
export const CADENCE_MS: Readonly<
  Record<Exclude<DueSource, "weather">, Readonly<Record<CalendarPhase | "fallback", number>>>
> = Object.freeze({
  "nflverse:schedules": Object.freeze({
    pregame: 15 * MIN_MS,
    gameday: 30 * MIN_MS,
    report: HOUR_MS,
    postgame: HOUR_MS,
    in_season: HOUR_MS,
    off_season: 6 * HOUR_MS,
    fallback: 30 * MIN_MS,
  }),
  "nflverse:injuries": Object.freeze({
    pregame: 2 * HOUR_MS,
    gameday: 2 * HOUR_MS,
    report: 2 * HOUR_MS,
    postgame: 6 * HOUR_MS,
    in_season: 6 * HOUR_MS,
    off_season: 6 * HOUR_MS,
    fallback: 2 * HOUR_MS,
  }),
  "nflverse:roster_weekly": Object.freeze({
    pregame: 6 * HOUR_MS,
    gameday: 6 * HOUR_MS,
    report: 6 * HOUR_MS,
    postgame: 6 * HOUR_MS,
    in_season: 6 * HOUR_MS,
    off_season: 6 * HOUR_MS,
    fallback: 6 * HOUR_MS,
  }),
  "nflverse:stats_player_week": Object.freeze({
    pregame: 6 * HOUR_MS,
    gameday: 6 * HOUR_MS,
    report: 6 * HOUR_MS,
    postgame: HOUR_MS,
    in_season: 6 * HOUR_MS,
    off_season: 6 * HOUR_MS,
    fallback: HOUR_MS,
  }),
});

/** Freshness classes a source feeds (the TTL guard). schedules → nflverse_schedules + lines. */
export const SOURCE_CLASSES: Readonly<Record<DueSource, readonly FreshnessClassId[]>> =
  Object.freeze({
    "nflverse:schedules": Object.freeze(["nflverse_schedules", "lines"] as const),
    "nflverse:injuries": Object.freeze(["nflverse_injuries"] as const),
    "nflverse:roster_weekly": Object.freeze(["nflverse_roster_weekly"] as const),
    "nflverse:stats_player_week": Object.freeze(["nflverse_stats_player_week"] as const),
    weather: Object.freeze(["weather"] as const),
  });

/** What the refresh_log and provider_backoff say about one source. */
export interface SourceState {
  readonly file: "ok" | "never_loaded" | "unreadable";
  /** The current file's instants (refresh_log current row), null when never loaded. */
  readonly basis: StampInstants | null;
  /**
   * The newest attempt by any process: the latest refresh_log started_at (any outcome), a later
   * "unchanged" check of the current file, and the newest season_check of the source.
   */
  readonly lastAttemptMs: number | null;
  /**
   * When the newest attempt found the season in progress not published upstream yet (a
   * `not_published` run: season_check rows only, no refresh_log row — QA-1-037) and the current file
   * does not hold that season: that attempt's instant. Null (or absent) otherwise.
   */
  readonly notPublishedAtMs?: number | null;
  readonly consecutiveFailures: number;
  /** provider_backoff until (Retry-After / 429), null when none. */
  readonly backoffUntilMs: number | null;
}

/** The weather source's extra state: the newest row's hour bucket and the provider's horizon. */
export interface WeatherState {
  readonly lastBucketMs: number | null;
  readonly horizonHours: number;
}

/** One decision's inputs. */
export interface DueInput {
  readonly source: DueSource;
  readonly nowMs: number;
  readonly cal: GameCalendar;
  readonly state: SourceState;
  /** Required when source === "weather". */
  readonly weather?: WeatherState;
}

/** Why a source is (not) due. */
export type DueReason =
  | "repair"
  | "provider_backoff"
  | "failure_backoff"
  | "min_gap"
  | "ttl_guard"
  | "cadence"
  | "not_due"
  | "no_games"
  | "same_bucket"
  /** The newest attempt found the season unpublished upstream: waiting the phase cadence. */
  | "not_published";

/** The tick's decision for one source. */
export interface DueDecision {
  readonly source: DueSource;
  readonly due: boolean;
  readonly reason: DueReason;
  /** Earliest instant the source may be due (null when due now or never, e.g. no_games). */
  readonly next_at_ms: number | null;
}

/** min(15 min × 2^(n−1), 60 min); 0 for n = 0 (or anything not a positive count). */
export function failureBackoffMs(consecutiveFailures: number): number {
  const n = Math.floor(consecutiveFailures);
  if (!(n >= 1)) return 0;
  return Math.min(FAILURE_BACKOFF_CAP_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (n - 1));
}

/**
 * A 429 / Retry-After backoff: max(Retry-After, 15 min × 2^(n−1)) capped at 2 h (n counts this
 * failure, at least 1). A missing or invalid Retry-After counts as 0.
 */
export function rateLimitBackoffMs(
  retryAfterS: number | null,
  consecutiveFailures: number,
): number {
  const ra =
    retryAfterS !== null && Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS : 0;
  const n = Math.max(1, Number.isFinite(consecutiveFailures) ? Math.floor(consecutiveFailures) : 1);
  const exp = Math.min(RATE_LIMIT_BACKOFF_CAP_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (n - 1));
  return Math.min(RATE_LIMIT_BACKOFF_CAP_MS, Math.max(ra * 1000, exp));
}

/** The UTC hour bucket start of an instant. */
function bucketOf(ms: number): number {
  return Math.floor(ms / WEATHER_CADENCE_MS) * WEATHER_CADENCE_MS;
}

/** The weather window: an outdoor kickoff in [now − 1 h, now + horizon] (a fallback: always). */
function weatherHasGames(cal: GameCalendar, nowMs: number, w: WeatherState): boolean {
  if (cal.basis === "fallback") return true;
  const horizon = Math.max(0, w.horizonHours) * HOUR_MS;
  return anyKickoffIn(cal.outdoor_kickoffs, nowMs - WEATHER_LOOKBACK_MS, nowMs + horizon);
}

/** When the next outdoor kickoff enters the weather window, or null when none is scheduled. */
function weatherNextAt(cal: GameCalendar, nowMs: number, w: WeatherState): number | null {
  const horizon = Math.max(0, w.horizonHours) * HOUR_MS;
  const k = cal.outdoor_kickoffs[firstAfter(cal.outdoor_kickoffs, nowMs + horizon)];
  return k === undefined ? null : k - horizon;
}

function weatherOf(i: DueInput): WeatherState {
  if (i.weather === undefined)
    throw new TypeError("cadence: the weather source needs its WeatherState");
  return i.weather;
}

/** The interval that applies now: the tightest phase's (the fallback column for a fallback). */
export function cadenceIntervalMs(
  source: Exclude<DueSource, "weather">,
  cal: GameCalendar,
  nowMs: number,
): number {
  const row = CADENCE_MS[source];
  if (cal.basis === "fallback") return row.fallback;
  let best = Number.POSITIVE_INFINITY;
  for (const p of phasesAt(cal, nowMs)) best = Math.min(best, row[p]);
  return best;
}

/**
 * What holds an attempt back now, from the last attempt by any process: the 14-minute floor
 * (`min_gap`), then a failure streak's backoff (`failureBackoffMs(n)`); null when nothing does.
 */
function floorOf(
  state: SourceState,
  nowMs: number,
): { readonly reason: "min_gap" | "failure_backoff"; readonly until: number } | null {
  const last = state.lastAttemptMs;
  if (last === null) return null;
  if (nowMs - last < MIN_RELEASE_GAP_MS)
    return { reason: "min_gap", until: last + MIN_RELEASE_GAP_MS };
  const backoff = failureBackoffMs(state.consecutiveFailures);
  if (backoff > 0 && nowMs < last + backoff)
    return { reason: "failure_backoff", until: last + backoff };
  return null;
}

/**
 * When a source whose newest attempt found its season unpublished upstream may be checked again: the
 * tightest calendar phase's cadence from that attempt (less the tick tolerance). Upstream publishes a
 * new season about once a year, so neither the TTL guard (judged on another season's file) nor a
 * repair every tick can do better; null when the source is not in that state.
 */
function notPublishedUntil(i: DueInput): number | null {
  const np = i.state.notPublishedAtMs ?? null;
  if (np === null || i.source === "weather") return null;
  return np + cadenceIntervalMs(i.source, i.cal, i.nowMs) - TICK_SLACK_MS;
}

/**
 * The tick's decision (§4.2), in order: provider backoff (a Retry-After is honoured even for a
 * repair, as at answer time); a never-loaded or unreadable file is due (`repair`) — unless the newest
 * attempt found the season unpublished upstream; an attempt less than 14 min ago blocks (`min_gap`,
 * counting every process's attempts); a failure streak waits `failureBackoffMs(n)` from the last
 * attempt; a season upstream has not published waits the phase cadence from that attempt
 * (`not_published`); then the TTL guard (due when the next tick could find a judged class stale)
 * and the cadence of the tightest calendar phase. Weather replaces the last two with its hourly rule:
 * due only while an outdoor kickoff lies in [now − 1 h, now + horizon] and the newest row is from an
 * older hour bucket.
 */
export function dueDecision(i: DueInput): DueDecision {
  const { source, nowMs, cal, state } = i;
  const d = (due: boolean, reason: DueReason, next: number | null): DueDecision =>
    Object.freeze({ source, due, reason, next_at_ms: due ? null : next });

  if (source === "weather" && !weatherHasGames(cal, nowMs, weatherOf(i)))
    return d(false, "no_games", weatherNextAt(cal, nowMs, weatherOf(i)));
  if (state.backoffUntilMs !== null && nowMs < state.backoffUntilMs)
    return d(false, "provider_backoff", state.backoffUntilMs);
  const unpublishedUntil = notPublishedUntil(i);
  if (unpublishedUntil !== null) {
    const held = floorOf(state, nowMs);
    if (held !== null) return d(false, held.reason, held.until);
    if (nowMs < unpublishedUntil) return d(false, "not_published", unpublishedUntil);
    return d(true, state.file !== "ok" || state.basis === null ? "repair" : "cadence", null);
  }
  if (state.file !== "ok" || state.basis === null) return d(true, "repair", null);
  const held = floorOf(state, nowMs);
  if (held !== null) return d(false, held.reason, held.until);

  if (source === "weather") {
    const w = weatherOf(i);
    const bucket = bucketOf(nowMs);
    if (w.lastBucketMs !== null && w.lastBucketMs >= bucket)
      return d(false, "same_bucket", bucket + WEATHER_CADENCE_MS);
    return d(true, "cadence", null);
  }

  // TTL guard: due when the next tick (plus its tolerance) could judge a class stale.
  const basisT = state.basis;
  const untils = SOURCE_CLASSES[source]
    .map((id) => freshUntilMs(freshnessClass(id), basisT, cal))
    .filter((u): u is number => u !== null);
  const guardAt = Math.min(...untils) - TICK_MS - TICK_SLACK_MS;
  if (nowMs >= guardAt) return d(true, "ttl_guard", null);

  const basis = basisOf(state.basis);
  const dueAt = basis + cadenceIntervalMs(source, cal, nowMs) - TICK_SLACK_MS;
  if (nowMs >= dueAt) return d(true, "cadence", null);
  return d(false, "not_due", Math.min(dueAt, guardAt));
}

/** The release basis of a stamp: the later of checked_at and fetched_at. */
function basisOf(t: StampInstants): number {
  const f = Date.parse(t.fetched_at);
  return t.checked_at === null ? f : Math.max(Date.parse(t.checked_at), f);
}

// --- answer time (§6) -------------------------------------------------------------------------------

/** Budgets and caps of the answer-time refresh. */
export const ON_DEMAND = Object.freeze({
  fastFloorMs: 15 * MIN_MS,
  slowFloorMs: 6 * HOUR_MS,
  postgameStatsFloorMs: 60 * MIN_MS,
  waitFastMs: 6_000,
  waitRepairMs: 15_000,
  callCapMs: 15_000,
  maxChildren: 3,
  maxSpawnsPerHour: 20,
  childDeadlineMs: 60_000,
  killAfterMs: 90_000,
  retry: Object.freeze({ maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 }),
});

/** Fast sources are waited on at answer time; slow ones are revalidated in the background. */
export type OnDemandTier = "fast" | "slow";
export const ON_DEMAND_TIER: Readonly<Record<DueSource, OnDemandTier>> = Object.freeze({
  "nflverse:schedules": "fast",
  "nflverse:injuries": "fast",
  "nflverse:roster_weekly": "slow",
  "nflverse:stats_player_week": "slow",
  weather: "fast",
});

/** The answer-time decision's inputs. */
export interface OnDemandInput extends DueInput {
  /** The tool cannot answer without this source (schedules for every analytics tool). */
  readonly required: boolean;
  /** The current file is past its class's hard limit. */
  readonly expired: boolean;
}

/** What to do for one source before answering. */
export type OnDemandAction =
  | {
      readonly kind: "none";
      readonly reason: "fresh_enough" | "min_gap" | "same_bucket" | "no_games" | "not_published";
    }
  | {
      readonly kind: "skip";
      readonly reason: "provider_backoff" | "failure_backoff";
      readonly until_ms: number;
    }
  | { readonly kind: "wait"; readonly reason: "repair" | "revalidate"; readonly budget_ms: number }
  | { readonly kind: "background"; readonly reason: "revalidate" | "slow_tier" };

/**
 * The answer-time decision (§8.4): a required source that is never loaded, unreadable or expired is
 * a repair (`wait` up to `waitRepairMs`); a provider backoff or a running failure backoff skips (so
 * an offline machine answers at once instead of waiting on a child that will fail); a fast source
 * last attempted ≥ 15 min ago waits up to `waitFastMs`; weather waits once per hour bucket while an
 * outdoor kickoff is in its window; a slow source last attempted ≥ 6 h ago (stats in a post-game
 * window: ≥ 1 h) is revalidated in the background; otherwise nothing. A source whose newest attempt
 * found its season unpublished upstream is never waited on: nothing until the tick's phase cadence
 * from that attempt has passed, then a background check.
 */
export function onDemandDecision(i: OnDemandInput): OnDemandAction {
  const { source, nowMs, cal, state } = i;
  if (state.backoffUntilMs !== null && nowMs < state.backoffUntilMs)
    return { kind: "skip", reason: "provider_backoff", until_ms: state.backoffUntilMs };
  const backoff = failureBackoffMs(state.consecutiveFailures);
  if (backoff > 0 && state.lastAttemptMs !== null && nowMs < state.lastAttemptMs + backoff)
    return { kind: "skip", reason: "failure_backoff", until_ms: state.lastAttemptMs + backoff };

  const since =
    state.lastAttemptMs === null ? Number.POSITIVE_INFINITY : nowMs - state.lastAttemptMs;
  const unpublishedUntil = notPublishedUntil(i);
  if (unpublishedUntil !== null)
    return since < MIN_RELEASE_GAP_MS || nowMs < unpublishedUntil
      ? { kind: "none", reason: "not_published" }
      : { kind: "background", reason: "revalidate" };

  const broken = state.file !== "ok" || state.basis === null || i.expired;
  if (broken && i.required)
    return { kind: "wait", reason: "repair", budget_ms: ON_DEMAND.waitRepairMs };

  if (source === "weather") {
    const w = weatherOf(i);
    if (!weatherHasGames(cal, nowMs, w)) return { kind: "none", reason: "no_games" };
    if (w.lastBucketMs !== null && w.lastBucketMs >= bucketOf(nowMs) && !broken)
      return { kind: "none", reason: "same_bucket" };
    if (since < MIN_RELEASE_GAP_MS) return { kind: "none", reason: "min_gap" };
    return { kind: "wait", reason: "revalidate", budget_ms: ON_DEMAND.waitFastMs };
  }
  if (since < MIN_RELEASE_GAP_MS) return { kind: "none", reason: "min_gap" };
  if (ON_DEMAND_TIER[source] === "fast") {
    if (since >= ON_DEMAND.fastFloorMs)
      return { kind: "wait", reason: "revalidate", budget_ms: ON_DEMAND.waitFastMs };
    return { kind: "none", reason: "fresh_enough" };
  }
  // stats after a game (or under a fallback calendar, which never under-refreshes): the 1-h floor
  const postgame = cal.basis === "fallback" || phasesAt(cal, nowMs).has("postgame");
  const floor =
    source === "nflverse:stats_player_week" && postgame
      ? ON_DEMAND.postgameStatsFloorMs
      : ON_DEMAND.slowFloorMs;
  if (since >= floor || broken) return { kind: "background", reason: "slow_tier" };
  return { kind: "none", reason: "fresh_enough" };
}

const BUCKET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;

/** The weather source's version string (hour bucket `YYYY-MM-DDTHH`, UTC) → bucket start ms; null if malformed. */
export function weatherBucketMs(fileVersion: string): number | null {
  const m = BUCKET_RE.exec(fileVersion);
  if (!m) return null;
  const [y, mo, d, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (mo < 1 || mo > 12 || d < 1 || h > 23) return null;
  const ms = Date.UTC(y, mo - 1, d, h);
  const t = new Date(ms);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? ms : null;
}
