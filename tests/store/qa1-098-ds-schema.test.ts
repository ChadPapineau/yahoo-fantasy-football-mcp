// qa1-098-ds-schema.test.ts — [QA-1-098] a dataset file of another layout (plan 03 §7: "Dataset
// table changes bump ds_schema; a dataset file is never migrated in place — the next ff refresh
// writes a new file") is refused at attach like a source mismatch or a missing contract table: the
// source reads as never loaded (stamp null, no throw, warning `dataset_schema_mismatch`), and the
// publisher no longer treats that file as current, so the next refresh republishes it.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DS_SCHEMA_VERSION } from "../../src/store/attach.js";
import type { DatasetPublisher, Store } from "../../src/store/types.js";
import { PUBLISH_ALREADY_CURRENT } from "../../src/store/types.js";
import { SEASON, gamesRows, publishTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let pub: DatasetPublisher;
let s: Store | null;
const warnings: string[] = [];
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
  s = null;
  warnings.length = 0;
});
afterEach(() => {
  s?.close();
  pub.close();
  t.cleanup();
});

const SCHED = (): string => `${t.datasetDir}/nflverse__schedules.sqlite`;
const open = (): Store => (s = openStore(t, { onWarning: (c) => warnings.push(c) }));
/** Rewrites the published schedules file in place (what another binary's layout looks like). */
const rewrite = (...sql: string[]): void => {
  const db = new DatabaseSync(SCHED());
  for (const q of sql) db.exec(q);
  db.close();
};

describe("[QA-1-098] a dataset file whose ds_schema is not this binary's is never served", () => {
  it("control: a file of the current layout attaches and serves rows", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    open();
    const out = s?.datasets.schedules.games(SEASON, [1]);
    expect(out?.rows.length).toBeGreaterThan(0);
    expect(out?.stamp).not.toBeNull();
    expect(warnings).not.toContain("dataset_schema_mismatch");
  });

  it("another layout (ds_schema bumped, a reader column gone) reads as never loaded — no 'no such column' throw", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    rewrite(
      "ALTER TABLE ds_games DROP COLUMN kickoff_utc",
      `UPDATE dataset_meta SET value = '${String(DS_SCHEMA_VERSION + 1)}' WHERE key = 'ds_schema'`,
    );
    open();
    expect(() => s?.datasets.schedules.games(SEASON, [1])).not.toThrow();
    expect(s?.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(s?.datasets.schedules.firstKickoff(SEASON, 1)).toBeNull();
    expect(warnings).toContain("dataset_schema_mismatch");
  });

  it.each([
    ["an older layout", String(DS_SCHEMA_VERSION - 1)],
    ["a newer layout", String(DS_SCHEMA_VERSION + 7)],
    ["a non-numeric ds_schema", "one"],
    ["a numeric prefix", `${String(DS_SCHEMA_VERSION)}x`],
  ])("%s is refused even when every column still exists", async (_label, value) => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    rewrite(`UPDATE dataset_meta SET value = '${value}' WHERE key = 'ds_schema'`);
    open();
    expect(s?.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_schema_mismatch");
  });

  it("a file with no ds_schema stamp (not written by this publisher) is refused", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    rewrite("DELETE FROM dataset_meta WHERE key = 'ds_schema'");
    open();
    expect(s?.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_schema_mismatch");
  });

  it("a file swapped to another layout after attach is refused on the next call", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    open();
    expect(s?.datasets.schedules.games(SEASON, [1]).rows.length).toBeGreaterThan(0);
    rewrite(
      `UPDATE dataset_meta SET value = '${String(DS_SCHEMA_VERSION + 1)}' WHERE key = 'ds_schema'`,
      "CREATE TABLE pad (x)", // grow the file so the stat check sees the change
    );
    expect(s?.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_schema_mismatch");
  });

  it("the publisher does not treat such a file as current: recordUnchanged refuses, skipIfCurrent republishes", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    rewrite(
      `UPDATE dataset_meta SET value = '${String(DS_SCHEMA_VERSION + 1)}' WHERE key = 'ds_schema'`,
    );
    await expect(pub.recordUnchanged("nflverse:schedules", "v1", t.clock.nowIso())).rejects.toThrow(
      RangeError,
    );
    let filled = 0;
    const out = await pub.publish(
      "nflverse:schedules",
      "v1",
      null,
      (w) => {
        filled += 1;
        let rows = 0;
        for (const g of gamesRows()) {
          w.createTable(g.spec);
          rows += w.insert(g.spec.name, g.rows);
        }
        return Promise.resolve({ rows, tables: [], seasons: [SEASON], columns_hash: "h" });
      },
      { skipIfCurrent: true },
    );
    expect(out.ok ? "published" : out.error).not.toBe(PUBLISH_ALREADY_CURRENT);
    expect(out.ok).toBe(true);
    expect(filled).toBe(1);
    open();
    expect(s?.datasets.schedules.games(SEASON, [1]).rows.length).toBeGreaterThan(0);
    expect(warnings).not.toContain("dataset_schema_mismatch");
  });
});
