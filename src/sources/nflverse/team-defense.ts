// team-defense.ts — `ds_team_defense_week` derived at load from the stats_player_week rows (tables.ts
// DS_TEAM_DEFENSE_WEEK: SUM of TEAM_DEFENSE_SUM_COLUMNS per season/week/team over the rows accepted
// into ds_player_week, plus the opponent offence's passing/sack/rushing yards from the opponent's
// rows in the same game; plan 08 §3.2 dst_* inputs). A team-level row (no player_id — nflverse's
// unattributed team credits, e.g. the BUF week-2 2026 safety) adds its TEAM_DEFENSE_SUM_COLUMNS only:
// no player count and no offence yardage. Memory: one accumulator per team-week.
import {
  DST_FUMBLE_RETURN_TD_COLUMN,
  defensiveFumbleReturnTds,
} from "../../domain/scoring/nflverse.js";
import { TEAM_DEFENSE_SUM_COLUMNS } from "../../store/datasets/tables.js";
import { asInt, asReal, asText } from "./rows.js";

type Value = string | number | null;

interface Acc {
  season: number;
  week: number;
  team: string;
  season_type: string | null;
  opponent_team: string | null;
  game_id: string | null;
  sums: Record<string, number>;
  pass: number;
  sackYds: number;
  rush: number;
  rows: number;
}

/** Accumulates player rows into team-defence rows. */
export class TeamDefenseAggregator {
  private readonly groups = new Map<string, Acc>();
  private conflicts = 0;

  private static key(season: number, week: number, team: string): string {
    return `${String(season)}|${String(week)}|${team}`;
  }

  /** Adds one accepted player row (raw upstream values). */
  add(raw: Readonly<Record<string, unknown>>): void {
    this.accumulate(raw, true);
  }

  /**
   * Adds a team-level row (no player_id): its team-defence credits (a safety, a block, a return TD
   * nflverse could not attribute to a player) count for the team; it is not a player row and its
   * offence yardage is not the opponent's yards allowed.
   */
  addTeamRow(raw: Readonly<Record<string, unknown>>): void {
    this.accumulate(raw, false);
  }

  private accumulate(raw: Readonly<Record<string, unknown>>, player: boolean): void {
    const season = asInt(raw.season);
    const week = asInt(raw.week);
    const team = asText(raw.team);
    if (season === null || week === null || team === null) return;
    const k = TeamDefenseAggregator.key(season, week, team);
    let acc = this.groups.get(k);
    if (!acc) {
      acc = {
        season,
        week,
        team,
        season_type: null,
        opponent_team: null,
        game_id: null,
        sums: Object.fromEntries(
          [...TEAM_DEFENSE_SUM_COLUMNS, DST_FUMBLE_RETURN_TD_COLUMN].map((c) => [c, 0]),
        ),
        pass: 0,
        sackYds: 0,
        rush: 0,
        rows: 0,
      };
      this.groups.set(k, acc);
    }
    if (player) acc.rows++;
    for (const f of ["season_type", "opponent_team", "game_id"] as const) {
      const v = asText(raw[f]);
      if (v === null) continue;
      if (acc[f] === null) acc[f] = v;
      else if (acc[f] !== v) this.conflicts++;
    }
    for (const c of TEAM_DEFENSE_SUM_COLUMNS)
      acc.sums[c] = (acc.sums[c] ?? 0) + (asReal(raw[c]) ?? 0);
    // per-row derived, not a plain sum: def_tds holds interception returns only (QA-1-017)
    acc.sums[DST_FUMBLE_RETURN_TD_COLUMN] =
      (acc.sums[DST_FUMBLE_RETURN_TD_COLUMN] ?? 0) + defensiveFumbleReturnTds(raw);
    if (!player) return;
    acc.pass += asReal(raw.passing_yards) ?? 0;
    acc.sackYds += asReal(raw.sack_yards_lost) ?? 0;
    acc.rush += asReal(raw.rushing_yards) ?? 0;
  }

  /** Rows whose team had two different opponents / game ids / season types in one week. */
  get conflictCount(): number {
    return this.conflicts;
  }

  /** The team-defence rows (DS_TEAM_DEFENSE_WEEK column order), sorted by season, week, team. */
  rows(): Record<string, Value>[] {
    const out: Record<string, Value>[] = [];
    const sorted = [...this.groups.values()].sort(
      (a, b) => a.season - b.season || a.week - b.week || (a.team < b.team ? -1 : 1),
    );
    for (const a of sorted) {
      const opp =
        a.opponent_team === null
          ? undefined
          : this.groups.get(TeamDefenseAggregator.key(a.season, a.week, a.opponent_team));
      const sameGame =
        opp !== undefined &&
        (a.game_id === null || opp.game_id === null || opp.game_id === a.game_id);
      const row: Record<string, Value> = {
        season: a.season,
        week: a.week,
        season_type: a.season_type,
        team: a.team,
        opponent_team: a.opponent_team,
        game_id: a.game_id,
      };
      for (const c of TEAM_DEFENSE_SUM_COLUMNS) row[c] = a.sums[c] ?? 0;
      row[DST_FUMBLE_RETURN_TD_COLUMN] = a.sums[DST_FUMBLE_RETURN_TD_COLUMN] ?? 0;
      row.opp_passing_yards = sameGame ? opp.pass : null;
      row.opp_sack_yards_lost = sameGame ? opp.sackYds : null;
      row.opp_rushing_yards = sameGame ? opp.rush : null;
      row.player_rows = a.rows;
      out.push(row);
    }
    return out;
  }
}
