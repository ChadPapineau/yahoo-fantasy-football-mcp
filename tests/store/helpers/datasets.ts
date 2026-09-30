// datasets.ts — synthetic dataset rows for the fixture roster (fixtures/players/fixture-roster.json,
// real public nflverse players), shaped exactly by the ds_* contract (src/store/datasets/tables.ts),
// and a helper that publishes them through the real DatasetPublisher.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { DatasetSourceId } from "../../../src/config/freshness.js";
import {
  DS_GAMES,
  DS_INJURIES,
  DS_PLAYER_WEEK,
  DS_ROSTER_WEEKLY,
  DS_TEAM_DEFENSE_WEEK,
  DS_VENUES,
  DS_WEATHER_NWS,
  DS_WEATHER_OPEN_METEO,
} from "../../../src/store/datasets/tables.js";
import type {
  DatasetPublisher,
  DatasetRow,
  DatasetTableSpec,
  PublishOutcome,
} from "../../../src/store/types.js";
import { ROOT } from "./env.js";

export interface FixturePlayer {
  readonly kind: "player";
  readonly gsis_id: string;
  readonly name: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly position: string;
  readonly team: string;
  readonly jersey: number | null;
  readonly yahoo_id: string | null;
  readonly sleeper_id: string | null;
  readonly espn_id: string | null;
  readonly pfr_id: string | null;
}

export const ROSTER = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures", "players", "fixture-roster.json"), "utf8"),
) as { season: number; players: FixturePlayer[] };

export const PLAYERS = ROSTER.players;
export const SEASON = 2026;

/** A full row for `spec` with every column null, overlaid with `values`. */
export function row(
  spec: DatasetTableSpec,
  values: Record<string, string | number | null>,
): DatasetRow {
  const out: Record<string, string | number | null> = {};
  for (const c of spec.columns) out[c.name] = null;
  for (const [k, v] of Object.entries(values)) out[k] = v;
  return out;
}

export interface TableRows {
  readonly spec: DatasetTableSpec;
  readonly rows: readonly DatasetRow[];
}

/** Publishes `tables` as `source` at `version`. */
export async function publishTables(
  pub: DatasetPublisher,
  source: DatasetSourceId,
  version: string,
  tables: readonly TableRows[],
  seasons: readonly number[] = [SEASON],
  releaseUpdatedAt: string | null = "2026-09-30T09:40:10.000Z",
): Promise<PublishOutcome> {
  return pub.publish(source, version, releaseUpdatedAt, (w) => {
    let n = 0;
    for (const t of tables) {
      w.createTable(t.spec);
      n += w.insert(t.spec.name, t.rows);
    }
    const cols = tables
      .flatMap((t) => t.spec.columns.map((c) => `${t.spec.name}.${c.name}`))
      .sort();
    return Promise.resolve({
      rows: n,
      tables: tables.map((t) => ({ name: t.spec.name, rows: t.rows.length })),
      seasons,
      columns_hash: createHash("sha256").update(cols.join(",")).digest("hex"),
    });
  });
}

// --- fixture rows per table -------------------------------------------------------------------------

export const GAME_BUF_MIA = "2026_01_BUF_MIA";
export const GAME_DET_GB = "2026_01_DET_GB";

export function gamesRows(): TableRows[] {
  const games = [
    row(DS_GAMES, {
      game_id: GAME_BUF_MIA,
      season: SEASON,
      game_type: "REG",
      week: 1,
      gameday: "2026-09-13",
      gametime: "13:00",
      kickoff_utc: "2026-09-13T17:00:00.000Z",
      away_team: "BUF",
      home_team: "MIA",
      away_score: 27,
      home_score: 20,
      spread_line: -3.5,
      total_line: 48.5,
      away_moneyline: -170,
      home_moneyline: 145,
      div_game: 1,
      roof: null,
      surface: "grass",
      away_rest: 7,
      home_rest: 7,
      stadium_id: "MIA00",
      stadium: "Hard Rock Stadium",
      venue_id: "MIA00",
    }),
    row(DS_GAMES, {
      game_id: GAME_DET_GB,
      season: SEASON,
      game_type: "REG",
      week: 1,
      gameday: "2026-09-10",
      gametime: "20:20",
      kickoff_utc: "2026-09-11T00:20:00.000Z",
      away_team: "DET",
      home_team: "GB",
      away_score: null,
      home_score: null,
      div_game: 1,
      roof: "outdoors",
      stadium_id: "GNB00",
      stadium: "Lambeau Field",
      venue_id: "GNB00",
    }),
    row(DS_GAMES, {
      game_id: "2026_02_XXX_YYY",
      season: SEASON,
      game_type: "REG",
      week: 2,
      gameday: "2026-09-20",
      away_team: "XXX",
      home_team: "BUF",
      kickoff_utc: null,
    }),
    row(DS_GAMES, {
      game_id: "2025_01_BUF_NYJ",
      season: 2025,
      game_type: "REG",
      week: 1,
      gameday: "2025-09-07",
      away_team: "BUF",
      home_team: "NYJ",
      kickoff_utc: "2025-09-07T17:00:00.000Z",
    }),
  ];
  const venues = [
    row(DS_VENUES, {
      stadium_id: "MIA00",
      name: "Hard Rock Stadium",
      tz: "America/New_York",
      lat: 25.958,
      lon: -80.2389,
      roof_default: "outdoors",
      retractable: 0,
      country: "US",
    }),
    row(DS_VENUES, {
      stadium_id: "GNB00",
      name: "Lambeau Field",
      tz: "America/Chicago",
      lat: 44.5013,
      lon: -88.0622,
      roof_default: "outdoors",
      retractable: 0,
      country: "US",
    }),
  ];
  return [
    { spec: DS_GAMES, rows: games },
    { spec: DS_VENUES, rows: venues },
  ];
}

export function injuryRows(): TableRows[] {
  const p0 = PLAYERS[0];
  const p2 = PLAYERS[2];
  if (p0 === undefined || p2 === undefined) throw new Error("fixture roster too small");
  return [
    {
      spec: DS_INJURIES,
      rows: [
        row(DS_INJURIES, {
          season: SEASON,
          game_type: "REG",
          week: 3,
          team: p0.team,
          gsis_id: p0.gsis_id,
          full_name: p0.name,
          report_status: "Questionable",
          report_primary_injury: "Ankle",
          practice_status: "Limited Participation in Practice",
          practice_primary_injury: "Ankle",
          practice_secondary_injury: "Knee",
        }),
        row(DS_INJURIES, {
          season: SEASON,
          game_type: "REG",
          week: 3,
          team: p2.team,
          gsis_id: p2.gsis_id,
          full_name: p2.name,
          report_status: null,
          practice_status: null,
        }),
        row(DS_INJURIES, {
          season: SEASON,
          game_type: "REG",
          week: 3,
          team: "ZZZ",
          gsis_id: "00-0000001",
        }),
      ],
    },
  ];
}

export function rosterRows(weeks: readonly number[] = [1, 2, 3]): TableRows[] {
  const rows: DatasetRow[] = [];
  for (const w of weeks)
    for (const p of PLAYERS)
      rows.push(
        row(DS_ROSTER_WEEKLY, {
          season: SEASON,
          week: w,
          game_type: "REG",
          team: p.team,
          gsis_id: p.gsis_id,
          full_name: p.name,
          first_name: p.first_name,
          last_name: p.last_name,
          position: p.position,
          jersey_number: p.jersey,
          status: "ACT",
          yahoo_id: p.yahoo_id,
          sleeper_id: p.sleeper_id,
          espn_id: p.espn_id,
          pfr_id: p.pfr_id,
        }),
      );
  return [{ spec: DS_ROSTER_WEEKLY, rows }];
}

/** Player-week rows for every fixture player × weeks, plus `padding` filler rows (size tests). */
export function playerWeekRows(weeks: readonly number[] = [1, 2, 3], padding = 0): TableRows[] {
  const rows: DatasetRow[] = [];
  for (const w of weeks)
    for (const [i, p] of PLAYERS.entries()) {
      const k = p.position === "K";
      rows.push(
        row(DS_PLAYER_WEEK, {
          player_id: p.gsis_id,
          player_display_name: p.name,
          position: p.position,
          position_group: p.position,
          season: SEASON,
          week: w,
          season_type: "REG",
          game_id: `2026_0${String(w)}_${p.team}_OPP`,
          team: p.team,
          opponent_team: p.team === "DET" ? "GB" : "MIA",
          passing_yards: p.position === "QB" ? 250 + i : null,
          passing_tds: p.position === "QB" ? 2 : null,
          rushing_yards: k ? null : 10 + i,
          rushing_2pt_conversions: k ? null : 1,
          receiving_2pt_conversions: null,
          fg_made_40_49: k ? 2 : null,
          fg_made_50_59: k ? 1 : null,
          fg_made_60_: k ? 0 : null,
          pat_made: k ? 3 : null,
          pat_missed: k ? 0 : null,
        }),
      );
    }
  for (let j = 0; j < padding; j++)
    rows.push(
      row(DS_PLAYER_WEEK, {
        player_id: `00-9${String(j).padStart(6, "0")}`,
        player_display_name: `Filler Player ${String(j)}`,
        position: "CB",
        position_group: "DB",
        season: SEASON,
        week: (j % 3) + 1,
        season_type: "REG",
        game_id: `2026_0${String((j % 3) + 1)}_XXX_YYY`,
        team: "NYJ",
        opponent_team: "NE",
        fg_made_list: "51;43;38;22",
        passing_yards: j,
        rushing_yards: j % 97,
        receiving_yards: j % 53,
        target_share: 0.125,
        fantasy_points: 1.5,
        fantasy_points_ppr: 2.5,
      }),
    );
  const defense = [
    row(DS_TEAM_DEFENSE_WEEK, {
      season: SEASON,
      week: 1,
      season_type: "REG",
      team: "MIA",
      opponent_team: "BUF",
      game_id: GAME_BUF_MIA,
      def_sacks: 2.5,
      def_interceptions: 1,
      fumble_recovery_opp: 0,
      def_tds: 0,
      special_teams_tds: 1,
      def_safeties: 0,
      def_fg_blocks: 1,
      def_punt_blocks: 0,
      def_pat_blocks: 1,
      opp_passing_yards: 260,
      opp_sack_yards_lost: 15,
      opp_rushing_yards: 110,
      player_rows: 22,
    }),
    row(DS_TEAM_DEFENSE_WEEK, {
      season: SEASON,
      week: 1,
      season_type: "REG",
      team: "DET",
      opponent_team: "GB",
      game_id: GAME_DET_GB,
      def_sacks: 3,
      def_interceptions: 0,
      fumble_recovery_opp: 1,
      def_tds: 1,
      special_teams_tds: 0,
      def_safeties: 1,
      def_fg_blocks: 0,
      def_punt_blocks: 0,
      def_pat_blocks: 0,
      opp_passing_yards: null,
      opp_sack_yards_lost: null,
      opp_rushing_yards: null,
      player_rows: 20,
    }),
  ];
  return [
    { spec: DS_PLAYER_WEEK, rows },
    { spec: DS_TEAM_DEFENSE_WEEK, rows: defense },
  ];
}

export function weatherRows(
  provider: "open_meteo" | "nws",
  gameIds: readonly string[],
  tempF: number,
): TableRows[] {
  const spec = provider === "nws" ? DS_WEATHER_NWS : DS_WEATHER_OPEN_METEO;
  return [
    {
      spec,
      rows: gameIds.map((g) =>
        row(spec, {
          game_id: g,
          season: SEASON,
          week: 1,
          venue_id: "MIA00",
          lat: 25.958,
          lon: -80.2389,
          kickoff_utc: "2026-09-13T17:00:00.000Z",
          forecast_hour_utc: "2026-09-13T17:00:00.000Z",
          temp_f: tempF,
          wind_mph: 12,
          gust_mph: provider === "nws" ? null : 20,
          precip_prob: 0.2,
          as_of: "2026-09-12T06:00:00.000Z",
        }),
      ),
    },
  ];
}

/** Publishes every Phase-1a fixture dataset. */
export async function publishAllFixtures(pub: DatasetPublisher): Promise<void> {
  const outs = await Promise.all([
    publishTables(pub, "nflverse:schedules", "2026-09-30T15:58:07Z", gamesRows(), [2025, 2026]),
    publishTables(pub, "nflverse:injuries", "2026-09-30T13:36:26Z", injuryRows()),
    publishTables(pub, "nflverse:roster_weekly", "2026-09-30T13:40:10Z", rosterRows()),
    publishTables(pub, "nflverse:stats_player_week", "2026-09-30T09:05:48Z", playerWeekRows()),
    publishTables(
      pub,
      "weather:open_meteo",
      "2026-09-30T12",
      weatherRows("open_meteo", [GAME_BUF_MIA], 81),
      [],
      null,
    ),
    publishTables(
      pub,
      "weather:nws",
      "2026-09-30T12",
      weatherRows("nws", [GAME_BUF_MIA, GAME_DET_GB], 60),
      [],
      null,
    ),
  ]);
  for (const o of outs) if (!o.ok) throw new Error(`fixture publish failed: ${o.error}`);
}
