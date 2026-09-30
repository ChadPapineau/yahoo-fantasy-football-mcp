// store.ts — StoreFactory.open → Store (plan 01 §5.1 one store file, WAL; §5.3 write classes; §5.5
// dataset files attached read-only; plan 03 §1.1 step 3 open → migrate → attach, §1.3 close with a
// WAL checkpoint, §7 forward-only migrations after a consistent backup under the process lock).
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assertSecureFile, ensureSecureDir, PathSecurityError } from "../config/paths.js";
import type { Clock } from "../domain/clock.js";
import { Attachments } from "./attach.js";
import {
  backupTo,
  preMigrationBackupPath,
  prunePreMigrationBackups,
  vacuumInto,
} from "./backup.js";
import { acquireLock, acquireLockSync } from "./lock.js";
import {
  applyMigrations,
  MIGRATIONS,
  readSchemaVersion,
  targetVersion,
  type Migration,
} from "./migrations/index.js";
import { createReaders } from "./readers.js";
import type { RepoDeps } from "./repos/common.js";
import { crosswalkRepository } from "./repos/crosswalk.js";
import {
  faPoolSnapshotRepository,
  leagueSettingsRepository,
  rosterSnapshotRepository,
  scoreboardSnapshotRepository,
  transactionsSeenRepository,
} from "./repos/league.js";
import {
  limiterStateRepository,
  platformCacheRepository,
  pointsCacheRepository,
} from "./repos/caches.js";
import { jobLockRepository, refreshLogRepository, writeJournalRepository } from "./repos/ops.js";
import { projectionRepository } from "./repos/projection.js";
import { recommendationLogRepository } from "./repos/reclog.js";
import { createPrivateFile, openStoreConnection, StatementGuard, WriteExecutor } from "./sqlite.js";
import {
  BUSY_TIMEOUT_MS,
  REQUIRED_WRITE_BUDGET_MS,
  StoreMigrationPendingError,
  StoreVersionError,
  type BackupResult,
  type Store,
  type StoreOpenOptions,
  type StoreRepositories,
} from "./types.js";

/** Test/tooling hooks (not part of the StoreFactory contract). */
export interface StoreInternals {
  /** The migration list (default MIGRATIONS); tests inject a synthetic 002. */
  readonly migrations?: readonly Migration[];
  /** The required-write budget (default REQUIRED_WRITE_BUDGET_MS). */
  readonly requiredWriteBudgetMs?: number;
}

/** busy_timeout while migrating at startup (before the stdio loop exists). */
export const MIGRATION_BUSY_TIMEOUT_MS = 5000;

const guards = new WeakMap<object, StatementGuard>();

/** The dataset write guard of an open store (the statement trace — tests and `ff doctor`). */
export function statementGuardOf(store: Store): StatementGuard | null {
  return guards.get(store) ?? null;
}

/** `<store>.lock`: the process-wide store lock file. */
export const lockPathOf = (storePath: string): string => `${storePath}.lock`;

function assertAbsolute(p: string, what: string): void {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.includes("\0"))
    throw new PathSecurityError("relative", p, what);
}

/**
 * Prepares the store file: its directory 0700 (created), the file 0600 (created `wx` when absent,
 * else refused when a symlink, not regular, not ours or group/other-accessible); -wal/-shm must not
 * be symlinks either.
 */
export function prepareStoreFile(storePath: string): void {
  assertAbsolute(storePath, "store file");
  ensureSecureDir(path.dirname(storePath), { create: true, what: "cache directory" });
  if (!createPrivateFile(storePath)) assertSecureFile(storePath, "store file");
  for (const side of ["-wal", "-shm", "-journal"]) {
    try {
      if (lstatSync(storePath + side).isSymbolicLink())
        throw new PathSecurityError("symlink", storePath + side, "store file");
    } catch (e) {
      if (e instanceof PathSecurityError) throw e;
    }
  }
}

/**
 * Opens (and when asked, migrates) a store-role connection: refuses a newer schema, refuses a
 * pending migration without `migrate`, else backs up (version > 0) and migrates under the lock.
 */
export function openMigrated(opts: {
  path: string;
  backupDir: string;
  clock: Clock;
  migrate: boolean;
  migrations: readonly Migration[];
  guard: StatementGuard;
}): { db: DatabaseSync; version: number } {
  prepareStoreFile(opts.path);
  const db = openStoreConnection(opts.path, opts.guard);
  try {
    const target = targetVersion(opts.migrations);
    let v = readSchemaVersion(db);
    if (v > target) throw new StoreVersionError(v, target);
    if (v < target) {
      if (!opts.migrate) throw new StoreMigrationPendingError(v, target);
      const lock = acquireLockSync(lockPathOf(opts.path));
      try {
        db.exec(`PRAGMA busy_timeout = ${String(MIGRATION_BUSY_TIMEOUT_MS)}`);
        v = readSchemaVersion(db);
        if (v > target) throw new StoreVersionError(v, target);
        if (v < target) {
          if (v > 0) {
            ensureSecureDir(opts.backupDir, { create: true, what: "backup directory" });
            vacuumInto(
              db,
              preMigrationBackupPath(opts.backupDir, v, opts.clock.nowMs()),
              opts.guard,
            );
          }
          applyMigrations(db, opts.migrations, () => opts.clock.nowIso());
          if (v > 0) prunePreMigrationBackups(opts.backupDir);
          v = readSchemaVersion(db);
        }
      } finally {
        db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
        lock.release();
      }
    }
    return { db, version: v };
  } catch (e) {
    db.close();
    throw e;
  }
}

function buildRepos(deps: RepoDeps): StoreRepositories {
  return Object.freeze({
    recommendationLog: recommendationLogRepository(deps),
    crosswalk: crosswalkRepository(deps),
    projections: projectionRepository(deps),
    leagueSettings: leagueSettingsRepository(deps),
    pointsCache: pointsCacheRepository(deps),
    platformCache: platformCacheRepository(deps),
    refreshLog: refreshLogRepository(deps),
    jobLock: jobLockRepository(deps),
    limiterState: limiterStateRepository(deps),
    writeJournal: writeJournalRepository(deps),
    rosterSnapshots: rosterSnapshotRepository(deps),
    scoreboardSnapshots: scoreboardSnapshotRepository(deps),
    faPoolSnapshots: faPoolSnapshotRepository(deps),
    transactionsSeen: transactionsSeenRepository(deps),
  });
}

/** StoreFactory.open. */
export function openStore(opts: StoreOpenOptions, internals: StoreInternals = {}): Store {
  assertAbsolute(opts.datasetDir, "dataset directory");
  assertAbsolute(opts.backupDir, "backup directory");
  const guard = new StatementGuard();
  const { db, version } = openMigrated({
    path: opts.path,
    backupDir: opts.backupDir,
    clock: opts.clock,
    migrate: opts.migrate,
    migrations: internals.migrations ?? MIGRATIONS,
    guard,
  });
  let closed = false;
  try {
    ensureSecureDir(opts.datasetDir, { create: true, what: "dataset directory" });
  } catch (e) {
    db.close();
    throw e;
  }
  const warn = (code: string): void => {
    try {
      opts.onWarning?.(code);
    } catch {
      // a throwing warning sink must never break a read
    }
  };
  const writes = new WriteExecutor(internals.requiredWriteBudgetMs ?? REQUIRED_WRITE_BUDGET_MS);
  const deps: RepoDeps = { db, writes };
  const repos = buildRepos(deps);
  const attachments = new Attachments({
    db,
    repo: deps,
    datasetDir: opts.datasetDir,
    clock: opts.clock,
    warn,
  });
  const readers = createReaders({
    db,
    attachments,
    weatherFirst: opts.weatherSource ?? "weather:open_meteo",
    warn,
  });
  attachments.reattachIfChanged();

  const store: Store = {
    path: opts.path,
    schemaVersion: version,
    repos,
    datasets: readers.datasets,
    rosterWeekly: readers.rosterWeekly,
    attachments: () => attachments.list(),
    reattachIfChanged: () => attachments.reattachIfChanged(),
    async backup(destPath): Promise<BackupResult> {
      assertAbsolute(destPath, "backup file");
      const lock = await acquireLock(lockPathOf(opts.path));
      try {
        const { method } = await backupTo(db, destPath, guard);
        return {
          path: destPath,
          bytes: statSync(destPath).size,
          taken_at: opts.clock.nowIso(),
          method,
        };
      } finally {
        lock.release();
      }
    },
    stats() {
      let size = 0;
      for (const f of [opts.path, `${opts.path}-wal`]) {
        try {
          size += statSync(f).size;
        } catch {
          // no -wal right after a checkpoint(TRUNCATE)
        }
      }
      return {
        path: opts.path,
        size_bytes: size,
        schema_version: version,
        cache_misses_busy: writes.cacheMissesBusy,
        attached: attachments.list(),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        attachments.detachAll();
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // another process holds the lock: the next opener checkpoints
      }
      db.close();
    },
  };
  guards.set(store, guard);
  return store;
}
