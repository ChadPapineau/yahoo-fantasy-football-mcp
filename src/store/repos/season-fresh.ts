// season-fresh.ts — the migration-003 repositories (the schedule-driven refresh): schedule_change
// (the kickoff-change history: append-only, deduplicated on the change itself), job_run (one
// heartbeat row per scheduled job), season_check (whether upstream has published a source's season
// yet) and provider_backoff (a 429 / Retry-After pause per provider, shared by every process). Every
// write is a required write (≤ 1 s of yielding retries, then StoreBusyError). Values are validated
// before they reach disk: a schedule change carries ids, instants, dates and week numbers only —
// never third-party free text.
import { isDatasetSourceId } from "../../config/freshness.js";
import { isNflTeam } from "../../config/schema.js";
import { WEEK_INDEX_MAX } from "../../config/weeks.js";
import {
  SCHEDULE_CHANGE_KINDS,
  type BackoffProvider,
  type JobRunRepository,
  type JobRunRow,
  type ProviderBackoffRepository,
  type ProviderBackoffRow,
  type ScheduleChange,
  type ScheduleChangeKind,
  type ScheduleChangeRepository,
  type SeasonCheckRepository,
  type SeasonCheckRow,
  type SeasonCheckStatus,
} from "../../domain/analytics/types.js";
import type { DatasetSourceId } from "../../config/freshness.js";
import type { NflTeam } from "../../config/schema.js";
import { immediate } from "../sqlite.js";
import { intIn, isoMs, SEASON_MAX, SEASON_MIN, type RepoDeps } from "./common.js";

/** A schedule change's game id: `<season>_<week>_<away>_<home>` (nflverse). */
export const GAME_ID_RE = /^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/;
/** A change value: an ISO instant, an Eastern date, a venue id or a week number — nothing else. */
export const CHANGE_VALUE_RE = /^[A-Za-z0-9:._+-]{1,40}$/;
/** Most rows `recent` returns. */
export const RECENT_CHANGES_MAX = 200;
/** Most rows one `append` call takes (a whole season's games moving is 272). */
export const APPEND_MAX_ROWS = 5_000;
/** A job name (`refresh-due`, `store-prune`, …). */
export const JOB_RUN_NAME_RE = /^[a-z][a-z0-9_:.-]{0,63}$/;
/** A job_run summary: printable ASCII, server-authored counts only. */
export const JOB_RUN_SUMMARY_RE = /^[ -~]{0,200}$/;
/** The providers a backoff can be recorded for. */
export const BACKOFF_PROVIDERS: readonly BackoffProvider[] = [
  "nflverse",
  "weather:open_meteo",
  "weather:nws",
];
const BACKOFF_REASONS = new Set(["rate_limited", "server_error"]);
const CHECK_STATUSES = new Set<SeasonCheckStatus>(["not_published", "published"]);
const KINDS = new Set<string>(SCHEDULE_CHANGE_KINDS);

/** A canonical ISO instant (`toISOString`), so stored instants order lexically. */
const canonical = (iso: unknown, what: string): string => new Date(isoMs(iso, what)).toISOString();

function changeValue(v: unknown, what: string): string | null {
  if (v === null) return null;
  if (typeof v !== "string" || !CHANGE_VALUE_RE.test(v))
    throw new RangeError(`store: ${what} must be an id, instant, date or week number`);
  return v;
}

/** Validates one schedule change and returns it with canonical instants. */
export function checkScheduleChange(c: ScheduleChange): ScheduleChange {
  if (typeof c.game_id !== "string" || !GAME_ID_RE.test(c.game_id))
    throw new RangeError("store: game_id must look like 2026_15_CHI_BUF");
  if (typeof c.kind !== "string" || !KINDS.has(c.kind))
    throw new RangeError("store: unknown schedule change kind");
  if (typeof c.away !== "string" || !isNflTeam(c.away))
    throw new RangeError("store: away must be an NFL team");
  if (typeof c.home !== "string" || !isNflTeam(c.home))
    throw new RangeError("store: home must be an NFL team");
  return {
    detected_at: canonical(c.detected_at, "detected_at"),
    release_updated_at:
      c.release_updated_at === null ? null : canonical(c.release_updated_at, "release_updated_at"),
    season: intIn(c.season, SEASON_MIN, SEASON_MAX, "season"),
    week: intIn(c.week, 1, WEEK_INDEX_MAX, "week"),
    game_id: c.game_id,
    away: c.away,
    home: c.home,
    kind: c.kind,
    old_value: changeValue(c.old_value, "old_value"),
    new_value: changeValue(c.new_value, "new_value"),
  };
}

interface ChangeRow {
  detected_at: string;
  release_updated_at: string | null;
  season: number;
  week: number;
  game_id: string;
  away: string;
  home: string;
  kind: string;
  old_value: string | null;
  new_value: string | null;
}

const toChange = (r: ChangeRow): ScheduleChange => ({
  detected_at: r.detected_at,
  release_updated_at: r.release_updated_at,
  season: r.season,
  week: r.week,
  game_id: r.game_id,
  away: r.away as NflTeam,
  home: r.home as NflTeam,
  kind: r.kind as ScheduleChangeKind,
  old_value: r.old_value,
  new_value: r.new_value,
});

const CHANGE_COLUMNS =
  "detected_at, release_updated_at, season, week, game_id, away, home, kind, old_value, new_value";

/** schedule_change, plus the prune `ff prune` runs. */
export interface ScheduleChangeStore extends ScheduleChangeRepository {
  /** Deletes changes detected before `before`; resolves to the rows removed. */
  prune(before: string): Promise<number>;
}

export function scheduleChangeRepository({ db, writes }: RepoDeps): ScheduleChangeStore {
  return {
    async append(rows) {
      if (!Array.isArray(rows) || rows.length > APPEND_MAX_ROWS)
        throw new RangeError(`store: append takes at most ${String(APPEND_MAX_ROWS)} changes`);
      const checked = rows.map(checkScheduleChange);
      if (checked.length === 0) return 0;
      return writes.required("schedule_change", () =>
        immediate(db, () => {
          const st = db.prepare(
            `INSERT OR IGNORE INTO schedule_change (${CHANGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          let n = 0;
          for (const c of checked) {
            const r = st.run(
              c.detected_at,
              c.release_updated_at,
              c.season,
              c.week,
              c.game_id,
              c.away,
              c.home,
              c.kind,
              c.old_value,
              c.new_value,
            );
            n += Number(r.changes);
          }
          return n;
        }),
      );
    },
    recent(since, limit) {
      const from = canonical(since, "since");
      intIn(limit, 0, RECENT_CHANGES_MAX, "limit");
      return (
        db
          .prepare(
            `SELECT ${CHANGE_COLUMNS} FROM schedule_change WHERE detected_at >= ?
             ORDER BY detected_at DESC, id DESC LIMIT ?`,
          )
          .all(from, limit) as unknown as ChangeRow[]
      ).map(toChange);
    },
    forWeek(season, week) {
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      intIn(week, 1, WEEK_INDEX_MAX, "week");
      return (
        db
          .prepare(
            `SELECT ${CHANGE_COLUMNS} FROM schedule_change WHERE season = ? AND week = ?
             ORDER BY detected_at, id`,
          )
          .all(season, week) as unknown as ChangeRow[]
      ).map(toChange);
    },
    async prune(before) {
      const cut = canonical(before, "before");
      return writes.required("schedule_change", () =>
        Number(db.prepare("DELETE FROM schedule_change WHERE detected_at < ?").run(cut).changes),
      );
    },
  };
}

/** Validates a job_run row and returns it with a canonical instant. */
export function checkJobRun(row: JobRunRow): JobRunRow {
  if (typeof row.job !== "string" || !JOB_RUN_NAME_RE.test(row.job))
    throw new RangeError("store: invalid job name");
  if (
    row.summary !== null &&
    (typeof row.summary !== "string" || !JOB_RUN_SUMMARY_RE.test(row.summary))
  )
    throw new RangeError("store: job_run summary must be at most 200 printable ASCII characters");
  return {
    job: row.job,
    last_run_at: canonical(row.last_run_at, "last_run_at"),
    exit: intIn(row.exit, 0, 255, "exit"),
    summary: row.summary,
  };
}

export function jobRunRepository({ db, writes }: RepoDeps): JobRunRepository {
  return {
    async record(row) {
      const r = checkJobRun(row);
      await writes.required("job_run", () => {
        db.prepare(
          "INSERT OR REPLACE INTO job_run (job, last_run_at, exit, summary) VALUES (?, ?, ?, ?)",
        ).run(r.job, r.last_run_at, r.exit, r.summary);
      });
    },
    list() {
      return db
        .prepare("SELECT job, last_run_at, exit, summary FROM job_run ORDER BY job")
        .all() as unknown as JobRunRow[];
    },
  };
}

/** Validates a season_check row and returns it with a canonical instant. */
export function checkSeasonCheck(row: SeasonCheckRow): SeasonCheckRow {
  if (typeof row.source !== "string" || !isDatasetSourceId(row.source))
    throw new RangeError("store: unknown dataset source");
  if (!CHECK_STATUSES.has(row.status)) throw new RangeError("store: unknown season check status");
  return {
    source: row.source,
    season: intIn(row.season, SEASON_MIN, SEASON_MAX, "season"),
    checked_at: canonical(row.checked_at, "checked_at"),
    status: row.status,
  };
}

/** season_check, plus the prune `ff prune` runs. */
export interface SeasonCheckStore extends SeasonCheckRepository {
  /** Deletes checks made before `before`; resolves to the rows removed. */
  prune(before: string): Promise<number>;
}

export function seasonCheckRepository({ db, writes }: RepoDeps): SeasonCheckStore {
  const SELECT = "SELECT source, season, checked_at, status FROM season_check";
  return {
    async record(row) {
      const r = checkSeasonCheck(row);
      await writes.required("season_check", () => {
        db.prepare(
          "INSERT OR REPLACE INTO season_check (source, season, checked_at, status) VALUES (?, ?, ?, ?)",
        ).run(r.source, r.season, r.checked_at, r.status);
      });
    },
    latest(source: DatasetSourceId, season: number) {
      if (!isDatasetSourceId(source)) throw new RangeError("store: unknown dataset source");
      intIn(season, SEASON_MIN, SEASON_MAX, "season");
      const r = db.prepare(`${SELECT} WHERE source = ? AND season = ?`).get(source, season) as
        SeasonCheckRow | undefined;
      return r ?? null;
    },
    all() {
      return (
        db.prepare(`${SELECT} ORDER BY source, season`).all() as unknown as SeasonCheckRow[]
      ).filter((r) => isDatasetSourceId(r.source));
    },
    async prune(before) {
      const cut = canonical(before, "before");
      return writes.required("season_check", () =>
        Number(db.prepare("DELETE FROM season_check WHERE checked_at < ?").run(cut).changes),
      );
    },
  };
}

/** Validates a provider_backoff row and returns it with canonical instants. */
export function checkBackoff(row: ProviderBackoffRow): ProviderBackoffRow {
  if (!BACKOFF_PROVIDERS.includes(row.provider))
    throw new RangeError("store: unknown backoff provider");
  if (!BACKOFF_REASONS.has(row.reason)) throw new RangeError("store: unknown backoff reason");
  return {
    provider: row.provider,
    until_at: canonical(row.until_at, "until_at"),
    reason: row.reason,
    set_at: canonical(row.set_at, "set_at"),
  };
}

/** provider_backoff, plus the prune `ff prune` runs. */
export interface ProviderBackoffStore extends ProviderBackoffRepository {
  /** Deletes pauses that ended before `now`; resolves to the rows removed. */
  prune(now: string): Promise<number>;
}

export function providerBackoffRepository({ db, writes }: RepoDeps): ProviderBackoffStore {
  return {
    async set(row) {
      const r = checkBackoff(row);
      await writes.required("provider_backoff", () => {
        db.prepare(
          "INSERT OR REPLACE INTO provider_backoff (provider, until_at, reason, set_at) VALUES (?, ?, ?, ?)",
        ).run(r.provider, r.until_at, r.reason, r.set_at);
      });
    },
    get(provider) {
      if (!BACKOFF_PROVIDERS.includes(provider))
        throw new RangeError("store: unknown backoff provider");
      const r = db
        .prepare(
          "SELECT provider, until_at, reason, set_at FROM provider_backoff WHERE provider = ?",
        )
        .get(provider) as ProviderBackoffRow | undefined;
      return r ?? null;
    },
    async clear(provider) {
      if (!BACKOFF_PROVIDERS.includes(provider))
        throw new RangeError("store: unknown backoff provider");
      await writes.required("provider_backoff", () => {
        db.prepare("DELETE FROM provider_backoff WHERE provider = ?").run(provider);
      });
    },
    async prune(now) {
      const cut = canonical(now, "now");
      return writes.required("provider_backoff", () =>
        Number(db.prepare("DELETE FROM provider_backoff WHERE until_at < ?").run(cut).changes),
      );
    },
  };
}
