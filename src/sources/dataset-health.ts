// dataset-health.ts — whether the CURRENT published dataset file of a source is one the server can
// serve (QA-1-097, QA-1-038; plan 05 §4.1 torn-write row; plan 01 §5.5 "the server and refresh must
// recover from a damaged dataset file"; plan 03 §5 doctor row 8 — "a ds/<source>.sqlite present and
// quick_check-clean for every source refresh_log lists as current", fix column `ff refresh`).
// The refresh runner's release short-circuit ("the upstream version equals the published one →
// unchanged") consults this before trusting refresh_log: a file that is missing, not a regular file,
// fails `PRAGMA quick_check`, carries another source/version/layout, or lacks a contract table is
// NOT current, so the run republishes instead of reporting "unchanged". The checks mirror what the
// server's attach (src/store/attach.ts) refuses, plus quick_check (what `ff doctor` runs).
// Opened read-only on its own connection; never throws; never writes.
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { DatasetSourceId } from "../config/freshness.js";
import { DATASET_META_TABLE, DS_SCHEMA_VERSION } from "../store/attach.js";
import { tablesFor } from "../store/datasets/tables.js";

/** What the current dataset file is, as far as serving it goes. */
export type DatasetHealth =
  /** Present, a regular file, quick_check-clean, stamped with this source + version + layout. */
  | "ok"
  /** No file (or refresh_log records none). */
  | "missing"
  /** A symlink / directory / device, or a file SQLite cannot open or read cleanly. */
  | "unreadable"
  /** A readable file stamped with another source, version or ds_schema, or missing a contract table. */
  | "mismatch";

/** The port the runner takes (injected in tests; `checkDatasetFile` by default). */
export type DatasetCheck = (
  source: DatasetSourceId,
  file: string | null,
  version: string,
) => DatasetHealth;

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** Checks the dataset file refresh_log names as current for `source` at `version`. */
export const checkDatasetFile: DatasetCheck = (source, file, version) => {
  if (file === null) return "missing";
  try {
    // lstat: a symlink is never followed (the server refuses to attach one)
    if (!lstatSync(file).isFile()) return "unreadable";
  } catch {
    return "missing";
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true, enableDoubleQuotedStringLiterals: false });
    db.exec("PRAGMA trusted_schema = OFF");
    const qc = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    if (qc.length !== 1 || qc[0]?.quick_check !== "ok") return "unreadable";
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name?: unknown;
        }[]
      ).map((r) => r.name),
    );
    if (!tables.has(DATASET_META_TABLE)) return "mismatch";
    const meta = new Map<string, string>();
    for (const r of db.prepare(`SELECT key, value FROM ${q(DATASET_META_TABLE)}`).all() as {
      key?: unknown;
      value?: unknown;
    }[]) {
      if (typeof r.key === "string" && typeof r.value === "string") meta.set(r.key, r.value);
    }
    if (
      meta.get("source") !== source ||
      meta.get("file_version") !== version ||
      meta.get("ds_schema") !== String(DS_SCHEMA_VERSION)
    )
      return "mismatch";
    if (!tablesFor(source).every((t) => tables.has(t.name))) return "mismatch";
    return "ok";
  } catch {
    return "unreadable";
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
};
