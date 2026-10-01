// freshness.ts — the plan 01 §5.2/§5.4 TTL and hard-limit table as data, the per-source registry
// (license + attribution, plan 01 §8 / §4.2 / research 04 §G.3), and the pure classifiers the
// envelope reads (plan 01 §4.2 `meta.freshness`, §5.5 `STALE_ONLY`; plan 05 §2 `config/freshness`),
// including `stampState` — the ONE place a class's AgeBasis picks which instant an input is judged
// from (release → last successful check, age → fetch, file → mtime; critics C-12/C-08).
// Every number here is an assumption (plan 01 A-4..A-9): tests assert the SHAPE (fresh < hard),
// never the values.

/** The envelope's freshness label (plan 01 §4.2): `provisional` = platform scoring not yet final. */
export type Freshness = "fresh" | "stale" | "provisional";

/** What a classifier says about one input's age against its class. */
export type FreshnessState = "fresh" | "stale" | "expired";

/** What happens past the hard limit: a `STALE_ONLY` error, or the driver is omitted and named. */
export type BeyondHardLimit = "STALE_ONLY" | "omit";

/** How a class's age is measured. */
export type AgeBasis =
  /** seconds since the data was fetched */
  | "age"
  /** seconds since the last successful release check (`timestamp.txt` / `updated_at` unchanged) */
  | "release"
  /** seconds since the user last edited the file (`league.yaml` mtime) */
  | "file"
  /** never ages (final-week stats, persisted crosswalk pairs) */
  | "immutable";

/** The build phase in which a class first has a producer (plan 10 §3). */
export type Phase = "1a" | "1b" | "2" | "later";

/** One row of the freshness table. */
export interface FreshnessClass {
  /** Stable identifier, used by sources, the envelope and `ff status`. */
  readonly id: FreshnessClassId;
  /** One-line human description (the plan 01 §5.2 "data class"). */
  readonly description: string;
  /** How age is measured for this class. */
  readonly basis: AgeBasis;
  /** Fresh while age ≤ this many seconds; `null` = always fresh (immutable classes). */
  readonly ttlSeconds: number | null;
  /** Stale (served, warned) while age ≤ this; beyond → `beyondHard`. `null` = never expires. */
  readonly hardLimitSeconds: number | null;
  /** The consequence past the hard limit; `null` exactly when `hardLimitSeconds` is null. */
  readonly beyondHard: BeyondHardLimit | null;
  /** Build phase that first produces this class. */
  readonly phase: Phase;
  /** The plan 01 §13 assumption id(s) behind the numbers, when they are assumed. */
  readonly assumption: string | null;
  /**
   * The TTL off game days, or null (the same TTL every day). Release-basis only: a check made on a
   * Tuesday, Wednesday, Friday or Saturday (local time, like launchd's calendar) is judged against
   * this, matching the refresh job's 6-hourly off-day cadence; Thursday, Sunday and Monday keep
   * `ttlSeconds` (QA-1-036).
   */
  readonly offDayTtlSeconds: number | null;
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every freshness class id (plan 01 §5.2 rows; Yahoo rows kept for the 1b seam). */
export const FRESHNESS_CLASS_IDS = [
  "manual_league",
  "platform_settings",
  "platform_roster",
  "platform_free_agents",
  "platform_scoreboard_live",
  "platform_scoreboard",
  "platform_player_stats_provisional",
  "platform_player_stats_final",
  "platform_transactions",
  "platform_pending",
  "nflverse_stats_player_week",
  "nflverse_stats_team_week",
  "nflverse_pbp",
  "nflverse_snap_counts",
  "nflverse_injuries",
  "nflverse_depth_charts",
  "nflverse_roster_weekly",
  "nflverse_schedules",
  "lines",
  "ffopportunity_ep_weekly",
  "odds",
  "weather",
  "sleeper_trending",
  "sleeper_players",
  "dynastyprocess_ids",
  "news",
  "crosswalk",
] as const;

/** A freshness class id. */
export type FreshnessClassId = (typeof FRESHNESS_CLASS_IDS)[number];

const row = (
  id: FreshnessClassId,
  description: string,
  basis: AgeBasis,
  ttlSeconds: number | null,
  hardLimitSeconds: number | null,
  beyondHard: BeyondHardLimit | null,
  phase: Phase,
  assumption: string | null = null,
  offDayTtlSeconds: number | null = null,
): FreshnessClass =>
  Object.freeze({
    id,
    description,
    basis,
    ttlSeconds,
    hardLimitSeconds,
    beyondHard,
    phase,
    assumption,
    offDayTtlSeconds,
  });

/** The local weekdays the schedules job checks every 30 min (Date#getDay: Thu, Sun, Mon). */
export const GAME_DAYS: readonly number[] = Object.freeze([4, 0, 1]);
/** The off-day TTL of the 30-minute classes: the 6-hourly cadence plus a run's duration. */
const OFF_DAY_TTL = 6 * HOUR + 30 * MIN;

/**
 * The table (plan 01 §5.2 "TTL (fresh)" and "Hard limit", §5.4 "beyond"). Release-based nflverse
 * classes are fresh while the last successful release check is ≤ 24 h old (the daily job cadence,
 * plan 06) — "fresh until the next release" cannot be observed between checks.
 */
export const FRESHNESS_TABLE: Readonly<Record<FreshnessClassId, FreshnessClass>> = Object.freeze({
  manual_league: row(
    "manual_league",
    "hand-edited <config>/league.yaml (ManualLeagueProvider); stale after a week without an edit",
    "file",
    7 * DAY,
    null,
    null,
    "1a",
    "A-12",
  ),
  platform_settings: row(
    "platform_settings",
    "league settings (scoring, slots, rules)",
    "age",
    DAY,
    7 * DAY,
    "STALE_ONLY",
    "1b",
    "A-4",
  ),
  platform_roster: row(
    "platform_roster",
    "rosters (mine + others)",
    "age",
    MIN,
    DAY,
    "STALE_ONLY",
    "1b",
  ),
  platform_free_agents: row(
    "platform_free_agents",
    "free agents / waiver wire",
    "age",
    5 * MIN,
    DAY,
    "STALE_ONLY",
    "1b",
    "A-5",
  ),
  platform_scoreboard_live: row(
    "platform_scoreboard_live",
    "scoreboard during a game window",
    "age",
    MIN,
    DAY,
    "STALE_ONLY",
    "1b",
    "A-6",
  ),
  platform_scoreboard: row(
    "platform_scoreboard",
    "scoreboard / matchups / standings outside game windows",
    "age",
    15 * MIN,
    DAY,
    "STALE_ONLY",
    "1b",
    "A-6",
  ),
  platform_player_stats_provisional: row(
    "platform_player_stats_provisional",
    "platform player stats while the week is provisional",
    "age",
    10 * MIN,
    DAY,
    "STALE_ONLY",
    "1b",
  ),
  platform_player_stats_final: row(
    "platform_player_stats_final",
    "platform player stats for a final week (immutable)",
    "immutable",
    null,
    null,
    null,
    "1b",
  ),
  platform_transactions: row(
    "platform_transactions",
    "transactions (most recent N)",
    "age",
    2 * MIN,
    DAY,
    "STALE_ONLY",
    "1b",
  ),
  platform_pending: row(
    "platform_pending",
    "pending waivers / trades (mine)",
    "age",
    MIN,
    6 * HOUR,
    "STALE_ONLY",
    "1b",
  ),
  nflverse_stats_player_week: row(
    "nflverse_stats_player_week",
    "nflverse weekly player stats",
    "release",
    DAY,
    3 * DAY,
    "STALE_ONLY",
    "1a",
    "A-7",
  ),
  nflverse_stats_team_week: row(
    "nflverse_stats_team_week",
    "nflverse weekly team stats",
    "release",
    DAY,
    3 * DAY,
    "STALE_ONLY",
    "2",
    "A-7",
  ),
  nflverse_pbp: row(
    "nflverse_pbp",
    "nflverse play-by-play (projected subset)",
    "release",
    DAY,
    3 * DAY,
    "STALE_ONLY",
    "2",
    "A-7, A-8",
  ),
  nflverse_snap_counts: row(
    "nflverse_snap_counts",
    "nflverse snap counts",
    "release",
    DAY,
    3 * DAY,
    "STALE_ONLY",
    "2",
    "A-7",
  ),
  nflverse_injuries: row(
    "nflverse_injuries",
    "nflverse injuries + practice",
    "release",
    12 * HOUR,
    36 * HOUR,
    "STALE_ONLY",
    "1a",
  ),
  nflverse_depth_charts: row(
    "nflverse_depth_charts",
    "nflverse depth charts",
    "release",
    DAY,
    4 * DAY,
    "STALE_ONLY",
    "2",
  ),
  nflverse_roster_weekly: row(
    "nflverse_roster_weekly",
    "nflverse weekly rosters + ids (feeds the crosswalk)",
    "release",
    DAY,
    7 * DAY,
    "STALE_ONLY",
    "1a",
  ),
  nflverse_schedules: row(
    "nflverse_schedules",
    "schedule, kickoffs, roof",
    "release",
    30 * MIN,
    7 * DAY,
    "STALE_ONLY",
    "1a",
    "A-9",
    OFF_DAY_TTL,
  ),
  lines: row(
    "lines",
    "betting lines from nflverse schedules (spread, total, moneyline)",
    "release",
    30 * MIN,
    DAY,
    "omit",
    "1a",
    "A-9",
    OFF_DAY_TTL,
  ),
  ffopportunity_ep_weekly: row(
    "ffopportunity_ep_weekly",
    "ffopportunity expected fantasy points",
    "release",
    DAY,
    4 * DAY,
    "STALE_ONLY",
    "2",
  ),
  odds: row(
    "odds",
    "The Odds API multi-book lines (optional key)",
    "age",
    8 * HOUR,
    DAY,
    "omit",
    "later",
  ),
  weather: row(
    "weather",
    "game-venue weather (Open-Meteo / NWS)",
    "age",
    HOUR,
    12 * HOUR,
    "omit",
    "1a",
  ),
  sleeper_trending: row(
    "sleeper_trending",
    "Sleeper trending adds/drops",
    "age",
    30 * MIN,
    6 * HOUR,
    "omit",
    "2",
  ),
  sleeper_players: row(
    "sleeper_players",
    "Sleeper players (ids, injury fields)",
    "age",
    DAY,
    7 * DAY,
    "STALE_ONLY",
    "2",
  ),
  dynastyprocess_ids: row(
    "dynastyprocess_ids",
    "DynastyProcess player ids",
    "release",
    7 * DAY,
    30 * DAY,
    "STALE_ONLY",
    "2",
  ),
  news: row("news", "RSS news items", "age", 15 * MIN, DAY, "omit", "2"),
  crosswalk: row(
    "crosswalk",
    "persisted player crosswalk pairs",
    "immutable",
    null,
    null,
    null,
    "1a",
  ),
});

/** Looks up a class; throws on an unknown id (a programming error, never user input). */
export function freshnessClass(id: FreshnessClassId): FreshnessClass {
  const c = (FRESHNESS_TABLE as Partial<Record<string, FreshnessClass>>)[id];
  if (!c) throw new Error(`freshness: unknown class ${id}`);
  return c;
}

/**
 * Classifies an age against a class (plan 01 §5.4): `fresh` while age ≤ ttl, `stale` while
 * age ≤ hard limit, `expired` beyond it. Monotone in age. A negative, NaN or infinite age is a
 * caller bug and throws — it must never silently read as fresh.
 */
export function classifyAge(
  cls: FreshnessClass,
  ageSeconds: number,
  ttlSeconds: number | null = cls.ttlSeconds,
): FreshnessState {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    throw new RangeError("freshness: age must be a finite, non-negative number of seconds");
  }
  if (ttlSeconds === null || ageSeconds <= ttlSeconds) return "fresh";
  if (cls.hardLimitSeconds === null || ageSeconds <= cls.hardLimitSeconds) return "stale";
  return "expired";
}

/**
 * The TTL that applies to a check made at `basisMs` (QA-1-036): `offDayTtlSeconds` when the class
 * has one and the check's local weekday is not a game day, else `ttlSeconds`.
 */
export function ttlAt(cls: FreshnessClass, basisMs: number): number | null {
  if (cls.offDayTtlSeconds === null || cls.basis !== "release") return cls.ttlSeconds;
  return GAME_DAYS.includes(new Date(basisMs).getDay()) ? cls.ttlSeconds : cls.offDayTtlSeconds;
}

/**
 * The instants an input stamp carries (a DatasetStamp or a PlatformStamp, flattened): `as_of` is the
 * content time (release `updated_at`; league.yaml mtime for the manual league), `fetched_at` the
 * download/read time, `checked_at` the last successful release check (release basis only; null →
 * `fetched_at`).
 */
export interface StampInstants {
  readonly as_of: string;
  readonly fetched_at: string;
  readonly checked_at: string | null;
}

/** An input's state judged by its class's basis, with the instant it was judged from. */
export interface StampState {
  readonly state: FreshnessState;
  /** The instant the age was measured from (ISO-8601 UTC) — what a stale warning must quote. */
  readonly basis_at: string;
  /** Whole seconds from `basis_at` to now, ≥ 0 (a future instant — clock skew — reads 0). */
  readonly age_s: number;
}

function isoMs(s: string): number {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new RangeError("freshness: invalid ISO instant in stamp");
  return ms;
}

/**
 * Judges one input against its class (plan 01 §5.4) from the instant its AgeBasis names:
 * `age` → `fetched_at`; `release` → the later of `checked_at` and `fetched_at` (an unchanged release
 * checked an hour ago is fresh, however old the download); `file` → `as_of` (the file's mtime);
 * `immutable` → always fresh, measured from `fetched_at`. Every tool uses this, so a quiet week can
 * never turn an unchanged nflverse release STALE_ONLY and a stale warning names the right age.
 */
export function stampState(cls: FreshnessClass, t: StampInstants, nowMs: number): StampState {
  if (!Number.isFinite(nowMs)) throw new RangeError("freshness: now must be finite");
  const fetched = isoMs(t.fetched_at);
  let basis: number;
  switch (cls.basis) {
    case "release":
      basis = t.checked_at === null ? fetched : Math.max(isoMs(t.checked_at), fetched);
      break;
    case "file":
      basis = isoMs(t.as_of);
      break;
    case "age":
    case "immutable":
      basis = fetched;
      break;
  }
  const age = Math.max(0, Math.floor((nowMs - basis) / 1000));
  return {
    state: cls.basis === "immutable" ? "fresh" : classifyAge(cls, age, ttlAt(cls, basis)),
    basis_at: new Date(basis).toISOString(),
    age_s: age,
  };
}

/** The worse of two envelope labels: stale > provisional > fresh. */
export function worseFreshness(a: Freshness, b: Freshness): Freshness {
  const rank: Record<Freshness, number> = { fresh: 0, provisional: 1, stale: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * A resource's `ttlMs` (plan 01 §3.1 / plan 07 §4.1): the class TTL in ms, capped at one day, and
 * one day for immutable classes (a client cache needs a finite number).
 */
export function resourceTtlMs(cls: FreshnessClass): number {
  const capped = cls.ttlSeconds === null ? DAY : Math.min(cls.ttlSeconds, DAY);
  return capped * 1000;
}

/**
 * Whether a platform week's scoring is still provisional (plan 01 §5.4, research 03 §D.2): a week
 * is final only after the next matchup week's first kickoff. `nextWeekFirstKickoffMs = null` (no
 * known next kickoff — e.g. the last week of a season) is conservatively provisional.
 */
export function isProvisionalWeek(nextWeekFirstKickoffMs: number | null, nowMs: number): boolean {
  if (nextWeekFirstKickoffMs === null) return true;
  return nowMs < nextWeekFirstKickoffMs;
}

// --- Source registry: license + attribution (plan 01 §8 DataSource, §4.2 meta.attribution) --------

/** A source's license class (plan 01 §8); non-commercial and share-alike are visible on purpose. */
export type License =
  "CC-BY-4.0" | "CC-BY-SA-4.0" | "public-domain" | "non-commercial" | "api-terms";

/** One `meta.attribution[]` entry (plan 01 §4.2). */
export interface Attribution {
  /** Display name of the provider. */
  readonly source: string;
  /** Required attribution wording, when the provider mandates one. */
  readonly text: string | null;
  /** License class, when one applies. */
  readonly license: License | null;
  /** Link back to the provider. */
  readonly url: string;
}

/** Every dataset source id a `DataSource` may carry (`<provider>:<dataset>`). */
export const DATASET_SOURCE_IDS = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "nflverse:stats_team_week",
  "nflverse:pbp",
  "nflverse:snap_counts",
  "nflverse:depth_charts",
  "ffopportunity:ep_weekly",
  "weather:open_meteo",
  "weather:nws",
  "sleeper:players",
  "sleeper:trending",
  "dynastyprocess:ids",
  "news:rotowire",
  "news:espn",
  "news:cbs",
  "odds:the_odds_api",
] as const;

/** A dataset source id. */
export type DatasetSourceId = (typeof DATASET_SOURCE_IDS)[number];

/** Registry row for one dataset source. */
export interface SourceInfo {
  /** The dataset source id. */
  readonly id: DatasetSourceId;
  /** Freshness class its rows are judged by. */
  readonly freshness: FreshnessClassId;
  /** Attribution entry (license included) the envelope emits when this source contributed. */
  readonly attribution: Attribution;
  /** Build phase that first ships this source. */
  readonly phase: Phase;
}

/** The attribution entries, one per provider (plan 01 §4.2; HANDOFF "Yahoo terms"). */
export const ATTRIBUTIONS = Object.freeze({
  yahoo: Object.freeze({
    source: "Yahoo Fantasy",
    text: "Fantasy data provided by Yahoo Fantasy",
    license: null,
    url: "https://football.fantasysports.yahoo.com/",
  }),
  nflverse: Object.freeze({
    source: "nflverse",
    text: null,
    license: "CC-BY-4.0",
    url: "https://github.com/nflverse/nflverse-data",
  }),
  ffopportunity: Object.freeze({
    source: "ffopportunity (ffverse)",
    text: null,
    license: "CC-BY-SA-4.0",
    url: "https://github.com/ffverse/ffopportunity",
  }),
  open_meteo: Object.freeze({
    source: "Open-Meteo",
    text: "Weather data by Open-Meteo.com (CC BY 4.0); free API for non-commercial use",
    license: "non-commercial",
    url: "https://open-meteo.com/",
  }),
  nws: Object.freeze({
    source: "National Weather Service",
    text: null,
    license: "public-domain",
    url: "https://www.weather.gov/",
  }),
  sleeper: Object.freeze({
    source: "Sleeper",
    text: null,
    license: "non-commercial",
    url: "https://docs.sleeper.com/",
  }),
  dynastyprocess: Object.freeze({
    source: "DynastyProcess",
    text: null,
    license: "api-terms",
    url: "https://github.com/dynastyprocess/data",
  }),
  rotowire: Object.freeze({
    source: "RotoWire",
    text: null,
    license: "api-terms",
    url: "https://www.rotowire.com/",
  }),
  espn: Object.freeze({
    source: "ESPN",
    text: null,
    license: "api-terms",
    url: "https://www.espn.com/",
  }),
  cbs: Object.freeze({
    source: "CBS Sports",
    text: null,
    license: "api-terms",
    url: "https://www.cbssports.com/",
  }),
  the_odds_api: Object.freeze({
    source: "The Odds API",
    text: null,
    license: "api-terms",
    url: "https://the-odds-api.com/",
  }),
} satisfies Record<string, Attribution>);

const src = (
  id: DatasetSourceId,
  freshness: FreshnessClassId,
  attribution: Attribution,
  phase: Phase,
): SourceInfo => Object.freeze({ id, freshness, attribution, phase });

/** The dataset source registry (plan 01 §5.2 sources; research 04 §G.3 licenses). */
export const SOURCE_REGISTRY: Readonly<Record<DatasetSourceId, SourceInfo>> = Object.freeze({
  "nflverse:schedules": src(
    "nflverse:schedules",
    "nflverse_schedules",
    ATTRIBUTIONS.nflverse,
    "1a",
  ),
  "nflverse:injuries": src("nflverse:injuries", "nflverse_injuries", ATTRIBUTIONS.nflverse, "1a"),
  "nflverse:roster_weekly": src(
    "nflverse:roster_weekly",
    "nflverse_roster_weekly",
    ATTRIBUTIONS.nflverse,
    "1a",
  ),
  "nflverse:stats_player_week": src(
    "nflverse:stats_player_week",
    "nflverse_stats_player_week",
    ATTRIBUTIONS.nflverse,
    "1a",
  ),
  "nflverse:stats_team_week": src(
    "nflverse:stats_team_week",
    "nflverse_stats_team_week",
    ATTRIBUTIONS.nflverse,
    "2",
  ),
  "nflverse:pbp": src("nflverse:pbp", "nflverse_pbp", ATTRIBUTIONS.nflverse, "2"),
  "nflverse:snap_counts": src(
    "nflverse:snap_counts",
    "nflverse_snap_counts",
    ATTRIBUTIONS.nflverse,
    "2",
  ),
  "nflverse:depth_charts": src(
    "nflverse:depth_charts",
    "nflverse_depth_charts",
    ATTRIBUTIONS.nflverse,
    "2",
  ),
  "ffopportunity:ep_weekly": src(
    "ffopportunity:ep_weekly",
    "ffopportunity_ep_weekly",
    ATTRIBUTIONS.ffopportunity,
    "2",
  ),
  "weather:open_meteo": src("weather:open_meteo", "weather", ATTRIBUTIONS.open_meteo, "1a"),
  "weather:nws": src("weather:nws", "weather", ATTRIBUTIONS.nws, "1a"),
  "sleeper:players": src("sleeper:players", "sleeper_players", ATTRIBUTIONS.sleeper, "2"),
  "sleeper:trending": src("sleeper:trending", "sleeper_trending", ATTRIBUTIONS.sleeper, "2"),
  "dynastyprocess:ids": src(
    "dynastyprocess:ids",
    "dynastyprocess_ids",
    ATTRIBUTIONS.dynastyprocess,
    "2",
  ),
  "news:rotowire": src("news:rotowire", "news", ATTRIBUTIONS.rotowire, "2"),
  "news:espn": src("news:espn", "news", ATTRIBUTIONS.espn, "2"),
  "news:cbs": src("news:cbs", "news", ATTRIBUTIONS.cbs, "2"),
  "odds:the_odds_api": src("odds:the_odds_api", "odds", ATTRIBUTIONS.the_odds_api, "later"),
});

/** Whether a string is a known dataset source id. */
export function isDatasetSourceId(s: string): s is DatasetSourceId {
  return (DATASET_SOURCE_IDS as readonly string[]).includes(s);
}

/**
 * The attribution entry for one `meta.source[]` tag, or null when none is owed. Tags are a
 * dataset source id, `"yahoo"`, `"manual"` (the user's own league.yaml — no third party), or an
 * internal tag such as `"engine"` / `"store.recommendation_log"`.
 */
export function attributionFor(sourceTag: string): Attribution | null {
  if (sourceTag === "yahoo" || sourceTag.startsWith("yahoo:")) return ATTRIBUTIONS.yahoo;
  return isDatasetSourceId(sourceTag) ? SOURCE_REGISTRY[sourceTag].attribution : null;
}
