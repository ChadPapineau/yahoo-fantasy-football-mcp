// publisher.ts — StoreFactory.openPublisher → DatasetPublisher, the refresh process's only dataset
// writer (plan 01 §5.5, round 2 OBJ-27; plan 05 §2 `store` + `sources/*`): take the source's job_lock
// (a second publisher for the same source SKIPS with `job_locked` — no double download, no retry
// storm, plan 01 §5.7), sweep crashed runs' temp debris, fill a fresh 0600 staging file
// (journal_mode=DELETE: one file, no -wal) through a DatasetWriter (one transaction per insert),
// stamp dataset_meta, fsync the file, then ONE commit (QA-1-032): take the store's writer lock,
// rename() the file over `<ds>/<stem>.sqlite`, fsync the directory and insert the refresh_log row
// under it. A failure before the rename deletes the staging file and leaves the previous dataset file
// untouched; one after it is PUBLISH_UNRECORDED, and the next publish records the live file first.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isDatasetSourceId, type DatasetSourceId } from "../config/freshness.js";
import { BACKUP_DIR_NAME, datasetFileStem, ensureSecureDir } from "../config/paths.js";
import type { RefreshLogRow } from "../domain/analytics/types.js";
import { DATASET_META_TABLE, DS_SCHEMA_VERSION, parseDsSchema } from "./attach.js";
import { ddlFor, tablesFor } from "./datasets/tables.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import type { RepoDeps } from "./repos/common.js";
import {
  checkRefreshRow,
  currentRefreshRow,
  insertRefreshRow,
  jobLockRepository,
  markCheckedRow,
  REFRESH_ERROR_RE,
} from "./repos/ops.js";
import { createPrivateFile, immediate, StatementGuard, WriteExecutor } from "./sqlite.js";
import { openMigrated } from "./store.js";
import {
  PUBLISH_ALREADY_CURRENT,
  PUBLISH_UNRECORDED,
  StoreBusyError,
  type DatasetPublisher,
  type DatasetRow,
  type DatasetTableSpec,
  type DatasetWriter,
  type PublishOptions,
  type PublishOutcome,
  type PublishStats,
  type PublisherOpenOptions,
} from "./types.js";

/** A publish job lock older than this is broken (a pbp publish takes about a minute). */
export const PUBLISH_LOCK_STALE_MS = 15 * 60 * 1000;
/** Longest release version string accepted (it becomes refresh_log.file_version). */
export const VERSION_MAX = 128;
/** Most rows one `insert` call takes (one transaction; the source batches). */
export const INSERT_MAX_ROWS = 1_000_000;

/**
 * How long the publish commit (rename + refresh_log row) waits for the store's writer lock. The
 * refresh process is not interactive, so it outwaits plan 05 §4.1's "write lock held 3 s by another
 * process" instead of failing a finished download on the server's 1-s required-write budget.
 */
export const PUBLISH_COMMIT_BUDGET_MS = 30_000;

/** The job name of a source's publish lock. */
export const publishJob = (source: DatasetSourceId): string => `publish:${source}`;

/** Jobs held by publishers of THIS process (job_lock is keyed by pid, so it cannot tell them apart). */
const heldInProcess = new Set<string>();

/** The staging path `<ds>/<stem>.<version>.<rand>.tmp` (config/paths datasetTempPath's pattern). */
export function stagingPath(datasetDir: string, source: DatasetSourceId, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "v";
  return path.join(
    datasetDir,
    `${datasetFileStem(source)}.${safe}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/** Removes a source's staging debris (`<stem>.*.tmp` and its `-journal`); returns names removed. */
export function sweepDebris(datasetDir: string, source: DatasetSourceId): string[] {
  const prefix = `${datasetFileStem(source)}.`;
  const removed: string[] = [];
  for (const n of readdirSync(datasetDir)) {
    if (!n.startsWith(prefix) || !(n.endsWith(".tmp") || n.endsWith(".tmp-journal"))) continue;
    const p = path.join(datasetDir, n);
    const st = lstatSync(p);
    if (st.isFile() || st.isSymbolicLink()) {
      rmSync(p, { force: true });
      removed.push(n);
    }
  }
  return removed.sort();
}

/**
 * The `dataset_meta` of a published dataset file, read through its own read-only connection; null
 * when the path is not a regular file, is not a SQLite database, or carries no dataset_meta.
 */
export function readDatasetFileMeta(file: string): Readonly<Record<string, string>> | null {
  try {
    if (!lstatSync(file).isFile()) return null;
  } catch {
    return null;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    const has = db
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(DATASET_META_TABLE);
    if (has === undefined) return null;
    const out: Record<string, string> = Object.create(null) as Record<string, string>; // a "__proto__" key stays data
    for (const r of db.prepare(`SELECT key, value FROM ${DATASET_META_TABLE}`).all() as unknown as {
      key: unknown;
      value: unknown;
    }[])
      if (typeof r.key === "string" && typeof r.value === "string") out[r.key] = r.value;
    return out;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function fsyncPath(p: string, flags: number): void {
  const fd = openSync(p, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A publish failure carrying its fixed-vocabulary refresh_log code. */
class PublishError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The fixed-vocabulary code for a failure (a source may throw `{ code: "network" }`-style errors). */
export function errorCode(e: unknown, fallback: string): string {
  if (e instanceof PublishError) return e.code;
  if (e instanceof StoreBusyError) return "store_busy";
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(c) && REFRESH_ERROR_RE.test(c)
    ? c
    : fallback;
}

/** The staging-file writer handed to `fill` (usable only until `fill` settles). */
class StagingWriter implements DatasetWriter {
  private readonly specs = new Map<string, { spec: DatasetTableSpec; insert: StatementSync }>();
  private open = true;
  readonly counts = new Map<string, number>();

  constructor(
    readonly path: string,
    private readonly db: DatabaseSync,
  ) {}

  close(): void {
    this.open = false;
  }

  private live(): void {
    if (!this.open) throw new Error("store: the DatasetWriter is closed");
  }

  createTable(spec: DatasetTableSpec): void {
    this.live();
    if (typeof spec.name !== "string" || !spec.name.startsWith("ds_"))
      throw new RangeError("store: dataset tables must be named ds_*");
    if (this.specs.has(spec.name)) throw new RangeError(`store: table ${spec.name} created twice`);
    for (const sql of ddlFor(spec)) this.db.exec(sql);
    const cols = spec.columns.map((c) => `"${c.name}"`).join(", ");
    const params = spec.columns.map(() => "?").join(", ");
    const insert = this.db.prepare(`INSERT INTO "${spec.name}" (${cols}) VALUES (${params})`);
    this.specs.set(spec.name, { spec, insert });
    this.counts.set(spec.name, 0);
  }

  insert(table: string, rows: readonly DatasetRow[]): number {
    this.live();
    const t = this.specs.get(table);
    if (t === undefined) throw new RangeError("store: insert into a table that was not created");
    if (rows.length > INSERT_MAX_ROWS)
      throw new RangeError(`store: insert takes at most ${String(INSERT_MAX_ROWS)} rows per call`);
    const names = new Set(t.spec.columns.map((c) => c.name));
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        for (const k of Object.keys(row))
          if (!names.has(k))
            throw new RangeError(`store: ${table} has no column ${JSON.stringify(k)}`);
        t.insert.run(...t.spec.columns.map((c) => row[c.name] ?? null));
      }
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    this.counts.set(table, (this.counts.get(table) ?? 0) + rows.length);
    return rows.length;
  }
}

function checkStats(stats: unknown): PublishStats {
  const s = stats as PublishStats | null;
  if (
    s === null ||
    typeof s !== "object" ||
    !Number.isInteger(s.rows) ||
    s.rows < 0 ||
    !Array.isArray(s.tables) ||
    !Array.isArray(s.seasons) ||
    !s.seasons.every((x) => Number.isInteger(x) && x >= 1990 && x <= 2100) ||
    typeof s.columns_hash !== "string" ||
    s.columns_hash.length === 0 ||
    s.columns_hash.length > 128
  )
    throw new PublishError("bad_stats");
  return s;
}

/** Test hooks for the publisher. */
export interface PublisherInternals {
  readonly migrations?: readonly Migration[];
  /** Runs after fsync, before rename (fault injection: a crash here must leave the old file). */
  readonly beforeRename?: (stagingFile: string) => void;
  /** Runs right after the rename, inside the commit (fault injection: live but unrecorded). */
  readonly afterRename?: (finalFile: string) => void;
  /** Overrides PUBLISH_COMMIT_BUDGET_MS (tests). */
  readonly commitBudgetMs?: number;
}

/**
 * The refresh_log row a live dataset file stands for, rebuilt from its own dataset_meta (the
 * publisher stamps rows and seasons there too), or null when the meta is not a complete, valid
 * stamp of `source` in this layout.
 */
function rowFromMeta(
  source: DatasetSourceId,
  file: string,
  meta: Readonly<Record<string, string>>,
): RefreshLogRow | null {
  if (meta.source !== source || parseDsSchema(meta.ds_schema) !== DS_SCHEMA_VERSION) return null;
  const version = meta.file_version;
  const at = meta.published_at;
  if (version === undefined || at === undefined || !Number.isFinite(Date.parse(at))) return null;
  let seasons: number[] = [];
  try {
    const parsed: unknown = JSON.parse(meta.seasons ?? "[]");
    if (Array.isArray(parsed) && parsed.every((x) => Number.isInteger(x)))
      seasons = parsed as number[];
  } catch {
    seasons = [];
  }
  const rows =
    meta.rows !== undefined && /^[0-9]{1,15}$/.test(meta.rows) ? Number(meta.rows) : null;
  const release = meta.release_updated_at ?? null;
  const row: RefreshLogRow = {
    source,
    file,
    file_version: version,
    release_updated_at: release !== null && Number.isFinite(Date.parse(release)) ? release : null,
    seasons,
    rows,
    columns_hash: meta.columns_hash ?? null,
    started_at: at,
    finished_at: at,
    ok: true,
    error: null,
    checked_at: at,
  };
  try {
    checkRefreshRow(row);
  } catch {
    return null;
  }
  return row;
}

export function openPublisher(
  opts: PublisherOpenOptions,
  internals: PublisherInternals = {},
): DatasetPublisher {
  if (!path.isAbsolute(opts.datasetDir)) throw new RangeError("store: datasetDir must be absolute");
  const guard = new StatementGuard();
  const { db } = openMigrated({
    path: opts.storePath,
    backupDir: path.join(path.dirname(opts.storePath), BACKUP_DIR_NAME),
    clock: opts.clock,
    migrate: true,
    migrations: internals.migrations ?? MIGRATIONS,
    guard,
  });
  try {
    ensureSecureDir(opts.datasetDir, { create: true, what: "dataset directory" });
  } catch (e) {
    db.close();
    throw e;
  }
  const deps: RepoDeps = { db, writes: new WriteExecutor(undefined, db) };
  /** The publish commit's executor: same connection, a budget that outwaits a 3-s foreign lock. */
  const commitWrites = new WriteExecutor(internals.commitBudgetMs ?? PUBLISH_COMMIT_BUDGET_MS, db);
  const jobLock = jobLockRepository(deps);
  const clock = opts.clock;
  let closed = false;

  const record = (row: RefreshLogRow): Promise<void> => {
    checkRefreshRow(row);
    return deps.writes.required("refresh_log", () => {
      insertRefreshRow(deps, row);
    });
  };

  /**
   * The current row carries `version`, its file exists, and that file is the one this binary would
   * serve — its dataset_meta names this source and version in THIS layout (plan 03 §7 ds_schema,
   * QA-1-098: a file of another layout is republished, never kept as "unchanged"). Else a
   * RangeError naming why not.
   */
  const assertCurrent = (sourceId: DatasetSourceId, version: string): void => {
    const cur = currentRefreshRow(deps, sourceId);
    if (cur?.file_version !== version)
      throw new RangeError("store: version is not the current published one");
    const file = path.join(opts.datasetDir, `${datasetFileStem(sourceId)}.sqlite`);
    try {
      lstatSync(file);
    } catch {
      throw new RangeError("store: the current dataset file is missing; publish it again");
    }
    const meta = readDatasetFileMeta(file);
    if (
      meta?.source !== sourceId ||
      meta.file_version !== version ||
      parseDsSchema(meta.ds_schema) !== DS_SCHEMA_VERSION
    )
      throw new RangeError(
        "store: the current dataset file is not this version in this layout; publish it again",
      );
  };
  /** A successful "unchanged" check: advances checked_at and ends any failure streak (QA-1-037). */
  const markChecked = (sourceId: DatasetSourceId, checkedAt: string): Promise<void> =>
    deps.writes.required("refresh_log", () => {
      markCheckedRow(deps, sourceId, checkedAt);
    });
  /**
   * Records the live file of `sourceId` when refresh_log does not list its version as current — a
   * publish that renamed but could not record (PUBLISH_UNRECORDED), or crashed between its rename
   * and its commit (QA-1-032). Runs under the source's job lock; best-effort (a busy store or an
   * unreadable file just leaves things as they are, and the publish then proceeds normally).
   */
  const recordLiveFile = async (sourceId: DatasetSourceId, finalPath: string): Promise<void> => {
    try {
      const meta = readDatasetFileMeta(finalPath);
      const live = meta === null ? null : rowFromMeta(sourceId, finalPath, meta);
      if (live === null || currentRefreshRow(deps, sourceId)?.file_version === live.file_version)
        return;
      await commitWrites.required("refresh_log", () => {
        insertRefreshRow(deps, live);
      });
    } catch {
      // left unrecorded: the publish below writes (and records) a file of its own
    }
  };
  const isCurrent = (sourceId: DatasetSourceId, version: string): boolean => {
    try {
      assertCurrent(sourceId, version);
      return true;
    } catch {
      return false;
    }
  };

  async function publish(
    sourceId: DatasetSourceId,
    version: string,
    releaseUpdatedAt: string | null,
    fill: (writer: DatasetWriter) => Promise<PublishStats>,
    options?: PublishOptions,
  ): Promise<PublishOutcome> {
    if (closed) throw new Error("store: the publisher is closed");
    if (!isDatasetSourceId(sourceId)) return { ok: false, error: "invalid_source" };
    if (
      typeof version !== "string" ||
      version.length === 0 ||
      version.length > VERSION_MAX ||
      version.includes("\0")
    )
      return { ok: false, error: "invalid_version" };
    if (releaseUpdatedAt !== null && !Number.isFinite(Date.parse(releaseUpdatedAt)))
      return { ok: false, error: "invalid_release_time" };
    const job = publishJob(sourceId);
    const lockKey = `${opts.storePath}|${job}`;
    if (heldInProcess.has(lockKey)) return { ok: false, error: "job_locked" };
    heldInProcess.add(lockKey);
    let acquired = false;
    try {
      acquired = await jobLock.acquire(job, process.pid, clock.nowIso(), PUBLISH_LOCK_STALE_MS);
    } catch (e) {
      heldInProcess.delete(lockKey);
      return { ok: false, error: errorCode(e, "job_lock_failed") };
    }
    if (!acquired) {
      heldInProcess.delete(lockKey);
      return { ok: false, error: "job_locked" };
    }
    const startedAt = clock.nowIso();
    const finalPath = path.join(opts.datasetDir, `${datasetFileStem(sourceId)}.sqlite`);
    let staging: string | null = null;
    let wdb: DatabaseSync | null = null;
    let writer: StagingWriter | null = null;
    let stage = "sweep_failed";
    try {
      await recordLiveFile(sourceId, finalPath);
      // single-flight (plan 01 §5.7): the caller's "unchanged" check ran before this lock; another
      // refresh may have published this very release and released the lock since
      if (options?.skipIfCurrent === true && isCurrent(sourceId, version)) {
        stage = "refresh_log_failed"; // a failed check write is not a failed publish: no failure row
        await markChecked(sourceId, clock.nowIso());
        return { ok: false, error: PUBLISH_ALREADY_CURRENT };
      }
      sweepDebris(opts.datasetDir, sourceId);
      stage = "staging_failed";
      staging = stagingPath(opts.datasetDir, sourceId, version);
      createPrivateFile(staging);
      wdb = new DatabaseSync(staging, { enableDoubleQuotedStringLiterals: false });
      wdb.exec(
        "PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF; PRAGMA trusted_schema = OFF",
      );
      writer = new StagingWriter(staging, wdb);
      stage = "fill_failed";
      const stats = checkStats(await fill(writer));
      writer.close();
      // A file the server would refuse (a contract table missing) is never published.
      if (!tablesFor(sourceId).every((t) => writer?.counts.has(t.name) === true))
        throw new PublishError("tables_missing");
      stage = "meta_failed";
      wdb.exec(
        `CREATE TABLE ${DATASET_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
      );
      const meta = wdb.prepare(`INSERT INTO ${DATASET_META_TABLE} (key, value) VALUES (?, ?)`);
      const publishedAt = clock.nowIso();
      for (const [k, v] of [
        ["source", sourceId],
        ["file_version", version],
        ["release_updated_at", releaseUpdatedAt],
        ["published_at", publishedAt],
        ["ds_schema", String(DS_SCHEMA_VERSION)],
        ["columns_hash", stats.columns_hash],
        // what refresh_log records, so a live-but-unrecorded file can be recorded later (QA-1-032)
        ["rows", String(stats.rows)],
        ["seasons", JSON.stringify(stats.seasons)],
      ] as const)
        if (v !== null) meta.run(k, v);
      wdb.close();
      wdb = null;
      stage = "fsync_failed";
      fsyncPath(staging, fsc.O_RDONLY);
      internals.beforeRename?.(staging);
      stage = "rename_failed";
      const success = (finishedAt: string): RefreshLogRow => ({
        source: sourceId,
        file: finalPath,
        file_version: version,
        release_updated_at: releaseUpdatedAt,
        seasons: [...stats.seasons],
        rows: stats.rows,
        columns_hash: stats.columns_hash,
        started_at: startedAt,
        finished_at: finishedAt,
        ok: true,
        error: null,
        checked_at: finishedAt,
      });
      checkRefreshRow(success(startedAt)); // nothing that can be refused is left past the rename
      // The commit point (QA-1-032): the writer lock FIRST (a busy store fails here, before the
      // rename — the previous file really is intact), then rename + directory fsync + the row, one
      // transaction. A retry after a busy try never renames twice.
      const from = staging;
      const commit = { renamed: false };
      try {
        await commitWrites.required("refresh_log", () => {
          immediate(db, () => {
            if (!commit.renamed) {
              renameSync(from, finalPath);
              commit.renamed = true;
              staging = null;
              fsyncPath(opts.datasetDir, fsc.O_RDONLY);
              internals.afterRename?.(finalPath);
            }
            insertRefreshRow(deps, success(clock.nowIso()));
          });
        });
      } catch (e) {
        if (commit.renamed) throw new PublishError(PUBLISH_UNRECORDED);
        throw e;
      }
      return { ok: true, file: finalPath, file_version: version, stats };
    } catch (e) {
      writer?.close();
      if (wdb !== null) {
        try {
          wdb.close();
        } catch {
          // already closed
        }
      }
      if (staging !== null) {
        rmSync(staging, { force: true });
        rmSync(`${staging}-journal`, { force: true });
      }
      const code = errorCode(e, stage);
      // no failure row for a failed check write, nor for a file that IS live (PUBLISH_UNRECORDED)
      if (stage !== "refresh_log_failed" && code !== PUBLISH_UNRECORDED) {
        const now = clock.nowIso();
        try {
          await record({
            source: sourceId,
            file: null,
            file_version: null,
            release_updated_at: releaseUpdatedAt,
            seasons: [],
            rows: null,
            columns_hash: null,
            started_at: startedAt,
            finished_at: now,
            ok: false,
            error: code,
            checked_at: now,
          });
        } catch {
          // the failure row is best-effort once the publish itself failed
        }
      }
      return { ok: false, error: code };
    } finally {
      heldInProcess.delete(lockKey);
      try {
        await jobLock.release(job, process.pid);
      } catch {
        // a lock we could not release goes stale after PUBLISH_LOCK_STALE_MS / when we exit
      }
    }
  }

  return {
    publish,
    async recordUnchanged(sourceId, version, checkedAt) {
      if (closed) throw new Error("store: the publisher is closed");
      if (!isDatasetSourceId(sourceId)) throw new RangeError("store: unknown dataset source");
      if (!Number.isFinite(Date.parse(checkedAt)))
        throw new RangeError("store: checkedAt must be ISO-8601");
      assertCurrent(sourceId, version);
      await markChecked(sourceId, checkedAt);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // busy: the next opener checkpoints
      }
      db.close();
    },
  };
}
