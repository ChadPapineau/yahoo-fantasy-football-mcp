// ops.ts — the operational store tables: refresh_log (plan 01 §5.5 — which dataset file version is
// current; "release" age basis via checked_at, critics C-12/C-08b), job_lock (single-flight refresh
// jobs across processes) and write_journal counts (plan 02 §4.5; read-only in this build).
import { isDatasetSourceId, type DatasetSourceId } from "../../config/freshness.js";
import type {
  JournalStatus,
  RefreshLogRepository,
  RefreshLogRow,
  WriteJournalRepository,
} from "../../domain/analytics/types.js";
import { pidAlive } from "../lock.js";
import { immediate } from "../sqlite.js";
import type { JobLockRepository } from "../types.js";
import { intIn, isoMs, keyString, parseJson, type RepoDeps } from "./common.js";

/** refresh_log `error` grammar: a fixed-vocabulary code, never an upstream body. */
export const REFRESH_ERROR_RE = /^[a-z][a-z0-9_:.-]{0,63}$/;

interface RefreshRow {
  source: string;
  file: string | null;
  file_version: string | null;
  release_updated_at: string | null;
  seasons_json: string;
  rows: number | null;
  columns_hash: string | null;
  started_at: string;
  finished_at: string;
  ok: number;
  error: string | null;
  checked_at: string;
}

const toRefresh = (r: RefreshRow): RefreshLogRow => ({
  source: r.source as DatasetSourceId,
  file: r.file,
  file_version: r.file_version,
  release_updated_at: r.release_updated_at,
  seasons: parseJson<number[]>(r.seasons_json),
  rows: r.rows,
  columns_hash: r.columns_hash,
  started_at: r.started_at,
  finished_at: r.finished_at,
  ok: r.ok === 1,
  error: r.error,
  checked_at: r.checked_at,
});

/** Validates a refresh_log row before it is written. */
export function checkRefreshRow(row: RefreshLogRow): void {
  if (!isDatasetSourceId(row.source)) throw new RangeError("store: unknown dataset source");
  if (row.file !== null) keyString(row.file, "file", 4096);
  if (row.file_version !== null) keyString(row.file_version, "file_version", 128);
  if (row.release_updated_at !== null) isoMs(row.release_updated_at, "release_updated_at");
  if (!Array.isArray(row.seasons) || row.seasons.length > 64)
    throw new RangeError("store: seasons must be an array of at most 64 seasons");
  for (const s of row.seasons) intIn(s, 1990, 2100, "season");
  if (row.rows !== null) intIn(row.rows, 0, Number.MAX_SAFE_INTEGER, "rows");
  if (row.columns_hash !== null) keyString(row.columns_hash, "columns_hash", 128);
  isoMs(row.started_at, "started_at");
  isoMs(row.finished_at, "finished_at");
  isoMs(row.checked_at, "checked_at");
  if (typeof row.ok !== "boolean") throw new RangeError("store: ok must be a boolean");
  if (row.error !== null && (typeof row.error !== "string" || !REFRESH_ERROR_RE.test(row.error)))
    throw new RangeError("store: refresh_log error must be a fixed-vocabulary code");
}

/** Inserts one refresh_log row (no validation, no retry — callers wrap it). */
export function insertRefreshRow(deps: RepoDeps, row: RefreshLogRow): void {
  deps.db
    .prepare(
      `INSERT INTO refresh_log (source, file, file_version, release_updated_at, seasons_json, rows, columns_hash,
         started_at, finished_at, ok, error, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.source,
      row.file,
      row.file_version,
      row.release_updated_at,
      JSON.stringify(row.seasons),
      row.rows,
      row.columns_hash,
      row.started_at,
      row.finished_at,
      row.ok ? 1 : 0,
      row.error,
      row.checked_at,
    );
}

export function refreshLogRepository(deps: RepoDeps): RefreshLogRepository {
  const { db, writes } = deps;
  return {
    async record(row) {
      checkRefreshRow(row);
      await writes.required("refresh_log", () => {
        insertRefreshRow(deps, row);
      });
    },
    current() {
      return (
        db
          .prepare(
            `SELECT r.* FROM refresh_log AS r
             WHERE r.ok = 1 AND r.id = (SELECT MAX(id) FROM refresh_log WHERE source = r.source AND ok = 1)
             ORDER BY r.source`,
          )
          .all() as unknown as RefreshRow[]
      )
        .filter((r) => isDatasetSourceId(r.source))
        .map(toRefresh);
    },
    latest(source) {
      const r = db
        .prepare("SELECT * FROM refresh_log WHERE source = ? ORDER BY id DESC LIMIT 1")
        .get(source) as RefreshRow | undefined;
      return r === undefined ? null : toRefresh(r);
    },
    consecutiveFailures(source) {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM refresh_log WHERE source = :s AND ok = 0
             AND id > COALESCE((SELECT MAX(id) FROM refresh_log WHERE source = :s AND ok = 1), 0)`,
          )
          .get({ s: source }) as { n: number }
      ).n;
    },
  };
}

/** The newest successful refresh_log row of `source` (or null). */
export function currentRefreshRow(deps: RepoDeps, source: DatasetSourceId): RefreshLogRow | null {
  const r = deps.db
    .prepare("SELECT * FROM refresh_log WHERE source = ? AND ok = 1 ORDER BY id DESC LIMIT 1")
    .get(source) as RefreshRow | undefined;
  return r === undefined ? null : toRefresh(r);
}

/** Job names: `publish:<source>` and similar short codes. */
const JOB_RE = /^[a-z][a-z0-9_:.-]{0,95}$/;

export function jobLockRepository({ db, writes }: RepoDeps): JobLockRepository {
  return {
    async acquire(job, pid, now, staleAfterMs) {
      if (!JOB_RE.test(job)) throw new RangeError("store: invalid job name");
      intIn(pid, 1, 2 ** 31 - 1, "pid");
      const nowMs = isoMs(now, "now");
      intIn(staleAfterMs, 0, 7 * 86_400_000, "staleAfterMs");
      return writes.required("job_lock", () =>
        immediate(db, () => {
          const cur = db.prepare("SELECT pid, acquired_ms FROM job_lock WHERE job = ?").get(job) as
            { pid: number; acquired_ms: number } | undefined;
          const free =
            cur === undefined ||
            cur.pid === pid ||
            nowMs - cur.acquired_ms > staleAfterMs ||
            !pidAlive(cur.pid);
          if (!free) return false;
          db.prepare(
            "INSERT OR REPLACE INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)",
          ).run(job, pid, now, nowMs);
          return true;
        }),
      );
    },
    async release(job, pid) {
      await writes.required("job_lock", () => {
        db.prepare("DELETE FROM job_lock WHERE job = ? AND pid = ?").run(job, pid);
      });
    },
  };
}

/** Journal states still awaiting an outcome (plan 02 §4.5): everything before a terminal state. */
export const PENDING_JOURNAL_STATUSES: readonly JournalStatus[] = [
  "prepared",
  "sent",
  "sent_unknown",
];

export function writeJournalRepository({ db }: RepoDeps): WriteJournalRepository {
  return {
    countByStatus() {
      const rows = db
        .prepare("SELECT status, COUNT(*) AS n FROM write_journal GROUP BY status ORDER BY status")
        .all() as unknown as { status: JournalStatus; n: number }[];
      const out: Partial<Record<JournalStatus, number>> = {};
      for (const r of rows) out[r.status] = r.n;
      return out;
    },
    oldestPendingAgeSeconds(now) {
      const nowMs = isoMs(now, "now");
      const r = db
        .prepare(
          "SELECT MIN(created_ms) AS m FROM write_journal WHERE status IN (SELECT value FROM json_each(?))",
        )
        .get(JSON.stringify(PENDING_JOURNAL_STATUSES)) as { m: number | null };
      if (r.m === null) return null;
      return Math.max(0, Math.floor((nowMs - r.m) / 1000));
    },
  };
}
