// runner.ts — the refresh runner behind `ff refresh <source>` (plan 01 §5.5 refresh execution model,
// §5.7 "retry 3× with jitter inside one run, then stop and report"; plan 06 §1.2 per-job pipeline,
// §2 season awareness + per-job lock; plan 05 §4.1 "network error on refresh" row; OBJ-22/OBJ-27).
// version() → (release unchanged AND the current file healthy → recordUnchanged) → fetch → assertSchema → publisher.publish(fill
// via source.publish; the unchanged check re-made under the job lock) → outcome. Pure orchestration over injected HttpGet/Clock/Rng/publisher/temp
// area: no Date.now, no Math.random, no process globals. Never throws: every path returns a result.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetSourceId } from "../config/freshness.js";
import type { RefreshLogRepository, ScheduleReader } from "../domain/analytics/types.js";
import type { Clock, Rng } from "../domain/clock.js";
import type { IsoInstant, Week } from "../domain/league/types.js";
import { HttpError, isNetworkFailure, isTransientNetworkError } from "../http/errors.js";
import { createRateLimiter, limitDownload, limitGet } from "../http/limiter.js";
import { abortableSleep, type Sleep } from "../http/sleep.js";
import { checkDatasetFile, type DatasetCheck, type DatasetHealth } from "./dataset-health.js";
import {
  PUBLISH_ALREADY_CURRENT,
  type DatasetPublisher,
  type PublishOutcome,
  type PublishStats,
} from "../store/types.js";
import type {
  DataSource,
  HttpDownload,
  HttpGet,
  ReleaseVersion,
  SchemaReport,
  SourceContext,
  TempFile,
} from "./source.js";

/** Attempts per network step (plan 01 §5.7 / §6: max 3 attempts). */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Full-jitter backoff: delay = U[0,1) × min(cap, base × 2^(attempt−1)). */
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;
/** "Outside the season" = no game kicking off within ± this many days (plan 06 §2). */
export const SEASON_WINDOW_DAYS = 7;
/** Every week a season can have (REG 1–18 + POST). */
export const ALL_SEASON_WEEKS: readonly Week[] = Object.freeze(
  Array.from({ length: 22 }, (_, i) => i + 1),
);
/**
 * The error a DatasetPublisher returns when the source's job_lock is held by another live refresh
 * (plan 06 §2 "exits 0 if another instance is running"). Requested of the store owner; until then
 * any error starting with it is read as "locked".
 */
export const JOB_LOCKED_ERROR = "job_locked";

/** Fixed-vocabulary refresh_log errors (never an upstream body — plan 01 §8.2 RefreshLogRow). */
export type RefreshErrorCode =
  "network" | "schema" | "publish" | "store" | "aborted" | "invalid_request" | "internal";

/** Why a run did nothing, successfully. */
export type SkipReason = "off_season" | "schedules_never_loaded" | "locked";

/** The result of one refresh run. */
export type RefreshResult =
  | {
      readonly status: "published";
      readonly source: DatasetSourceId;
      readonly version: ReleaseVersion;
      readonly file: string;
      readonly file_version: string;
      readonly stats: PublishStats;
      readonly attempts: number;
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "unchanged";
      readonly source: DatasetSourceId;
      readonly version: ReleaseVersion;
      readonly attempts: number;
    }
  | { readonly status: "skipped"; readonly source: DatasetSourceId; readonly reason: SkipReason }
  | {
      readonly status: "failed";
      readonly source: DatasetSourceId;
      readonly error: RefreshErrorCode;
      /** Server-authored, one line (names the column/codec on a schema failure). */
      readonly message: string;
      readonly version: ReleaseVersion | null;
      readonly attempts: number;
      readonly schema: SchemaReport | null;
    };

/** Whether a result is a success for the job's exit code (published, unchanged or skipped). */
export function isRefreshSuccess(r: RefreshResult): boolean {
  return r.status !== "failed";
}

/** Where a run's temp files live; the runner removes the run directory on every path. */
export interface TempArea {
  /** Creates a fresh private directory for one attempt of `source`. */
  create(source: DatasetSourceId): Promise<string>;
  /** Removes a directory or file recursively; never throws for a missing path. */
  remove(path: string): Promise<void>;
}

/** A TempArea under `root` (`<cache>/tmp`, created 0700): one `mkdtemp` directory per attempt. */
export function fsTempArea(root: string): TempArea {
  return {
    async create(source) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(join(root, `${source.replace(/[^a-z0-9_]/gi, "_")}-`));
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** The runner's logging surface (src/cli/log.ts's Logger satisfies it). */
export interface RunnerLog {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Retry tuning (defaults per plan 01 §5.7). */
export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

/** Everything the runner is given; nothing is read from globals. */
export interface RefreshDeps {
  readonly http: HttpGet;
  readonly download?: HttpDownload;
  readonly clock: Clock;
  readonly rng: Rng;
  readonly publisher: DatasetPublisher;
  /** Failures before publish are recorded here; the publisher records its own publish rows. */
  readonly refreshLog: Pick<RefreshLogRepository, "record" | "current">;
  readonly schedules: ScheduleReader;
  readonly temp: TempArea;
  readonly sleep?: Sleep;
  readonly log?: RunnerLog;
  readonly retry?: RetryPolicy;
  /**
   * Whether the file refresh_log lists as current is servable (default `checkDatasetFile`). The
   * "unchanged" short-circuit is taken only when it is: a missing, unreadable or foreign file is
   * republished (QA-1-097, QA-1-038).
   */
  readonly checkDataset?: DatasetCheck;
}

/** One run's request. */
export interface RefreshRequest {
  readonly source: DataSource;
  /** Seasons the run covers, newest last (non-empty). */
  readonly seasons: readonly number[];
  readonly week: Week | null;
  readonly signal?: AbortSignal;
  /** Re-download even when the release version equals the published one. */
  readonly force?: boolean;
}

/** Season state for the gate. */
export type SeasonState = "in_season" | "off_season" | "never_loaded";

/**
 * Whether any game of `season` kicks off within ±SEASON_WINDOW_DAYS of `nowMs` (plan 06 §2). A
 * schedules dataset that was never loaded reads `never_loaded` (the job skips; nflverse:schedules
 * itself is `always`-gated so it loads first).
 */
export function seasonState(schedules: ScheduleReader, season: number, nowMs: number): SeasonState {
  const res = schedules.games(season, ALL_SEASON_WEEKS);
  if (res.stamp === null) return "never_loaded";
  const window = SEASON_WINDOW_DAYS * 86_400_000;
  for (const g of res.rows) {
    if (g.kickoff === null) continue;
    const k = Date.parse(g.kickoff);
    if (Number.isFinite(k) && Math.abs(k - nowMs) <= window) return "in_season";
  }
  return "off_season";
}

const SAFE_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const safeName = (s: string): string => (SAFE_NAME.test(s) ? s : "?");

/** One line naming what failed the schema assertion (column names and codecs, sanitised). */
export function describeSchemaFailure(r: SchemaReport): string {
  const parts: string[] = [];
  if (r.missing_columns.length > 0)
    parts.push(`missing column(s): ${r.missing_columns.slice(0, 10).map(safeName).join(", ")}`);
  if (r.bad_codecs.length > 0)
    parts.push(
      `unsupported codec(s): ${r.bad_codecs
        .slice(0, 10)
        .map((c) => `${safeName(c.column)}=${safeName(c.codec)}`)
        .join(", ")}`,
    );
  return parts.length > 0
    ? `schema assertion failed: ${parts.join("; ")}`
    : "schema assertion failed";
}

function validRequest(req: RefreshRequest): boolean {
  return (
    req.seasons.length > 0 &&
    req.seasons.every((s) => Number.isInteger(s) && s >= 1999 && s <= 2100) &&
    (req.week === null || (Number.isInteger(req.week) && req.week >= 1 && req.week <= 22))
  );
}

function errorCodeFor(e: unknown, signal: AbortSignal): RefreshErrorCode {
  if (signal.aborted || (e instanceof HttpError && e.kind === "aborted")) return "aborted";
  return isNetworkFailure(e) ? "network" : "internal";
}

function messageFor(e: unknown): string {
  if (e instanceof HttpError)
    return `${e.message}${e.host === null ? "" : ` (${e.host})`}${e.status === null ? "" : ` status ${String(e.status)}`}`;
  return "the source failed";
}

/**
 * Runs one refresh. Retries a TRANSIENT network failure of `version()` or `fetch()` up to
 * `maxAttempts` with seeded full-jitter backoff; a schema or publish failure is never retried.
 * Every attempt's temp directory is removed on every path, as are TempFiles outside it.
 */
export async function runRefresh(req: RefreshRequest, deps: RefreshDeps): Promise<RefreshResult> {
  const { source } = req;
  const id = source.id;
  const signal = req.signal ?? new AbortController().signal;
  const started: IsoInstant = deps.clock.nowIso();
  const sleep = deps.sleep ?? abortableSleep;
  const maxAttempts = Math.max(1, Math.floor(deps.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const base = deps.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = deps.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitter = deps.rng.fork(`refresh:${id}`);
  let attempts = 0;
  let version: ReleaseVersion | null = null;

  const previous = (): {
    file_version: string;
    file: string | null;
    checked_at: IsoInstant;
  } | null => {
    try {
      const row = deps.refreshLog.current().find((r) => r.source === id && r.ok);
      return row && row.file_version !== null
        ? { file_version: row.file_version, file: row.file, checked_at: row.checked_at }
        : null;
    } catch {
      return null;
    }
  };

  const fail = async (
    error: RefreshErrorCode,
    message: string,
    schema: SchemaReport | null = null,
    record = true,
  ): Promise<RefreshResult> => {
    deps.log?.warn("refresh.failed", { source: id, error, attempts, version: version?.version });
    if (record) {
      const finished = deps.clock.nowIso();
      try {
        await deps.refreshLog.record({
          source: id,
          file: null,
          file_version: version?.version ?? null,
          release_updated_at: version?.released_at ?? null,
          seasons: [...req.seasons],
          rows: null,
          columns_hash: null,
          started_at: started,
          finished_at: finished,
          ok: false,
          error,
          checked_at: previous()?.checked_at ?? started,
        });
      } catch (e) {
        deps.log?.warn("refresh.log_write_failed", { source: id, error: e });
      }
    }
    return { status: "failed", source: id, error, message, version, attempts, schema };
  };

  /** Runs `step` with retries on transient network failures. */
  const withRetry = async <T>(step: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      attempts++;
      try {
        return await step();
      } catch (e) {
        if (attempt >= maxAttempts || signal.aborted || !isTransientNetworkError(e)) throw e;
        const delay = Math.floor(jitter.next() * Math.min(cap, base * 2 ** (attempt - 1)));
        deps.log?.info("refresh.retry", { source: id, attempt, delay_ms: delay });
        await sleep(delay, signal);
      }
    }
  };

  try {
    if (!validRequest(req))
      return await fail("invalid_request", "seasons/week out of range", null, false);

    if (source.seasonGate === "in_season") {
      const season = Math.max(...req.seasons);
      const state = seasonState(deps.schedules, season, deps.clock.nowMs());
      if (state !== "in_season") {
        const reason: SkipReason = state === "off_season" ? "off_season" : "schedules_never_loaded";
        deps.log?.info("refresh.skipped", { source: id, reason });
        return { status: "skipped", source: id, reason };
      }
    }

    const limiter = createRateLimiter(source.limiter, {
      nowMs: () => deps.clock.nowMs(),
      sleep,
    });
    const baseCtx: SourceContext = {
      http: limitGet(deps.http, limiter),
      signal,
      clock: deps.clock,
      seasons: req.seasons,
      week: req.week,
      datasets: { schedules: deps.schedules },
      ...(deps.download ? { download: limitDownload(deps.download, limiter) } : {}),
    };

    try {
      version = await withRetry(() => source.version(baseCtx));
    } catch (e) {
      return await fail(errorCodeFor(e, signal), messageFor(e));
    }
    if (version === null) return await fail("network", "the upstream version is unavailable");

    // Set when the current file is damaged: publish without the publisher's under-lock "already
    // current" check, which reads refresh_log (and the file's existence) only.
    let repair = false;
    if (source.versioning === "release" && req.force !== true) {
      const prev = previous();
      if (prev !== null && prev.file_version === version.version) {
        let health: DatasetHealth;
        try {
          health = (deps.checkDataset ?? checkDatasetFile)(id, prev.file, version.version);
        } catch {
          health = "unreadable";
        }
        if (health === "ok") {
          try {
            await deps.publisher.recordUnchanged(id, version.version, deps.clock.nowIso());
            deps.log?.info("refresh.unchanged", { source: id, version: version.version });
            return { status: "unchanged", source: id, version, attempts };
          } catch {
            // the check could not be recorded (the file vanished since, or the store is busy):
            // publishing is always a correct answer — the publisher re-checks under its lock
            deps.log?.warn("refresh.unchanged_check_failed", { source: id });
          }
        } else {
          repair = true;
          deps.log?.warn("refresh.dataset_repair", {
            source: id,
            health,
            version: version.version,
          });
        }
      }
    }

    const v = version;
    let files: readonly TempFile[] = [];
    let dir: string | null = null;
    const cleanup = async (): Promise<void> => {
      for (const f of files) {
        if (dir === null || !f.path.startsWith(`${dir}/`))
          await deps.temp.remove(f.path).catch(() => undefined);
      }
      if (dir !== null) await deps.temp.remove(dir).catch(() => undefined);
      files = [];
      dir = null;
    };

    try {
      try {
        files = await withRetry(async () => {
          await cleanup();
          dir = await deps.temp.create(id);
          return source.fetch(v, { ...baseCtx, tempDir: dir });
        });
      } catch (e) {
        return await fail(errorCodeFor(e, signal), messageFor(e));
      }

      let report: SchemaReport;
      try {
        report = await source.assertSchema(files);
      } catch {
        return await fail("schema", "schema assertion could not read the download");
      }
      if (!report.ok) return await fail("schema", describeSchemaFailure(report), report);
      if (signal.aborted) return await fail("aborted", "aborted before publish");

      let outcome: PublishOutcome;
      try {
        outcome = await deps.publisher.publish(
          id,
          v.version,
          v.released_at,
          (w) => source.publish(files, w),
          // the "unchanged" check above ran without the job lock: re-made under it (single-flight)
          { skipIfCurrent: source.versioning === "release" && req.force !== true && !repair },
        );
      } catch {
        return await fail("publish", "the publisher failed");
      }
      if (!outcome.ok) {
        if (outcome.error === PUBLISH_ALREADY_CURRENT) {
          // another refresh published this release while we fetched; its check time was recorded
          deps.log?.info("refresh.unchanged", { source: id, version: v.version });
          return { status: "unchanged", source: id, version: v, attempts };
        }
        if (outcome.error.startsWith(JOB_LOCKED_ERROR)) {
          deps.log?.info("refresh.skipped", { source: id, reason: "locked" });
          return { status: "skipped", source: id, reason: "locked" };
        }
        // The publisher recorded its own refresh_log row for a failed publish.
        return await fail(
          "publish",
          "publish failed; the previous dataset file is intact",
          null,
          false,
        );
      }
      deps.log?.info("refresh.published", {
        source: id,
        version: v.version,
        rows: outcome.stats.rows,
        attempts,
      });
      return {
        status: "published",
        source: id,
        version: v,
        file: outcome.file,
        file_version: outcome.file_version,
        stats: outcome.stats,
        attempts,
        warnings: report.warnings,
      };
    } finally {
      await cleanup();
    }
  } catch {
    return await fail("internal", "the refresh runner failed");
  }
}
