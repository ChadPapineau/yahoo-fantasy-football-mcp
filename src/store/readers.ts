// readers.ts — the domain's read-only dataset ports over the attached files (plan 01 §5.2/§5.5;
// plan 07 §2 stamps), running EXACTLY the SQL of READER_QUERIES (src/store/datasets/tables.ts) with
// `bindSchema` and JSON-array list parameters, and applying each entry's `mapping`. A dataset whose
// file is absent answers `{ rows: [], stamp: null }` — the contract's "never loaded" outcome
// (DATASET_NEVER_LOADED_HINT at the tool layer), never an exception.
import type { DatabaseSync } from "node:sqlite";
import { isNflTeam, type NflTeam } from "../config/schema.js";
import type {
  AttachedDataset,
  DatasetReaders,
  DatasetResult,
  DatasetStamp,
  GameLines,
  InjuryReport,
  NflGame,
  PlayerWeekLine,
  TeamDefenseWeekLine,
  WeatherObservation,
} from "../domain/analytics/types.js";
import type { NflRosterPlayer, RosterWeeklyReader } from "../domain/crosswalk/types.js";
import type { IsoInstant, Week } from "../domain/league/types.js";
import type { Attachments } from "./attach.js";
import { impliedPoints } from "./datasets/derive.js";
import { defenseRowToStatLine, playerRowToStatLine, type SqlRow } from "./datasets/statline.js";
import {
  BY_PLATFORM_STATEMENT,
  bindSchema,
  READER_QUERIES,
  type ReaderMethod,
} from "./datasets/tables.js";

/** Most ids/weeks/teams one reader call accepts (bounded statement; 20 k ids is well inside). */

/**
 * A game's roof: the venue's physical roof decides for open-air (`outdoors`) and fixed-roof (`dome`)
 * venues — nflverse says `dome` for the open-air MCG, Stade de France and Allianz Arena — and only
 * for a retractable venue (`closed`/`open` default) does the game row's own state win, falling back
 * to the venue default. The same rule as the weather sources' needsWeather, so analytics and the
 * published forecasts agree on which games are outdoors.
 */
export function gameRoof(gameRoofValue: string | null, venueDefault: string | null): string | null {
  if (venueDefault === "outdoors" || venueDefault === "dome") return venueDefault;
  return gameRoofValue ?? venueDefault;
}

export const READER_LIST_MAX = 100_000;
/** Longest platform id `byPlatformId` sends to SQL. */
export const PLATFORM_ID_MAX = 64;

/** Which weather table a WeatherReader consults first (FF_WEATHER_SOURCE; plan 01 §5.2). */
export type WeatherPreference = "weather:open_meteo" | "weather:nws";

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null;
const team = (v: unknown): NflTeam | null => (typeof v === "string" && isNflTeam(v) ? v : null);

function season(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1990 || v > 2100)
    throw new RangeError("store: season must be an integer in 1990..2100");
  return v;
}
function week(v: unknown): Week {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 22)
    throw new RangeError("store: week must be an integer in 1..22");
  return v;
}
function weekList(v: readonly Week[]): string {
  if (!Array.isArray(v) || v.length > READER_LIST_MAX)
    throw new RangeError("store: weeks must be a bounded array");
  return JSON.stringify(v.map(week));
}
function stringList(v: readonly string[], what: string): string {
  if (!Array.isArray(v) || v.length > READER_LIST_MAX)
    throw new RangeError(
      `store: ${what} must be an array of at most ${String(READER_LIST_MAX)} strings`,
    );
  for (const s of v)
    if (typeof s !== "string") throw new RangeError(`store: ${what} must hold strings`);
  return JSON.stringify(v);
}

/** Options the readers are built from. */
export interface ReadersOptions {
  readonly db: DatabaseSync;
  readonly attachments: Attachments;
  readonly weatherFirst: WeatherPreference;
  readonly warn: (code: string) => void;
}

export function createReaders(o: ReadersOptions): {
  datasets: DatasetReaders;
  rosterWeekly: RosterWeeklyReader;
} {
  const { db, attachments, warn } = o;

  /** Runs statement `i` of a reader method on the attachment of its source; null when never loaded. */
  function run(
    method: ReaderMethod,
    i: number,
    params: Record<string, string | number | null>,
  ): { rows: SqlRow[]; att: AttachedDataset } | null {
    const st = READER_QUERIES[method].statements[i];
    if (st === undefined) throw new Error(`store: ${method} has no statement ${String(i)}`);
    const att = attachments.use(st.source);
    if (att === null) return null;
    const rows = db.prepare(bindSchema(st.sql, att.schema)).all(params) as unknown as SqlRow[];
    return { rows, att };
  }

  const stampOf = (att: AttachedDataset): DatasetStamp => attachments.stamp(att);

  function mapGame(r: SqlRow, asOf: IsoInstant): NflGame | null {
    const away = team(r.away_team);
    const home = team(r.home_team);
    if (away === null || home === null) {
      warn("dataset_row_skipped_team");
      return null;
    }
    const spread = numOrNull(r.spread_line);
    const total = numOrNull(r.total_line);
    const mlAway = numOrNull(r.away_moneyline);
    const mlHome = numOrNull(r.home_moneyline);
    const lines: GameLines | null =
      spread === null && total === null && mlAway === null && mlHome === null
        ? null
        : {
            spread_line: spread,
            total_line: total,
            implied: impliedPoints(spread, total),
            moneyline: { away: mlAway, home: mlHome },
            as_of: asOf,
          };
    const as = numOrNull(r.away_score);
    const hs = numOrNull(r.home_score);
    const final = as !== null && hs !== null;
    const div = numOrNull(r.div_game);
    return {
      game_id: str(r.game_id) ?? "",
      season: numOrNull(r.season) ?? 0,
      week: numOrNull(r.week) ?? 0,
      kickoff: str(r.kickoff_utc),
      away,
      home,
      stadium_id: str(r.venue_id),
      stadium: str(r.stadium),
      venue_tz: str(r.venue_tz),
      roof: gameRoof(str(r.roof), str(r.venue_roof_default)),
      surface: str(r.surface),
      divisional: div === null ? null : div === 1,
      rest_days: { away: numOrNull(r.away_rest), home: numOrNull(r.home_rest) },
      lines,
      is_final: final,
      score: final ? { away: as, home: hs } : null,
    };
  }

  const schedules: DatasetReaders["schedules"] = {
    games(s, weeks): DatasetResult<NflGame> {
      const res = run("ScheduleReader.games", 0, { season: season(s), weeks: weekList(weeks) });
      if (res === null) return { rows: [], stamp: null };
      const stamp = stampOf(res.att);
      const rows = res.rows
        .map((r) => mapGame(r, stamp.as_of))
        .filter((g): g is NflGame => g !== null);
      return { rows, stamp };
    },
    firstKickoff(s, w) {
      const res = run("ScheduleReader.firstKickoff", 0, { season: season(s), week: week(w) });
      return res === null ? null : str(res.rows[0]?.first_kickoff);
    },
  };

  const injuries: DatasetReaders["injuries"] = {
    reports(s, w, gsisIds): DatasetResult<InjuryReport> {
      const ids = gsisIds === null ? null : stringList(gsisIds, "gsisIds");
      const res = run("InjuryReader.reports", 0, {
        season: season(s),
        week: week(w),
        gsis_ids: ids,
      });
      if (res === null) return { rows: [], stamp: null };
      const stamp = stampOf(res.att);
      const rows: InjuryReport[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const gsis = str(r.gsis_id);
        if (t === null || gsis === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        const practice = str(r.practice_status);
        rows.push({
          gsis_id: gsis,
          season: numOrNull(r.season) ?? s,
          week: numOrNull(r.week) ?? w,
          nfl_team: t,
          report_status: str(r.report_status),
          practice: practice === null ? [] : [{ day: "week", status: practice }],
          primary_injury: str(r.report_primary_injury) ?? str(r.practice_primary_injury),
          secondary_injury: str(r.report_secondary_injury) ?? str(r.practice_secondary_injury),
          as_of: stamp.as_of,
        });
      }
      return { rows, stamp };
    },
  };

  const playerWeeks: DatasetReaders["playerWeeks"] = {
    lines(gsisIds, s, weeks): DatasetResult<PlayerWeekLine> {
      const res = run("PlayerWeekReader.lines", 0, {
        season: season(s),
        weeks: weekList(weeks),
        gsis_ids: stringList(gsisIds, "gsisIds"),
      });
      if (res === null) return { rows: [], stamp: null };
      const rows: PlayerWeekLine[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        const gsis = str(r.player_id);
        if (t === null || gsis === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        rows.push({
          gsis_id: gsis,
          season: numOrNull(r.season) ?? s,
          week: numOrNull(r.week) ?? 0,
          nfl_team: t,
          opponent: team(r.opponent_team),
          position: str(r.position) ?? "",
          line: playerRowToStatLine(r),
        });
      }
      return { rows, stamp: stampOf(res.att) };
    },

    defenseLines(teams, s, weeks): DatasetResult<TeamDefenseWeekLine> {
      const sn = season(s);
      const res = run("PlayerWeekReader.defenseLines", 0, {
        season: sn,
        weeks: weekList(weeks),
        teams: stringList(teams, "teams"),
      });
      if (res === null) return { rows: [], stamp: null };
      const gameIds = [
        ...new Set(res.rows.map((r) => str(r.game_id)).filter((g): g is string => g !== null)),
      ];
      // Statement 2: points allowed from the schedules file (skipped when it is not attached).
      const scores = new Map<string, SqlRow>();
      if (gameIds.length > 0) {
        const g = run("PlayerWeekReader.defenseLines", 1, {
          season: sn,
          game_ids: JSON.stringify(gameIds),
        });
        for (const r of g?.rows ?? []) {
          const id = str(r.game_id);
          if (id !== null) scores.set(id, r);
        }
      }
      const rows: TeamDefenseWeekLine[] = [];
      for (const r of res.rows) {
        const t = team(r.team);
        if (t === null) {
          warn("dataset_row_skipped_team");
          continue;
        }
        const game = scores.get(str(r.game_id) ?? "");
        let pa: number | null = null;
        if (game !== undefined) {
          const as = numOrNull(game.away_score);
          const hs = numOrNull(game.home_score);
          if (as !== null && hs !== null) {
            if (game.home_team === t) pa = as;
            else if (game.away_team === t) pa = hs;
          }
        }
        rows.push({
          nfl_team: t,
          season: numOrNull(r.season) ?? sn,
          week: numOrNull(r.week) ?? 0,
          opponent: team(r.opponent_team),
          line: defenseRowToStatLine(r, pa),
        });
      }
      return { rows, stamp: stampOf(res.att) };
    },
  };

  const weather: DatasetReaders["weather"] = {
    forGames(gameIds): DatasetResult<WeatherObservation> {
      const ids = stringList(gameIds, "gameIds");
      const order: [WeatherPreference, number][] =
        o.weatherFirst === "weather:nws"
          ? [
              ["weather:nws", 1],
              ["weather:open_meteo", 0],
            ]
          : [
              ["weather:open_meteo", 0],
              ["weather:nws", 1],
            ];
      const found = new Map<string, WeatherObservation>();
      let stamp: DatasetStamp | null = null;
      let firstAttached: AttachedDataset | null = null;
      const want = JSON.parse(ids) as string[];
      for (const [source, idx] of order) {
        const missing = want.filter((g) => !found.has(g));
        if (missing.length === 0 && want.length > 0) break;
        const res = run("WeatherReader.forGames", idx, { game_ids: JSON.stringify(missing) });
        if (res === null) continue;
        firstAttached ??= res.att;
        let contributed = false;
        for (const r of res.rows) {
          const id = str(r.game_id);
          if (id === null || found.has(id)) continue;
          found.set(id, {
            game_id: id,
            temp_f: numOrNull(r.temp_f),
            wind_mph: numOrNull(r.wind_mph),
            gust_mph: numOrNull(r.gust_mph),
            precip_prob: numOrNull(r.precip_prob),
            as_of: str(r.as_of) ?? "",
            source,
          });
          contributed = true;
        }
        if (contributed && stamp === null) stamp = stampOf(res.att);
      }
      if (stamp === null && firstAttached !== null) stamp = stampOf(firstAttached);
      const rows = [...found.values()].sort((a, b) => a.game_id.localeCompare(b.game_id));
      return { rows, stamp };
    },
  };

  function mapRoster(r: SqlRow): NflRosterPlayer | null {
    const t = team(r.team);
    const gsis = str(r.gsis_id);
    if (t === null || gsis === null) {
      warn("dataset_row_skipped_team");
      return null;
    }
    return {
      gsis_id: gsis,
      season: numOrNull(r.season) ?? 0,
      week: numOrNull(r.week) ?? 0,
      full_name: str(r.full_name) ?? "",
      team: t,
      position: str(r.position) ?? "",
      jersey_number: numOrNull(r.jersey_number),
      yahoo_id: str(r.yahoo_id),
      sleeper_id: str(r.sleeper_id),
      espn_id: str(r.espn_id),
      pfr_id: str(r.pfr_id),
      status: str(r.status),
    };
  }

  const rosterWeekly: RosterWeeklyReader = {
    latest(s): DatasetResult<NflRosterPlayer> {
      const res = run("RosterWeeklyReader.latest", 0, { season: season(s) });
      if (res === null) return { rows: [], stamp: null };
      const rows = res.rows.map(mapRoster).filter((p): p is NflRosterPlayer => p !== null);
      return { rows, stamp: stampOf(res.att) };
    },
    byPlatformId(platform, id): DatasetResult<NflRosterPlayer> {
      const idx = BY_PLATFORM_STATEMENT[platform];
      if ((idx as number | undefined) === undefined)
        throw new RangeError("store: unknown platform");
      if (typeof id !== "string" || id.trim() === "" || id.length > PLATFORM_ID_MAX) {
        const att = attachments.use("nflverse:roster_weekly");
        return { rows: [], stamp: att === null ? null : stampOf(att) };
      }
      const res = run("RosterWeeklyReader.byPlatformId", idx, { id });
      if (res === null) return { rows: [], stamp: null };
      const rows = res.rows.map(mapRoster).filter((p): p is NflRosterPlayer => p !== null);
      return { rows, stamp: stampOf(res.att) };
    },
  };

  return { datasets: { schedules, injuries, playerWeeks, weather }, rosterWeekly };
}
