// parquet.ts — reading nflverse release files with hyparquet (plan 01 D7: parquet via hyparquet,
// SNAPPY/UNCOMPRESSED only, codec asserted per column chunk; §5.5 expected column set asserted
// before anything is written). Rows are decoded one row group at a time and only for the columns
// the contract needs, so memory is bounded by one row group of those columns (plus the file).
import { readFile } from "node:fs/promises";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData, SchemaElement } from "hyparquet";
import { ALLOWED_PARQUET_CODECS, type ColumnCodec } from "../source.js";
import { NflverseSourceError } from "./release.js";
import type { ColumnKind } from "./schemas.js";

/** A column whose physical/logical type is not the expected kind. */
export interface ColumnTypeMismatch {
  readonly column: string;
  readonly expected: ColumnKind;
  /** e.g. `DOUBLE`, `BYTE_ARRAY/STRING`, `INT32/DATE`. */
  readonly found: string;
}

/** One file's schema check. */
export interface ParquetCheck {
  readonly rows: number;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly mismatches: readonly ColumnTypeMismatch[];
  readonly badCodecs: readonly ColumnCodec[];
  /** nflverse's own stamp in the key-value metadata (`nflverse_timestamp`), when present. */
  readonly nflverseTimestamp: string | null;
}

/** An opened parquet file: the bytes and the parsed footer. */
export interface OpenedParquet {
  readonly buffer: ArrayBuffer;
  readonly metadata: FileMetaData;
}

const MAGIC = [0x50, 0x41, 0x52, 0x31]; // "PAR1"

/** Reads and parses a parquet file; anything that is not one fails with `not_parquet`. */
export async function openParquet(path: string): Promise<OpenedParquet> {
  const b = await readFile(path);
  const n = b.length;
  const magicOk =
    n >= 12 && MAGIC.every((m, i) => b[i] === m) && MAGIC.every((m, i) => b[n - 4 + i] === m);
  if (!magicOk) throw new NflverseSourceError("not_parquet", "nflverse: file is not parquet");
  const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + n);
  let metadata: FileMetaData;
  try {
    metadata = parquetMetadata(buffer);
  } catch {
    throw new NflverseSourceError("not_parquet", "nflverse: unreadable parquet footer");
  }
  return { buffer, metadata };
}

function describe(el: SchemaElement): string {
  const logical = el.logical_type?.type ?? el.converted_type;
  const type = el.type ?? "GROUP";
  return logical ? `${type}/${logical}` : type;
}

/** Whether a schema element decodes to the expected kind. */
export function kindMatches(el: SchemaElement, kind: ColumnKind): boolean {
  const logical = el.logical_type?.type ?? el.converted_type;
  const isString =
    el.type === "BYTE_ARRAY" &&
    (logical === undefined || logical === "STRING" || logical === "UTF8");
  const isInt =
    (el.type === "INT32" || el.type === "INT64") &&
    (logical === undefined || logical === "INTEGER" || /^U?INT_\d+$/.test(logical));
  switch (kind) {
    case "string":
      return isString;
    case "int":
      return isInt;
    case "double":
      return el.type === "DOUBLE" || el.type === "FLOAT" || isInt;
    case "date":
      return (el.type === "INT32" && logical === "DATE") || isString;
  }
}

/**
 * Checks one file's top-level columns against the expected kinds and every column chunk's codec
 * against ALLOWED_PARQUET_CODECS (plan 01 D7). Nested (group) columns count as extra.
 */
export function checkParquet(
  metadata: FileMetaData,
  expected: Readonly<Record<string, ColumnKind>>,
): ParquetCheck {
  const top = new Map<string, SchemaElement>();
  const schema = metadata.schema;
  // Walk the root's children, skipping each child's own subtree.
  const rootChildren = schema[0]?.num_children ?? 0;
  let skip = 0;
  let taken = 0;
  for (const el of schema.slice(1)) {
    if (skip > 0) {
      // inside a group column's subtree
      skip += (el.num_children ?? 0) - 1;
      continue;
    }
    if (taken === rootChildren) break;
    taken++;
    top.set(el.name, el);
    skip = el.num_children ?? 0;
  }
  const missing: string[] = [];
  const mismatches: ColumnTypeMismatch[] = [];
  for (const [name, kind] of Object.entries(expected)) {
    const el = top.get(name);
    if (!el) missing.push(name);
    else if ((el.num_children ?? 0) > 0 || !kindMatches(el, kind)) {
      mismatches.push({
        column: name,
        expected: kind,
        found: el.num_children ? "GROUP" : describe(el),
      });
    }
  }
  const extra = [...top.keys()].filter((n) => !Object.hasOwn(expected, n));
  const seen = new Set<string>();
  const badCodecs: ColumnCodec[] = [];
  for (const rg of metadata.row_groups) {
    for (const chunk of rg.columns) {
      const md = chunk.meta_data;
      if (!md) continue;
      if (ALLOWED_PARQUET_CODECS.includes(md.codec)) continue;
      const column = md.path_in_schema.join(".");
      const key = `${column}\u0000${md.codec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      badCodecs.push({ column, codec: md.codec });
    }
  }
  const ts = metadata.key_value_metadata?.find((k) => k.key === "nflverse_timestamp")?.value;
  return {
    rows: Number(metadata.num_rows),
    missing: missing.sort(),
    extra: extra.sort(),
    mismatches: mismatches.sort((a, b) => (a.column < b.column ? -1 : 1)),
    badCodecs,
    nflverseTimestamp: ts ?? null,
  };
}

/**
 * Yields the rows of `columns` one row group at a time (hyparquet decodes a row group's column
 * chunks whole; reading by row group keeps memory at one group). Values are hyparquet's: numbers,
 * bigints (INT64), strings, Dates (DATE), null.
 */
export async function* readRowGroups(
  file: OpenedParquet,
  columns: readonly string[],
): AsyncGenerator<readonly Readonly<Record<string, unknown>>[]> {
  let start = 0;
  for (const rg of file.metadata.row_groups) {
    const n = Number(rg.num_rows);
    if (n > 0) {
      yield await parquetReadObjects({
        file: file.buffer,
        metadata: file.metadata,
        columns: [...columns],
        rowStart: start,
        rowEnd: start + n,
      });
    }
    start += n;
  }
}
