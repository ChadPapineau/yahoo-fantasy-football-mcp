// dataset-repair.test.ts — `ff refresh` repairs a damaged CURRENT dataset file (QA-1-097, QA-1-038;
// plan 05 §4.1 torn-write row; plan 01 §5.5; plan 03 §5 doctor row 8, whose fix column is
// `ff refresh`). The release short-circuit used to look only at refresh_log: a deleted file FAILED
// ("store: could not record the unchanged check") and a truncated, overwritten or foreign file was
// reported "unchanged", exit 0 — so the command every tool hint names repaired nothing until
// upstream shipped a new release. Driven against the REAL publisher, refresh log and files.
import {
  closeSync,
  copyFileSync,
  lstatSync,
  openSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import type { HttpGet } from "../../../src/sources/source.js";
import type { DatasetPublisher, Store } from "../../../src/store/types.js";
import { injuryRows } from "../../store/helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import { fakeSchedules, fakeSource, game, STATS } from "./helpers.js";

const NOW = "2026-10-01T12:00:00.000Z";
const V1 = "20260930T133627Z_2026";
const V2 = "20261001T090000Z_2026";
const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

let t: TempCache;
let store: Store;
let pub: DatasetPublisher;
let root = "";
beforeEach(async () => {
  t = tempCache("ff-repair-");
  store = openStore(t);
  pub = openPublisher(t);
  root = await mkdtemp(join(tmpdir(), "ff-repair-tmp-"));
});
afterEach(async () => {
  pub.close();
  store.close();
  t.cleanup();
  await rm(root, { recursive: true, force: true });
});

const file = (): string => join(t.datasetDir, "nflverse__injuries.sqlite");

function deps(): RefreshDeps {
  return {
    http: noHttp,
    clock: fixedClock(NOW),
    rng: seededRng(7),
    publisher: pub,
    refreshLog: store.repos.refreshLog,
    schedules: fakeSchedules([game("2026_05_DAL_CLE", "2026-10-04T17:00:00.000Z")]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
}

/** An injuries source at `version` filling the real contract tables (many rows → many pages). */
function injuries(version: string) {
  return fakeSource({
    version: () => Promise.resolve({ version, released_at: "2026-09-30T13:36:27.000Z" }),
    fetch: (_v, ctx) =>
      Promise.resolve([{ path: join(ctx.tempDir ?? root, "x.parquet"), bytes: 1, season: 2026 }]),
    publish: (_files, w) => {
      let n = 0;
      for (const tr of injuryRows()) {
        w.createTable(tr.spec);
        for (let copy = 0; copy < 400; copy++)
          n += w.insert(
            tr.spec.name,
            tr.rows.map((r, i) => ({
              ...r,
              gsis_id: `00-${String(copy).padStart(4, "0")}${String(i).padStart(3, "0")}`,
            })),
          );
      }
      return Promise.resolve({ ...STATS, rows: n, tables: [{ name: "ds_injuries", rows: n }] });
    },
  });
}

const refresh = (version = V1) =>
  runRefresh({ source: injuries(version), seasons: [2026], week: null }, deps());

/** `PRAGMA quick_check` ("error" when it throws) + the version the file itself carries. */
function inspect(): { qc: string; version: string | null } | "unreadable" {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file(), { readOnly: true });
  } catch {
    return "unreadable";
  }
  try {
    let qc: string;
    try {
      qc = (db.prepare("PRAGMA quick_check").all() as { quick_check: string }[])
        .map((r) => r.quick_check)
        .join("; ");
    } catch {
      qc = "error";
    }
    let version: string | null;
    try {
      const v = db.prepare("SELECT value FROM dataset_meta WHERE key = 'file_version'").get() as
        { value: string } | undefined;
      version = v?.value ?? null;
    } catch {
      version = null;
    }
    return qc === "error" && version === null ? "unreadable" : { qc, version };
  } finally {
    db.close();
  }
}

// Each case opens a real store and fsyncs real publishes: generous limits for a loaded machine.
const SLOW = 30_000;

describe(
  "a damaged current dataset file is republished by a plain refresh",
  { timeout: SLOW },
  () => {
    beforeEach(async () => {
      expect((await refresh()).status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
      expect(statSync(file()).size).toBeGreaterThan(8 * 4096);
    }, SLOW);

    it("control: a healthy current file is 'unchanged' and never re-fetched", async () => {
      const src = injuries(V1);
      const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
      expect(r.status).toBe("unchanged");
      expect(src.calls.fetch).toBe(0);
    });

    it("(a) deleted → published again (was: FAILED store: could not record the unchanged check)", async () => {
      rmSync(file());
      const r = await refresh();
      expect(r.status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
    });

    it("(QA-1-038) truncated → published again (was: 'unchanged', exit 0)", async () => {
      truncateSync(file(), Math.floor(statSync(file()).size / 2));
      const r = await refresh();
      expect(r.status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
    });

    it("(b) data pages overwritten, size kept → published again (was: 'unchanged', exit 0)", async () => {
      const size = statSync(file()).size;
      const fd = openSync(file(), "r+");
      try {
        writeSync(fd, Buffer.alloc(size - 2 * 4096, 0xab), 0, size - 2 * 4096, 2 * 4096);
      } finally {
        closeSync(fd);
      }
      expect(statSync(file()).size).toBe(size);
      const r = await refresh();
      expect(r.status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
    });

    it("(b) data pages corrupted, dataset_meta still readable (what `ff doctor` flags: quick_check) → published again", async () => {
      // Only the ds_* pages are overwritten: page 1 (the schema) and dataset_meta's own pages stay
      // intact, so the file still opens and names the right source + version — exactly the state
      // the server serves as 'database disk image is malformed' and a meta-only check calls current.
      const db = new DatabaseSync(file(), { readOnly: true });
      const keep = new Set<number>([1]);
      for (const r of db
        .prepare("SELECT rootpage FROM sqlite_master WHERE tbl_name = 'dataset_meta'")
        .all() as { rootpage: number }[])
        keep.add(r.rootpage);
      const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      db.close();
      const pages = statSync(file()).size / pageSize;
      const fd = openSync(file(), "r+");
      try {
        for (let pg = 2; pg <= pages; pg++)
          if (!keep.has(pg))
            writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, (pg - 1) * pageSize);
      } finally {
        closeSync(fd);
      }
      const before = inspect();
      expect(before).not.toBe("unreadable");
      if (before !== "unreadable") {
        expect(before.version).toBe(V1); // the meta still reads…
        expect(before.qc).not.toBe("ok"); // …the data does not
      }
      const r = await refresh();
      expect(r.status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
    });

    it("a file carrying another version than refresh_log's (restored from an old copy) → republished", async () => {
      copyFileSync(file(), join(root, "old.sqlite"));
      expect((await refresh(V2)).status).toBe("published");
      copyFileSync(join(root, "old.sqlite"), file()); // refresh_log says V2; the file says V1
      const r = await refresh(V2);
      expect(r.status).toBe("published");
      expect(inspect()).toEqual({ qc: "ok", version: V2 });
    });

    it("a symlink in place of the file (the server refuses to attach one) → republished as a file", async () => {
      copyFileSync(file(), join(root, "elsewhere.sqlite"));
      rmSync(file());
      symlinkSync(join(root, "elsewhere.sqlite"), file());
      const r = await refresh();
      expect(r.status).toBe("published");
      expect(lstatSync(file()).isFile()).toBe(true);
      expect(inspect()).toEqual({ qc: "ok", version: V1 });
    });
  },
);
