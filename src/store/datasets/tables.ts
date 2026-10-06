// tables.ts — the ds_* dataset-table contract for every Phase-1a source (plan 01 §5.1/§5.2/§5.5
// per-source dataset files; plan 08 §3.2 stat columns; plan 10 §3.1a sources), grounded in the real
// 2026 nflverse parquet files read on 2026-09-30 (research 04 §H.8 closed: parquet = CSV schema).
//
// One contract, two sides: the sources layer fills these tables (through DatasetWriter) and the
// store layer implements the domain's dataset readers over them (READER_QUERIES below).
// Columns keep nflverse's own names wherever they are stored verbatim; every other column names the
// source columns it is derived from and how (`derivation`). Conventions for every table:
//   - TEXT values pass through `emptyToNull` (derive.ts): "" and whitespace-only → NULL;
//   - a NOT NULL column whose source value is null makes the ROW invalid → the row is dropped and
//     counted in the SchemaReport warnings (never the whole publish), unless `row_filter` says more;
//   - tables are created STRICT (ddlFor), so a type slip fails loudly at insert time.
import type { DatasetSourceId } from "../../config/freshness.js";
import { DST_FUMBLE_RETURN_TD_COLUMN } from "../../domain/scoring/nflverse.js";
import type { DatasetColumn, DatasetColumnType, DatasetTableSpec } from "../types.js";

// --- contract types (extend the store's DatasetTableSpec; every contract IS a DatasetTableSpec) -----

/** One column plus its provenance. */
export interface ContractColumn extends DatasetColumn {
  /** Upstream columns read to produce it (`[name]` when verbatim); empty for checked-in reference data. */
  readonly from: readonly string[];
  /** How it is derived; null = verbatim copy of the one `from` column (after `emptyToNull` on TEXT). */
  readonly derivation: string | null;
}

/** The Phase-1a dataset sources (plan 10 §3.1a: schedules, injuries, roster_weekly, stats_player_week, weather). */
export const PHASE_1A_DATASET_SOURCES = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "weather:open_meteo",
  "weather:nws",
] as const satisfies readonly DatasetSourceId[];
/** A Phase-1a dataset source id. */
export type Phase1aDatasetSourceId = (typeof PHASE_1A_DATASET_SOURCES)[number];

/** A ds_* table with its provenance. Assignable to `DatasetTableSpec` (what DatasetWriter takes). */
export interface DatasetTableContract extends DatasetTableSpec {
  readonly columns: readonly ContractColumn[];
  /** The source whose dataset file holds the table. */
  readonly source: Phase1aDatasetSourceId;
  /** Upstream file (release path) or reference the rows come from. */
  readonly upstream: string;
  /** `season` when the table is per-season (then `season` is in `primary_key`); null otherwise. */
  readonly season_key: "season" | null;
  /** Rows dropped at load beyond the NOT NULL rule (counted as warnings); null = none. */
  readonly row_filter: string | null;
  readonly description: string;
}

// --- column helpers ---------------------------------------------------------------------------------

const col = (
  name: string,
  type: DatasetColumnType,
  nullable: boolean,
  from: readonly string[] = [name],
  derivation: string | null = null,
): ContractColumn =>
  Object.freeze({ name, type, nullable, from: Object.freeze([...from]), derivation });
const text = (name: string, nullable = true): ContractColumn => col(name, "TEXT", nullable);
const int = (name: string, nullable = true): ContractColumn => col(name, "INTEGER", nullable);
const real = (name: string, nullable = true): ContractColumn => col(name, "REAL", nullable);
const ints = (...names: string[]): ContractColumn[] => names.map((n) => int(n));
const reals = (...names: string[]): ContractColumn[] => names.map((n) => real(n));
const texts = (...names: string[]): ContractColumn[] => names.map((n) => text(n));

const table = (t: DatasetTableContract): DatasetTableContract =>
  Object.freeze({
    ...t,
    columns: Object.freeze([...t.columns]),
    primary_key: t.primary_key ? Object.freeze([...t.primary_key]) : null,
    indexes: Object.freeze(t.indexes.map((ix) => Object.freeze([...ix]))),
  });

// --- nflverse:schedules ------------------------------------------------------------------------------

/**
 * `ds_games` — every game of the covered seasons from `schedules/games.parquet` (ONE file for all
 * seasons 1999–; the source keeps `season ∈ ctx.seasons`). Observed 2026-09-30: 7,548 rows (272 in
 * 2026), 46 columns, SNAPPY. `gametime` is null on 259 games of 1999 only.
 */
export const DS_GAMES = table({
  name: "ds_games",
  source: "nflverse:schedules",
  upstream: "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.parquet",
  season_key: "season",
  row_filter: "season not in ctx.seasons",
  description: "NFL games: kickoff, teams, score, rest, betting lines, roof/surface, venue",
  columns: [
    text("game_id", false),
    int("season", false),
    text("game_type", false), // REG | WC | DIV | CON | SB
    int("week", false), // nflverse numbering: REG 1–18, postseason continues 19–22
    text("gameday", false), // YYYY-MM-DD, Eastern date
    text("weekday"),
    text("gametime"), // HH:MM Eastern (research 04 §B1)
    col(
      "kickoff_utc",
      "TEXT",
      true,
      ["gameday", "gametime"],
      "kickoffUtcFromEastern(gameday, gametime): America/New_York wall time → UTC ISO-8601 (DST-aware); null when gametime is null/malformed",
    ),
    text("away_team", false),
    text("home_team", false),
    ...ints("away_score", "home_score"), // null until final (see READER_QUERIES games.is_final)
    text("location"), // Home | Neutral
    ...ints("result", "total", "overtime", "away_rest", "home_rest"),
    ...ints("away_moneyline", "home_moneyline"),
    real("spread_line"), // + = home favoured (nflverse dictionary)
    ...ints("away_spread_odds", "home_spread_odds"),
    real("total_line"),
    ...ints("under_odds", "over_odds", "div_game"),
    col(
      "roof",
      "TEXT",
      true,
      ["roof"],
      'normalizeRoof: "" (retractable, state unknown) → NULL; lower-cased',
    ),
    text("surface"),
    ...ints("temp", "wind"), // post-game actuals for outdoor/open games only — never a forecast
    text("stadium_id"), // verbatim nflverse id — NOT always the real venue (see venue_id)
    text("stadium"), // raw stadium name (third-party text; wrapped on output)
    col(
      "venue_id",
      "TEXT",
      true,
      ["game_id", "stadium_id", "stadium"],
      "resolveVenueId(game_id, stadium_id, stadium) from src/sources/venues.ts: per-game override → unique stadium-name match → stadium_id; null when unknown. nflverse mis-codes some international games (2026_05_PHI_JAX: stadium_id JAX00, stadium 'Tottenham Hotspur Stadium'; 2025's seven international games carry the home team's stadium)",
    ),
  ],
  primary_key: ["season", "game_id"],
  indexes: [
    ["season", "week"],
    ["season", "home_team"],
    ["season", "away_team"],
  ],
});

/**
 * `ds_venues` — the checked-in stadium reference (src/sources/venues.ts VENUES), written into the
 * schedules dataset file on every schedules publish so `ds_games.venue_id` joins inside one file.
 */
export const DS_VENUES = table({
  name: "ds_venues",
  source: "nflverse:schedules",
  upstream: "src/sources/venues.ts (checked-in reference; research 04 §H.7)",
  season_key: null,
  row_filter: null,
  description: "Venue reference: IANA zone, coordinates, default roof",
  columns: [
    col("stadium_id", "TEXT", false, [], "VenueReference.stadium_id (checked-in reference)"),
    col("name", "TEXT", false, [], "VenueReference.name (checked-in reference)"),
    col("tz", "TEXT", false, [], "VenueReference.tz (checked-in reference)"),
    col("lat", "REAL", false, [], "VenueReference.lat (checked-in reference)"),
    col("lon", "REAL", false, [], "VenueReference.lon (checked-in reference)"),
    col(
      "roof_default",
      "TEXT",
      false,
      [],
      "VenueReference.roof_default: outdoors | dome | closed | open",
    ),
    col("retractable", "INTEGER", false, [], "VenueReference.retractable → 0 | 1"),
    col("country", "TEXT", false, [], "VenueReference.country: ISO 3166-1 alpha-2"),
  ],
  primary_key: ["stadium_id"],
  indexes: [],
});

// --- nflverse:injuries --------------------------------------------------------------------------------

/**
 * `ds_injuries` — official injury + practice reports, `injuries/injuries_{season}.parquet`. Observed
 * 2026: 744 rows, weeks 1–4, 16 columns, SNAPPY; NO timestamp or per-day practice column (one
 * `practice_status` per player-week) — `as_of` is the release stamp.
 */
export const DS_INJURIES = table({
  name: "ds_injuries",
  source: "nflverse:injuries",
  upstream:
    "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_{season}.parquet",
  season_key: "season",
  row_filter: "gsis_id null/empty",
  description: "Official injury report status and practice participation per player-week",
  columns: [
    int("season", false),
    text("game_type", false),
    int("week", false),
    text("team", false),
    text("gsis_id", false),
    ...texts("position", "full_name"),
    ...texts("report_primary_injury", "report_secondary_injury", "report_status"),
    ...texts("practice_primary_injury", "practice_secondary_injury", "practice_status"),
  ],
  primary_key: ["season", "week", "gsis_id", "team"],
  indexes: [["gsis_id", "season", "week"]],
});

// --- nflverse:roster_weekly ---------------------------------------------------------------------------

/**
 * `ds_roster_weekly` — weekly rosters + cross-platform ids (the crosswalk's source, research 04 §D),
 * `weekly_rosters/roster_weekly_{season}.parquet`. Observed 2026: 10,579 rows, weeks 1–4, 36
 * columns, SNAPPY; 5 rows with null gsis_id (dropped), 16 rows with `yahoo_id = ""` (→ NULL).
 */
export const DS_ROSTER_WEEKLY = table({
  name: "ds_roster_weekly",
  source: "nflverse:roster_weekly",
  upstream:
    "https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.parquet",
  season_key: "season",
  row_filter: "gsis_id null/empty",
  description: "Weekly NFL rosters with gsis_id and platform ids",
  columns: [
    int("season", false),
    int("week", false),
    text("game_type", false),
    text("team", false),
    text("gsis_id", false),
    text("full_name", false),
    ...texts("first_name", "last_name", "football_name"),
    ...texts("position", "depth_chart_position"),
    int("jersey_number"),
    ...texts("status", "status_description_abbr"), // ACT DEV RES RET EXE CUT INA
    col("birth_date", "TEXT", true, ["birth_date"], "isoDate: parquet DATE → YYYY-MM-DD"),
    ...texts("yahoo_id", "sleeper_id", "espn_id", "pfr_id", "sportradar_id"),
    ...texts("rotowire_id", "pff_id", "fantasy_data_id", "esb_id", "smart_id"),
    ...ints("years_exp", "entry_year", "rookie_year", "draft_number"),
    text("draft_club"),
  ],
  primary_key: ["season", "week", "gsis_id"],
  indexes: [
    ["season", "gsis_id", "week"],
    ["season", "team", "position"],
    ["yahoo_id"],
    ["sleeper_id"],
    ["espn_id"],
  ],
});

// --- nflverse:stats_player_week ------------------------------------------------------------------------

/**
 * The stat columns of `ds_player_week`, verbatim nflverse names — exactly what plan 08 §3.2's
 * `toStatLine(nflverse)` reads, plus usage shares for projections v1 and nflverse's own fantasy
 * points (a cross-check only). `fg_*_list` are `;`-separated kick distances ("51;43") — the path to
 * a league's own FG-distance brackets (plan 08 §4.1) without pbp.
 */
export const PLAYER_WEEK_STAT_COLUMNS: readonly ContractColumn[] = Object.freeze([
  ...ints("completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions"),
  ...ints("sacks_suffered", "sack_yards_lost", "sack_fumbles", "sack_fumbles_lost"),
  ...ints("passing_air_yards", "passing_first_downs", "passing_2pt_conversions"),
  ...ints("carries", "rushing_yards", "rushing_tds", "rushing_fumbles", "rushing_fumbles_lost"),
  ...ints("rushing_first_downs", "rushing_2pt_conversions"),
  ...ints("receptions", "targets", "receiving_yards", "receiving_tds"),
  ...ints("receiving_fumbles", "receiving_fumbles_lost", "receiving_air_yards"),
  ...ints("receiving_yards_after_catch", "receiving_first_downs", "receiving_2pt_conversions"),
  ...reals("target_share", "air_yards_share", "wopr"),
  ...ints("special_teams_tds", "fumble_recovery_own", "fumble_recovery_tds"),
  ...ints("punt_return_yards", "kickoff_return_yards"),
  ...ints("fg_made", "fg_att", "fg_missed", "fg_blocked", "fg_long"),
  ...ints("fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49"),
  ...ints("fg_made_50_59", "fg_made_60_"),
  ...ints("fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49"),
  ...ints("fg_missed_50_59", "fg_missed_60_"),
  ...texts("fg_made_list", "fg_missed_list", "fg_blocked_list"),
  ...ints("pat_made", "pat_att", "pat_missed", "pat_blocked"),
  ...reals("fantasy_points", "fantasy_points_ppr"),
]);

/**
 * `ds_player_week` — one row per player-week, `stats_player/stats_player_week_{season}.parquet`.
 * Observed 2026: 3,339 rows, weeks 1–3, 150 columns, SNAPPY; 3 rows with null player_id (all-zero
 * team placeholders, dropped). Every position is kept (IDP rows too) — the reader filters.
 */
export const DS_PLAYER_WEEK = table({
  name: "ds_player_week",
  source: "nflverse:stats_player_week",
  upstream:
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.parquet",
  season_key: "season",
  row_filter: "player_id null/empty",
  description: "Weekly player stat lines (offence, kicking, usage shares)",
  columns: [
    text("player_id", false), // = gsis_id
    ...texts("player_display_name", "position", "position_group"),
    int("season", false),
    int("week", false),
    text("season_type", false), // REG | POST
    text("game_id"),
    text("team", false),
    text("opponent_team"),
    ...PLAYER_WEEK_STAT_COLUMNS,
  ],
  primary_key: ["season", "week", "player_id"],
  indexes: [
    ["player_id", "season", "week"],
    ["season", "week", "team"],
  ],
});

/** Defensive player columns summed into a team-defence row (verbatim names, summed per team-week). */
export const TEAM_DEFENSE_SUM_COLUMNS = Object.freeze([
  "def_sacks",
  "def_interceptions",
  "fumble_recovery_opp",
  "def_tds",
  "special_teams_tds",
  "def_safeties",
  "def_fg_blocks",
  "def_punt_blocks",
  "def_pat_blocks",
] as const);

/**
 * `ds_team_defense_week` — the team-defence (DT) week DERIVED at load from the same
 * stats_player_week file: `SUM(col) GROUP BY season, week, team` over ALL of the file's player rows
 * (IDP included), plus the opponent offence's yardage from the opponent team's rows of the same
 * game. Points allowed are NOT here: they come from `ds_games` scores (schedules file). Chosen over
 * `stats_team_week` because that source is Phase 2 in SOURCE_REGISTRY (plan 10 §3.1a lists only
 * stats_player_week for 1a); its agreement with stats_team_week is [U] until Phase 2 cross-checks it.
 */
export const DS_TEAM_DEFENSE_WEEK = table({
  name: "ds_team_defense_week",
  source: "nflverse:stats_player_week",
  upstream:
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_{season}.parquet",
  season_key: "season",
  row_filter: "player_id null/empty (same rows as ds_player_week are aggregated)",
  description: "Team-defence week lines aggregated from player rows",
  columns: [
    int("season", false),
    int("week", false),
    text("season_type", false),
    text("team", false),
    col(
      "opponent_team",
      "TEXT",
      true,
      ["opponent_team"],
      "the team's (single) opponent_team for the week",
    ),
    col("game_id", "TEXT", true, ["game_id"], "the team's (single) game_id for the week"),
    col("def_sacks", "REAL", false, ["def_sacks"], "SUM over the team's rows (half sacks → REAL)"),
    ...TEAM_DEFENSE_SUM_COLUMNS.filter((c) => c !== "def_sacks").map((c) =>
      col(c, "INTEGER", false, [c], "SUM over the team's rows (NULL counts 0)"),
    ),
    col(
      DST_FUMBLE_RETURN_TD_COLUMN,
      "INTEGER",
      false,
      ["fumble_recovery_tds", "fumble_recovery_opp"],
      "SUM over the team's rows of defensiveFumbleReturnTds(row) = min(fumble_recovery_tds, fumble_recovery_opp) when fumble_recovery_opp > 0: defensive fumble-return TDs (nflverse def_tds holds interception returns only; QA-1-017)",
    ),
    col(
      "opp_passing_yards",
      "INTEGER",
      true,
      ["passing_yards", "opponent_team", "game_id"],
      "SUM(passing_yards) over the opponent's rows in the same game (gross, before sacks); null when the opponent has no rows",
    ),
    col(
      "opp_sack_yards_lost",
      "INTEGER",
      true,
      ["sack_yards_lost", "opponent_team", "game_id"],
      "|SUM(sack_yards_lost)| over the opponent's rows in the same game: the yards lost to sacks as a non-negative magnitude (upstream stores the loss negative; QA-2-032)",
    ),
    col(
      "opp_rushing_yards",
      "INTEGER",
      true,
      ["rushing_yards", "opponent_team", "game_id"],
      "SUM(rushing_yards) over the opponent's rows in the same game",
    ),
    col(
      "player_rows",
      "INTEGER",
      false,
      ["player_id"],
      "COUNT of the team's player rows aggregated",
    ),
  ],
  primary_key: ["season", "week", "team"],
  indexes: [["season", "week", "opponent_team"]],
});

// --- weather:open_meteo / weather:nws ------------------------------------------------------------------

/**
 * The weather tables' shared column list. One row per upcoming game at an outdoor/open venue (plan
 * 01 §5.2: only the coming week's outdoor games), the forecast hour that contains kickoff.
 * `precip_prob` is a FRACTION 0–1 (providers send percent; divide by 100). Units: °F, mph.
 */
const WEATHER_COLUMNS = (provider: string): ContractColumn[] => [
  col("game_id", "TEXT", false, ["ds_games.game_id"], "the schedules game the forecast is for"),
  col("season", "INTEGER", false, ["ds_games.season"], "copied from the game"),
  col("week", "INTEGER", false, ["ds_games.week"], "copied from the game"),
  col("venue_id", "TEXT", true, ["ds_games.venue_id"], "copied from the game"),
  col("lat", "REAL", false, ["ds_venues.lat"], "the venue coordinates queried"),
  col("lon", "REAL", false, ["ds_venues.lon"], "the venue coordinates queried"),
  col("kickoff_utc", "TEXT", false, ["ds_games.kickoff_utc"], "copied from the game"),
  col(
    "forecast_hour_utc",
    "TEXT",
    false,
    [`${provider}:time`],
    "the forecast hour containing kickoff, UTC ISO",
  ),
  col("temp_f", "REAL", true, [`${provider}:temperature`], "°F"),
  col("wind_mph", "REAL", true, [`${provider}:wind_speed`], "mph (10 m)"),
  col(
    "gust_mph",
    "REAL",
    true,
    [`${provider}:wind_gusts`],
    "mph; null when the provider omits gusts",
  ),
  col(
    "precip_prob",
    "REAL",
    true,
    [`${provider}:precipitation_probability`],
    "percent / 100 → 0..1",
  ),
  col(
    "as_of",
    "TEXT",
    false,
    [`${provider}:update_time`],
    "the provider's forecast issue time when it states one (NWS `updateTime`), else the fetch instant from the injected Clock",
  ),
];

/** `ds_weather_open_meteo` — Open-Meteo hourly forecast (research 04 §B7; non-commercial). */
export const DS_WEATHER_OPEN_METEO = table({
  name: "ds_weather_open_meteo",
  source: "weather:open_meteo",
  upstream:
    "https://api.open-meteo.com/v1/forecast (hourly; temperature_unit=fahrenheit, wind_speed_unit=mph)",
  season_key: null,
  row_filter: "games not in the coming week or at a dome/closed venue",
  description: "Kickoff-hour forecast per upcoming outdoor game (Open-Meteo)",
  columns: WEATHER_COLUMNS("open_meteo"),
  primary_key: ["game_id"],
  indexes: [["season", "week"]],
});

/** `ds_weather_nws` — NWS gridpoint hourly forecast (research 04 §B8; US venues only). */
export const DS_WEATHER_NWS = table({
  name: "ds_weather_nws",
  source: "weather:nws",
  upstream: "https://api.weather.gov/points/{lat},{lon} → forecastHourly",
  season_key: null,
  row_filter: "games not in the coming week, at a dome/closed venue, or outside the US",
  description: "Kickoff-hour forecast per upcoming outdoor US game (NWS)",
  columns: WEATHER_COLUMNS("nws"),
  primary_key: ["game_id"],
  indexes: [["season", "week"]],
});

// --- the registry ---------------------------------------------------------------------------------------

/** Every Phase-1a ds_* table, by the source whose dataset file holds it. */
export const DATASET_TABLES: Readonly<
  Record<Phase1aDatasetSourceId, readonly DatasetTableContract[]>
> = Object.freeze({
  "nflverse:schedules": Object.freeze([DS_GAMES, DS_VENUES]),
  "nflverse:injuries": Object.freeze([DS_INJURIES]),
  "nflverse:roster_weekly": Object.freeze([DS_ROSTER_WEEKLY]),
  "nflverse:stats_player_week": Object.freeze([DS_PLAYER_WEEK, DS_TEAM_DEFENSE_WEEK]),
  "weather:open_meteo": Object.freeze([DS_WEATHER_OPEN_METEO]),
  "weather:nws": Object.freeze([DS_WEATHER_NWS]),
});

/** Every Phase-1a table, flat. */
export const ALL_DATASET_TABLES: readonly DatasetTableContract[] = Object.freeze(
  PHASE_1A_DATASET_SOURCES.flatMap((s) => DATASET_TABLES[s]),
);

/** Whether `s` is a Phase-1a dataset source id. */
export function isPhase1aDatasetSource(s: string): s is Phase1aDatasetSourceId {
  return (PHASE_1A_DATASET_SOURCES as readonly string[]).includes(s);
}

/** The tables a source publishes; empty for a source with no Phase-1a tables. */
export function tablesFor(source: DatasetSourceId): readonly DatasetTableContract[] {
  return isPhase1aDatasetSource(source) ? DATASET_TABLES[source] : [];
}

/**
 * The upstream parquet columns a source's `assertSchema` must require (plan 01 §5.5: a missing or
 * renamed column fails the job): the union of every `from` of its tables, excluding reference and
 * cross-dataset inputs (`ds_*.x`, `provider:x`). Sorted, unique. Weather sources return [].
 */
export function requiredUpstreamColumns(source: DatasetSourceId): readonly string[] {
  const out = new Set<string>();
  for (const t of tablesFor(source)) {
    for (const c of t.columns) {
      for (const f of c.from) if (!f.includes(".") && !f.includes(":")) out.add(f);
    }
  }
  return [...out].sort();
}

// --- DDL -------------------------------------------------------------------------------------------------

/** Identifier grammar for table and column names (lowercase snake; nflverse's `fg_made_60_` fits). */
export const DATASET_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;

const q = (id: string): string => {
  if (!DATASET_IDENTIFIER_RE.test(id))
    throw new Error(`dataset contract: invalid identifier ${JSON.stringify(id)}`);
  return `"${id}"`;
};

/**
 * CREATE TABLE (STRICT) + CREATE INDEX statements for one table, in an optional attached schema.
 * Every identifier is validated against DATASET_IDENTIFIER_RE and double-quoted; a spec that names
 * an unknown PK/index column throws. Index names are `<table>__<col>__<col>`.
 */
export function ddlFor(spec: DatasetTableSpec, schema: string | null = null): readonly string[] {
  const names = new Set<string>();
  const cols = spec.columns.map((c) => {
    if (names.has(c.name))
      throw new Error(`dataset contract: duplicate column ${c.name} in ${spec.name}`);
    names.add(c.name);
    return `${q(c.name)} ${c.type}${c.nullable ? "" : " NOT NULL"}`;
  });
  const known = (c: string): string => {
    if (!names.has(c)) throw new Error(`dataset contract: ${spec.name} has no column ${c}`);
    return q(c);
  };
  const pre = schema === null ? "" : `${q(schema)}.`;
  const pk = spec.primary_key ? [`PRIMARY KEY (${spec.primary_key.map(known).join(", ")})`] : [];
  const out = [`CREATE TABLE ${pre}${q(spec.name)} (${[...cols, ...pk].join(", ")}) STRICT`];
  for (const ix of spec.indexes) {
    const cs = ix.map(known).join(", ");
    out.push(
      `CREATE INDEX ${pre}${q(`${spec.name}__${ix.join("__")}`)} ON ${q(spec.name)} (${cs})`,
    );
  }
  return out;
}

// --- reader queries: the SQL each domain reader method runs (store implements; plan 01 §5.5) ------------

/**
 * One statement a reader runs against ONE attached dataset file. `{schema}` is replaced by the
 * store with that source's quoted attachment schema name (e.g. `"ds_nflverse__schedules"`); list
 * parameters are JSON arrays bound as TEXT and expanded with `json_each` — the SQL text is fixed, so
 * no caller value is ever spliced into it.
 */
export interface ReaderStatement {
  readonly source: Phase1aDatasetSourceId;
  readonly tables: readonly string[];
  /** Named parameters (`:name`) the statement binds. */
  readonly params: readonly string[];
  readonly sql: string;
}

/** A reader method's contract: statements plus how rows map onto the domain type. */
export interface ReaderContract {
  /** `Interface.method` in src/domain (analytics/types.ts, crosswalk/types.ts). */
  readonly method: string;
  /** The domain row type it returns. */
  readonly returns: string;
  readonly statements: readonly ReaderStatement[];
  /** Mapping rules the store applies to each row (third-party text stays raw; the tools wrap it). */
  readonly mapping: string;
}

const stmt = (
  source: Phase1aDatasetSourceId,
  tables: readonly string[],
  params: readonly string[],
  sql: string,
): ReaderStatement =>
  Object.freeze({
    source,
    tables: Object.freeze([...tables]),
    params: Object.freeze([...params]),
    sql,
  });

/** Every reader method of the Phase-1a dataset ports, keyed `Interface.method`. */
export const READER_QUERIES = Object.freeze({
  /** ScheduleReader.games(season, weeks) — ds_games LEFT JOIN ds_venues (both in the schedules file). */
  "ScheduleReader.games": Object.freeze({
    method: "ScheduleReader.games",
    returns: "NflGame",
    statements: [
      stmt(
        "nflverse:schedules",
        ["ds_games", "ds_venues"],
        ["season", "weeks"],
        `SELECT g.*, v.tz AS venue_tz, v.roof_default AS venue_roof_default
FROM {schema}.ds_games AS g LEFT JOIN {schema}.ds_venues AS v ON v.stadium_id = g.venue_id
WHERE g.season = :season AND g.week IN (SELECT value FROM json_each(:weeks))
ORDER BY g.kickoff_utc IS NULL, g.kickoff_utc, g.game_id`,
      ),
    ],
    mapping:
      "kickoff ← kickoff_utc; away/home ← away_team/home_team (rows with a non-NflTeam abbreviation are skipped and warned); stadium_id ← venue_id (resolved venue, not the raw nflverse id); stadium ← stadium; venue_tz ← venue_tz; roof ← COALESCE(roof, venue_roof_default); divisional ← div_game = 1 (null → null); rest_days ← away_rest/home_rest; lines ← null when spread_line, total_line and both moneylines are all null, else { spread_line, total_line, implied: impliedPoints(spread_line, total_line), moneyline: away/home_moneyline, as_of: stamp.as_of }; is_final ← away_score AND home_score non-null ([U] nflverse fills scores only at final); score ← both scores when final, else null",
  }),
  /** ScheduleReader.firstKickoff(season, week) — MIN(kickoff_utc) over ds_games. */
  "ScheduleReader.firstKickoff": Object.freeze({
    method: "ScheduleReader.firstKickoff",
    returns: "IsoInstant | null",
    statements: [
      stmt(
        "nflverse:schedules",
        ["ds_games"],
        ["season", "week"],
        `SELECT MIN(kickoff_utc) AS first_kickoff FROM {schema}.ds_games
WHERE season = :season AND week = :week AND kickoff_utc IS NOT NULL`,
      ),
    ],
    mapping: "first_kickoff as-is; null when the week has no game with a kickoff (or none at all)",
  }),
  /** InjuryReader.reports(season, week, gsisIds | null) — ds_injuries. */
  "InjuryReader.reports": Object.freeze({
    method: "InjuryReader.reports",
    returns: "InjuryReport",
    statements: [
      stmt(
        "nflverse:injuries",
        ["ds_injuries"],
        ["season", "week", "gsis_ids"],
        `SELECT * FROM {schema}.ds_injuries
WHERE season = :season AND week = :week
  AND (:gsis_ids IS NULL OR gsis_id IN (SELECT value FROM json_each(:gsis_ids)))
ORDER BY team, gsis_id`,
      ),
    ],
    mapping:
      "nfl_team ← team; report_status as-is; practice ← practice_status null ? [] : [{ day: 'week', status: practice_status }] (the file has ONE practice status per player-week, no per-day rows); primary_injury ← COALESCE(report_primary_injury, practice_primary_injury); secondary_injury ← COALESCE(report_secondary_injury, practice_secondary_injury); as_of ← stamp.as_of (no timestamp column); `gsis_ids = NULL` means every player",
  }),
  /** PlayerWeekReader.lines(gsisIds, season, weeks) — ds_player_week. */
  "PlayerWeekReader.lines": Object.freeze({
    method: "PlayerWeekReader.lines",
    returns: "PlayerWeekLine",
    statements: [
      stmt(
        "nflverse:stats_player_week",
        ["ds_player_week"],
        ["season", "weeks", "gsis_ids"],
        `SELECT * FROM {schema}.ds_player_week
WHERE season = :season AND week IN (SELECT value FROM json_each(:weeks))
  AND player_id IN (SELECT value FROM json_each(:gsis_ids))
ORDER BY player_id, week`,
      ),
    ],
    mapping:
      "gsis_id ← player_id; nfl_team ← team; opponent ← opponent_team; position as-is; line ← toStatLine(nflverse) over PLAYER_WEEK_STAT_COLUMNS (plan 08 §3.2; NULL stat → absent from `present`)",
  }),
  /**
   * PlayerWeekReader.defenseLines(teams, season, weeks) — ds_team_defense_week, then points allowed
   * from ds_games (a second statement on the schedules file; no cross-file JOIN, so an LRU detach of
   * either file never breaks the query — the second is skipped and dst_pa is absent when schedules
   * is not attached).
   */
  "PlayerWeekReader.defenseLines": Object.freeze({
    method: "PlayerWeekReader.defenseLines",
    returns: "TeamDefenseWeekLine",
    statements: [
      stmt(
        "nflverse:stats_player_week",
        ["ds_team_defense_week"],
        ["season", "weeks", "teams"],
        `SELECT * FROM {schema}.ds_team_defense_week
WHERE season = :season AND week IN (SELECT value FROM json_each(:weeks))
  AND team IN (SELECT value FROM json_each(:teams))
ORDER BY team, week`,
      ),
      stmt(
        "nflverse:schedules",
        ["ds_games"],
        ["season", "game_ids"],
        `SELECT game_id, away_team, home_team, away_score, home_score FROM {schema}.ds_games
WHERE season = :season AND game_id IN (SELECT value FROM json_each(:game_ids))`,
      ),
    ],
    mapping:
      "nfl_team ← team; opponent ← opponent_team; line ← DT StatLine: dst_sack ← def_sacks, dst_int ← def_interceptions, dst_fum_rec ← fumble_recovery_opp, dst_td ← def_tds + fumble_recovery_tds_opp, dst_ret_td ← special_teams_tds, dst_safety ← def_safeties, dst_blk ← def_fg_blocks + def_punt_blocks (+ def_pat_blocks per the league's rule, plan 08 U), dst_pa ← the opponent's score from statement 2 (game final only; definition (a)/(b) per plan 08 §3.2 U-6), dst_ya ← yardsAllowed(opp_passing_yards, opp_sack_yards_lost, opp_rushing_yards) = opp_passing_yards − |opp_sack_yards_lost| + opp_rushing_yards, the opponent's net yards ([U] Yahoo's yards-allowed definition; QA-2-032)",
  }),
  /** WeatherReader.forGames(gameIds) — the configured weather source's table, then the other. */
  "WeatherReader.forGames": Object.freeze({
    method: "WeatherReader.forGames",
    returns: "WeatherObservation",
    statements: [
      stmt(
        "weather:open_meteo",
        ["ds_weather_open_meteo"],
        ["game_ids"],
        `SELECT * FROM {schema}.ds_weather_open_meteo
WHERE game_id IN (SELECT value FROM json_each(:game_ids)) ORDER BY game_id`,
      ),
      stmt(
        "weather:nws",
        ["ds_weather_nws"],
        ["game_ids"],
        `SELECT * FROM {schema}.ds_weather_nws
WHERE game_id IN (SELECT value FROM json_each(:game_ids)) ORDER BY game_id`,
      ),
    ],
    mapping:
      "run the FF_WEATHER_SOURCE statement first, then the other for game_ids still missing (a missing file is skipped); source ← 'weather:open_meteo' | 'weather:nws' by table; temp_f, wind_mph, gust_mph, precip_prob (0..1), as_of as-is; the stamp is the first contributing source's",
  }),
  /** RosterWeeklyReader.latest(season) — the newest week's row per gsis_id. */
  "RosterWeeklyReader.latest": Object.freeze({
    method: "RosterWeeklyReader.latest",
    returns: "NflRosterPlayer",
    statements: [
      stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["season"],
        `SELECT r.* FROM {schema}.ds_roster_weekly AS r
JOIN (SELECT gsis_id, MAX(week) AS week FROM {schema}.ds_roster_weekly WHERE season = :season GROUP BY gsis_id) AS m
  ON m.gsis_id = r.gsis_id AND m.week = r.week
WHERE r.season = :season ORDER BY r.gsis_id`,
      ),
    ],
    mapping:
      "gsis_id, season, week, full_name, position, jersey_number, yahoo_id, sleeper_id, espn_id, pfr_id, status as-is; team as NflTeam (non-NflTeam rows skipped and warned)",
  }),
  /**
   * RosterWeeklyReader.byPlatformId(platform, id) — one statement per platform column; the store
   * picks it by `platform` from a fixed map (never splices the column name from input).
   */
  "RosterWeeklyReader.byPlatformId": Object.freeze({
    method: "RosterWeeklyReader.byPlatformId",
    returns: "NflRosterPlayer",
    statements: (["yahoo_id", "sleeper_id", "espn_id"] as const).map((idCol) =>
      stmt(
        "nflverse:roster_weekly",
        ["ds_roster_weekly"],
        ["id"],
        `SELECT * FROM {schema}.ds_roster_weekly WHERE ${idCol} = :id
ORDER BY season DESC, week DESC LIMIT 1`,
      ),
    ),
    mapping:
      "statements[0] yahoo, [1] sleeper, [2] espn; the newest row for that id (0 or 1 row); an empty/blank id never reaches SQL (returns no rows) — stored ids are NULL, never ''",
  }),
} satisfies Record<string, ReaderContract>);

/** A reader method key. */
export type ReaderMethod = keyof typeof READER_QUERIES;

/** The platform → statement index of `RosterWeeklyReader.byPlatformId`. */
export const BY_PLATFORM_STATEMENT: Readonly<Record<"yahoo" | "sleeper" | "espn", 0 | 1 | 2>> =
  Object.freeze({ yahoo: 0, sleeper: 1, espn: 2 });

/** Substitutes an attachment schema name into a reader statement (validated, double-quoted). */
export function bindSchema(sql: string, schema: string): string {
  return sql.replaceAll("{schema}", q(schema));
}
