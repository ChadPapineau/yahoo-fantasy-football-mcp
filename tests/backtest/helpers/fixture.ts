// fixture.ts — in-memory DatasetReaders over the committed nflverse fixture parquet files (plan 05
// §3.2; fixtures/nflverse/manifest.json) and the fixture league (fixtures/manual/league.yaml), so the
// analytics tests and backtests replay real 2026 weeks 1–3 without a store, a network or ~/.config.
// The translation mirrors READER_QUERIES (src/store/datasets/tables.ts): statLineFromPlayerWeek for
// player rows, a team-week SUM of TEAM_DEFENSE_SUM_COLUMNS + the opponent's yardage for DT lines,
// points allowed from the schedule's final scores.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parquetReadObjects } from "hyparquet";
import { isNflTeam, type NflTeam } from "../../../src/config/schema.js";
import type {
  DatasetResult,
  DatasetStamp,
  InjuryReport,
  InjuryReader,
  NflGame,
  PlayerWeekLine,
  PlayerWeekReader,
  ScheduleReader,
  TeamDefenseWeekLine,
  WeatherObservation,
  WeatherReader,
} from "../../../src/domain/analytics/types.js";
import type { Week } from "../../../src/domain/league/types.js";
import {
  DST_FUMBLE_RETURN_TD_COLUMN,
  defensiveFumbleReturnTds,
  positionTypeForNflPosition,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "../../../src/domain/scoring/nflverse.js";
import { impliedPoints, kickoffUtcFromEastern } from "../../../src/store/datasets/derive.js";
import { TEAM_DEFENSE_SUM_COLUMNS } from "../../../src/store/datasets/tables.js";

export const REPO = fileURLToPath(new URL("../../../", import.meta.url));
export const FIXTURE_DIR = `${REPO}fixtures/nflverse/`;
export const LEAGUE_FILE = `${REPO}fixtures/manual/league.yaml`;
export const FIXTURE_ROSTER = `${REPO}fixtures/players/fixture-roster.json`;

type Row = Readonly<Record<string, unknown>>;

async function readParquet(rel: string): Promise<Row[]> {
  const buf = readFileSync(`${FIXTURE_DIR}${rel}`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return (await parquetReadObjects({ file: ab })) as Row[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A fixed release stamp for a fixture source (as_of = the release's own stamp). */
export function fixtureStamp(source: DatasetStamp["source"], asOf: string): DatasetStamp {
  return {
    source,
    as_of: asOf,
    fetched_at: "2026-09-30T16:00:00.000Z",
    checked_at: "2026-09-30T16:00:00.000Z",
    freshness_class:
      source === "nflverse:schedules"
        ? "nflverse_schedules"
        : source === "nflverse:injuries"
          ? "nflverse_injuries"
          : "nflverse_stats_player_week",
    file_version: "fixture",
  };
}

/** Everything the readers serve, already translated. */
export interface FixtureData {
  readonly games: readonly NflGame[];
  readonly lines: readonly PlayerWeekLine[];
  readonly defense: readonly TeamDefenseWeekLine[];
  readonly injuries: readonly InjuryReport[];
  /** Raw stats rows (for K fg lists and realised checks). */
  readonly statsRows: readonly Row[];
}

let cached: Promise<FixtureData> | null = null;
const oppOf = new Map<string, string>();

/** Loads (once per process) and translates the fixture parquet files. */
export function loadFixtureData(): Promise<FixtureData> {
  cached ??= build();
  return cached;
}

async function build(): Promise<FixtureData> {
  const [sched, stats, inj] = await Promise.all([
    readParquet("schedules/games.excerpt.parquet"),
    readParquet("stats_player/stats_player_week_2026.parquet"),
    readParquet("injuries/injuries_2026.parquet"),
  ]);
  const schedAsOf = "2026-09-30T15:58:07.000Z";
  const games: NflGame[] = [];
  for (const r of sched) {
    const away = str(r.away_team);
    const home = str(r.home_team);
    if (away === null || home === null || !isNflTeam(away) || !isNflTeam(home)) continue;
    const spread = num(r.spread_line);
    const total = num(r.total_line);
    const implied = impliedPoints(spread, total);
    const as = num(r.away_score);
    const hs = num(r.home_score);
    games.push({
      game_id: String(r.game_id),
      season: Number(r.season),
      week: Number(r.week),
      kickoff: kickoffUtcFromEastern(r.gameday, r.gametime),
      away,
      home,
      stadium_id: str(r.stadium_id),
      stadium: str(r.stadium),
      venue_tz: null,
      roof: str(r.roof),
      surface: str(r.surface),
      divisional: num(r.div_game) === null ? null : num(r.div_game) === 1,
      rest_days: { away: num(r.away_rest), home: num(r.home_rest) },
      lines:
        spread === null && total === null
          ? null
          : {
              spread_line: spread,
              total_line: total,
              implied,
              moneyline: { away: num(r.away_moneyline), home: num(r.home_moneyline) },
              as_of: schedAsOf,
            },
      is_final: as !== null && hs !== null,
      score: as !== null && hs !== null ? { away: as, home: hs } : null,
    });
  }

  const lines: PlayerWeekLine[] = [];
  for (const r of stats) {
    const id = str(r.player_id);
    const team = str(r.team);
    const pt = positionTypeForNflPosition(str(r.position));
    if (id === null || team === null || !isNflTeam(team) || (pt !== "O" && pt !== "K")) continue;
    const opp = str(r.opponent_team);
    lines.push({
      gsis_id: id,
      season: Number(r.season),
      week: Number(r.week),
      nfl_team: team,
      opponent: opp !== null && isNflTeam(opp) ? opp : null,
      position: String(r.position),
      line: statLineFromPlayerWeek(r, { positionType: pt }),
    });
  }

  // team-week sums (READER_QUERIES["PlayerWeekReader.defenseLines"])
  const sums = new Map<string, Record<string, number>>();
  for (const r of stats) {
    const team = str(r.team);
    if (team === null) continue;
    const key = `${String(r.season)}|${String(r.week)}|${team}`;
    const acc = sums.get(key) ?? {
      __opp: 0,
      passing_yards: 0,
      sack_yards_lost: 0,
      rushing_yards: 0,
    };
    for (const c of TEAM_DEFENSE_SUM_COLUMNS) acc[c] = (acc[c] ?? 0) + (num(r[c]) ?? 0);
    // mirrors team-defense.ts: defensive fumble-return TDs, per row (QA-1-017)
    acc[DST_FUMBLE_RETURN_TD_COLUMN] =
      (acc[DST_FUMBLE_RETURN_TD_COLUMN] ?? 0) + defensiveFumbleReturnTds(r);
    acc.passing_yards = (acc.passing_yards ?? 0) + (num(r.passing_yards) ?? 0);
    acc.sack_yards_lost = (acc.sack_yards_lost ?? 0) + (num(r.sack_yards_lost) ?? 0);
    acc.rushing_yards = (acc.rushing_yards ?? 0) + (num(r.rushing_yards) ?? 0);
    sums.set(key, acc);
    const opp = str(r.opponent_team);
    if (opp !== null) oppOf.set(key, opp);
  }
  const defense: TeamDefenseWeekLine[] = [];
  for (const [key, acc] of sums) {
    const [season, week, team] = key.split("|") as [string, string, string];
    const opp = oppOf.get(key) ?? null;
    if (!isNflTeam(team) || opp === null || !isNflTeam(opp)) continue;
    const o = sums.get(`${season}|${week}|${opp}`);
    const g = games.find(
      (x) =>
        x.season === Number(season) &&
        x.week === Number(week) &&
        (x.home === team || x.away === team),
    );
    const pa = g?.score == null ? null : g.home === team ? g.score.away : g.score.home;
    defense.push({
      nfl_team: team,
      season: Number(season),
      week: Number(week),
      opponent: opp,
      line: statLineFromTeamDefense(
        {
          ...acc,
          opp_passing_yards: o?.passing_yards ?? null,
          opp_sack_yards_lost: o?.sack_yards_lost ?? null,
          opp_rushing_yards: o?.rushing_yards ?? null,
        },
        { pointsAllowed: pa },
      ),
    });
  }

  const injuries: InjuryReport[] = [];
  for (const r of inj) {
    const id = str(r.gsis_id);
    const team = str(r.team);
    if (id === null || team === null || !isNflTeam(team)) continue;
    const practice = str(r.practice_status);
    injuries.push({
      gsis_id: id,
      season: Number(r.season),
      week: Number(r.week),
      nfl_team: team,
      report_status: str(r.report_status),
      practice: practice === null ? [] : [{ day: "week", status: practice }],
      primary_injury: str(r.report_primary_injury) ?? str(r.practice_primary_injury),
      secondary_injury: str(r.report_secondary_injury) ?? str(r.practice_secondary_injury),
      as_of: "2026-09-30T13:36:25.000Z",
    });
  }
  return { games, lines, defense, injuries, statsRows: stats };
}

/** Options for the readers (e.g. to simulate a never-loaded dataset). */
export interface ReaderOptions {
  readonly statsLoaded?: boolean;
  readonly schedulesLoaded?: boolean;
  readonly injuriesLoaded?: boolean;
  readonly weather?: readonly WeatherObservation[];
}

/** The four DatasetReaders over fixture data (seasons outside the data return empty rows). */
export function fixtureReaders(
  data: FixtureData,
  opts: ReaderOptions = {},
): {
  schedules: ScheduleReader;
  injuries: InjuryReader;
  playerWeeks: PlayerWeekReader;
  weather: WeatherReader;
} {
  const statsStamp = fixtureStamp("nflverse:stats_player_week", "2026-09-30T09:05:44.000Z");
  const schedStamp = fixtureStamp("nflverse:schedules", "2026-09-30T15:58:07.000Z");
  const injStamp = fixtureStamp("nflverse:injuries", "2026-09-30T13:36:25.000Z");
  const result = <T>(rows: T[], stamp: DatasetStamp, loaded: boolean): DatasetResult<T> =>
    loaded ? { rows, stamp } : { rows: [], stamp: null };
  // the fixture holds only the 2026 stats file: an earlier season reads as "never loaded"
  const statsFor = (season: number): boolean => (opts.statsLoaded ?? true) && season === 2026;
  return {
    schedules: {
      games: (season: number, weeks: readonly Week[]) =>
        result(
          data.games.filter((g) => g.season === season && weeks.includes(g.week)),
          schedStamp,
          opts.schedulesLoaded ?? true,
        ),
      firstKickoff: (season: number, week: Week) => {
        const ks = data.games
          .filter((g) => g.season === season && g.week === week && g.kickoff !== null)
          .map((g) => Date.parse(g.kickoff ?? ""));
        return ks.length === 0 ? null : new Date(Math.min(...ks)).toISOString();
      },
    },
    injuries: {
      reports: (season: number, week: Week, ids: readonly string[] | null) =>
        result(
          data.injuries.filter(
            (r) =>
              r.season === season && r.week === week && (ids === null || ids.includes(r.gsis_id)),
          ),
          injStamp,
          (opts.injuriesLoaded ?? true) && season === 2026,
        ),
    },
    playerWeeks: {
      lines: (ids: readonly string[], season: number, weeks: readonly Week[]) =>
        result(
          data.lines.filter(
            (l) => l.season === season && weeks.includes(l.week) && ids.includes(l.gsis_id),
          ),
          statsStamp,
          statsFor(season),
        ),
      defenseLines: (teams: readonly NflTeam[], season: number, weeks: readonly Week[]) =>
        result(
          data.defense.filter(
            (l) => l.season === season && weeks.includes(l.week) && teams.includes(l.nfl_team),
          ),
          statsStamp,
          statsFor(season),
        ),
    },
    weather: {
      forGames: (ids: readonly string[]) => ({
        rows: (opts.weather ?? []).filter((w) => ids.includes(w.game_id)),
        stamp: null,
      }),
    },
  };
}

/** One fixture-roster player (fixtures/players/fixture-roster.json). */
export interface FixturePlayer {
  readonly kind: "player" | "defense";
  readonly gsis_id?: string;
  readonly name?: string;
  readonly position?: string;
  readonly team: string;
}

/** name|team|position → gsis id for the rookies the league file lists without one. */
export function rosterGsisByName(): Map<string, string> {
  const json = JSON.parse(readFileSync(FIXTURE_ROSTER, "utf8")) as { players: FixturePlayer[] };
  const out = new Map<string, string>();
  for (const p of json.players) {
    if (p.kind === "player" && p.gsis_id !== undefined && p.name !== undefined) {
      out.set(`${p.name}|${p.team}|${p.position ?? ""}`, p.gsis_id);
    }
  }
  return out;
}
