// index.ts — the Phase-1a nflverse DataSources (plan 10 §3.1a: schedules, injuries, roster_weekly,
// stats_player_week) and the pieces other modules call (plan 08 §3.2 toStatLine).
import type { DataSource } from "../source.js";
import { injuriesSource } from "./injuries.js";
import { rosterWeeklySource } from "./roster-weekly.js";
import { schedulesSource } from "./schedules.js";
import type { NflverseSourceId } from "./schemas.js";
import { statsPlayerWeekSource } from "./stats-player-week.js";

export { injuriesSource } from "./injuries.js";
export { rosterWeeklySource } from "./roster-weekly.js";
export { gameLines, gameRow, schedulesSource } from "./schedules.js";
export { statsPlayerWeekSource, UNMAPPED_PLAYER_WEEK_COLUMNS } from "./stats-player-week.js";
export type { NflversePublishStats, NflverseSchemaReport } from "./base.js";
export {
  NFLVERSE_STAT_MAP,
  kickDistances,
  pointsAllowedFor,
  positionTypeOf,
  toDefenseStatLine,
  toStatLine,
  translatePlayerWeek,
} from "./columns.js";
export { NflverseSourceError, parseNflverseTimestamp } from "./release.js";
export { EXPECTED_COLUMNS, NFLVERSE_SOURCE_IDS, type NflverseSourceId } from "./schemas.js";

/** Every nflverse DataSource, by id (the runner's registry for `ff refresh nflverse`). */
export const NFLVERSE_SOURCES: Readonly<Record<NflverseSourceId, DataSource>> = Object.freeze({
  "nflverse:schedules": schedulesSource,
  "nflverse:injuries": injuriesSource,
  "nflverse:roster_weekly": rosterWeeklySource,
  "nflverse:stats_player_week": statsPlayerWeekSource,
});
