// base.ts — what the four nflverse DataSources share (plan 01 §8 DataSource as amended by OBJ-27,
// §5.5 refresh model, D7 codec assertion; plan 05 §2 `sources/*`): release versioning from
// timestamp.txt, one TempFile per season, the schema + codec assertion over every file, and the
// publish loop that reads row groups and writes contract rows through TableLoaders.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { SOURCE_REGISTRY } from "../../config/freshness.js";
import { DATASET_TABLES } from "../../store/datasets/tables.js";
import type {
  DataSource,
  DatasetTableSpec,
  DatasetWriter,
  PublishStats,
  RateLimit,
  ReleaseVersion,
  SchemaReport,
  SourceContext,
  TempFile,
} from "../source.js";
import { checkParquet, openParquet, readRowGroups, type ColumnTypeMismatch } from "./parquet.js";
import {
  NflverseSourceError,
  downloadAsset,
  isNotFound,
  mayBeUnpublished,
  releaseUrl,
  releaseVersion,
  runSeasons,
  sourceTempDir,
  versionString,
  type NflverseTag,
} from "./release.js";
import type { TableLoader } from "./rows.js";
import { EXPECTED_COLUMNS, type NflverseSourceId } from "./schemas.js";

/** nflverse asks for nothing; one request a second is polite for release downloads. */
export const NFLVERSE_LIMITER: RateLimit = Object.freeze({ minIntervalMs: 1000, maxPerDay: null });

/** SchemaReport plus what the nflverse loader also reports. */
export interface NflverseSchemaReport extends SchemaReport {
  /** Columns present with the wrong type (fail, naming the column). */
  readonly type_mismatches: readonly ColumnTypeMismatch[];
  /** Per file: season, rows and nflverse's own `nflverse_timestamp` metadata. */
  readonly files: readonly {
    readonly season: number | null;
    readonly rows: number;
    readonly nflverse_timestamp: string | null;
  }[];
}

/** PublishStats plus the rows dropped and why. */
export interface NflversePublishStats extends PublishStats {
  readonly warnings: readonly string[];
}

/** A per-source publish: fills the tables from the files and returns the loaders it used. */
export type PublishFn = (
  files: readonly TempFile[],
  into: DatasetWriter,
) => Promise<{ readonly loaders: readonly TableLoader[]; readonly warnings: readonly string[] }>;

/** How one nflverse source differs from the others. */
export interface NflverseSourceDef {
  readonly id: NflverseSourceId;
  readonly tag: NflverseTag;
  /** Per-season file name, or `{ all }` for one file holding every season (schedules). */
  readonly file: ((season: number) => string) | { readonly all: string };
  readonly publish: PublishFn;
}

/** sha256 of the sorted `table.column TYPE` list (PublishStats.columns_hash). */
export function columnsHash(tables: readonly DatasetTableSpec[]): string {
  const cols = tables.flatMap((t) => t.columns.map((c) => `${t.name}.${c.name} ${c.type}`)).sort();
  return createHash("sha256").update(cols.join("\n")).digest("hex");
}

const label = (f: TempFile): string => (f.season === null ? "file" : `season ${String(f.season)}`);

/** Asserts columns, types and codecs of every file (plan 01 §5.5, D7). Never throws on data. */
export async function assertNflverseSchema(
  id: NflverseSourceId,
  files: readonly TempFile[],
): Promise<NflverseSchemaReport> {
  const expected = EXPECTED_COLUMNS[id];
  const missing = new Set<string>();
  const extra = new Set<string>();
  const mismatches = new Map<string, ColumnTypeMismatch>();
  const codecs = new Map<string, { column: string; codec: string }>();
  const warnings: string[] = [];
  const perFile: { season: number | null; rows: number; nflverse_timestamp: string | null }[] = [];
  let rows = 0;
  let unreadable = false;
  if (files.length === 0) warnings.push(`${id}: no files to check`);
  for (const f of files) {
    let check;
    try {
      check = checkParquet((await openParquet(f.path)).metadata, expected);
    } catch (err) {
      unreadable = true;
      const why = err instanceof NflverseSourceError ? err.message : "unreadable file";
      warnings.push(`${id} ${label(f)}: ${why}`);
      continue;
    }
    check.missing.forEach((c) => missing.add(c));
    check.extra.forEach((c) => extra.add(c));
    for (const mm of check.mismatches) mismatches.set(mm.column, mm);
    for (const bc of check.badCodecs) codecs.set(`${bc.column}\u0000${bc.codec}`, bc);
    if (check.rows === 0) warnings.push(`${id} ${label(f)}: file has no rows`);
    rows += check.rows;
    perFile.push({
      season: f.season,
      rows: check.rows,
      nflverse_timestamp: check.nflverseTimestamp,
    });
  }
  const missingList = [...missing].sort();
  const extraList = [...extra].sort();
  const mismatchList = [...mismatches.values()].sort((a, b) => (a.column < b.column ? -1 : 1));
  const badCodecs = [...codecs.values()];
  if (missingList.length > 0) {
    warnings.push(`${id}: missing or renamed column(s): ${missingList.join(", ")}`);
  }
  for (const mm of mismatchList) {
    warnings.push(`${id}: column ${mm.column} expected ${mm.expected}, found ${mm.found}`);
  }
  for (const bc of badCodecs) {
    warnings.push(
      `${id}: column ${bc.column} uses codec ${bc.codec} (allowed: SNAPPY, UNCOMPRESSED)`,
    );
  }
  if (extraList.length > 0) {
    warnings.push(
      `${id}: ${String(extraList.length)} extra column(s) tolerated: ${extraList.join(", ")}`,
    );
  }
  if (files.length > 0 && !unreadable && rows === 0) warnings.push(`${id}: no rows in any file`);
  const ok =
    files.length > 0 &&
    !unreadable &&
    rows > 0 &&
    missingList.length === 0 &&
    mismatchList.length === 0 &&
    badCodecs.length === 0;
  return {
    ok,
    missing_columns: missingList,
    extra_columns: extraList,
    bad_codecs: badCodecs,
    type_mismatches: mismatchList,
    rows,
    warnings,
    files: perFile,
  };
}

/**
 * Calls `fn` for every row of every file, one row group at a time, reading only the columns the
 * contract needs (the asserted ones).
 */
export async function eachRow(
  id: NflverseSourceId,
  files: readonly TempFile[],
  fn: (raw: Readonly<Record<string, unknown>>, file: TempFile) => void,
): Promise<void> {
  const columns = Object.keys(EXPECTED_COLUMNS[id]);
  for (const f of files) {
    const opened = await openParquet(f.path);
    const check = checkParquet(opened.metadata, EXPECTED_COLUMNS[id]);
    if (check.missing.length > 0 || check.mismatches.length > 0 || check.badCodecs.length > 0) {
      throw new NflverseSourceError("schema", `${id}: ${label(f)} fails the schema assertion`);
    }
    for await (const group of readRowGroups(opened, columns)) {
      for (const raw of group) fn(raw, f);
    }
  }
}

/** Collects loader reports into PublishStats. */
export function publishStats(
  loaders: readonly TableLoader[],
  extraWarnings: readonly string[],
): NflversePublishStats {
  const reports = loaders.map((l) => l.finish());
  const seasons = new Set<number>();
  for (const r of reports) r.seasons.forEach((s) => seasons.add(s));
  return {
    rows: reports.reduce((n, r) => n + r.rows, 0),
    tables: reports.map((r) => ({ name: r.name, rows: r.rows })),
    seasons: [...seasons].sort((a, b) => a - b),
    columns_hash: columnsHash(loaders.map((l) => l.spec)),
    warnings: [...reports.flatMap((r) => r.warnings), ...extraWarnings],
  };
}

/** Builds an nflverse DataSource from its definition. */
export function makeNflverseSource(def: NflverseSourceDef): DataSource {
  const info = SOURCE_REGISTRY[def.id];
  const slug = def.id.replace(":", "-");
  return Object.freeze({
    id: def.id,
    license: "CC-BY-4.0" as const,
    attribution: info.attribution,
    freshness: info.freshness,
    limiter: NFLVERSE_LIMITER,
    versioning: "release" as const,
    tables: DATASET_TABLES[def.id],
    version: (ctx: SourceContext): Promise<ReleaseVersion | null> => releaseVersion(def.tag, ctx),
    async fetch(_version: ReleaseVersion, ctx: SourceContext): Promise<readonly TempFile[]> {
      const seasons = runSeasons(ctx.seasons);
      if (seasons.length === 0) return [];
      const dir = await sourceTempDir(ctx, slug);
      const out: TempFile[] = [];
      try {
        if (typeof def.file === "function") {
          for (const s of seasons) {
            const url = releaseUrl(def.tag, def.file(s));
            try {
              out.push(await downloadAsset(ctx, url, join(dir, `${String(s)}.parquet`), s));
            } catch (err) {
              // a new season's file does not exist until the season has data (QA-1-033): the
              // runner publishes the other seasons; any other 404 fails the run as not_found
              if (!isNotFound(err) || !mayBeUnpublished(s, ctx) || !ctx.notPublished) throw err;
              ctx.notPublished(s);
            }
          }
        } else {
          // One upstream file holds every season: one download, one copy per season so each
          // TempFile carries the season its rows are filtered to at publish.
          const all = await downloadAsset(
            ctx,
            releaseUrl(def.tag, def.file.all),
            join(dir, "all.parquet"),
            null,
          );
          for (const s of seasons) {
            const dest = join(dir, `${String(s)}.parquet`);
            await copyFile(all.path, dest, constants.COPYFILE_EXCL);
            out.push({ path: dest, bytes: all.bytes, season: s });
          }
          await rm(all.path, { force: true });
        }
      } catch (err) {
        await rm(dir, { recursive: true, force: true });
        throw err;
      }
      return out;
    },
    versionForSeasons: (version: ReleaseVersion, seasons: readonly number[]): ReleaseVersion =>
      version.released_at === null
        ? version
        : {
            version: versionString(version.released_at, seasons),
            released_at: version.released_at,
          },
    assertSchema: (files: readonly TempFile[]): Promise<NflverseSchemaReport> =>
      assertNflverseSchema(def.id, files),
    async publish(files: readonly TempFile[], into: DatasetWriter): Promise<NflversePublishStats> {
      const { loaders, warnings } = await def.publish(files, into);
      return publishStats(loaders, warnings);
    },
  });
}

/**
 * Whether a row belongs to its file's season (a per-season file holding another season's row is
 * an upstream anomaly: the row is dropped and counted on `loader`).
 */
export function inFileSeason(loader: TableLoader, season: number | null, file: TempFile): boolean {
  if (file.season === null || season === file.season) return true;
  loader.drop("season differs from the file's season");
  return false;
}
