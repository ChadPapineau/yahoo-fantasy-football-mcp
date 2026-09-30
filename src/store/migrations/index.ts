// index.ts — the forward-only migration list and runner (plan 03 §7: `NNN_<name>.ts` export `up(db)`
// only, applied in order inside BEGIN IMMEDIATE, schema_version recorded per step; a store newer
// than the binary is refused with StoreVersionError, plan 03 §1.1 step 3 / L7).
import type { DatabaseSync } from "node:sqlite";
import { up as up001 } from "./001_initial.js";

/** One forward-only migration. */
export interface Migration {
  /** 1, 2, 3, … contiguous. */
  readonly version: number;
  readonly name: string;
  readonly up: (db: DatabaseSync) => void;
}

/** Every migration this binary ships, in order. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([
  Object.freeze({ version: 1, name: "initial", up: up001 }),
]);

/** Asserts a migration list is 1..n contiguous; returns n (the binary's schema version). */
export function targetVersion(migrations: readonly Migration[]): number {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error("store: migrations must be numbered 1..n contiguously");
  });
  return migrations.length;
}

/** The store's schema version: 0 for a file with no schema_version table (a fresh store). */
export function readSchemaVersion(db: DatabaseSync): number {
  const t = db
    .prepare(
      "SELECT 1 AS x FROM main.sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (t === undefined) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM main.schema_version").get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

/**
 * Applies every migration above the store's version, each in its own BEGIN IMMEDIATE transaction
 * that re-reads the version first (a second process that migrated meanwhile makes this a no-op).
 * Returns the versions applied.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  appliedAt: () => string,
): number[] {
  const applied: number[] = [];
  for (const m of migrations) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (readSchemaVersion(db) < m.version) {
        m.up(db);
        db.prepare("INSERT INTO main.schema_version (version, applied_at) VALUES (?, ?)").run(
          m.version,
          appliedAt(),
        );
        applied.push(m.version);
      }
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw e;
    }
  }
  return applied;
}
