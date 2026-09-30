// rows.ts — turning decoded parquet rows into contract rows and writing them in batches (plan 01
// §5.5 publish into a fresh dataset file through DatasetWriter; the tables.ts conventions: TEXT via
// emptyToNull, a NOT NULL violation drops the ROW and is counted, never failing the publish; STRICT
// tables, so values are coerced to the column type here, never left to SQLite).
import { emptyToNull } from "../../store/datasets/derive.js";
import type { DatasetColumnType, DatasetRow } from "../../store/types.js";
import type { DatasetTableSpec, DatasetWriter } from "../source.js";

/** Rows per DatasetWriter.insert call (one transaction each): bounded memory, few transactions. */
export const INSERT_BATCH_ROWS = 500;

type Value = string | number | null;

/** A TEXT value: strings through emptyToNull; anything else is null. */
export function asText(v: unknown): string | null {
  return emptyToNull(v);
}

/** An INTEGER value: a safe integer (number or bigint), else null. */
export function asInt(v: unknown): number | null {
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : null;
  }
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/** A REAL value: a finite number (or a safe bigint), else null (NaN/±Infinity never stored). */
export function asReal(v: unknown): number | null {
  if (typeof v === "bigint") return asInt(v);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Coerces a value to a column type. */
export function coerce(type: DatasetColumnType, v: unknown): Value {
  switch (type) {
    case "TEXT":
      return asText(v);
    case "INTEGER":
      return asInt(v);
    case "REAL":
      return asReal(v);
    case "BLOB":
      return null;
  }
}

/**
 * Builds a contract row: every spec column, in spec order — `derived[name](raw)` when given, else
 * the raw value of the same name coerced to the column type.
 */
export function buildRow(
  spec: DatasetTableSpec,
  raw: Readonly<Record<string, unknown>>,
  derived: Readonly<Record<string, (raw: Readonly<Record<string, unknown>>) => unknown>> = {},
): Record<string, Value> {
  const row: Record<string, Value> = {};
  for (const c of spec.columns) {
    const fn = derived[c.name];
    row[c.name] = coerce(c.type, fn ? fn(raw) : raw[c.name]);
  }
  return row;
}

/**
 * Writes one table: creates it, checks NOT NULL columns, drops duplicate primary keys (the first
 * row wins), batches inserts, and counts every dropped row by reason.
 */
export class TableLoader {
  readonly spec: DatasetTableSpec;
  private readonly writer: DatasetWriter;
  private readonly keys = new Set<string>();
  private readonly pending: DatasetRow[] = [];
  private readonly dropped = new Map<string, number>();
  private readonly seasonSet = new Set<number>();
  private inserted = 0;

  constructor(writer: DatasetWriter, spec: DatasetTableSpec) {
    this.writer = writer;
    this.spec = spec;
    writer.createTable(spec);
  }

  /** Counts a row the caller filtered out before `add` (e.g. another season). */
  drop(reason: string): void {
    this.dropped.set(reason, (this.dropped.get(reason) ?? 0) + 1);
  }

  /** Adds one row; returns whether it was kept. */
  add(row: DatasetRow): boolean {
    for (const c of this.spec.columns) {
      if (!c.nullable && (row[c.name] ?? null) === null) {
        this.drop(`null ${c.name}`);
        return false;
      }
    }
    if (this.spec.primary_key) {
      const key = JSON.stringify(this.spec.primary_key.map((k) => row[k] ?? null));
      if (this.keys.has(key)) {
        this.drop("duplicate primary key");
        return false;
      }
      this.keys.add(key);
    }
    const season = row.season;
    if (typeof season === "number") this.seasonSet.add(season);
    this.pending.push(row);
    if (this.pending.length >= INSERT_BATCH_ROWS) this.flush();
    return true;
  }

  /** Inserts what is pending. */
  flush(): void {
    if (this.pending.length === 0) return;
    const n = this.writer.insert(this.spec.name, this.pending.splice(0));
    this.inserted += n;
  }

  /** Flushes and reports. */
  finish(): {
    readonly name: string;
    readonly rows: number;
    readonly seasons: readonly number[];
    readonly warnings: readonly string[];
  } {
    this.flush();
    const warnings = [...this.dropped].map(
      ([reason, n]) => `${this.spec.name}: dropped ${String(n)} row(s) — ${reason}`,
    );
    return {
      name: this.spec.name,
      rows: this.inserted,
      seasons: [...this.seasonSet].sort((a, b) => a - b),
      warnings,
    };
  }
}
