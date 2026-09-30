// sqlite.ts — the one place the store opens `node:sqlite` connections: file creation 0600, WAL +
// pragmas (plan 01 §5.1), the write-class executor (plan 01 §5.3 best-effort vs required, plan 03
// L9 / §1.2 bounded waits, critic C-04b yielding retries) and the dataset write guard (plan 01 §5.5,
// round 2 OBJ-27: an authorizer that denies every ds_* / attached-schema write and can trace them).
import { constants as C, DatabaseSync } from "node:sqlite";
import { closeSync, constants as fsc, openSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BUSY_TIMEOUT_MS,
  REQUIRED_WRITE_BUDGET_MS,
  StoreBusyError,
  type BestEffortOutcome,
  type StoreTable,
} from "./types.js";

/** SQLite primary result codes the store treats as "the lock is held by someone else". */
const BUSY_CODES: ReadonlySet<number> = new Set([5 /* SQLITE_BUSY */, 6 /* SQLITE_LOCKED */]);

/** Whether `e` is a node:sqlite error for a busy/locked database (extended codes included). */
export function isBusyError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { errcode?: unknown }).errcode;
  return typeof code === "number" && BUSY_CODES.has(code & 0xff);
}

/**
 * Creates `file` as an empty 0600 regular file when it does not exist (`wx`: exclusive, never
 * follows a pre-placed symlink). SQLite then opens the empty file as a new database, so the store
 * and every staging dataset file are born private instead of inheriting the umask.
 */
export function createPrivateFile(file: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  closeSync(fd);
  return true;
}

/** One authorizer decision recorded by the statement trace. */
export interface TraceEntry {
  /** SQLite authorizer action code (`constants.SQLITE_INSERT`, …). */
  readonly action: number;
  /** Table (or other object) name the action touches; null when SQLite gives none. */
  readonly object: string | null;
  /** Schema name (`main`, `temp`, an attachment); null when SQLite gives none. */
  readonly schema: string | null;
  readonly denied: boolean;
}

/** Actions that write or change schema — denied on anything but `main`/`temp` non-`ds_*` objects. */
const WRITE_ACTIONS: ReadonlySet<number> = new Set([
  C.SQLITE_INSERT,
  C.SQLITE_UPDATE,
  C.SQLITE_DELETE,
  C.SQLITE_CREATE_INDEX,
  C.SQLITE_CREATE_TABLE,
  C.SQLITE_CREATE_TRIGGER,
  C.SQLITE_CREATE_VIEW,
  C.SQLITE_DROP_INDEX,
  C.SQLITE_DROP_TABLE,
  C.SQLITE_DROP_TRIGGER,
  C.SQLITE_DROP_VIEW,
  C.SQLITE_ALTER_TABLE,
  C.SQLITE_REINDEX,
  C.SQLITE_ANALYZE,
  C.SQLITE_CREATE_VTABLE,
  C.SQLITE_DROP_VTABLE,
]);

/** Whether an authorizer write targets a dataset (an attached schema, or any `ds_*` object). */
export function isDatasetWrite(
  action: number,
  object: string | null,
  schema: string | null,
): boolean {
  if (!WRITE_ACTIONS.has(action)) return false;
  const onAttachment = schema !== null && schema !== "main" && schema !== "temp";
  const dsObject = object?.toLowerCase().startsWith("ds_") === true;
  return onAttachment || dsObject;
}

/** The dataset write guard: denies every write to a dataset; optionally records every decision. */
export class StatementGuard {
  private readonly entries: TraceEntry[] = [];
  private tracing = false;
  /** Maximum trace entries kept (oldest dropped) so a long trace cannot grow without bound. */
  static readonly MAX_TRACE = 200_000;

  private installedOn: DatabaseSync | null = null;

  /**
   * Runs `fn` with the guard lifted. Only for `VACUUM INTO`, whose internal copy writes into a
   * temporary attached schema (`vacuum_db`) the guard would otherwise deny; never around a caller's SQL.
   */
  bypass<T>(fn: () => T): T {
    const db = this.installedOn;
    if (db === null) return fn();
    db.setAuthorizer(null);
    try {
      return fn();
    } finally {
      this.install(db);
    }
  }

  install(db: DatabaseSync): void {
    this.installedOn = db;
    db.setAuthorizer((action, a1, _a2, schema) => {
      const denied = isDatasetWrite(action, a1, schema);
      if (this.tracing) {
        if (this.entries.length >= StatementGuard.MAX_TRACE) this.entries.shift();
        this.entries.push({ action, object: a1, schema, denied });
      }
      return denied ? C.SQLITE_DENY : C.SQLITE_OK;
    });
  }

  /** Starts (and clears) the trace. */
  startTrace(): void {
    this.entries.length = 0;
    this.tracing = true;
  }

  /** Stops tracing and returns what was recorded. */
  stopTrace(): readonly TraceEntry[] {
    this.tracing = false;
    return [...this.entries];
  }
}

/** Opens a store-role connection: WAL, synchronous NORMAL, foreign keys, untrusted schema, 100 ms busy. */
export function openStoreConnection(file: string, guard: StatementGuard): DatabaseSync {
  const db = new DatabaseSync(file, {
    timeout: BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.enableDefensive(true);
    const mode = db.prepare("PRAGMA journal_mode = WAL").get() as { journal_mode?: unknown };
    if (mode.journal_mode !== "wal") throw new Error("store: could not enable WAL");
    db.exec("PRAGMA synchronous = NORMAL; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON");
    guard.install(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT` (the write lock is taken up front, so the busy handler applies). */
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * After a best-effort write finds the lock busy, further best-effort writes within this window are
 * counted as misses WITHOUT waiting (a circuit breaker): a 3-s foreign writer lock then costs the
 * stdio loop ~100 ms per 350 ms instead of 100 ms per cache write (plan 05 §2 contention test:
 * 50 cache-missing reads under a 3-s lock, every cache write a miss, p95 < 300 ms). Decision
 * recorded: the plan fixes the 100 ms wait, not how often a known-busy lock is re-tried.
 */
export const BEST_EFFORT_BACKOFF_MS = 250;

/** Monotonic milliseconds (lock-wait accounting only; never a stored instant). */
const monoMs = (): number => performance.now();

/**
 * The write-class executor (plan 01 §5.3). Best-effort writes wait at most the connection's
 * `busy_timeout` once and turn a busy lock into a counted miss; required writes retry — each
 * attempt waits ≤ BUSY_TIMEOUT_MS, then YIELDS to the event loop — until the next attempt would
 * overrun REQUIRED_WRITE_BUDGET_MS, then reject with StoreBusyError (plan 03 §1.2).
 */
export class WriteExecutor {
  private misses = 0;
  private busyUntil = Number.NEGATIVE_INFINITY;
  constructor(private readonly budgetMs: number = REQUIRED_WRITE_BUDGET_MS) {}

  /** Best-effort writes skipped because the lock was busy. */
  get cacheMissesBusy(): number {
    return this.misses;
  }

  bestEffort(fn: () => void): BestEffortOutcome {
    if (monoMs() < this.busyUntil) {
      this.misses += 1;
      return { written: false, reason: "busy" };
    }
    try {
      fn();
      return { written: true };
    } catch (e) {
      if (!isBusyError(e)) throw e;
      this.misses += 1;
      this.busyUntil = monoMs() + BEST_EFFORT_BACKOFF_MS;
      return { written: false, reason: "busy" };
    }
  }

  async required<T>(table: StoreTable, fn: () => T): Promise<T> {
    const start = monoMs();
    let longest = 0;
    for (;;) {
      const t0 = monoMs();
      try {
        return fn();
      } catch (e) {
        if (!isBusyError(e)) throw e;
      }
      const now = monoMs();
      longest = Math.max(longest, now - t0, 1);
      const waited = now - start;
      if (waited + longest > this.budgetMs) throw new StoreBusyError(table, Math.round(waited));
      await sleep(1);
    }
  }
}
