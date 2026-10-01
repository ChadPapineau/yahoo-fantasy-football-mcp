// source.ts — the DataSource contract (plan 01 §8, AMENDED by round 2 OBJ-27 / plan 01 §5.5): a
// source never loads rows into store.sqlite. `ff refresh` asks it for the release `version()`,
// `fetch`es the release into a temp file, `assertSchema`s it (expected columns AND parquet codec —
// plan 01 D7, OBJ-20), then `publish`es it into a FRESH per-source dataset file through a
// DatasetWriter; the DatasetPublisher fsyncs and atomically renames it, and the server ATTACHes it
// read-only. License + attribution are fields, not decoration (research 04 §G.3).
// Contract revision: a run covers a LIST of seasons, one TempFile per season, all published into one
// dataset file whose tables key on `season` (plan 10 §3.2 "two prior seasons"; critic C-06b); the
// context carries the Clock, the target week and read access to schedules (weather is driven by the
// coming week's outdoor games; critic C-05b); `version()` returns `{version, released_at}` and a
// source declares whether it is release-versioned or time-bucketed (weather) so the runner never
// skips a weather run as "unchanged"; HttpGet follows redirects itself, re-checking every hop
// against the host allow-list, and reports `final_url` (critic C-16b).
import type {
  Attribution,
  DatasetSourceId,
  FreshnessClassId,
  License,
} from "../config/freshness.js";
import type { ScheduleReader } from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type { IsoInstant, Week } from "../domain/league/types.js";
import type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

export type { Attribution, DatasetSourceId, License } from "../config/freshness.js";
export type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

/** A downloaded release file in the cache's temp area; deleted by the runner after publish. */
export interface TempFile {
  /** Absolute path. */
  readonly path: string;
  /** Size in bytes once fetched. */
  readonly bytes: number;
  /** The season the file holds; null for a season-less source (weather buckets, id maps). */
  readonly season: number | null;
}

/** Per-source politeness limits (plan 01 §6 "per-source limiters"). */
export interface RateLimit {
  /** Minimum interval between two requests to this source. */
  readonly minIntervalMs: number;
  /** Daily request cap, or null. */
  readonly maxPerDay: number | null;
}

/** Most redirect hops HttpGet follows (each re-checked against the host allow-list). */
export const MAX_REDIRECT_HOPS = 3;

/**
 * A bounded HTTP GET the runner injects (implemented over src/http with its host allow-list, plan
 * 02 §7). Redirects are followed MANUALLY (`redirect: "manual"`), at most MAX_REDIRECT_HOPS, and every
 * hop's host is re-checked against the allow-list before it is requested — a redirect off the list
 * fails the call. GitHub release downloads 302 to `release-assets.githubusercontent.com` (verified
 * 2026-09-30), which the allow-list must include (plan deviation recorded; owned by src/http).
 */
export type HttpGet = (
  url: string,
  opts: { readonly signal: AbortSignal; readonly maxBytes: number; readonly accept?: string },
) => Promise<{
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  /** The URL actually served after redirects (tests assert the hop host). */
  readonly final_url: string;
}>;

/**
 * A bounded HTTP GET that STREAMS the body to a new file at `dest` (created exclusively, mode 0600)
 * instead of returning it — the release-download path (plan 01 §5.5 "downloads to a temp file").
 * Same allow-list, redirect, timeout, size and error rules as HttpGet; on any failure the partial
 * file is removed. Additive (src/http): a source uses `ctx.download` when present.
 */
export type HttpDownload = (
  url: string,
  opts: {
    readonly signal: AbortSignal;
    readonly maxBytes: number;
    readonly dest: string;
    readonly accept?: string;
  },
) => Promise<{
  readonly status: number;
  /** Bytes written to `dest` (after any content decoding). */
  readonly bytes: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly final_url: string;
  /** Equals `dest`. */
  readonly path: string;
}>;

/**
 * When a job runs (plan 06 §2 "Season awareness"): `always` (nflverse — schedules must load even
 * off-season), or `in_season` (weather: outside the season — no game within ±7 days, or schedules
 * never loaded — the runner exits with a skip outcome before any network call).
 */
export type SeasonGate = "always" | "in_season";

/** What the runner gives a source for one run. */
export interface SourceContext {
  readonly http: HttpGet;
  /** Cancels the run (timeouts, shutdown). */
  readonly signal: AbortSignal;
  /** The injected clock (hour buckets, `as_of` stamps; never Date.now()). */
  readonly clock: Clock;
  /** The seasons this run covers, newest last (e.g. two prior seasons + the current one). */
  readonly seasons: readonly number[];
  /** The week the run targets (weather: the coming week); null for season-wide sources. */
  readonly week: Week | null;
  /** Read access to already-published datasets a source is driven by (weather ← schedules). */
  readonly datasets: { readonly schedules: ScheduleReader };
  /**
   * The run's private temp directory (created by the runner, removed by it on EVERY path — a
   * source writes its TempFiles here). Additive; set by src/sources/runner.ts.
   */
  readonly tempDir?: string;
  /** Streaming download to a file (src/http); additive, set by the runner when it has one. */
  readonly download?: HttpDownload;
  /**
   * Reports that `season`'s data is not published upstream YET (a new season before its first
   * data: the release answers 404 — plan 06 §2; QA-1-033). The source leaves that season out of
   * its TempFiles; the runner publishes the rest under `versionForSeasons`, warning, or skips the
   * run when no season is left. Additive, set by the runner.
   */
  readonly notPublished?: (season: number) => void;
}

/**
 * How a source versions its data: `release` (nflverse `timestamp.txt`, `updated_at`, an etag — an
 * unchanged version is skipped via `DatasetPublisher.recordUnchanged`) or `time_bucket` (weather:
 * the version is the hour bucket, so every run in a new bucket fetches, and the runner never treats
 * a bucket as "unchanged → skip" across buckets).
 */
export type Versioning = "release" | "time_bucket";

/** A source's current version. */
export interface ReleaseVersion {
  /** Opaque version string (release timestamp, etag, or `YYYY-MM-DDTHH` bucket). */
  readonly version: string;
  /** When upstream released it; null when the source does not say (time buckets). */
  readonly released_at: IsoInstant | null;
}

/** A parquet column chunk's codec as found in the file. */
export interface ColumnCodec {
  readonly column: string;
  readonly codec: string;
}

/**
 * The schema + codec assertion result (plan 01 §5.5; plan 05 §2 `sources/*`): a missing/renamed
 * column or a codec other than SNAPPY/UNCOMPRESSED fails, naming the column; extra columns warn.
 */
export interface SchemaReport {
  readonly ok: boolean;
  readonly missing_columns: readonly string[];
  readonly extra_columns: readonly string[];
  readonly bad_codecs: readonly ColumnCodec[];
  readonly rows: number;
  readonly warnings: readonly string[];
}

/** The codecs hyparquet reads natively (plan 01 D7): anything else fails the assertion. */
export const ALLOWED_PARQUET_CODECS: readonly string[] = ["SNAPPY", "UNCOMPRESSED"];

/** One external dataset (plan 01 §8 as amended by OBJ-27). */
export interface DataSource {
  /** `<provider>:<dataset>`, e.g. `nflverse:stats_player_week`. */
  readonly id: DatasetSourceId;
  readonly license: License;
  readonly attribution: Attribution;
  /** The freshness class its rows are judged by (src/config/freshness.ts). */
  readonly freshness: FreshnessClassId;
  readonly limiter: RateLimit;
  /** Release-versioned or hour-bucketed. */
  readonly versioning: Versioning;
  /** Whether the job runs off-season (default `always`); additive (plan 06 §2). */
  readonly seasonGate?: SeasonGate;
  /** The `ds_*` tables it publishes into its dataset file (per-season tables key on `season`). */
  readonly tables: readonly DatasetTableSpec[];
  /** The current version; null when upstream is unreachable (the run fails, nothing is written). */
  version(ctx: SourceContext): Promise<ReleaseVersion | null>;
  /**
   * Downloads `version` for every season in `ctx.seasons` into the runner's temp area: one TempFile
   * per season (or one for a season-less source), in `ctx.seasons` order.
   */
  fetch(version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]>;
  /** Asserts expected columns and codecs of every file before anything is written. */
  assertSchema(files: readonly TempFile[]): Promise<SchemaReport>;
  /** Writes every season's rows into the fresh staging dataset file; never touches store.sqlite. */
  publish(files: readonly TempFile[], into: DatasetWriter): Promise<PublishStats>;
  /**
   * The version of `version`'s release restricted to `seasons` — used when `fetch` reported a
   * season as not published, so the published file's version names only the seasons it holds and
   * a later run (that season now out) is never skipped as "unchanged". Optional (QA-1-033).
   */
  versionForSeasons?(version: ReleaseVersion, seasons: readonly number[]): ReleaseVersion;
}
