// 002_reclog_dedup_scope.ts — migration 002 (plan 03 §7 forward-only `up(db)`; QA-1-061): the
// recommendation log deduplicates a `client_ref` within RECORD_DEDUP_SCOPE (league, season, week,
// kind, client_ref), not within the league alone. The unique index follows the scope, so a record
// that is correctly NOT deduplicated (same key, another week) can be inserted. Every existing row
// already satisfies the new, looser index. The SQL is literal on purpose: a shipped migration never
// changes; tests/store/migrations.test.ts pins its columns to RECORD_DEDUP_SCOPE.
import type { DatabaseSync } from "node:sqlite";

/** The DDL, one statement per entry. */
export const MIGRATION_002_SQL: readonly string[] = Object.freeze([
  "DROP INDEX recommendation_log__league_key__client_ref",
  "CREATE UNIQUE INDEX recommendation_log__dedup_scope ON recommendation_log (league_key, season, week, kind, client_ref) WHERE client_ref IS NOT NULL",
]);

export function up(db: DatabaseSync): void {
  for (const sql of MIGRATION_002_SQL) db.exec(sql);
}
