// stats-player-week.ts — `nflverse:stats_player_week` (plan 08 §3.2 the Phase-1 stat source; plan
// 10 §3.1a): `stats_player/stats_player_week_{season}.parquet` → `ds_player_week` (identity +
// PLAYER_WEEK_STAT_COLUMNS verbatim) and `ds_team_defense_week` aggregated from the same rows
// (team-defence DT lines; tables.ts DS_TEAM_DEFENSE_WEEK). Rows without a player_id (all-zero team
// placeholders, 3 in 2026) are dropped and are not aggregated.
import {
  DS_PLAYER_WEEK,
  DS_TEAM_DEFENSE_WEEK,
  PLAYER_WEEK_STAT_COLUMNS,
} from "../../store/datasets/tables.js";
import type { DataSource } from "../source.js";
import { eachRow, inFileSeason, makeNflverseSource } from "./base.js";
import { unmappedStatColumns } from "./columns.js";
import { TableLoader, asInt, buildRow } from "./rows.js";
import { TeamDefenseAggregator } from "./team-defense.js";

/** The stored stat columns toStatLine does not read (usage shares, attempts, fantasy points, …). */
export const UNMAPPED_PLAYER_WEEK_COLUMNS: readonly string[] = unmappedStatColumns(
  PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name),
);

/** The weekly player stats DataSource. */
export const statsPlayerWeekSource: DataSource = makeNflverseSource({
  id: "nflverse:stats_player_week",
  tag: "stats_player",
  file: (season) => `stats_player_week_${String(season)}.parquet`,
  async publish(files, into) {
    const players = new TableLoader(into, DS_PLAYER_WEEK);
    const defense = new TableLoader(into, DS_TEAM_DEFENSE_WEEK);
    const agg = new TeamDefenseAggregator();
    await eachRow("nflverse:stats_player_week", files, (raw, file) => {
      if (!inFileSeason(players, asInt(raw.season), file)) return;
      if (players.add(buildRow(DS_PLAYER_WEEK, raw))) agg.add(raw);
    });
    for (const row of agg.rows()) defense.add(row);
    const warnings =
      agg.conflictCount > 0
        ? [
            `ds_team_defense_week: ${String(agg.conflictCount)} row(s) disagreed on the team's game/opponent`,
          ]
        : [];
    return { loaders: [players, defense], warnings };
  },
});
