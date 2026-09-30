// source.ts — the DataSource contract (plan 01 §8, AMENDED by round 2 OBJ-27 / plan 01 §5.5): a
// source never loads rows into store.sqlite. `ff refresh` asks it for the release `version()`,
// `fetch`es the release into a temp file, `assertSchema`s it (expected columns AND parquet codec —
// plan 01 D7, OBJ-20), then `publish`es it into a FRESH per-source dataset file through a
// DatasetWriter; the DatasetPublisher fsyncs and atomically renames it, and the server ATTACHes it
// read-only. License + attribution are fields, not decoration (research 04 §G.3).
import type {
  Attribution,
  DatasetSourceId,
  FreshnessClassId,
  License,
} from "../config/freshness.js";
import type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

export type { Attribution, DatasetSourceId, License } from "../config/freshness.js";
export type { DatasetTableSpec, DatasetWriter, PublishStats } from "../store/types.js";

/** A downloaded release file in the cache's temp area; deleted by the runner after publish. */
export interface TempFile {
  /** Absolute path. */
  readonly path: string;
  /** Size in bytes once fetched. */
  readonly bytes: number;
}

/** Per-source politeness limits (plan 01 §6 "per-source limiters"). */
export interface RateLimit {
  /** Minimum interval between two requests to this source. */
  readonly minIntervalMs: number;
  /** Daily request cap, or null. */
  readonly maxPerDay: number | null;
}

/** A bounded HTTP GET the runner injects (implemented over src/http with its host allow-list). */
export type HttpGet = (
  url: string,
  opts: { readonly signal: AbortSignal; readonly maxBytes: number; readonly accept?: string },
) => Promise<{
  readonly status: number;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}>;

/** What the runner gives a source for one run. */
export interface SourceContext {
  readonly http: HttpGet;
  /** Cancels the run (timeouts, shutdown). */
  readonly signal: AbortSignal;
  /** The season being refreshed. */
  readonly season: number;
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
  /** The `ds_*` tables it publishes into its dataset file. */
  readonly tables: readonly DatasetTableSpec[];
  /** Release version (`timestamp.txt`, `updated_at`, etag); null when unreachable. */
  version(ctx: SourceContext): Promise<string | null>;
  /** Downloads release `version` into `into`. */
  fetch(version: string, into: TempFile, ctx: SourceContext): Promise<void>;
  /** Asserts expected columns and codecs before anything is written. */
  assertSchema(file: TempFile): Promise<SchemaReport>;
  /** Writes every table into the fresh staging dataset file; never touches store.sqlite. */
  publish(file: TempFile, into: DatasetWriter): Promise<PublishStats>;
}
