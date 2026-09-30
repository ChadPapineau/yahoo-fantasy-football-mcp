// rewrite.ts — derive hostile variants of the real fixture files (renamed/dropped/retyped columns,
// a foreign codec label, duplicated or edited rows) with the test-only parquet writer, and write
// them as TempFiles. The source rows are the real nflverse rows; only the named change differs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { TempFile } from "../../../../src/sources/source.js";
import { fixtureBytes } from "./harness.js";
import {
  writeParquet,
  type Codec,
  type PhysicalType,
  type WriterColumn,
} from "./parquet-writer.js";

export type Row = Record<string, unknown>;

export interface Rewrite {
  readonly rename?: Readonly<Record<string, string>>;
  readonly drop?: readonly string[];
  /** Re-type a column (values are converted: STRING → String(v)). */
  readonly retype?: Readonly<Record<string, { type: PhysicalType; logical?: "STRING" | "DATE" }>>;
  readonly codec?: Readonly<Record<string, Codec>>;
  readonly rows?: (rows: Row[]) => Row[];
  readonly extra?: readonly Omit<WriterColumn, "values">[];
}

const toAb = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** The real rows of a fixture. */
export async function fixtureRows(rel: string): Promise<Row[]> {
  return (await parquetReadObjects({ file: toAb(fixtureBytes(rel)) })) as Row[];
}

/** Rewrites a fixture file with the given changes; returns the new bytes. */
export async function rewrite(rel: string, change: Rewrite = {}): Promise<Uint8Array> {
  const ab = toAb(fixtureBytes(rel));
  const md = parquetMetadata(ab);
  let rows = (await parquetReadObjects({ file: ab })) as Row[];
  if (change.rows) rows = change.rows(rows);
  const cols: WriterColumn[] = [];
  for (const el of md.schema.slice(1)) {
    if (change.drop?.includes(el.name)) continue;
    const re = change.retype?.[el.name];
    const logical = re ? re.logical : el.logical_type?.type;
    const type = re ? re.type : (el.type as PhysicalType);
    const name = change.rename?.[el.name] ?? el.name;
    const codecLabel = change.codec?.[el.name];
    cols.push({
      name,
      type,
      ...(logical === "STRING" || logical === "DATE" ? { logical } : {}),
      ...(codecLabel ? { codecLabel } : {}),
      values: rows.map((r): unknown => {
        const v = r[el.name] ?? null;
        if (v === null || !re) return v;
        if (re.type === "BYTE_ARRAY") {
          return typeof v === "number" || typeof v === "bigint" ? v.toString() : JSON.stringify(v);
        }
        if (re.type === "DOUBLE") return Number(v);
        if (re.type === "INT64") return BigInt(Math.trunc(Number(v)));
        return v;
      }),
    });
  }
  for (const e of change.extra ?? []) {
    cols.push({ ...e, values: rows.map((): unknown => null) });
  }
  return writeParquet(cols);
}

/** Writes bytes as a TempFile in `dir`. */
export function tempFile(
  dir: string,
  name: string,
  bytes: Uint8Array,
  season: number | null,
): TempFile {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length, season };
}
