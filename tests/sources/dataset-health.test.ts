// dataset-health.test.ts — checkDatasetFile, the "is the current dataset file servable" check the
// refresh runner consults before reporting "unchanged" (QA-1-097, QA-1-038). Every branch, on real
// SQLite files under os.tmpdir().
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDatasetFile } from "../../src/sources/dataset-health.js";
import { DATASET_META_TABLE, DS_SCHEMA_VERSION } from "../../src/store/attach.js";
import { DS_INJURIES, ddlFor } from "../../src/store/datasets/tables.js";

const SRC = "nflverse:injuries";
const V = "20260930T133627Z_2026";
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ff-dataset-health-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A dataset file as the publisher writes it, with `meta` overrides (null = key omitted). */
function datasetFile(
  meta: Partial<Record<"source" | "file_version" | "ds_schema", string | null>> = {},
  opts: { contractTables?: boolean; metaTable?: boolean } = {},
): string {
  const path = join(dir, `f-${String(Math.random()).slice(2)}.sqlite`);
  const db = new DatabaseSync(path);
  if (opts.contractTables !== false) for (const sql of ddlFor(DS_INJURIES)) db.exec(sql);
  if (opts.metaTable !== false) {
    db.exec(
      `CREATE TABLE ${DATASET_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
    );
    const all = { source: SRC, file_version: V, ds_schema: String(DS_SCHEMA_VERSION), ...meta };
    const ins = db.prepare(`INSERT INTO ${DATASET_META_TABLE} (key, value) VALUES (?, ?)`);
    for (const [k, v] of Object.entries(all)) if (v !== null) ins.run(k, v);
  }
  db.close();
  return path;
}

describe("checkDatasetFile", () => {
  it("a file the publisher would write is ok", () => {
    expect(checkDatasetFile(SRC, datasetFile(), V)).toBe("ok");
  });

  it("no file recorded, or none on disk → missing", () => {
    expect(checkDatasetFile(SRC, null, V)).toBe("missing");
    expect(checkDatasetFile(SRC, join(dir, "absent.sqlite"), V)).toBe("missing");
  });

  it("a directory, a symlink (even to a good file), or not SQLite at all → unreadable", () => {
    const d = join(dir, "d.sqlite");
    mkdirSync(d);
    expect(checkDatasetFile(SRC, d, V)).toBe("unreadable");
    const link = join(dir, "link.sqlite");
    symlinkSync(datasetFile(), link);
    expect(checkDatasetFile(SRC, link, V)).toBe("unreadable");
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, Buffer.alloc(8192, 0x41));
    expect(checkDatasetFile(SRC, junk, V)).toBe("unreadable");
  });

  it("another source, version or layout, no dataset_meta, or a contract table missing → mismatch", () => {
    expect(checkDatasetFile(SRC, datasetFile({ source: "nflverse:schedules" }), V)).toBe(
      "mismatch",
    );
    expect(checkDatasetFile(SRC, datasetFile({ file_version: "older" }), V)).toBe("mismatch");
    expect(
      checkDatasetFile(SRC, datasetFile({ ds_schema: String(DS_SCHEMA_VERSION + 1) }), V),
    ).toBe("mismatch");
    expect(checkDatasetFile(SRC, datasetFile({ ds_schema: null }), V)).toBe("mismatch");
    expect(checkDatasetFile(SRC, datasetFile({}, { metaTable: false }), V)).toBe("mismatch");
    expect(checkDatasetFile(SRC, datasetFile({}, { contractTables: false }), V)).toBe("mismatch");
  });

  it("never throws, whatever the path", () => {
    for (const p of ["", "\0", "/dev/null", dir, join(dir, "a\nb")])
      expect(() => checkDatasetFile(SRC, p, V)).not.toThrow();
  });
});
