// attach.test.ts — dataset files attached read-only on the server connection (plan 01 §5.5, round
// 2 OBJ-27; plan 05 §2 `store`; critic C-15b): DETACH/ATTACH re-attach under REATTACH_BUDGET_MS on
// the named fixture sizes (a ≤ 300 KB stats_player_week file and a synthetic ~10 MB / 40-column
// pbp-sized file — the bound is on the attach, not the data volume); a query in flight on the old
// file completes with the old rows after the rename; attach-on-demand with LRU eviction past
// MAX_ATTACHED − RESERVED_ATTACH_SLOTS; and a statement trace proving ZERO ds_* DML on the store
// connection — with the authorizer denying any attempt.
import { rmSync, statSync } from "node:fs";
import path from "node:path";
import { constants as C } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import { readOnlyUri } from "../../src/store/attach.js";
import { isDatasetWrite } from "../../src/store/sqlite.js";
import { statementGuardOf, storeInternalsOf } from "../../src/store/store.js";
import {
  MAX_ATTACHED,
  REATTACH_BUDGET_MS,
  RESERVED_ATTACH_SLOTS,
  type DatasetColumn,
  type DatasetPublisher,
  type DatasetRow,
  type DatasetTableSpec,
  type Store,
} from "../../src/store/types.js";
import {
  PLAYERS,
  SEASON,
  injuryRows,
  playerWeekRows,
  publishAllFixtures,
  publishTables,
  row,
} from "./helpers/datasets.js";
import { openPublisher, openStore, percentile, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";

let t: TempCache;
let pub: DatasetPublisher;
let s: Store | null = null;
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
});
afterEach(() => {
  s?.close();
  s = null;
  pub.close();
  t.cleanup();
});

const internals = (st: Store) => {
  const i = storeInternalsOf(st);
  if (i === null) throw new Error("no internals");
  return i;
};

/** A 40-column pbp-shaped table (20 INTEGER, 10 REAL, 10 TEXT). */
const PBP: DatasetTableSpec = {
  name: "ds_pbp_synthetic",
  columns: [
    ...Array.from({ length: 20 }, (_, i): DatasetColumn => ({
      name: `i${String(i)}`,
      type: "INTEGER",
      nullable: true,
    })),
    ...Array.from({ length: 10 }, (_, i): DatasetColumn => ({
      name: `r${String(i)}`,
      type: "REAL",
      nullable: true,
    })),
    ...Array.from({ length: 10 }, (_, i): DatasetColumn => ({
      name: `t${String(i)}`,
      type: "TEXT",
      nullable: true,
    })),
  ],
  primary_key: null,
  indexes: [["i0", "i1"]],
};

async function publishPbp(version: string, rows: number): Promise<void> {
  const out = await pub.publish("nflverse:pbp", version, null, (w) => {
    w.createTable(PBP);
    const batch: DatasetRow[] = [];
    for (let n = 0; n < rows; n++) {
      const r: Record<string, number | string> = {};
      for (let i = 0; i < 20; i++) r[`i${String(i)}`] = n * 31 + i * 1_000_003;
      for (let i = 0; i < 10; i++) r[`r${String(i)}`] = n / (i + 1.5);
      for (let i = 0; i < 10; i++) r[`t${String(i)}`] = `play-${String(n)}-${String(i)}-${version}`;
      batch.push(r);
      if (batch.length === 5000) w.insert(PBP.name, batch.splice(0));
    }
    if (batch.length > 0) w.insert(PBP.name, batch.splice(0));
    return Promise.resolve({
      rows,
      tables: [{ name: PBP.name, rows }],
      seasons: [SEASON],
      columns_hash: "pbp",
    });
  });
  if (!out.ok) throw new Error(out.error);
}

const fileOf = (source: DatasetSourceId): string =>
  path.join(t.datasetDir, `${source.replace(":", "__")}.sqlite`);

describe(`re-attach < ${String(REATTACH_BUDGET_MS)} ms (≤ 300 KB stats_player_week file; ~10 MB / 40-column pbp-sized file)`, () => {
  it("re-attaches both after a publish-by-rename within the budget (median of 5)", async () => {
    await publishTables(pub, "nflverse:stats_player_week", "v0", playerWeekRows([1, 2, 3], 950));
    await publishPbp("p0", 27_000);
    const statsBytes = statSync(fileOf("nflverse:stats_player_week")).size;
    const pbpBytes = statSync(fileOf("nflverse:pbp")).size;
    expect(statsBytes).toBeLessThanOrEqual(300 * 1024);
    expect(statsBytes).toBeGreaterThan(150 * 1024);
    expect(pbpBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(pbpBytes).toBeLessThan(14 * 1024 * 1024);
    s = openStore(t);
    const store = s;
    const att = internals(store).attachments;
    expect(
      store
        .attachments()
        .map((a) => a.source)
        .sort(),
    ).toEqual(["nflverse:pbp", "nflverse:stats_player_week"]);
    const times: number[] = [];
    for (let k = 1; k <= 5; k++) {
      await publishTables(
        pub,
        "nflverse:stats_player_week",
        `v${String(k)}`,
        playerWeekRows([1, 2, 3], 950),
      );
      await publishPbp(`p${String(k)}`, 27_000);
      const report = store.reattachIfChanged();
      expect([...report.reattached].sort()).toEqual(["nflverse:pbp", "nflverse:stats_player_week"]);
      times.push(report.elapsed_ms);
      expect(store.attachments().find((a) => a.source === "nflverse:pbp")?.file_version).toBe(
        `p${String(k)}`,
      );
    }
    expect(percentile(times, 50)).toBeLessThan(REATTACH_BUDGET_MS);
    // the per-source swap on a reader's first call is the same operation
    await publishTables(pub, "nflverse:stats_player_week", "v9", playerWeekRows([1, 2, 3], 950));
    const t0 = performance.now();
    expect(att.use("nflverse:stats_player_week")?.file_version).toBe("v9");
    expect(performance.now() - t0).toBeLessThan(REATTACH_BUDGET_MS);
    const r = store.datasets.playerWeeks.lines([PLAYERS[0]?.gsis_id ?? ""], SEASON, [1]);
    expect(r.stamp?.file_version).toBe("v9");
  }, 120_000);
});

describe("a query in flight on the old file", () => {
  it("completes with the old version's rows after the rename; the next call sees the new version", async () => {
    await publishTables(pub, "nflverse:injuries", "old", injuryRows());
    s = openStore(t);
    const store = s;
    const { db } = internals(store);
    const schema = store.attachments()[0]?.schema ?? "";
    const it = db.prepare(`SELECT gsis_id FROM "${schema}".ds_injuries ORDER BY gsis_id`).iterate();
    const first = it.next();
    expect(first.done).toBe(false);
    // ff refresh publishes a new file (rename over the attached one) while the query is running
    const newer = injuryRows()[0];
    if (newer === undefined) throw new Error("rows");
    const out = await publishTables(pub, "nflverse:injuries", "new", [
      {
        spec: newer.spec,
        rows: [
          row(newer.spec, {
            season: SEASON,
            game_type: "REG",
            week: 3,
            team: "DET",
            gsis_id: "00-0099999",
          }),
        ],
      },
    ]);
    expect(out.ok).toBe(true);
    // the swap is deferred while the statement is live — never an error
    const during = store.reattachIfChanged();
    expect(during.unchanged).toContain("nflverse:injuries");
    expect(store.datasets.injuries.reports(SEASON, 3, null).stamp?.file_version).toBe("old");
    const rest = [...it].map((r) => (r as { gsis_id: string }).gsis_id);
    expect([first.value as { gsis_id: string }].map((r) => r.gsis_id).concat(rest)).toHaveLength(3); // old file: 3 rows
    // statement finished: the next call re-attaches and sees the new version
    const next = store.datasets.injuries.reports(SEASON, 3, null);
    expect(next.stamp?.file_version).toBe("new");
    expect(next.rows.map((r) => r.gsis_id)).toEqual(["00-0099999"]);
  });

  it("a file deleted under the server is reported missing and answered as never loaded", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuryRows());
    s = openStore(t);
    rmSync(fileOf("nflverse:injuries"));
    const rep = s.reattachIfChanged();
    expect(rep.missing).toEqual(["nflverse:injuries"]);
    expect(s.attachments()).toEqual([]);
    expect(s.datasets.injuries.reports(SEASON, 3, null)).toEqual({ rows: [], stamp: null });
  });

  it("an unchanged pass reports unchanged and is cheap", async () => {
    await publishAllFixtures(pub);
    s = openStore(t);
    const rep = s.reattachIfChanged();
    expect(rep.reattached).toEqual([]);
    expect(rep.unchanged).toHaveLength(6);
    expect(rep.elapsed_ms).toBeLessThan(REATTACH_BUDGET_MS);
  });
});

describe("attach on demand with LRU eviction (critic C-15b)", () => {
  const EXTRA: DatasetSourceId[] = [
    "nflverse:stats_team_week",
    "nflverse:pbp",
    "nflverse:snap_counts",
    "nflverse:depth_charts",
    "ffopportunity:ep_weekly",
    "sleeper:players",
  ];
  const tiny: DatasetTableSpec = {
    name: "ds_tiny",
    columns: [{ name: "x", type: "INTEGER", nullable: false }],
    primary_key: null,
    indexes: [],
  };

  it("never holds more than MAX_ATTACHED − RESERVED; a reader never fails for want of a slot", async () => {
    await publishAllFixtures(pub);
    for (const src of EXTRA) {
      const o = await publishTables(pub, src, "x1", [{ spec: tiny, rows: [{ x: 1 }] }]);
      expect(o.ok).toBe(true);
    }
    s = openStore(t);
    const store = s;
    const cap = MAX_ATTACHED - RESERVED_ATTACH_SLOTS;
    expect(store.attachments()).toHaveLength(cap);
    // the six sources the readers serve are attached first
    for (const src of ["nflverse:schedules", "nflverse:injuries", "weather:nws"])
      expect(store.attachments().map((a) => a.source)).toContain(src);
    const att = internals(store).attachments;
    for (const src of EXTRA) expect(att.use(src)).not.toBeNull();
    expect(store.attachments()).toHaveLength(cap);
    // every Phase-1a reader still answers (re-attaching on demand, evicting the LRU)
    expect(store.datasets.schedules.games(SEASON, [1]).stamp).not.toBeNull();
    expect(store.datasets.injuries.reports(SEASON, 3, null).stamp).not.toBeNull();
    expect(store.datasets.playerWeeks.lines([], SEASON, [1]).stamp).not.toBeNull();
    expect(store.datasets.weather.forGames([]).stamp).not.toBeNull();
    expect(store.rosterWeekly.latest(SEASON).stamp).not.toBeNull();
    expect(store.attachments()).toHaveLength(cap);
    const rep = store.reattachIfChanged();
    expect(rep.detached.length).toBeGreaterThan(0);
    expect(store.reattachIfChanged().detached).toEqual([]);
    // the reserved slot is free: a consistent backup (VACUUM INTO fallback needs it) still works
    const b = await store.backup(path.join(t.backupDir, "b.sqlite"));
    expect(b.bytes).toBeGreaterThan(0);
  });

  it("borrows the reserved slot rather than fail when every slot is mid-iteration", async () => {
    for (const src of [
      ...EXTRA,
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:schedules",
      "weather:nws",
    ] as DatasetSourceId[]) {
      const o = await publishTables(
        pub,
        src,
        "x",
        EXTRA.includes(src) ? [{ spec: tiny, rows: [{ x: 1 }] }] : await fixtureFor(src),
      );
      expect(o.ok).toBe(true);
    }
    s = openStore(t);
    const store = s;
    const { db, attachments } = internals(store);
    const live = store.attachments().map((a) => {
      const it = db.prepare(`SELECT * FROM "${a.schema}".sqlite_master`).iterate();
      it.next();
      return it;
    });
    expect(live).toHaveLength(MAX_ATTACHED - RESERVED_ATTACH_SLOTS);
    const missingOne = (
      [
        "weather:nws",
        "nflverse:schedules",
        ...EXTRA,
        "nflverse:injuries",
        "nflverse:roster_weekly",
      ] as DatasetSourceId[]
    ).find((src) => !store.attachments().some((a) => a.source === src));
    expect(missingOne).toBeDefined();
    if (missingOne === undefined) throw new Error("every source attached");
    expect(attachments.use(missingOne)).not.toBeNull();
    expect(store.attachments()).toHaveLength(MAX_ATTACHED);
    for (const it of live) expect([...it].length).toBeGreaterThanOrEqual(0);
  });
});

async function fixtureFor(src: DatasetSourceId) {
  const h = await import("./helpers/datasets.js");
  if (src === "nflverse:injuries") return h.injuryRows();
  if (src === "nflverse:roster_weekly") return h.rosterRows([1]);
  if (src === "nflverse:schedules") return h.gamesRows();
  return h.weatherRows("nws", ["g"], 50);
}

describe("the store connection never writes a dataset (statement trace + authorizer)", () => {
  it("a full workload records reads of ds_* tables and zero ds_* DML", async () => {
    await publishAllFixtures(pub);
    s = openStore(t);
    const store = s;
    const guard = statementGuardOf(store);
    if (guard === null) throw new Error("no guard");
    guard.startTrace();
    // every reader, every write family, a re-attach after a publish, a backup
    const ids = PLAYERS.map((p) => p.gsis_id);
    store.datasets.schedules.games(SEASON, [1, 2]);
    store.datasets.schedules.firstKickoff(SEASON, 1);
    store.datasets.injuries.reports(SEASON, 3, null);
    store.datasets.playerWeeks.lines(ids, SEASON, [1, 2, 3]);
    store.datasets.playerWeeks.defenseLines(["DET", "MIA"], SEASON, [1]);
    store.datasets.weather.forGames(["2026_01_BUF_MIA"]);
    store.rosterWeekly.latest(SEASON);
    store.rosterWeekly.byPlatformId("yahoo", "30977");
    await store.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    store.repos.pointsCache.put("h", ids[0] ?? "", SEASON, 1, 3);
    await publishTables(pub, "nflverse:injuries", "again", injuryRows());
    store.reattachIfChanged();
    store.datasets.injuries.reports(SEASON, 3, null);
    await store.backup(path.join(t.backupDir, "trace.sqlite"));
    const trace = guard.stopTrace();
    const dsReads = trace.filter(
      (e) =>
        e.action === C.SQLITE_READ &&
        e.object?.startsWith("ds_") === true &&
        e.schema?.startsWith("ds_") === true,
    );
    expect(dsReads.length).toBeGreaterThan(10); // the trace is not vacuous
    const dml = trace.filter(
      (e) =>
        [C.SQLITE_INSERT, C.SQLITE_UPDATE, C.SQLITE_DELETE].includes(e.action) &&
        (e.object?.startsWith("ds_") === true ||
          (e.schema !== null && e.schema !== "main" && e.schema !== "temp")),
    );
    expect(dml).toEqual([]);
    expect(trace.filter((e) => e.denied)).toEqual([]);
    expect(
      trace.some(
        (e) =>
          e.action === C.SQLITE_INSERT && e.object === "recommendation_log" && e.schema === "main",
      ),
    ).toBe(true);
  });

  it("any attempted dataset write is denied by the authorizer (and would hit a read-only file anyway)", async () => {
    await publishAllFixtures(pub);
    s = openStore(t);
    const store = s;
    const { db, guard } = internals(store);
    const schema = store.attachments().find((a) => a.source === "nflverse:injuries")?.schema ?? "";
    guard.startTrace();
    for (const sql of [
      `INSERT INTO "${schema}".ds_injuries (season, game_type, week, team, gsis_id) VALUES (2026, 'REG', 1, 'BUF', '00-0000001')`,
      `UPDATE "${schema}".ds_injuries SET week = 9`,
      `DELETE FROM "${schema}".ds_injuries`,
      `CREATE TABLE "${schema}".x (a)`,
      `DROP TABLE "${schema}".ds_injuries`,
      `CREATE TABLE main.ds_sneaky (a)`,
      `CREATE TEMP TABLE ds_sneaky_temp (a)`,
    ])
      expect(() => {
        db.exec(sql);
      }, sql).toThrow(/not authorized/);
    const denied = guard.stopTrace().filter((e) => e.denied);
    expect(denied.length).toBeGreaterThanOrEqual(7);
    expect(store.datasets.injuries.reports(SEASON, 3, null).rows).toHaveLength(2);
    // belt: without the guard the read-only attach refuses the write too
    guard.bypass(() => {
      expect(() => {
        db.exec(`DELETE FROM "${schema}".ds_injuries`);
      }).toThrow(/readonly/);
    });
  });

  it("isDatasetWrite classifies by action, object and schema", () => {
    expect(isDatasetWrite(C.SQLITE_INSERT, "crosswalk", "main")).toBe(false);
    expect(isDatasetWrite(C.SQLITE_INSERT, "ds_games", "main")).toBe(true);
    expect(isDatasetWrite(C.SQLITE_INSERT, "DS_GAMES", "main")).toBe(true);
    expect(isDatasetWrite(C.SQLITE_UPDATE, "x", "ds_nflverse__schedules")).toBe(true);
    expect(isDatasetWrite(C.SQLITE_INSERT, "x", "temp")).toBe(false);
    expect(isDatasetWrite(C.SQLITE_READ, "ds_games", "ds_nflverse__schedules")).toBe(false);
    expect(isDatasetWrite(C.SQLITE_INSERT, null, null)).toBe(false);
  });
});

describe("attach URI", () => {
  it("percent-encodes every path segment so '?', '#', '%' and unicode stay part of the path", () => {
    expect(readOnlyUri("/a b/c?d#e%f/ü.sqlite")).toBe(
      "file:/a%20b/c%3Fd%23e%25f/%C3%BC.sqlite?mode=ro",
    );
  });

  it("attaches a dataset under a cache path with spaces and unicode", async () => {
    t.cleanup();
    t = tempCache("ff store ü ?#% ");
    pub.close();
    pub = openPublisher(t);
    await publishTables(pub, "nflverse:injuries", "v1", injuryRows());
    s = openStore(t);
    expect(s.datasets.injuries.reports(SEASON, 3, null).rows).toHaveLength(2);
  });
});
