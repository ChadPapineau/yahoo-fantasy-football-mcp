// types.ts — the store contract (plan 01 §5.1 one store file + immutable per-source dataset files
// attached read-only, §5.3 best-effort vs required writes with STORE_BUSY, §5.5 publish-by-rename
// and DETACH/ATTACH re-attach, §8.2 migration-001 table list; plan 03 L7 consistent backups, L9
// bounded lock waits; plan 05 §2 `store`). The store implements the domain's repository ports; the
// domain never imports this file (plan 01 §1.1).
import type { Clock } from "../domain/clock.js";
import type { DatasetReaders, ProjectionRepository } from "../domain/analytics/types.js";
import type { CrosswalkRepository, RosterWeeklyReader } from "../domain/crosswalk/types.js";
import type {
  IsoInstant,
  LeagueRules,
  PlatformPlayer,
  Roster,
  RosterSlots,
  Transaction,
  Week,
} from "../domain/league/types.js";
import type { RecommendationLogRepository } from "../domain/reclog/types.js";
import type { ScoringSettings } from "../domain/scoring/types.js";

// --- lock and write policy (plan 01 §5.3; plan 03 L9) -------------------------------------------------

/** SQLite `busy_timeout` on the server connection: every ms of wait blocks the stdio loop. */
export const BUSY_TIMEOUT_MS = 100;
/** Total retry budget for a REQUIRED write before STORE_BUSY. */
export const REQUIRED_WRITE_BUDGET_MS = 1000;
/** Upper bound for a DETACH/ATTACH re-attach on the fixture sizes (plan 05 §2 `store`). */
export const REATTACH_BUDGET_MS = 50;

/** The two classes of server write (plan 01 §5.3, round 1 OBJ-11). */
export type WriteClass = "best_effort" | "required";

/** A best-effort (cache) write's outcome: a lock timeout is a counted miss, never an error. */
export type BestEffortOutcome =
  { readonly written: true } | { readonly written: false; readonly reason: "busy" };

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

// --- tables (plan 01 §8.2) -----------------------------------------------------------------------------

/**
 * The store tables migration 001 creates (plan 01 §8.2, T12). The `ds_*` dataset tables are NOT
 * here: since round 2 (OBJ-27) they live in per-source dataset files, never in store.sqlite.
 */
export const MIGRATION_001_TABLES = [
  "schema_version",
  "yahoo_cache",
  "league_settings",
  "crosswalk",
  "write_journal",
  "recommendation_log",
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

/** Never pruned (plan 01 §5.1 T5): the migration comments each CREATE TABLE saying so. */
export const NEVER_PRUNED_TABLES: readonly StoreTable[] = [
  "recommendation_log",
  "league_settings",
  "write_journal",
];
/** Prunable caches (plan 06 §1.2 `store prune`); `ds_news` rows and old backups are pruned too. */
export const PRUNABLE_TABLES: readonly StoreTable[] = ["yahoo_cache", "points_cache"];
/** Which write class each table family belongs to (plan 01 §5.3). */
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
    refresh_log: "required",
    job_lock: "required",
    roster_snapshot: "required",
    scoreboard_snapshot: "required",
    fa_pool_snapshot: "required",
    transactions_seen: "required",
  });

// --- dataset files (plan 01 §5.5, round 2 OBJ-27) ---------------------------------------------------------

/** SQLite column affinity for a dataset column. */
export type DatasetColumnType = "TEXT" | "INTEGER" | "REAL" | "BLOB";

/** One dataset column. */
export interface DatasetColumn {
  readonly name: string;
  readonly type: DatasetColumnType;
  readonly nullable: boolean;
}

/** One `ds_*` table a source publishes into its dataset file. */
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
  /** sha256 of the sorted column list — the schema fingerprint recorded in refresh_log. */
  readonly columns_hash: string;
}

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
 * Publishes a dataset atomically (implemented once, used by every source via `ff refresh`): create
 * the staging file, let `fill` write it, `fsync`, `rename()` over `<cache>/ds/<stem>.sqlite`,
 * fsync the directory, then record refresh_log (a required write). Any failure deletes the staging
 * file and leaves the previous dataset file untouched (plan 05 §2 `sources/*`).
 */
export interface DatasetPublisher {
  publish(
    sourceId: string,
    version: string,
    releaseUpdatedAt: IsoInstant | null,
    fill: (writer: DatasetWriter) => Promise<PublishStats>,
  ): Promise<PublishOutcome>;
}

/** One dataset file currently ATTACHed read-only on the server connection. */
export interface AttachedDataset {
  readonly source: string;
  /** SQLite schema name (`ds_nflverse__stats_player_week`). */
  readonly schema: string;
  readonly file: string;
  readonly file_version: string;
  /** Identity of the attached inode, for the cheap `stat` change check. */
  readonly inode: number;
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly attached_at: IsoInstant;
}

/** What a re-attach pass did. */
export interface ReattachReport {
  readonly reattached: readonly string[];
  readonly unchanged: readonly string[];
  /** Sources refresh_log lists as current whose file is missing (→ STALE_ONLY with a refresh hint). */
  readonly missing: readonly string[];
  readonly elapsed_ms: number;
}

// --- repositories (one per table family) -------------------------------------------------------------------

/** One refresh_log row (plan 01 §5.5). */
export interface RefreshLogRow {
  readonly source: string;
  readonly file: string | null;
  readonly file_version: string | null;
  readonly release_updated_at: IsoInstant | null;
  readonly rows: number | null;
  readonly columns_hash: string | null;
  readonly started_at: IsoInstant;
  readonly finished_at: IsoInstant;
  readonly ok: boolean;
  /** Fixed-vocabulary error summary (never an upstream body). */
  readonly error: string | null;
  /** Last time the release version was checked successfully, even when unchanged (the "release" age basis). */
  readonly checked_at: IsoInstant;
}

/** refresh_log (required). */
export interface RefreshLogRepository {
  record(row: RefreshLogRow): void;
  /** The newest successful row per source (what is attached / should be attached). */
  current(): readonly RefreshLogRow[];
  latest(source: string): RefreshLogRow | null;
  /** Consecutive failures since the last success. */
  consecutiveFailures(source: string): number;
}

/** A normalised league-settings snapshot (plan 01 §5.2; referenced by the log, never pruned). */
export interface LeagueSettingsRow {
  readonly league_key: string;
  readonly settings_hash: string;
  readonly scoring: ScoringSettings;
  readonly slots: RosterSlots;
  readonly rules: LeagueRules;
  readonly fetched_at: IsoInstant;
}

/** A settings health flag (plan 03 §5 rows 19–20; plan 08 §6.3). */
export interface SettingsFlag {
  readonly league_key: string;
  readonly kind: "scoring_mismatch" | "scoring_mismatch_league" | "settings_changed";
  readonly detail: readonly string[];
  readonly raised_at: IsoInstant;
  readonly acknowledged: boolean;
}

/** league_settings (required). */
export interface LeagueSettingsRepository {
  put(row: LeagueSettingsRow): void;
  byHash(settingsHash: string): LeagueSettingsRow | null;
  latest(leagueKey: string): LeagueSettingsRow | null;
  raiseFlag(flag: SettingsFlag): void;
  openFlags(leagueKey: string): readonly SettingsFlag[];
}

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
  /** True when acquired; a lock older than `staleAfterMs` or owned by a dead pid is broken. */
  acquire(job: string, pid: number, now: IsoInstant, staleAfterMs: number): boolean;
  release(job: string, pid: number): void;
}

/** Write-journal states (plan 02 §4.5). Phase W — the table exists from migration 001. */
export type JournalStatus =
  | "prepared"
  | "denied"
  | "expired"
  | "voided_precondition"
  | "sent"
  | "applied"
  | "rejected_validation"
  | "rejected_not_provisioned"
  | "sent_unknown"
  | "confirmed_applied"
  | "confirmed_not_applied";

/** write_journal (required; read-only use in this build: counts for `ff status`). */
export interface WriteJournalRepository {
  countByStatus(): Readonly<Partial<Record<JournalStatus, number>>>;
  oldestPendingAgeSeconds(now: IsoInstant): number | null;
}

/** A roster snapshot (plan 06 §1.3; `ff://roster/snapshot`). */
export interface RosterSnapshot {
  readonly team_key: string;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  readonly roster: Roster;
}

/** roster_snapshot (required). */
export interface RosterSnapshotRepository {
  put(s: RosterSnapshot): void;
  /** The newest two snapshots (newest first) for diffs. */
  latestTwo(teamKey: string): readonly RosterSnapshot[];
}

/** A scoreboard snapshot (pre-week platform win probability, for later calibration — tension T11). */
export interface ScoreboardSnapshot {
  readonly league_key: string;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  /** The serialised matchups. */
  readonly matchups_json: string;
}

/** scoreboard_snapshot (required). */
export interface ScoreboardSnapshotRepository {
  put(s: ScoreboardSnapshot): void;
  forWeek(leagueKey: string, week: Week): readonly ScoreboardSnapshot[];
}

/** A free-agent pool snapshot (plan 06 §1.3). */
export interface FaPoolSnapshot {
  readonly league_key: string;
  readonly taken_at: IsoInstant;
  readonly players: readonly PlatformPlayer[];
}

/** fa_pool_snapshot (required). */
export interface FaPoolSnapshotRepository {
  put(s: FaPoolSnapshot): void;
  latestTwo(leagueKey: string): readonly FaPoolSnapshot[];
}

/** transactions_seen (required, append-only): history beyond the platform's "most recent N". */
export interface TransactionsSeenRepository {
  /** Appends unseen transactions (dedup by key); returns how many were new. */
  appendNew(leagueKey: string, txns: readonly Transaction[], seenAt: IsoInstant): number;
  list(leagueKey: string, since: IsoInstant | null, limit: number): readonly Transaction[];
  oldestSeen(leagueKey: string): IsoInstant | null;
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
}

/** A consistent backup (plan 03 L7: `sqlite.backup()` or `VACUUM INTO`, never a file copy). */
export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly taken_at: IsoInstant;
  readonly method: "backup_api" | "vacuum_into";
}

/** Store health for `ff status` / `ff_get_status` (plan 01 §7). */
export interface StoreStats {
  readonly path: string;
  readonly size_bytes: number;
  readonly schema_version: number;
  /** Best-effort writes skipped because the lock was busy, since open. */
  readonly cache_misses_busy: number;
  readonly attached: readonly AttachedDataset[];
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
  /** Currently attached dataset files. */
  attachments(): readonly AttachedDataset[];
  /** Compares refresh_log / inode+mtime with what is attached and DETACH/ATTACHes what changed. */
  reattachIfChanged(): ReattachReport;
  /** A consistent backup to `destPath` (under the process-wide lock). */
  backup(destPath: string): Promise<BackupResult>;
  stats(): StoreStats;
  /** Checkpoints WAL and closes; idempotent. */
  close(): void;
}

/** Opens stores (the one place that touches `node:sqlite`). */
export interface StoreFactory {
  open(opts: StoreOpenOptions): Store;
}
