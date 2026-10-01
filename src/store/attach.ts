// attach.ts — the server's read-only view of the per-source dataset files (plan 01 §5.5, round 2
// OBJ-27; plan 03 §1.1 step 3): each file ATTACHed `file:<path>?mode=ro` under its own schema name,
// re-attached (DETACH + ATTACH, a file-handle operation) when its inode/mtime/size changes after a
// publish-by-rename, attached ON DEMAND with LRU eviction once more sources are current than
// MAX_ATTACHED − RESERVED_ATTACH_SLOTS (critic C-15b). A statement still iterating the old file keeps
// it attached (SQLite refuses the DETACH) and finishes on the old inode; the swap happens next call.
import { lstatSync, type Stats } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDatasetSourceId, SOURCE_REGISTRY, type DatasetSourceId } from "../config/freshness.js";
import { datasetFileStem, datasetSchemaName } from "../config/paths.js";
import type { AttachedDataset, DatasetStamp } from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import { tablesFor } from "./datasets/tables.js";
import { currentRefreshRow } from "./repos/ops.js";
import type { RepoDeps } from "./repos/common.js";
import { MAX_ATTACHED, RESERVED_ATTACH_SLOTS, type ReattachReport } from "./types.js";

/** The metadata table the publisher writes into every dataset file (not a ds_* table). */
export const DATASET_META_TABLE = "dataset_meta";
/** Version of the dataset-file layout (plan 03 §7 `ds_schema`: bumped when ds_* tables change). */
export const DS_SCHEMA_VERSION = 1;

/**
 * A `dataset_meta.ds_schema` value as a layout version: digits only (so "1x" or " 1" is not 1),
 * else null. A file whose value is not DS_SCHEMA_VERSION is of another layout and is never served
 * or treated as current (plan 03 §7: never migrated in place — the next refresh writes a new file;
 * QA-1-098).
 */
export function parseDsSchema(value: string | null | undefined): number | null {
  return typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : null;
}

/** Metadata the publisher stamps into the file itself. */
export interface DatasetFileMeta {
  readonly source: string | null;
  readonly file_version: string | null;
  readonly release_updated_at: string | null;
  readonly published_at: string | null;
  readonly ds_schema: number | null;
}

interface Slot extends AttachedDataset {
  readonly meta: DatasetFileMeta;
  lastUsed: number;
}

/** A SQLite URI for a read-only attach: every path segment percent-encoded (`?`, `#`, `%`, unicode). */
export function readOnlyUri(file: string): string {
  const enc = file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file:${enc}?mode=ro`;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** Options the attachment manager is built from. */
export interface AttachmentsOptions {
  readonly db: DatabaseSync;
  readonly repo: RepoDeps;
  readonly datasetDir: string;
  readonly clock: Clock;
  readonly warn: (code: string) => void;
}

export class Attachments {
  private readonly slots = new Map<DatasetSourceId, Slot>();
  private tick = 0;
  private evicted: DatasetSourceId[] = [];
  /** Attach slots available to datasets (the reserved slot stays free for backup/VACUUM INTO). */
  readonly capacity = MAX_ATTACHED - RESERVED_ATTACH_SLOTS;

  constructor(private readonly o: AttachmentsOptions) {}

  /** The published file path of a source's dataset. */
  filePath(source: DatasetSourceId): string {
    return path.join(this.o.datasetDir, `${datasetFileStem(source)}.sqlite`);
  }

  list(): readonly AttachedDataset[] {
    return [...this.slots.values()]
      .sort((a, b) => a.source.localeCompare(b.source))
      .map(({ meta: _m, lastUsed: _l, ...rest }) => rest);
  }

  private statFile(source: DatasetSourceId): Stats | null {
    let st: Stats;
    try {
      st = lstatSync(this.filePath(source));
    } catch {
      return null;
    }
    if (!st.isFile()) {
      this.o.warn(st.isSymbolicLink() ? "dataset_symlink_refused" : "dataset_not_regular_file");
      return null;
    }
    return st;
  }

  private detach(source: DatasetSourceId): boolean {
    const slot = this.slots.get(source);
    if (slot === undefined) return true;
    try {
      this.o.db.exec(`DETACH DATABASE ${q(slot.schema)}`);
    } catch {
      return false; // a statement is still iterating it: keep serving the old inode
    }
    this.slots.delete(source);
    return true;
  }

  private makeRoom(except: DatasetSourceId): boolean {
    if (this.slots.size < this.capacity) return true;
    const lru = [...this.slots.values()]
      .filter((s) => s.source !== except)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of lru) {
      if (this.detach(s.source)) {
        this.evicted.push(s.source);
        return true;
      }
    }
    // Every slot is mid-iteration: borrow the reserved slot rather than fail the read.
    return this.slots.size < MAX_ATTACHED;
  }

  private readMeta(schema: string): DatasetFileMeta {
    const has = this.o.db
      .prepare(`SELECT 1 AS x FROM ${q(schema)}.sqlite_master WHERE type = 'table' AND name = ?`)
      .get(DATASET_META_TABLE);
    const out: Record<string, string> = Object.create(null) as Record<string, string>; // a "__proto__" key stays data
    if (has !== undefined) {
      const rows = this.o.db
        .prepare(`SELECT key, value FROM ${q(schema)}.${DATASET_META_TABLE}`)
        .all() as unknown as { key: string; value: string }[];
      for (const r of rows)
        if (typeof r.key === "string" && typeof r.value === "string") out[r.key] = r.value;
    }
    return {
      source: out.source ?? null,
      file_version: out.file_version ?? null,
      release_updated_at: out.release_updated_at ?? null,
      published_at: out.published_at ?? null,
      ds_schema: parseDsSchema(out.ds_schema),
    };
  }

  /** Whether the file holds every ds_* table the contract gives its source (READER_QUERIES read them). */
  private hasContractTables(schema: string, source: DatasetSourceId): boolean {
    const want = tablesFor(source).map((t) => t.name);
    if (want.length === 0) return true;
    const have = new Set(
      (
        this.o.db
          .prepare(`SELECT name FROM ${q(schema)}.sqlite_master WHERE type = 'table'`)
          .all() as unknown as { name: string }[]
      ).map((r) => r.name),
    );
    return want.every((n) => have.has(n));
  }

  private attach(source: DatasetSourceId, st: Stats): Slot | null {
    if (!this.makeRoom(source)) return null;
    const schema = datasetSchemaName(source);
    const file = this.filePath(source);
    try {
      this.o.db.prepare(`ATTACH DATABASE ? AS ${q(schema)}`).run(readOnlyUri(file));
    } catch {
      this.o.warn("dataset_attach_failed");
      return null;
    }
    let meta: DatasetFileMeta;
    try {
      meta = this.readMeta(schema);
    } catch {
      // Not a SQLite database (or unreadable): never serve it.
      this.o.db.exec(`DETACH DATABASE ${q(schema)}`);
      this.o.warn("dataset_unreadable");
      return null;
    }
    if (meta.source !== null && meta.source !== source) {
      this.o.db.exec(`DETACH DATABASE ${q(schema)}`);
      this.o.warn("dataset_source_mismatch");
      return null;
    }
    // Another layout (plan 03 §7 ds_schema; QA-1-098): its READER_QUERIES columns may not exist, so
    // it is refused like a source mismatch — never served, a refresh writes a file of this layout.
    const stamped = meta.ds_schema !== null;
    if (stamped && meta.ds_schema !== DS_SCHEMA_VERSION) {
      this.o.db.exec(`DETACH DATABASE ${q(schema)}`);
      this.o.warn("dataset_schema_mismatch");
      return null;
    }
    if (!this.hasContractTables(schema, source)) {
      this.o.db.exec(`DETACH DATABASE ${q(schema)}`);
      this.o.warn("dataset_tables_missing");
      return null;
    }
    if (!stamped) {
      // Every file this publisher writes carries ds_schema: an unstamped one is of unknown layout.
      this.o.db.exec(`DETACH DATABASE ${q(schema)}`);
      this.o.warn("dataset_schema_mismatch");
      return null;
    }
    const version =
      meta.file_version ?? currentRefreshRow(this.o.repo, source)?.file_version ?? "unknown";
    const slot: Slot = {
      source,
      schema,
      file,
      file_version: version,
      inode: st.ino,
      mtime_ms: st.mtimeMs,
      size_bytes: st.size,
      attached_at: this.o.clock.nowIso(),
      meta,
      lastUsed: ++this.tick,
    };
    this.slots.set(source, slot);
    return slot;
  }

  private changed(slot: Slot, st: Stats): boolean {
    return st.ino !== slot.inode || st.mtimeMs !== slot.mtime_ms || st.size !== slot.size_bytes;
  }

  /**
   * The attachment to read `source` from — attached on demand, swapped when the file changed
   * (one lstat), or null when the dataset was never loaded (no file). Bumps the LRU clock.
   */
  use(source: DatasetSourceId): AttachedDataset | null {
    const st = this.statFile(source);
    let slot = this.slots.get(source) ?? null;
    if (st === null) {
      if (slot !== null) this.detach(source);
      return null;
    }
    if (slot !== null && this.changed(slot, st)) {
      if (this.detach(source)) slot = this.attach(source, st);
    } else {
      slot ??= this.attach(source, st);
    }
    if (slot !== null) slot.lastUsed = ++this.tick;
    return slot;
  }

  /** Full pass against refresh_log (startup and `Store.reattachIfChanged`). */
  reattachIfChanged(): ReattachReport {
    const t0 = performance.now();
    const reattached: DatasetSourceId[] = [];
    const unchanged: DatasetSourceId[] = [];
    const missing: DatasetSourceId[] = [];
    const current = new Set(
      (
        this.o.repo.db
          .prepare("SELECT DISTINCT source FROM refresh_log WHERE ok = 1 ORDER BY source")
          .all() as unknown as { source: string }[]
      )
        .map((r) => r.source)
        .filter(isDatasetSourceId),
    );
    for (const s of this.slots.keys()) current.add(s);
    // Most recently used first, then the sources the readers serve, so a full pass never
    // crowds out what the tools read.
    const rank = (s: DatasetSourceId): number => (tablesFor(s).length > 0 ? 1 : 0);
    const order = [...current].sort(
      (a, b) =>
        (this.slots.get(b)?.lastUsed ?? 0) - (this.slots.get(a)?.lastUsed ?? 0) ||
        rank(b) - rank(a) ||
        a.localeCompare(b),
    );
    for (const source of order) {
      const st = this.statFile(source);
      const slot = this.slots.get(source);
      if (st === null) {
        missing.push(source);
        if (slot !== undefined) this.detach(source);
        continue;
      }
      if (slot !== undefined) {
        if (!this.changed(slot, st)) unchanged.push(source);
        else if (this.detach(source) && this.attach(source, st) !== null) reattached.push(source);
        else unchanged.push(source); // deferred: still iterating the old file
      } else if (this.slots.size < this.capacity && this.attach(source, st) !== null) {
        reattached.push(source);
      }
    }
    const detached = [...this.evicted];
    this.evicted = [];
    return { reattached, unchanged, missing, detached, elapsed_ms: performance.now() - t0 };
  }

  /** The provenance stamp of what is attached for `source` (refresh_log row for its version). */
  stamp(a: AttachedDataset): DatasetStamp {
    const slot = this.slots.get(a.source);
    const meta = slot?.meta ?? null;
    const row = this.o.repo.db
      .prepare(
        "SELECT finished_at, checked_at, release_updated_at FROM refresh_log WHERE source = ? AND ok = 1 AND file_version = ? ORDER BY id DESC LIMIT 1",
      )
      .get(a.source, a.file_version) as
      { finished_at: string; checked_at: string; release_updated_at: string | null } | undefined;
    const fetched = row?.finished_at ?? meta?.published_at ?? a.attached_at;
    return {
      source: a.source,
      as_of: row?.release_updated_at ?? meta?.release_updated_at ?? fetched,
      fetched_at: fetched,
      checked_at: row?.checked_at ?? fetched,
      freshness_class: SOURCE_REGISTRY[a.source].freshness,
      file_version: a.file_version,
    };
  }

  /** Sources evicted (LRU) since the last full pass; reported and cleared by reattachIfChanged. */
  get pendingEvictions(): readonly DatasetSourceId[] {
    return [...this.evicted];
  }

  /** Detaches everything that can be detached (close path). */
  detachAll(): void {
    for (const s of [...this.slots.keys()]) this.detach(s);
  }
}
