// 001_initial.ts — migration 001 (plan 01 §8.2 table list, T12; plan 03 §7 forward-only `up(db)`):
// every MIGRATION_001_TABLES store table, STRICT. The ds_* dataset tables are NOT here (round 2
// OBJ-27: they live in per-source dataset files). Instants are stored as given (ISO-8601) plus an
// `*_ms` epoch column wherever the store orders or compares by time.
import type { DatabaseSync } from "node:sqlite";

/** The DDL, one statement per entry (tests assert the never-pruned comments are present). */
export const MIGRATION_001_SQL: readonly string[] = Object.freeze([
  `CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT`,

  // Prunable cache (plan 06 §1.2 `store prune`): Yahoo responses (Phase 1b).
  `CREATE TABLE yahoo_cache (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  parsed_json TEXT,
  fetched_at TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  refresh_rate_s INTEGER,
  http_status INTEGER NOT NULL
) STRICT`,
  `CREATE INDEX yahoo_cache__fetched_ms ON yahoo_cache (fetched_ms)`,

  // NEVER PRUNED (plan 01 §5.1 T5): recommendation_log.settings_hash references these rows.
  `CREATE TABLE league_settings ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  league_key TEXT NOT NULL,
  settings_hash TEXT NOT NULL,
  scoring_json TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  fetched_ms INTEGER NOT NULL,
  PRIMARY KEY (league_key, settings_hash)
) STRICT`,
  `CREATE INDEX league_settings__settings_hash ON league_settings (settings_hash)`,
  `CREATE INDEX league_settings__league_key__fetched_ms ON league_settings (league_key, fetched_ms)`,
  // Part of the league_settings family (never pruned): settings health flags (plan 03 §5 rows 19-20).
  `CREATE TABLE league_settings_flag ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  league_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  raised_at TEXT NOT NULL,
  acknowledged INTEGER NOT NULL,
  PRIMARY KEY (league_key, kind)
) STRICT`,

  `CREATE TABLE crosswalk (
  platform TEXT NOT NULL,
  platform_player_id TEXT NOT NULL,
  gsis_id TEXT NOT NULL,
  method TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  PRIMARY KEY (platform, platform_player_id)
) STRICT`,
  `CREATE INDEX crosswalk__gsis_id ON crosswalk (gsis_id)`,

  // NEVER PRUNED (plan 01 §5.1 T5): the write journal (plan 02 §4.5; Phase W writes it).
  `CREATE TABLE write_journal ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  journal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT`,
  `CREATE INDEX write_journal__status__created_ms ON write_journal (status, created_ms)`,

  // NEVER PRUNED (plan 01 §5.1 T5, §8.2): the recommendation log. Free text inside record_json is
  // model-authored and untrusted on read (OBJ-15).
  `CREATE TABLE recommendation_log ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  log_id TEXT PRIMARY KEY,
  league_key TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  kind TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_ms INTEGER NOT NULL,
  settings_hash TEXT,
  client_ref TEXT,
  record_json TEXT NOT NULL
) STRICT`,
  `CREATE UNIQUE INDEX recommendation_log__league_key__client_ref ON recommendation_log (league_key, client_ref) WHERE client_ref IS NOT NULL`,
  `CREATE INDEX recommendation_log__league_key__season__week ON recommendation_log (league_key, season, week)`,
  `CREATE INDEX recommendation_log__league_key__recorded_ms ON recommendation_log (league_key, recorded_ms)`,

  // NEVER PRUNED (critic C-02b): the scored outcome beside each immutable log row.
  `CREATE TABLE recommendation_outcome ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  log_id TEXT PRIMARY KEY REFERENCES recommendation_log (log_id),
  followed INTEGER,
  realised REAL,
  regret REAL,
  decisive INTEGER,
  scored_at TEXT NOT NULL,
  week_final INTEGER NOT NULL
) STRICT`,

  // NEVER PRUNED (plan 10 T12): pre-game projection distributions, APPEND-ONLY per
  // (subject, season, week, model_version, made_at) so getAsOf never sees a post-kickoff run.
  `CREATE TABLE projection ( -- NEVER PRUNED (plan 01 §5.1 T5; plan 10 T12)
  subject_key TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  made_at TEXT NOT NULL,
  made_ms INTEGER NOT NULL,
  inputs_as_of TEXT NOT NULL,
  expectation_json TEXT NOT NULL,
  samples_json TEXT NOT NULL,
  PRIMARY KEY (subject_key, season, week, model_version, made_ms)
) STRICT`,

  // Prunable cache: league-scored points memo.
  `CREATE TABLE points_cache (
  settings_hash TEXT NOT NULL,
  gsis_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  points REAL NOT NULL,
  PRIMARY KEY (settings_hash, gsis_id, season, week)
) STRICT`,

  `CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  file TEXT,
  file_version TEXT,
  release_updated_at TEXT,
  seasons_json TEXT NOT NULL,
  rows INTEGER,
  columns_hash TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL
)`,
  `CREATE INDEX refresh_log__source__ok__id ON refresh_log (source, ok, id)`,

  `CREATE TABLE job_lock (
  job TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  acquired_ms INTEGER NOT NULL
) STRICT`,

  `CREATE TABLE limiter_state (
  client_key TEXT PRIMARY KEY,
  last999 TEXT NOT NULL
) STRICT`,

  `CREATE TABLE roster_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_key TEXT NOT NULL,
  week INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  roster_json TEXT NOT NULL
)`,
  `CREATE INDEX roster_snapshot__team_key__taken_ms ON roster_snapshot (team_key, taken_ms)`,

  `CREATE TABLE scoreboard_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_key TEXT NOT NULL,
  week INTEGER NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  matchups_json TEXT NOT NULL
)`,
  `CREATE INDEX scoreboard_snapshot__league_key__week ON scoreboard_snapshot (league_key, week, taken_ms)`,

  `CREATE TABLE fa_pool_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  league_key TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  taken_ms INTEGER NOT NULL,
  players_json TEXT NOT NULL
)`,
  `CREATE INDEX fa_pool_snapshot__league_key__taken_ms ON fa_pool_snapshot (league_key, taken_ms)`,

  // Append-only history beyond the platform's "most recent N" (plan 01 §5.2).
  `CREATE TABLE transactions_seen (
  league_key TEXT NOT NULL,
  transaction_key TEXT NOT NULL,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  txn_json TEXT NOT NULL,
  PRIMARY KEY (league_key, transaction_key)
) STRICT`,
  `CREATE INDEX transactions_seen__league_key__ts_ms ON transactions_seen (league_key, ts_ms)`,
]);

/** Applies migration 001 (the runner wraps it in BEGIN IMMEDIATE and records schema_version). */
export function up(db: DatabaseSync): void {
  for (const sql of MIGRATION_001_SQL) db.exec(sql);
}
