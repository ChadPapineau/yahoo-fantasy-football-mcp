// helpers.ts — fakes for the refresh runner: a scriptable DataSource, publisher, refresh log and
// schedule reader. Only temp dirs under os.tmpdir() are touched; no network, no ~/.cache.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatasetSourceId } from "../../../src/config/freshness.js";
import { ATTRIBUTIONS } from "../../../src/config/freshness.js";
import type {
  DatasetResult,
  NflGame,
  RefreshLogRow,
  ScheduleReader,
} from "../../../src/domain/analytics/types.js";
import type {
  DataSource,
  ReleaseVersion,
  SchemaReport,
  SourceContext,
  TempFile,
} from "../../../src/sources/source.js";
import type {
  DatasetPublisher,
  DatasetRow,
  DatasetTableSpec,
  DatasetWriter,
  PublishOutcome,
  PublishStats,
} from "../../../src/store/types.js";

export const OK_REPORT: SchemaReport = {
  ok: true,
  missing_columns: [],
  extra_columns: ["new_col"],
  bad_codecs: [],
  rows: 3,
  warnings: ["extra column new_col"],
};

export const STATS: PublishStats = {
  rows: 3,
  tables: [{ name: "ds_test", rows: 3 }],
  seasons: [2026],
  columns_hash: "abc",
};

export interface FakeSourceOpts {
  id?: DatasetSourceId;
  versioning?: "release" | "time_bucket";
  seasonGate?: "always" | "in_season";
  limiter?: { minIntervalMs: number; maxPerDay: number | null };
  version?: (ctx: SourceContext, n: number) => Promise<ReleaseVersion | null>;
  fetch?: (v: ReleaseVersion, ctx: SourceContext, n: number) => Promise<readonly TempFile[]>;
  assertSchema?: (files: readonly TempFile[]) => Promise<SchemaReport>;
  publish?: (files: readonly TempFile[], w: DatasetWriter) => Promise<PublishStats>;
}

export interface FakeSource extends DataSource {
  readonly calls: { version: number; fetch: number; assert: number; publish: number };
  readonly contexts: SourceContext[];
  readonly files: TempFile[];
}

/** A source whose default fetch writes one temp file into ctx.tempDir. */
export function fakeSource(o: FakeSourceOpts = {}): FakeSource {
  const calls = { version: 0, fetch: 0, assert: 0, publish: 0 };
  const contexts: SourceContext[] = [];
  const files: TempFile[] = [];
  const src: FakeSource = {
    id: o.id ?? "nflverse:injuries",
    license: "CC-BY-4.0",
    attribution: ATTRIBUTIONS.nflverse,
    freshness: "nflverse_injuries",
    limiter: o.limiter ?? { minIntervalMs: 0, maxPerDay: null },
    versioning: o.versioning ?? "release",
    ...(o.seasonGate ? { seasonGate: o.seasonGate } : {}),
    tables: [],
    calls,
    contexts,
    files,
    version(ctx) {
      calls.version++;
      contexts.push(ctx);
      return o.version
        ? o.version(ctx, calls.version)
        : Promise.resolve({
            version: "2026-09-30T13:36:27Z",
            released_at: "2026-09-30T13:36:27.000Z",
          });
    },
    async fetch(v, ctx) {
      calls.fetch++;
      contexts.push(ctx);
      if (o.fetch) return o.fetch(v, ctx, calls.fetch);
      const path = join(ctx.tempDir ?? "/nonexistent", "release.parquet");
      await writeFile(path, "PAR1");
      const f = { path, bytes: 4, season: 2026 };
      files.push(f);
      return [f];
    },
    assertSchema(f) {
      calls.assert++;
      return o.assertSchema ? o.assertSchema(f) : Promise.resolve(OK_REPORT);
    },
    publish(f, w) {
      calls.publish++;
      return o.publish ? o.publish(f, w) : Promise.resolve(STATS);
    },
  };
  return src;
}

/** A writer that records what it was asked to do. */
export function recordingWriter(): DatasetWriter & {
  tables: DatasetTableSpec[];
  rows: Map<string, DatasetRow[]>;
} {
  const tables: DatasetTableSpec[] = [];
  const rows = new Map<string, DatasetRow[]>();
  return {
    path: "/staging/fake.tmp",
    tables,
    rows,
    createTable(spec) {
      tables.push(spec);
      rows.set(spec.name, []);
    },
    insert(table, r) {
      rows.get(table)?.push(...r);
      return r.length;
    },
  };
}

export interface FakePublisher extends DatasetPublisher {
  readonly published: { source: DatasetSourceId; version: string; released: string | null }[];
  readonly unchanged: { source: DatasetSourceId; version: string; at: string }[];
  readonly writer: ReturnType<typeof recordingWriter>;
}

/** A publisher that runs `fill` against a recording writer and returns `outcome` (or ok). */
export function fakePublisher(
  outcome?: (stats: PublishStats) => PublishOutcome,
  opts: { throwOnPublish?: boolean; throwOnUnchanged?: boolean } = {},
): FakePublisher {
  const published: FakePublisher["published"] = [];
  const unchanged: FakePublisher["unchanged"] = [];
  const writer = recordingWriter();
  return {
    published,
    unchanged,
    writer,
    async publish(source, version, released, fill) {
      if (opts.throwOnPublish === true) throw new Error("disk full");
      published.push({ source, version, released });
      const stats = await fill(writer);
      return outcome
        ? outcome(stats)
        : { ok: true, file: `/cache/ds/${source}.sqlite`, file_version: version, stats };
    },
    recordUnchanged(source, version, at) {
      if (opts.throwOnUnchanged === true) return Promise.reject(new Error("busy"));
      unchanged.push({ source, version, at });
      return Promise.resolve();
    },
    close() {
      /* nothing */
    },
  };
}

/** An in-memory refresh log. */
export function fakeRefreshLog(initial: RefreshLogRow[] = []): {
  rows: RefreshLogRow[];
  record(row: RefreshLogRow): Promise<void>;
  current(): readonly RefreshLogRow[];
} {
  const rows = [...initial];
  return {
    rows,
    record(row) {
      rows.push(row);
      return Promise.resolve();
    },
    current() {
      return rows.filter((r) => r.ok);
    },
  };
}

/** A previous successful refresh_log row. */
export function okRow(source: DatasetSourceId, file_version: string): RefreshLogRow {
  return {
    source,
    file: `/cache/ds/${source}.sqlite`,
    file_version,
    release_updated_at: null,
    seasons: [2026],
    rows: 10,
    columns_hash: "h",
    started_at: "2026-09-29T10:00:00.000Z",
    finished_at: "2026-09-29T10:00:05.000Z",
    ok: true,
    error: null,
    checked_at: "2026-09-29T10:00:05.000Z",
  };
}

/** A game at `kickoff` (ISO). */
export function game(id: string, kickoff: string | null, extra: Partial<NflGame> = {}): NflGame {
  return {
    game_id: id,
    season: 2026,
    week: 5,
    kickoff,
    away: "DAL",
    home: "CLE",
    stadium_id: "CLE00",
    stadium: "Huntington Bank Field",
    venue_tz: "America/New_York",
    roof: "outdoors",
    surface: "grass",
    divisional: false,
    rest_days: { away: 7, home: 7 },
    lines: null,
    is_final: false,
    score: null,
    ...extra,
  };
}

/** A schedule reader over fixed games; `loaded: false` → stamp null (never loaded). */
export function fakeSchedules(
  games: readonly NflGame[],
  loaded = true,
): ScheduleReader & {
  queries: { season: number; weeks: readonly number[] }[];
} {
  const queries: { season: number; weeks: readonly number[] }[] = [];
  return {
    queries,
    games(season, weeks): DatasetResult<NflGame> {
      queries.push({ season, weeks });
      return {
        rows: games.filter((g) => g.season === season && weeks.includes(g.week)),
        stamp: loaded
          ? {
              source: "nflverse:schedules",
              as_of: "2026-09-30T15:58:07.000Z",
              fetched_at: "2026-09-30T16:00:00.000Z",
              checked_at: "2026-09-30T16:00:00.000Z",
              freshness_class: "nflverse_schedules",
              file_version: "v1",
            }
          : null,
      };
    },
    firstKickoff() {
      return null;
    },
  };
}
