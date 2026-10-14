// 003_season_fresh.ts — migration 003 (plan 03 §7 forward-only `up(db)`): the store tables the
// schedule-driven refresh needs. `schedule_change` is the kickoff-change history every schedules
// publish appends to (deduplicated on the change itself, so a re-run of the same release never
// duplicates a row); `job_run` is the heartbeat of each scheduled job (`refresh-due`, prune, backup);
// `season_check` records, per source and season, whether upstream has published that season yet
// (a not-yet-published new season is upstream's state, never an outage); `provider_backoff` holds a
// 429 / Retry-After pause per provider across processes. All four are required writes; `ff prune`
// removes schedule_change and season_check rows older than 400 days and provider_backoff rows past
// their end. No dataset layout changes (`ds_schema` stays), so no forced `ff refresh all`. The SQL is
// literal on purpose: a shipped migration never changes.
import type { DatabaseSync } from "node:sqlite";

/** The DDL, one statement per entry. */
export const MIGRATION_003_SQL: readonly string[] = Object.freeze([
  // Pruned after 400 days (`ff prune`).
  `CREATE TABLE schedule_change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  detected_at TEXT NOT NULL,
  release_updated_at TEXT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  away TEXT NOT NULL,
  home TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kickoff','gameday','venue','added','removed','week')),
  old_value TEXT,
  new_value TEXT
) STRICT`,
  "CREATE INDEX schedule_change__detected_at ON schedule_change (detected_at)",
  "CREATE INDEX schedule_change__season_week ON schedule_change (season, week)",
  `CREATE UNIQUE INDEX schedule_change__dedup ON schedule_change
  (game_id, kind, IFNULL(old_value,''), IFNULL(new_value,''), IFNULL(release_updated_at,''))`,

  // One row per job: the newest run (the heartbeat `ff doctor` row 11 and G1 jobs[] read).
  `CREATE TABLE job_run (
  job TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL,
  exit INTEGER NOT NULL,
  summary TEXT
) STRICT`,

  // Pruned after 400 days (`ff prune`).
  `CREATE TABLE season_check (
  source TEXT NOT NULL,
  season INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('not_published','published')),
  PRIMARY KEY (source, season)
) STRICT`,

  // Pruned once until_at has passed (`ff prune`).
  `CREATE TABLE provider_backoff (
  provider TEXT PRIMARY KEY,
  until_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('rate_limited','server_error')),
  set_at TEXT NOT NULL
) STRICT`,
]);

export function up(db: DatabaseSync): void {
  for (const sql of MIGRATION_003_SQL) db.exec(sql);
}
