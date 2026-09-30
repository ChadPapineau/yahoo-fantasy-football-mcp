// backup.ts — consistent store backups (plan 03 L7 / §7, round 1 OBJ-10): never a file copy — under
// WAL a copy of store.sqlite alone is a torn snapshot. `sqlite.backup()` in ONE step (a single read
// transaction, so a second process's committed-but-uncheckpointed WAL rows are included and no
// transaction is ever split) or `VACUUM INTO`, while holding the process-wide store lock. The
// synchronous pre-migration form uses VACUUM INTO (the store opens synchronously).
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { backup as sqliteBackup, type DatabaseSync } from "node:sqlite";
import { ensureSecureDir, STORE_FILE_NAME } from "../config/paths.js";
import { createPrivateFile, type StatementGuard } from "./sqlite.js";

/** `rate` for sqlite.backup(): every page in one step (one read transaction = one snapshot). */
export const ONE_STEP_PAGES = 2 ** 31 - 1;
/** Pre-migration backups of this many most recent schema versions are kept (plan 03 §7). */
export const KEEP_BACKUP_VERSIONS = 2;

function refuseExisting(dest: string): void {
  let exists = true;
  try {
    lstatSync(dest);
  } catch {
    exists = false;
  }
  if (exists) throw new Error("store: backup destination already exists");
}

/**
 * VACUUM INTO an empty 0600 file (SQLite accepts an existing empty file as the target), with the
 * dataset write guard lifted for the statement (it writes into its own temporary schema).
 */
export function vacuumInto(db: DatabaseSync, dest: string, guard: StatementGuard | null): void {
  refuseExisting(dest);
  createPrivateFile(dest);
  try {
    const run = (): void => {
      db.prepare("VACUUM main INTO ?").run(dest);
    };
    if (guard === null) run();
    else guard.bypass(run);
  } catch (e) {
    rmSync(dest, { force: true });
    throw e;
  }
}

/** The one-step backup API into a fresh 0600 file; falls back to VACUUM INTO when it fails. */
export async function backupTo(
  db: DatabaseSync,
  dest: string,
  guard: StatementGuard | null,
): Promise<{ method: "backup_api" | "vacuum_into" }> {
  ensureSecureDir(path.dirname(dest), { create: true, what: "backup directory" });
  refuseExisting(dest);
  createPrivateFile(dest);
  try {
    await sqliteBackup(db, dest, { rate: ONE_STEP_PAGES });
    return { method: "backup_api" };
  } catch {
    rmSync(dest, { force: true });
    vacuumInto(db, dest, guard);
    return { method: "vacuum_into" };
  }
}

const BAK_RE = new RegExp(`^${STORE_FILE_NAME.replace(".", "\\.")}\\.bak-v(\\d+)(?:-\\d+)?$`);

/** The pre-migration backup path for `version` (a timestamp suffix when one exists already). */
export function preMigrationBackupPath(backupDir: string, version: number, nowMs: number): string {
  const base = path.join(backupDir, `${STORE_FILE_NAME}.bak-v${String(version)}`);
  try {
    lstatSync(base);
    return `${base}-${String(nowMs)}`;
  } catch {
    return base;
  }
}

/** Deletes pre-migration backups older than the newest KEEP_BACKUP_VERSIONS versions; returns names removed. */
export function prunePreMigrationBackups(backupDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    return [];
  }
  const byVersion = new Map<number, string[]>();
  for (const n of names) {
    const m = BAK_RE.exec(n);
    if (m?.[1] === undefined) continue;
    const v = Number.parseInt(m[1], 10);
    byVersion.set(v, [...(byVersion.get(v) ?? []), n]);
  }
  const keep = new Set([...byVersion.keys()].sort((a, b) => b - a).slice(0, KEEP_BACKUP_VERSIONS));
  const removed: string[] = [];
  for (const [v, files] of byVersion) {
    if (keep.has(v)) continue;
    for (const f of files) {
      const p = path.join(backupDir, f);
      if (lstatSync(p).isFile()) {
        rmSync(p, { force: true });
        removed.push(f);
      }
    }
  }
  return removed.sort();
}
