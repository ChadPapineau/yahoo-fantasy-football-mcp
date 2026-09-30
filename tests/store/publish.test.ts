// publish.test.ts — the DatasetPublisher (plan 01 §5.5, round 2 OBJ-27; plan 05 §2 `store` +
// `sources/*`; §4.1 torn-write and two-process-refresh rows): fresh 0600 staging file with
// journal_mode=DELETE, one transaction per insert, fsync + atomic rename, refresh_log row; every
// failure leaves the previous file intact and no temp debris after the next run; job_lock makes a
// second publisher for the same source skip (`job_locked`), across processes too.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DS_INJURIES, DS_GAMES } from "../../src/store/datasets/tables.js";
import { errorCode, stagingPath, sweepDebris } from "../../src/store/publisher.js";
import {
  PUBLISH_ALREADY_CURRENT,
  type DatasetPublisher,
  type DatasetWriter,
  type PublishStats,
} from "../../src/store/types.js";
import { gamesRows, injuryRows, publishTables, row, SEASON } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";
import { run } from "./helpers/spawn.js";

let t: TempCache;
let pub: DatasetPublisher;
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
});
afterEach(() => {
  pub.close();
  t.cleanup();
});

const INJ = (): string => path.join(t.datasetDir, "nflverse__injuries.sqlite");
const stats = (rows: number): PublishStats => ({
  rows,
  tables: [{ name: "ds_injuries", rows }],
  seasons: [SEASON],
  columns_hash: "h",
});
const names = (rows: number, tag: string) =>
  Array.from({ length: rows }, (_, i) =>
    row(DS_INJURIES, {
      season: SEASON,
      game_type: "REG",
      week: 3,
      team: "BUF",
      gsis_id: `00-${String(1_000_000 + i)}`,
      full_name: tag,
    }),
  );
const fillWith =
  (tag: string, n = 5) =>
  (w: DatasetWriter): Promise<PublishStats> => {
    w.createTable(DS_INJURIES);
    w.insert("ds_injuries", names(n, tag));
    return Promise.resolve(stats(n));
  };
const tags = (file: string): string[] => {
  const db = new DatabaseSync(file, { readOnly: true });
  const r = db.prepare("SELECT DISTINCT full_name AS n FROM ds_injuries").all() as unknown as {
    n: string;
  }[];
  db.close();
  return r.map((x) => x.n);
};
const tmpFiles = (): string[] => readdirSync(t.datasetDir).filter((n) => n.includes(".tmp"));
const log = () => {
  const s = openStore(t);
  const out = {
    latest: s.repos.refreshLog.latest("nflverse:injuries"),
    current: s.repos.refreshLog.current(),
  };
  s.close();
  return out;
};

describe("publish: the happy path", () => {
  it("renames a private, single-file dataset into place and records refresh_log", async () => {
    const out = await pub.publish(
      "nflverse:injuries",
      "2026-09-30 09:36:26 EDT",
      "2026-09-30T13:36:26.000Z",
      fillWith("v1"),
    );
    expect(out).toEqual({
      ok: true,
      file: INJ(),
      file_version: "2026-09-30 09:36:26 EDT",
      stats: stats(5),
    });
    expect(statSync(INJ()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${INJ()}-wal`) || existsSync(`${INJ()}-journal`)).toBe(false);
    expect(tmpFiles()).toEqual([]);
    const db = new DatabaseSync(INJ(), { readOnly: true });
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
      "delete",
    );
    const meta = Object.fromEntries(
      (
        db.prepare("SELECT key, value FROM dataset_meta").all() as unknown as {
          key: string;
          value: string;
        }[]
      ).map((r) => [r.key, r.value]),
    );
    db.close();
    expect(meta).toMatchObject({
      source: "nflverse:injuries",
      file_version: "2026-09-30 09:36:26 EDT",
      release_updated_at: "2026-09-30T13:36:26.000Z",
      published_at: t.clock.nowIso(),
      ds_schema: "1",
      columns_hash: "h",
    });
    const { latest } = log();
    expect(latest).toMatchObject({
      source: "nflverse:injuries",
      file: INJ(),
      file_version: "2026-09-30 09:36:26 EDT",
      release_updated_at: "2026-09-30T13:36:26.000Z",
      seasons: [SEASON],
      rows: 5,
      columns_hash: "h",
      ok: true,
      error: null,
    });
  });

  it("a republish replaces the file (new inode) and the next refresh_log row is current", async () => {
    await pub.publish("nflverse:injuries", "v1", null, fillWith("v1"));
    const ino1 = statSync(INJ()).ino;
    await pub.publish("nflverse:injuries", "v2", null, fillWith("v2"));
    expect(statSync(INJ()).ino).not.toBe(ino1);
    expect(tags(INJ())).toEqual(["v2"]);
    expect(log().current.map((r) => r.file_version)).toEqual(["v2"]);
  });

  it("different sources publish concurrently; a file missing a contract table is refused", async () => {
    const outs = await Promise.all([
      publishTables(pub, "nflverse:injuries", "a", injuryRows()),
      publishTables(pub, "nflverse:schedules", "b", [{ spec: DS_GAMES, rows: [] }]),
    ]);
    expect(outs[0].ok).toBe(true);
    // schedules without ds_venues would be refused by the server, so it is never published
    expect(outs[1]).toEqual({ ok: false, error: "tables_missing" });
  });
});

describe("publish: failures leave the previous file intact and no debris", () => {
  beforeEach(async () => {
    await pub.publish("nflverse:injuries", "good", null, fillWith("good"));
  });
  const assertIntact = (): void => {
    expect(tags(INJ())).toEqual(["good"]);
    expect(tmpFiles()).toEqual([]);
    expect(log().current.map((r) => r.file_version)).toEqual(["good"]);
  };

  const cases: [string, (w: DatasetWriter) => Promise<PublishStats>, string][] = [
    [
      "fill throws",
      () => Promise.reject(new Error("boom <html>upstream body</html>")),
      "fill_failed",
    ],
    [
      "fill throws a coded error",
      () => Promise.reject(Object.assign(new Error("x"), { code: "network" })),
      "network",
    ],
    [
      "fill throws a node errno",
      () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
      "fill_failed",
    ],
    [
      "a non-ds table",
      (w) => {
        w.createTable({ ...DS_INJURIES, name: "evil" as never });
        return Promise.resolve(stats(0));
      },
      "fill_failed",
    ],
    [
      "a table created twice",
      (w) => {
        w.createTable(DS_INJURIES);
        w.createTable(DS_INJURIES);
        return Promise.resolve(stats(0));
      },
      "fill_failed",
    ],
    [
      "an insert into an uncreated table",
      (w) => {
        w.insert("ds_injuries", []);
        return Promise.resolve(stats(0));
      },
      "fill_failed",
    ],
    [
      "an unknown column",
      (w) => {
        w.createTable(DS_INJURIES);
        w.insert("ds_injuries", [{ ...names(1, "x")[0], "evil; DROP": 1 }]);
        return Promise.resolve(stats(1));
      },
      "fill_failed",
    ],
    [
      "a STRICT type slip",
      (w) => {
        w.createTable(DS_INJURIES);
        w.insert("ds_injuries", [{ ...names(1, "x")[0], week: "three" }]);
        return Promise.resolve(stats(1));
      },
      "fill_failed",
    ],
    [
      "a NOT NULL violation",
      (w) => {
        w.createTable(DS_INJURIES);
        w.insert("ds_injuries", [{ ...names(1, "x")[0], gsis_id: null }]);
        return Promise.resolve(stats(1));
      },
      "fill_failed",
    ],
    [
      "malformed stats",
      (w) => {
        w.createTable(DS_INJURIES);
        return Promise.resolve({ rows: -1, tables: [], seasons: [], columns_hash: "" });
      },
      "bad_stats",
    ],
    [
      "seasons out of range",
      (w) => {
        w.createTable(DS_INJURIES);
        return Promise.resolve({ ...stats(0), seasons: [1] });
      },
      "bad_stats",
    ],
  ];
  for (const [name, fill, code] of cases)
    it(`${name} → ${code}`, async () => {
      const out = await pub.publish("nflverse:injuries", "bad", null, fill);
      expect(out).toEqual({ ok: false, error: code });
      assertIntact();
      const { latest } = log();
      expect(latest).toMatchObject({ ok: false, error: code, file: null, file_version: null });
    });

  it("an insert that fails mid-batch rolls back the whole batch (one transaction per call)", async () => {
    let seen = -1;
    const out = await pub.publish("nflverse:injuries", "bad", null, (w) => {
      w.createTable(DS_INJURIES);
      w.insert("ds_injuries", names(3, "first"));
      try {
        w.insert("ds_injuries", [
          ...names(2, "second").map((r, i) => ({ ...r, gsis_id: `00-200000${String(i)}` })),
          { ...names(1, "x")[0], week: "bad" },
        ]);
      } catch {
        // swallowed: the batch must have left nothing behind
      }
      const db = new DatabaseSync(w.path, { readOnly: true });
      seen = (db.prepare("SELECT COUNT(*) AS n FROM ds_injuries").get() as { n: number }).n;
      db.close();
      return Promise.resolve(stats(3));
    });
    expect(out.ok).toBe(true);
    expect(seen).toBe(3);
  });

  it("the writer is dead once fill settles", async () => {
    let leaked: DatasetWriter | null = null;
    await pub.publish("nflverse:injuries", "v3", null, (w) => {
      leaked = w;
      return fillWith("v3")(w);
    });
    expect(() => (leaked as unknown as DatasetWriter).insert("ds_injuries", [])).toThrow(/closed/);
  });

  it("a crash between fsync and rename leaves the old file", async () => {
    const p2 = openPublisher(t, {
      beforeRename: () => {
        throw new Error("power cut");
      },
    });
    const out = await p2.publish("nflverse:injuries", "new", null, fillWith("new"));
    p2.close();
    expect(out).toEqual({ ok: false, error: "fsync_failed" });
    assertIntact();
  });

  it("invalid source / version / release time are refused without touching anything", async () => {
    expect(await pub.publish("evil:x" as never, "v", null, fillWith("x"))).toEqual({
      ok: false,
      error: "invalid_source",
    });
    expect(await pub.publish("nflverse:injuries", "", null, fillWith("x"))).toEqual({
      ok: false,
      error: "invalid_version",
    });
    expect(await pub.publish("nflverse:injuries", "v".repeat(129), null, fillWith("x"))).toEqual({
      ok: false,
      error: "invalid_version",
    });
    expect(await pub.publish("nflverse:injuries", "a\u0000b", null, fillWith("x"))).toEqual({
      ok: false,
      error: "invalid_version",
    });
    expect(await pub.publish("nflverse:injuries", "v", "not-a-time", fillWith("x"))).toEqual({
      ok: false,
      error: "invalid_release_time",
    });
    expect(log().latest?.ok).toBe(true);
    expect(tags(INJ())).toEqual(["good"]);
  });
});

describe("single-flight (job_lock)", () => {
  it("a second publish of the same source in this process skips with job_locked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = pub.publish("nflverse:injuries", "a", null, async (w) => {
      await gate;
      return fillWith("a")(w);
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = await pub.publish("nflverse:injuries", "b", null, fillWith("b"));
    expect(second).toEqual({ ok: false, error: "job_locked" });
    release();
    expect((await first).ok).toBe(true);
    expect(tags(INJ())).toEqual(["a"]);
    // the lock is released afterwards
    expect((await pub.publish("nflverse:injuries", "c", null, fillWith("c"))).ok).toBe(true);
  });

  it("two processes publishing the same source: exactly one publishes, the other skips", async () => {
    const a = run("publish-child.mjs", [t.storePath, t.datasetDir, "ok", "proc-a", "1500"], {
      tsx: true,
    });
    await a.waitFor(/^FILLING/, 30_000);
    const b = run("publish-child.mjs", [t.storePath, t.datasetDir, "ok", "proc-b", "0"], {
      tsx: true,
    });
    const outB = JSON.parse(await b.waitFor(/^\{/, 30_000)) as { ok: boolean; error?: string };
    const outA = JSON.parse(await a.waitFor(/^\{/, 30_000)) as { ok: boolean };
    await Promise.all([a.exited(), b.exited()]);
    expect(outA.ok).toBe(true);
    expect(outB).toEqual({ ok: false, error: "job_locked" });
    expect(tags(INJ())).toEqual(["child proc-a"]);
    expect(tmpFiles()).toEqual([]);
  }, 60_000);
});

describe("torn publish (plan 05 §4.1: crash mid-write)", () => {
  it("a publisher killed mid-fill leaves the previous file; the next run sweeps its debris and breaks its lock", async () => {
    await pub.publish("nflverse:injuries", "good", null, fillWith("good"));
    const before = statSync(INJ());
    const child = run("publish-child.mjs", [t.storePath, t.datasetDir, "crash", "torn", "0"], {
      tsx: true,
    });
    const filling = await child.waitFor(/^FILLING/, 30_000);
    expect(await child.exited()).toBe("SIGKILL");
    const staging = filling.slice("FILLING ".length);
    expect(existsSync(staging)).toBe(true); // the debris a crash leaves
    const after = statSync(INJ());
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);
    expect(tags(INJ())).toEqual(["good"]);
    // the server still reads the previous version
    const s = openStore(t);
    expect(s.datasets.injuries.reports(SEASON, 3, null).stamp?.file_version).toBe("good");
    s.close();
    // next run: the dead pid's job lock is broken, debris swept, new file published
    const out = await pub.publish("nflverse:injuries", "next", null, fillWith("next"));
    expect(out.ok).toBe(true);
    expect(existsSync(staging)).toBe(false);
    expect(tmpFiles()).toEqual([]);
    expect(tags(INJ())).toEqual(["next"]);
  }, 60_000);

  it("sweepDebris removes only the named source's staging files", () => {
    const mine = stagingPath(t.datasetDir, "nflverse:injuries", "v/../../x");
    expect(path.dirname(mine)).toBe(t.datasetDir);
    expect(path.basename(mine)).toMatch(/^nflverse__injuries\.v_______x\.[0-9a-f]{12}\.tmp$/);
    writeFileSync(mine, "x");
    writeFileSync(`${mine}-journal`, "x");
    const other = stagingPath(t.datasetDir, "nflverse:schedules", "v");
    writeFileSync(other, "x");
    writeFileSync(path.join(t.datasetDir, "nflverse__injuries.keep"), "x");
    expect(sweepDebris(t.datasetDir, "nflverse:injuries")).toEqual(
      [path.basename(mine), `${path.basename(mine)}-journal`].sort(),
    );
    expect(existsSync(other)).toBe(true);
    expect(stagingPath(t.datasetDir, "nflverse:injuries", "")).toMatch(/\.v\.[0-9a-f]{12}\.tmp$/);
  });
});

describe("recordUnchanged and lifecycle", () => {
  it("advances checked_at of the current row only; refuses a stale version or a missing file", async () => {
    await pub.publish("nflverse:injuries", "v1", null, fillWith("v1"));
    t.clock.advance(60_000);
    await pub.recordUnchanged("nflverse:injuries", "v1", t.clock.nowIso());
    const { latest } = log();
    expect(latest?.checked_at).toBe(t.clock.nowIso());
    expect(latest?.finished_at).not.toBe(latest?.checked_at);
    await expect(pub.recordUnchanged("nflverse:injuries", "v0", t.clock.nowIso())).rejects.toThrow(
      RangeError,
    );
    await expect(pub.recordUnchanged("nflverse:schedules", "v1", t.clock.nowIso())).rejects.toThrow(
      RangeError,
    );
    await expect(pub.recordUnchanged("nflverse:injuries", "v1", "nope")).rejects.toThrow(
      RangeError,
    );
    await expect(pub.recordUnchanged("x:y" as never, "v1", t.clock.nowIso())).rejects.toThrow(
      RangeError,
    );
    const { rmSync } = await import("node:fs");
    rmSync(INJ());
    await expect(pub.recordUnchanged("nflverse:injuries", "v1", t.clock.nowIso())).rejects.toThrow(
      /missing/,
    );
  });

  it("close is idempotent; a closed publisher refuses work", async () => {
    pub.close();
    pub.close();
    await expect(pub.publish("nflverse:injuries", "v", null, fillWith("x"))).rejects.toThrow(
      /closed/,
    );
    await expect(pub.recordUnchanged("nflverse:injuries", "v", t.clock.nowIso())).rejects.toThrow(
      /closed/,
    );
    pub = openPublisher(t);
  });

  it("errorCode keeps only fixed-vocabulary codes", () => {
    expect(errorCode(Object.assign(new Error(), { code: "schema" }), "f")).toBe("schema");
    expect(errorCode(Object.assign(new Error(), { code: "Bad Code" }), "f")).toBe("f");
    expect(errorCode(Object.assign(new Error(), { code: 5 }), "f")).toBe("f");
    expect(errorCode("x", "f")).toBe("f");
    expect(errorCode(null, "f")).toBe("f");
  });

  it("the publisher creates a missing store and dataset dir privately", () => {
    expect(statSync(t.storePath).mode & 0o777).toBe(0o600);
    expect(statSync(t.datasetDir).mode & 0o777).toBe(0o700);
  });
});

describe("single-flight: skipIfCurrent re-checks 'unchanged' under the job lock (plan 01 §5.7)", () => {
  const rows = (): { n: number; ok: number } => {
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    const r = db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(ok), 0) AS ok FROM refresh_log")
      .get() as { n: number; ok: number };
    db.close();
    return { n: r.n, ok: r.ok };
  };
  const jobLocks = (): number => {
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    const r = db.prepare("SELECT COUNT(*) AS n FROM job_lock").get() as { n: number };
    db.close();
    return r.n;
  };

  it("a second publish of the current version is refused as already_current: no fill, same file, checked_at advanced, lock released", async () => {
    expect((await pub.publish("nflverse:injuries", "v1", null, fillWith("first"))).ok).toBe(true);
    const before = statSync(INJ());
    t.clock.advance(60_000);
    let filled = 0;
    const out = await pub.publish(
      "nflverse:injuries",
      "v1",
      null,
      (w) => {
        filled++;
        return fillWith("second")(w);
      },
      { skipIfCurrent: true },
    );
    expect(out).toEqual({ ok: false, error: PUBLISH_ALREADY_CURRENT });
    expect(filled).toBe(0);
    const after = statSync(INJ());
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    expect(tags(INJ())).toEqual(["first"]);
    expect(rows()).toEqual({ n: 1, ok: 1 }); // no second row, and no failure row
    expect(log().latest?.checked_at).toBe(t.clock.nowIso());
    expect(jobLocks()).toBe(0);
    expect(tmpFiles()).toEqual([]);
    // the lock really was released: the next (new) version publishes
    expect(
      (await pub.publish("nflverse:injuries", "v2", null, fillWith("v2"), { skipIfCurrent: true }))
        .ok,
    ).toBe(true);
    expect(tags(INJ())).toEqual(["v2"]);
  });

  it("without the option (or false) the same version republishes — the --force path is unchanged", async () => {
    await pub.publish("nflverse:injuries", "v1", null, fillWith("first"));
    expect((await pub.publish("nflverse:injuries", "v1", null, fillWith("again"))).ok).toBe(true);
    expect(
      (
        await pub.publish("nflverse:injuries", "v1", null, fillWith("forced"), {
          skipIfCurrent: false,
        })
      ).ok,
    ).toBe(true);
    expect(tags(INJ())).toEqual(["forced"]);
    expect(rows()).toEqual({ n: 3, ok: 3 });
  });

  it("publishes when nothing is current, when another version is, when only a failed row carries it, and when the file is gone", async () => {
    const opt = { skipIfCurrent: true } as const;
    expect((await pub.publish("nflverse:injuries", "v1", null, fillWith("a"), opt)).ok).toBe(true);
    expect((await pub.publish("nflverse:injuries", "v2", null, fillWith("b"), opt)).ok).toBe(true);
    // a failed publish of v3 leaves v2 current; v3 is not "already current"
    const failed = await pub.publish("nflverse:injuries", "v3", null, () =>
      Promise.reject(new Error("boom")),
    );
    expect(failed.ok).toBe(false);
    expect((await pub.publish("nflverse:injuries", "v3", null, fillWith("c"), opt)).ok).toBe(true);
    // the current version's file deleted under us: republished (repair), not skipped
    const { rmSync } = await import("node:fs");
    rmSync(INJ());
    expect((await pub.publish("nflverse:injuries", "v3", null, fillWith("d"), opt)).ok).toBe(true);
    expect(tags(INJ())).toEqual(["d"]);
    // another source's current version never counts
    const games = gamesRows();
    const sched = await pub.publish(
      "nflverse:schedules",
      "v3",
      null,
      (w) => {
        for (const g of games) {
          w.createTable(g.spec);
          w.insert(g.spec.name, g.rows);
        }
        return Promise.resolve({
          ...stats(1),
          tables: games.map((g) => ({ name: g.spec.name, rows: g.rows.length })),
        });
      },
      opt,
    );
    expect(sched.ok).toBe(true);
  });

  it("a version that differs only by case or whitespace is not the current one", async () => {
    await pub.publish("nflverse:injuries", "v1", null, fillWith("a"));
    for (const v of ["V1", "v1 ", " v1", "v1​"]) {
      const out = await pub.publish("nflverse:injuries", v, null, fillWith(v), {
        skipIfCurrent: true,
      });
      expect(out.ok, JSON.stringify(v)).toBe(true);
    }
  });
});
