// types.ts — the store contract (plan 01 §5.1 one store file + immutable per-source dataset files
// attached read-only, §5.3 best-effort vs required writes with STORE_BUSY, §5.5 publish-by-rename
// and DETACH/ATTACH re-attach, §8.2 migration-001 table list; plan 03 L7 consistent backups, L9
// bounded lock waits, §1.2 the stdio loop never blocked > one statement / 100 ms; plan 05 §2
// `store`). The store implements the domain's repository ports; the domain never imports this file
// (plan 01 §1.1). Only implementation-side items live here; the ports tools read are in src/domain.
import type { Clock } from "../domain/clock.js";
import type {
  AttachedDataset,
  BestEffortOutcome,
  DatasetReaders,
  ProjectionRepository,
  RefreshLogRepository,
  StoreStats,
  WriteJournalRepository,
} from "../domain/analytics/types.js";
import type { DatasetSourceId } from "../config/freshness.js";
import type { CrosswalkRepository, RosterWeeklyReader } from "../domain/crosswalk/types.js";
import type {
  FaPoolSnapshotRepository,
  IsoInstant,
  LeagueSettingsRepository,
  RosterSnapshotRepository,
  ScoreboardSnapshotRepository,
  TransactionsSeenRepository,
  Week,
} from "../domain/league/types.js";
import type { RecommendationLogRepository } from "../domain/reclog/types.js";

export type {
  AttachedDataset,
  BestEffortOutcome,
  JournalStatus,
  RefreshLogRepository,
  RefreshLogRow,
  StoreStats,
  WriteJournalRepository,
} from "../domain/analytics/types.js";
export type {
  FaPoolSnapshot,
  FaPoolSnapshotRepository,
  LeagueSettingsRepository,
  LeagueSettingsRow,
  RosterSnapshot,
  RosterSnapshotRepository,
  ScoreboardSnapshot,
  ScoreboardSnapshotRepository,
  SettingsFlag,
  TransactionsSeenRepository,
} from "../domain/league/types.js";

// --- lock and write policy (plan 01 §5.3; plan 03 L9) -------------------------------------------------

/** SQLite `busy_timeout` on the server connection: every ms of wait blocks the stdio loop. */
export const BUSY_TIMEOUT_MS = 100;
/** Total retry budget for a REQUIRED write before STORE_BUSY (spent in yielding 100 ms steps). */
export const REQUIRED_WRITE_BUDGET_MS = 1000;
/** Upper bound for a DETACH/ATTACH re-attach on the fixture sizes (plan 05 §2 `store`). */
export const REATTACH_BUDGET_MS = 50;

/** The two classes of server write (plan 01 §5.3, round 1 OBJ-11). */
export type WriteClass = "best_effort" | "required";

/**
 * A REQUIRED write (write_journal, recommendation_log, crosswalk, league_settings, refresh_log,
 * snapshots) could not take the write lock within `REQUIRED_WRITE_BUDGET_MS`. Carries
 * `ffCode = "STORE_BUSY"`, which src/mcp/errors.ts maps to the STORE_BUSY tool error.
 */
export class StoreBusyError extends Error {
  /** Error-contract code (plan 01 §4.3). */
  readonly ffCode = "STORE_BUSY" as const;
  /** The table family that could not be written. */
  readonly table: StoreTable;
  /** How long the writer retried, in ms. */
  readonly waitedMs: number;
  constructor(table: StoreTable, waitedMs: number) {
    super(`store busy: could not write ${table} within ${String(waitedMs)} ms`);
    this.name = "StoreBusyError";
    this.table = table;
    this.waitedMs = waitedMs;
  }
}

/** The store file was written by a newer binary; startup exits 1 (plan 03 §1.1 step 3, L7). */
export class StoreVersionError extends Error {
  /** Error-contract code: not the user's fault, not retryable. */
  readonly ffCode = "INTERNAL" as const;
  /** CLI exit code (plan 03 §1.3). */
  readonly exitCode = 1 as const;
  readonly storeVersion: number;
  readonly binaryVersion: number;
  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `store schema version ${String(storeVersion)} is newer than this binary (${String(binaryVersion)}); upgrade the server`,
    );
    this.name = "StoreVersionError";
    this.storeVersion = storeVersion;
    this.binaryVersion = binaryVersion;
  }
}

/**
 * The store file is older than the binary but the caller opened it with `migrate: false` (e.g. a
 * read-only diagnostic): nothing is changed; run the server (or `ff doctor --fix`) to migrate.
 * Added by the store build (additive).
 */
export class StoreMigrationPendingError extends Error {
  readonly ffCode = "INTERNAL" as const;
  readonly exitCode = 1 as const;
  readonly storeVersion: number;
  readonly binaryVersion: number;
  constructor(storeVersion: number, binaryVersion: number) {
    super(
      `store schema version ${String(storeVersion)} is older than this binary (${String(binaryVersion)}) and migrations were not requested`,
    );
    this.name = "StoreMigrationPendingError";
    this.storeVersion = storeVersion;
    this.binaryVersion = binaryVersion;
  }
}

// --- tables (plan 01 §8.2) -----------------------------------------------------------------------------

/**
 * The store tables migration 001 creates (plan 01 §8.2, T12). The `ds_*` dataset tables are NOT
 * here: since round 2 (OBJ-27) they live in per-source dataset files, never in store.sqlite.
 * `recommendation_outcome` (critic C-02b) holds the retrospective's scored outcome per log row so
 * the log row itself stays immutable.
 */
export const MIGRATION_001_TABLES = [
  "schema_version",
  "yahoo_cache",
  "league_settings",
  "crosswalk",
  "write_journal",
  "recommendation_log",
  "recommendation_outcome",
  "projection",
  "points_cache",
  "refresh_log",
  "job_lock",
  "limiter_state",
  "roster_snapshot",
  "scoreboard_snapshot",
  "fa_pool_snapshot",
  "transactions_seen",
] as const;
/** A store table. */
export type StoreTable = (typeof MIGRATION_001_TABLES)[number];

/**
 * Never pruned (plan 01 §5.1 T5; plan 10 T12 adds `projection` — the retrospective's pre-game
 * distributions): the migration comments each CREATE TABLE saying so.
 */
export const NEVER_PRUNED_TABLES: readonly StoreTable[] = [
  "recommendation_log",
  "recommendation_outcome",
  "league_settings",
  "write_journal",
  "projection",
];
/** Prunable caches (plan 06 §1.2 `store prune`); `ds_news` rows and old backups are pruned too. */
export const PRUNABLE_TABLES: readonly StoreTable[] = ["yahoo_cache", "points_cache"];
/**
 * Which write class each table family belongs to (plan 01 §5.3). `projection` stays best-effort
 * (append-only; a busy lock during `ff refresh` must not fail E1/E2 — the retrospective counts only
 * persisted rows; decision recorded for critic C-03b).
 */
export const WRITE_CLASS: Readonly<Record<Exclude<StoreTable, "schema_version">, WriteClass>> =
  Object.freeze({
    yahoo_cache: "best_effort",
    points_cache: "best_effort",
    limiter_state: "best_effort",
    projection: "best_effort",
    league_settings: "required",
    crosswalk: "required",
    write_journal: "required",
    recommendation_log: "required",
    recommendation_outcome: "required",
    refresh_log: "required",
    job_lock: "required",
    roster_snapshot: "required",
    scoreboard_snapshot: "required",
    fa_pool_snapshot: "required",
    transactions_seen: "required",
  });

// --- dataset files (plan 01 §5.5, round 2 OBJ-27) ---------------------------------------------------------

/**
 * SQLite's attached-database limit as bundled in node:sqlite (verified on Node 24.21: the 11th
 * ATTACH fails "too many attached databases - max 10"; critic C-15b).
 */
export const MAX_ATTACHED = 10;
/** Attach slots kept free (e.g. for `VACUUM INTO`/backup or a re-attach swap). */
export const RESERVED_ATTACH_SLOTS = 1;

/** SQLite column affinity for a dataset column. */
export type DatasetColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

/** One dataset column. */
export interface DatasetColumn {
  readonly name: string;
  readonly type: DatasetColumnType;
  readonly nullable: boolean;
}

/**
 * One `ds_*` table a source publishes into its dataset file. A per-season source's tables carry a
 * `season` column in `primary_key` (critic C-06b: one file holds every season the source keeps).
 */
export interface DatasetTableSpec {
  /** Must start with `ds_`. */
  readonly name: `ds_${string}`;
  readonly columns: readonly DatasetColumn[];
  readonly primary_key: readonly string[] | null;
  readonly indexes: readonly (readonly string[])[];
}

/** One row to insert (column → value). */
export type DatasetRow = Readonly<Record<string, string | number | null | Uint8Array>>;

/**
 * The fresh staging dataset file a source fills (`journal_mode=DELETE`, no -wal). Only `ff refresh`
 * ever holds one; the server never writes a dataset.
 */
export interface DatasetWriter {
  /** Absolute path of the staging file `<cache>/ds/<stem>.<version>.<rand>.tmp`. */
  readonly path: string;
  createTable(spec: DatasetTableSpec): void;
  /** Inserts rows (in one transaction per call); returns the count inserted. */
  insert(table: string, rows: readonly DatasetRow[]): number;
}

/** What a source reports after filling its staging file. */
export interface PublishStats {
  readonly rows: number;
  readonly tables: readonly { readonly name: string; readonly rows: number }[];
  /** The seasons the file holds (recorded in refresh_log). */
  readonly seasons: readonly number[];
  /** sha256 of the sorted column list — the schema fingerprint recorded in refresh_log. */
  readonly columns_hash: string;
}

/** Options of `DatasetPublisher.publish` (additive; omitted = always publish). */
export interface PublishOptions {
  /**
   * Under the job lock, when the current refresh_log row already carries `version` and its file
   * exists, publish nothing: advance `checked_at` and return `{ ok: false, error:
   * PUBLISH_ALREADY_CURRENT }`. Set for release-versioned sources unless `--force`.
   */
  readonly skipIfCurrent?: boolean;
}

/** The `PublishOutcome` error when `skipIfCurrent` found the version already published. */
export const PUBLISH_ALREADY_CURRENT = "already_current";

/**
 * The `PublishOutcome` error when the new file WAS made live (renamed over the previous one) but its
 * refresh_log row could not be written — a failure after the commit point (QA-1-032). The previous
 * file is NOT intact; the next publish of the source records the live file before anything else.
 */
export const PUBLISH_UNRECORDED = "published_unrecorded";

/** The result of publishing a dataset file. */
export type PublishOutcome =
  | {
      readonly ok: true;
      readonly file: string;
      readonly file_version: string;
      readonly stats: PublishStats;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Publishes a dataset atomically (implemented once, used by every source via `ff refresh`; obtained
 * from `StoreFactory.openPublisher` — critic C-07b). `publish` takes the source's `job_lock`, creates
 * the staging file, lets `fill` write it, `fsync`s, `rename()`s over `<cache>/ds/<stem>.sqlite`,
 * fsyncs the directory, then records refresh_log with `checked_at = finished` — the rename and the
 * row are ONE commit: the store's writer lock is taken first (waiting up to
 * PUBLISH_COMMIT_BUDGET_MS, plan 05 §4.1's 3-s lock row), then the file is renamed and the row
 * inserted under it (QA-1-032). Any failure before the rename deletes the staging file and leaves the
 * previous dataset file untouched (plan 05 §2 `sources/*`); a failure after it returns
 * PUBLISH_UNRECORDED, and the next publish of that source records the live file first (it also
 * repairs a crash between the rename and the commit). `recordUnchanged` is the skip path: the release version equals the attached one, so
 * no file is written and only refresh_log `checked_at` advances (the "release" age basis).
 * `options.skipIfCurrent` re-makes that check UNDER the job lock (single-flight, plan 01 §5.7): a
 * refresh that checked "unchanged" before another refresh published the same release and released
 * the lock would otherwise publish it a second time — it returns `PUBLISH_ALREADY_CURRENT` instead,
 * having advanced `checked_at`, without calling `fill`.
 */
export interface DatasetPublisher {
  publish(
    sourceId: DatasetSourceId,
    version: string,
    releaseUpdatedAt: IsoInstant | null,
    fill: (writer: DatasetWriter) => Promise<PublishStats>,
    options?: PublishOptions,
  ): Promise<PublishOutcome>;
  recordUnchanged(sourceId: DatasetSourceId, version: string, checkedAt: IsoInstant): Promise<void>;
  /** Releases the publisher's connection; idempotent. */
  close(): void;
}

/** What a re-attach pass did. */
export interface ReattachReport {
  readonly reattached: readonly DatasetSourceId[];
  readonly unchanged: readonly DatasetSourceId[];
  /** Sources refresh_log lists as current whose file is missing (→ STALE_ONLY with a refresh hint). */
  readonly missing: readonly DatasetSourceId[];
  /** Sources detached to free a slot (LRU) because more are current than MAX_ATTACHED allows. */
  readonly detached: readonly DatasetSourceId[];
  readonly elapsed_ms: number;
}

// --- repositories (one per table family) -------------------------------------------------------------------
//
// The port interfaces tools read (refresh log, league settings + flags, snapshots, transactions,
// write journal, store stats) live in src/domain (league/types.ts, analytics/types.ts) so src/mcp can
// type against them (critic C-10b); they are re-exported above. Required writes return a Promise
// (critic C-04b): the store retries in BUSY_TIMEOUT_MS steps, YIELDING to the event loop between
// attempts (setTimeout), for at most REQUIRED_WRITE_BUDGET_MS, then rejects with StoreBusyError — so
// no single wait blocks the stdio loop longer than one statement or 100 ms (plan 03 §1.2).

/** points_cache (best-effort): league-scored points memo keyed by settings hash + player-week. */
export interface PointsCacheRepository {
  get(settingsHash: string, gsisId: string, season: number, week: Week): number | null;
  put(
    settingsHash: string,
    gsisId: string,
    season: number,
    week: Week,
    points: number,
  ): BestEffortOutcome;
}

/** One platform-response cache entry (`yahoo_cache`; Phase 1b — plan 01 §5.3). */
export interface PlatformCacheEntry {
  /** Canonical request path. */
  readonly key: string;
  readonly body: string;
  readonly parsed_json: string | null;
  readonly fetched_at: IsoInstant;
  readonly refresh_rate_s: number | null;
  readonly http_status: number;
}

/** yahoo_cache (best-effort). */
export interface PlatformCacheRepository {
  get(key: string): PlatformCacheEntry | null;
  put(entry: PlatformCacheEntry): BestEffortOutcome;
  /** Deletes entries fetched before `before`; returns rows removed. */
  prune(before: IsoInstant): number;
}

/** limiter_state (best-effort): the last-999 timestamp shared across processes (plan 01 §6, A-11). */
export interface LimiterStateRepository {
  last999(clientKey: string): IsoInstant | null;
  setLast999(clientKey: string, at: IsoInstant): BestEffortOutcome;
}

/** job_lock (required): single-flight for refresh jobs across processes. */
export interface JobLockRepository {
  /** Resolves true when acquired; a lock older than `staleAfterMs` or owned by a dead pid is broken. */
  acquire(job: string, pid: number, now: IsoInstant, staleAfterMs: number): Promise<boolean>;
  release(job: string, pid: number): Promise<void>;
}

/** Every repository the store serves, by table family. */
export interface StoreRepositories {
  readonly recommendationLog: RecommendationLogRepository;
  readonly crosswalk: CrosswalkRepository;
  readonly projections: ProjectionRepository;
  readonly leagueSettings: LeagueSettingsRepository;
  readonly pointsCache: PointsCacheRepository;
  readonly platformCache: PlatformCacheRepository;
  readonly refreshLog: RefreshLogRepository;
  readonly jobLock: JobLockRepository;
  readonly limiterState: LimiterStateRepository;
  readonly writeJournal: WriteJournalRepository;
  readonly rosterSnapshots: RosterSnapshotRepository;
  readonly scoreboardSnapshots: ScoreboardSnapshotRepository;
  readonly faPoolSnapshots: FaPoolSnapshotRepository;
  readonly transactionsSeen: TransactionsSeenRepository;
}

// --- the store -------------------------------------------------------------------------------------------------

/** How to open the store. */
export interface StoreOpenOptions {
  /** Absolute path of store.sqlite. */
  readonly path: string;
  /** Absolute `<cache>/ds/` directory. */
  readonly datasetDir: string;
  /** Absolute `<cache>/backups/` directory (pre-migration backups). */
  readonly backupDir: string;
  readonly clock: Clock;
  /** Run pending migrations (under an exclusive transaction, after a consistent backup). */
  readonly migrate: boolean;
  /**
   * Which weather dataset `WeatherReader.forGames` consults first (FF_WEATHER_SOURCE; the other
   * fills game ids the first lacks). Default `weather:open_meteo`. Added by the store build.
   */
  readonly weatherSource?: "weather:open_meteo" | "weather:nws";
  /**
   * Receives fixed-vocabulary warning codes (`dataset_row_skipped_team`, `dataset_unreadable`, …)
   * so the caller can log them; the store itself never logs. Added by the store build.
   */
  readonly onWarning?: (code: string) => void;
}

/** A consistent backup (plan 03 L7: `sqlite.backup()` or `VACUUM INTO`, never a file copy). */
export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly taken_at: IsoInstant;
  readonly method: "backup_api" | "vacuum_into";
}

/** An open store (one `DatabaseSync` connection, WAL, busy_timeout 100 ms). */
export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  readonly repos: StoreRepositories;
  /** The domain's read-only dataset ports, over the attached files. */
  readonly datasets: DatasetReaders;
  /** The crosswalk's roster port, over the attached `nflverse:roster_weekly` file. */
  readonly rosterWeekly: RosterWeeklyReader;
  /** Currently attached dataset files (≤ MAX_ATTACHED − RESERVED_ATTACH_SLOTS). */
  attachments(): readonly AttachedDataset[];
  /**
   * Compares refresh_log / inode+mtime with what is attached and DETACH/ATTACHes what changed. When
   * more sources are current than there are slots, datasets attach ON DEMAND at first read and the
   * least recently used one is detached (critic C-15b) — a reader never fails for want of a slot.
   */
  reattachIfChanged(): ReattachReport;
  /** A consistent backup to `destPath` (under the process-wide lock). */
  backup(destPath: string): Promise<BackupResult>;
  stats(): StoreStats;
  /** Checkpoints WAL and closes; idempotent. */
  close(): void;
}

/** Options for the refresh process's publisher. */
export interface PublisherOpenOptions {
  /** Absolute path of store.sqlite (refresh_log and job_lock live there). */
  readonly storePath: string;
  /** Absolute `<cache>/ds/` directory the staging and published files live in. */
  readonly datasetDir: string;
  readonly clock: Clock;
}

/** Opens stores and publishers (the one place that touches `node:sqlite`). */
export interface StoreFactory {
  open(opts: StoreOpenOptions): Store;
  /** The refresh-process role (`ff refresh`): a DatasetPublisher; the server never opens one. */
  openPublisher(opts: PublisherOpenOptions): DatasetPublisher;
}
