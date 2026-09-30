// backup.test.ts — consistent backups (plan 03 L7 / §7, round 1 OBJ-10; plan 05 §2 `store`): the
// backup is taken through SQLite (one-step backup API or VACUUM INTO) under the process-wide lock,
// so a SECOND process's committed-but-uncheckpointed WAL rows are in it and no transaction is ever
// split; the pre-migration backup is taken before the first pending migration and restores with
// the exact write_journal / recommendation_log row counts; old pre-migration backups are pruned.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  preMigrationBackupPath,
  prunePreMigrationBackups,
  vacuumInto,
} from "../../src/store/backup.js";
import {
  acquireLock,
  acquireLockSync,
  pidAlive,
  StoreLockTimeoutError,
} from "../../src/store/lock.js";
import { MIGRATIONS, readSchemaVersion } from "../../src/store/migrations/index.js";
import { lockPathOf } from "../../src/store/store.js";
import type { Store } from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store | null = null;
let child: Child | null = null;
beforeEach(() => {
  t = tempCache();
});
afterEach(async () => {
  if (child !== null) {
    child.proc.kill("SIGKILL");
    await child.exited();
    child = null;
  }
  s?.close();
  s = null;
  t.cleanup();
});

const counts = (file: string): { log: number; journal: number } => {
  const db = new DatabaseSync(file, { readOnly: true });
  const n = (tbl: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get() as { n: number }).n;
  const out = { log: n("recommendation_log"), journal: n("write_journal") };
  db.close();
  return out;
};

async function walRows(nLog: number, nJournal: number): Promise<Child> {
  child = run("wal-writer.mjs", [t.storePath, "fixed", String(nLog), String(nJournal)]);
  await child.waitFor(/^READY$/);
  return child;
}

describe("Store.backup under a second process's uncheckpointed WAL rows", () => {
  it("contains exactly the committed rows (a plain file copy would not)", async () => {
    s = openStore(t);
    await s.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    await walRows(25, 7);
    expect(statSync(`${t.storePath}-wal`).size).toBeGreaterThan(0);
    // non-vacuous: copying store.sqlite alone (no -wal) loses the second process's rows
    const torn = path.join(t.root, "torn.sqlite");
    copyFileSync(t.storePath, torn);
    let tornLog = -1;
    try {
      tornLog = counts(torn).log;
    } catch {
      tornLog = -1; // the copy lacks even the table: its schema is still in the -wal
    }
    expect(tornLog).toBeLessThan(26);
    const dest = path.join(t.backupDir, "store.backup.sqlite");
    const b = await s.backup(dest);
    expect(b).toMatchObject({ path: dest, method: "backup_api", taken_at: t.clock.nowIso() });
    expect(b.bytes).toBe(statSync(dest).size);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(counts(dest)).toEqual({ log: 26, journal: 7 });
    // the restored file is a working store at the same schema version
    const restoredDir = path.join(t.root, "restored");
    mkdirSync(restoredDir, { mode: 0o700 });
    copyFileSync(dest, path.join(restoredDir, "store.sqlite"));
    chmodSync(path.join(restoredDir, "store.sqlite"), 0o600);
    const r = openStore(t, { path: path.join(restoredDir, "store.sqlite") });
    expect(r.schemaVersion).toBe(1);
    expect(r.repos.writeJournal.countByStatus()).toEqual({ prepared: 7 });
    r.close();
  });

  it("never splits a transaction while the other process keeps committing", async () => {
    s = openStore(t);
    child = run("wal-writer.mjs", [t.storePath, "stream", "10"]);
    await child.waitFor(/^STARTED$/);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const dest = path.join(t.backupDir, `stream-${String(i)}.sqlite`);
      await s.backup(dest);
      results.push(counts(dest).log);
    }
    child.proc.stdin?.end();
    const done = await child.waitFor(/^DONE /);
    const total = Number(done.split(" ")[1]);
    for (const n of results) expect(n % 10).toBe(0);
    expect(results).toEqual([...results].sort((a, b) => a - b));
    expect(results[results.length - 1]).toBeLessThanOrEqual(total);
    expect(results[0]).toBeGreaterThan(0);
  }, 30_000);

  it("refuses an existing destination, a relative path, and never follows a planted symlink", async () => {
    s = openStore(t);
    const dest = path.join(t.backupDir, "x.sqlite");
    await s.backup(dest);
    await expect(s.backup(dest)).rejects.toThrow(/exists/);
    await expect(s.backup("rel.sqlite")).rejects.toThrow();
    const target = path.join(t.root, "target.sqlite");
    symlinkSync(target, path.join(t.backupDir, "link.sqlite"));
    await expect(s.backup(path.join(t.backupDir, "link.sqlite"))).rejects.toThrow(/exists/);
    expect(existsSync(target)).toBe(false);
    // the lock was released every time
    expect(existsSync(lockPathOf(t.storePath))).toBe(false);
  });

  it("VACUUM INTO produces the same consistent copy (the sync pre-migration path)", async () => {
    s = openStore(t);
    await walRows(4, 3);
    const dest = path.join(t.backupDir, "v.sqlite");
    mkdirSync(t.backupDir, { mode: 0o700, recursive: true });
    const db = new DatabaseSync(t.storePath);
    vacuumInto(db, dest, null);
    db.close();
    expect(counts(dest)).toEqual({ log: 4, journal: 3 });
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const db2 = new DatabaseSync(t.storePath);
    expect(() => {
      vacuumInto(db2, dest, null);
    }).toThrow(/exists/);
    db2.close();
  });
});

describe("pre-migration backup (plan 03 §7)", () => {
  const V2 = [
    ...MIGRATIONS,
    {
      version: 2,
      name: "synthetic",
      up: (db: DatabaseSync) => {
        db.exec("CREATE TABLE extra_v2 (x INTEGER)");
      },
    },
  ];

  it("is taken before the first pending migration, with a second process's WAL rows, and restores exactly", async () => {
    openStore(t).close();
    await walRows(40, 11);
    s = openStore(t, {}, { migrations: V2 });
    expect(s.schemaVersion).toBe(2);
    const bak = path.join(t.backupDir, "store.sqlite.bak-v1");
    expect(statSync(bak).mode & 0o777).toBe(0o600);
    expect(counts(bak)).toEqual({ log: 40, journal: 11 });
    const b = new DatabaseSync(bak, { readOnly: true });
    expect(readSchemaVersion(b)).toBe(1);
    expect(b.prepare("SELECT 1 FROM sqlite_master WHERE name = 'extra_v2'").get()).toBeUndefined();
    b.close();
    expect(existsSync(lockPathOf(t.storePath))).toBe(false);
  });

  it("no backup for a brand-new store (nothing to lose)", () => {
    s = openStore(t);
    expect(existsSync(t.backupDir) ? readdirSync(t.backupDir) : []).toEqual([]);
  });

  it("keeps the backups of the two newest versions only; a repeat gets a suffix", () => {
    mkdirSync(t.backupDir, { mode: 0o700, recursive: true });
    for (const n of [
      "store.sqlite.bak-v1",
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3",
      "store.sqlite.bak-v3-17",
      "store.sqlite.bak-vX",
      "other.txt",
    ])
      writeFileSync(path.join(t.backupDir, n), "x");
    expect(preMigrationBackupPath(t.backupDir, 3, 99)).toBe(
      path.join(t.backupDir, "store.sqlite.bak-v3-99"),
    );
    expect(preMigrationBackupPath(t.backupDir, 4, 99)).toBe(
      path.join(t.backupDir, "store.sqlite.bak-v4"),
    );
    expect(prunePreMigrationBackups(t.backupDir)).toEqual(["store.sqlite.bak-v1"]);
    expect(readdirSync(t.backupDir).sort()).toEqual([
      "other.txt",
      "store.sqlite.bak-v2",
      "store.sqlite.bak-v3",
      "store.sqlite.bak-v3-17",
      "store.sqlite.bak-vX",
    ]);
    expect(prunePreMigrationBackups(path.join(t.root, "nope"))).toEqual([]);
  });
});

describe("the process-wide store lock", () => {
  it("excludes a second holder, is broken when its pid is dead, times out when live", async () => {
    const lp = lockPathOf(t.storePath);
    const a = acquireLockSync(lp);
    await expect(acquireLock(lp, 100)).rejects.toBeInstanceOf(StoreLockTimeoutError);
    expect(() => acquireLockSync(lp, 50)).toThrow(StoreLockTimeoutError);
    a.release();
    a.release();
    writeFileSync(lp, `${String(2 ** 31 - 2)} 2026-09-30T00:00:00.000Z\n`, { mode: 0o600 });
    const b = await acquireLock(lp, 100);
    b.release();
    writeFileSync(lp, "garbage", { mode: 0o600 });
    acquireLockSync(lp, 100).release();
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(2 ** 31 - 2)).toBe(false);
  });

  it("a stale lock (older than 30 s) held by a live pid is broken", async () => {
    const lp = lockPathOf(t.storePath);
    writeFileSync(lp, `${String(process.ppid)} x\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lp, old, old);
    const l = await acquireLock(lp, 100);
    l.release();
  });

  it("a symlink planted at the lock path is removed, never followed", async () => {
    const lp = lockPathOf(t.storePath);
    const target = path.join(t.root, "victim");
    writeFileSync(target, "keep");
    symlinkSync(target, lp);
    const l = await acquireLock(lp, 200);
    l.release();
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
});
