// maintenance.test.ts — `ff prune` / `ff backup` (plan 06 §1.2: prune expired cache rows, ds/*.tmp
// debris and backups beyond two versions, never the recommendation log/settings/journal; backup =
// a consistent copy, keep 4). Only exact-name debris older than the publish-lock window is removed.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { main } from "../../src/cli/main.js";
import {
  backupWeekOf,
  KEEP_WEEKLY_BACKUPS,
  pruneFiles,
  rotateWeeklyBackups,
  weeklyBackupPath,
} from "../../src/cli/maintenance.js";
import { backupDir, datasetDir, storePath } from "../../src/config/paths.js";
import { fixedClock } from "../../src/domain/clock.js";
import { fakeExec, makeIo, sandbox, type Sandbox } from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const NOW = Date.parse("2026-10-04T03:00:00.000Z");
const old = new Date(NOW - 60 * 60 * 1000);

function touchOld(p: string): void {
  utimesSync(p, old, old);
}

describe("ff prune", () => {
  it("removes old staging debris and run temp dirs by exact name; keeps young and foreign entries", async () => {
    const s = sandbox();
    sb = s;
    const io = makeIo(s, { clock: fixedClock(NOW) });
    expect(await main(["prune"], io)).toBe(EXIT.OK); // creates + migrates the store
    const ds = datasetDir(s.cacheDir);
    mkdirSync(ds, { recursive: true, mode: 0o700 });
    const debris = "nflverse__injuries.20260930T133626Z_2026.0123456789ab.tmp";
    const journal = "nflverse__injuries.v.abcdefabcdef.tmp-journal";
    const young = "nflverse__schedules.v.0123456789ab.tmp";
    const foreign = "my-notes.tmp";
    for (const n of [debris, journal, young, foreign]) writeFileSync(path.join(ds, n), "x");
    for (const n of [debris, journal, foreign]) touchOld(path.join(ds, n));
    const recent = new Date(NOW - 60 * 1000);
    utimesSync(path.join(ds, young), recent, recent);
    const tmp = path.join(s.cacheDir, "tmp");
    mkdirSync(tmp, { mode: 0o700 }); // as the refresh runner creates it
    mkdirSync(path.join(tmp, "nflverse_injuries-AbC123", "inner"), { recursive: true });
    writeFileSync(path.join(tmp, "nflverse_injuries-AbC123", "inner", "f"), "x");
    touchOld(path.join(tmp, "nflverse_injuries-AbC123"));
    mkdirSync(path.join(tmp, "keep-me"));
    touchOld(path.join(tmp, "keep-me"));
    const bdir = backupDir(s.cacheDir);
    mkdirSync(bdir, { recursive: true, mode: 0o700 });
    for (const v of [1, 2, 3])
      writeFileSync(path.join(bdir, `store.sqlite.bak-v${String(v)}`), "x");
    const io2 = makeIo(s, { clock: fixedClock(NOW) });
    expect(await main(["prune"], io2)).toBe(EXIT.OK);
    expect(io2.out.text).toMatch(
      /pruned: 0 cache row\(s\), 2 dataset temp file\(s\), 1 run temp dir\(s\), 1 old pre-migration backup\(s\)/,
    );
    expect(readdirSync(ds).sort()).toEqual([foreign, young].sort());
    expect(readdirSync(tmp)).toEqual(["keep-me"]);
    expect(readdirSync(bdir).sort()).toEqual(["store.sqlite.bak-v2", "store.sqlite.bak-v3"]);
  });

  it("removes a symlink planted as debris without following it", () => {
    const s = sandbox({ create: true });
    sb = s;
    const ds = datasetDir(s.cacheDir);
    mkdirSync(ds, { mode: 0o700 });
    const victim = path.join(s.dir, "victim");
    writeFileSync(victim, "keep");
    const link = path.join(ds, "nflverse__injuries.v.0123456789ab.tmp");
    symlinkSync(victim, link);
    const r = pruneFiles(s.cacheDir, Date.now() + 3_600_000);
    expect(r.dataset_debris).toEqual(["nflverse__injuries.v.0123456789ab.tmp"]);
    expect(existsSync(victim)).toBe(true);
    expect(pruneFiles(path.join(s.dir, "none"), NOW)).toEqual({
      dataset_debris: [],
      run_temp: [],
      premigration_backups: [],
    });
  });

  it("never follows a symlinked <cache>/tmp or <cache>/backups into someone else's files [QA-1-087]", async () => {
    const s = sandbox();
    sb = s;
    expect(await main(["prune"], makeIo(s, { clock: fixedClock(NOW) }))).toBe(EXIT.OK);
    // a user relocated tmp/ and backups/ elsewhere with symlinks; the targets hold their own data
    const victim = path.join(s.dir, "victim");
    for (const d of ["family_photos-2024ab", "tax_2025-return"]) {
      mkdirSync(path.join(victim, d), { recursive: true });
      writeFileSync(path.join(victim, d, "precious.txt"), "precious");
      touchOld(path.join(victim, d));
    }
    const vb = path.join(s.dir, "victim-backups");
    mkdirSync(vb);
    for (const v of [1, 2, 3]) writeFileSync(path.join(vb, `store.sqlite.bak-v${String(v)}`), "x");
    symlinkSync(victim, path.join(s.cacheDir, "tmp"));
    const io = makeIo(s, { clock: fixedClock(NOW) });
    expect(await main(["prune"], io)).toBe(EXIT.ERROR);
    expect(io.err.text).toMatch(/symbolic link/);
    expect(readdirSync(victim).sort()).toEqual(["family_photos-2024ab", "tax_2025-return"]);
    rmSync(path.join(s.cacheDir, "tmp"));
    rmSync(backupDir(s.cacheDir), { recursive: true, force: true });
    symlinkSync(vb, backupDir(s.cacheDir));
    const io2 = makeIo(s, { clock: fixedClock(NOW) });
    expect(await main(["prune"], io2)).toBe(EXIT.ERROR);
    expect(io2.err.text).toMatch(/symbolic link/);
    expect(readdirSync(vb)).toHaveLength(3);
    // pruneFiles itself refuses rather than reading through the link
    expect(() => pruneFiles(s.cacheDir, NOW)).toThrow(/symbolic link/);
  });

  it("refuses a group/other-accessible tmp/ and leaves it alone [QA-1-087]", () => {
    const s = sandbox({ create: true });
    sb = s;
    const tmp = path.join(s.cacheDir, "tmp");
    mkdirSync(path.join(tmp, "nflverse_injuries-AbC123"), { recursive: true });
    touchOld(path.join(tmp, "nflverse_injuries-AbC123"));
    chmodSync(tmp, 0o755);
    expect(() => pruneFiles(s.cacheDir, NOW)).toThrow(/permission bits/);
    expect(readdirSync(tmp)).toEqual(["nflverse_injuries-AbC123"]);
  });

  it("never touches the recommendation log, league settings or write journal", async () => {
    const s = sandbox();
    sb = s;
    expect(await main(["prune"], makeIo(s, { clock: fixedClock(NOW) }))).toBe(EXIT.OK);
    const db = new DatabaseSync(storePath(s.cacheDir));
    db.exec(
      "INSERT INTO write_journal VALUES ('j1', 'applied', '2000-01-01T00:00:00.000Z', 946684800000, '2000-01-01T00:00:00.000Z', '{}')",
    );
    db.close();
    expect(await main(["prune"], makeIo(s, { clock: fixedClock(NOW) }))).toBe(EXIT.OK);
    const db2 = new DatabaseSync(storePath(s.cacheDir));
    expect(db2.prepare("SELECT COUNT(*) AS n FROM write_journal").get()).toEqual({ n: 1 });
    db2.close();
  });

  it("a store that cannot be opened is exit 1 with a notification", async () => {
    const s = sandbox();
    sb = s;
    writeFileSync(s.cacheDir, "file");
    const fx = fakeExec();
    const io = makeIo(s, { platform: "darwin", exec: fx.exec });
    expect(await main(["prune", "--notify"], io)).toBe(EXIT.ERROR);
    expect(fx.calls[0]?.args[1]).toContain("store-prune failed: prune");
  });
});

describe("ff backup", () => {
  it("writes a consistent dated backup and keeps the newest four", async () => {
    const s = sandbox();
    sb = s;
    const clock = fixedClock("2026-10-04T03:10:00.000Z");
    for (let i = 0; i < 6; i++) {
      const io = makeIo(s, { clock });
      expect(await main(["backup"], io)).toBe(EXIT.OK);
      expect(io.out.text).toMatch(
        /backup written: .*store-2026-1\d-\d\d\.sqlite \(\d+ bytes, (backup_api|vacuum_into)\)/,
      );
      clock.advance(7 * 24 * 3600 * 1000);
    }
    const names = readdirSync(backupDir(s.cacheDir))
      .filter((n) => n.startsWith("store-"))
      .sort();
    expect(names).toHaveLength(KEEP_WEEKLY_BACKUPS);
    expect(names[0]).toBe("store-2026-10-18.sqlite");
    const db = new DatabaseSync(path.join(backupDir(s.cacheDir), names[3] ?? ""), {
      readOnly: true,
    });
    expect(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 1 });
    db.close();
    expect(lstatSync(backupDir(s.cacheDir)).mode & 0o777).toBe(0o700);
  });

  it("a second backup the same day gets a time suffix", () => {
    const s = sandbox({ create: true });
    sb = s;
    const t = Date.parse("2026-10-04T03:10:07.000Z");
    const first = weeklyBackupPath(s.cacheDir, t);
    expect(path.basename(first)).toBe("store-2026-10-04.sqlite");
    writeFileSync(first, "");
    expect(path.basename(weeklyBackupPath(s.cacheDir, t))).toBe("store-2026-10-04-031007.sqlite");
    expect(rotateWeeklyBackups(path.join(s.dir, "nope"))).toEqual([]);
  });

  it("keeps four WEEKS of restore points: same-week extra backups never push older weeks out [QA-1-054]", async () => {
    const s = sandbox();
    sb = s;
    const bdir = backupDir(s.cacheDir);
    mkdirSync(bdir, { recursive: true, mode: 0o700 });
    const prior = ["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-27"].map(
      (d) => `store-${d}.sqlite`,
    );
    for (const n of prior) writeFileSync(path.join(bdir, n), "x");
    // four manual backups on Wednesday 2026-09-30 (before/after experimenting)
    const clock = fixedClock("2026-09-30T22:35:24.000Z");
    for (let i = 0; i < 4; i++) {
      expect(await main(["backup"], makeIo(s, { clock }))).toBe(EXIT.OK);
      clock.advance(1000);
    }
    const names = readdirSync(bdir)
      .filter((n) => n.startsWith("store-"))
      .sort();
    // the oldest WEEK goes once a fifth week appears; the three newer weeks all survive
    expect(names.filter((n) => prior.includes(n))).toEqual(prior.slice(1));
    expect(names.filter((n) => n.startsWith("store-2026-09-30"))).toHaveLength(4);
    // a fifth and sixth same-week backup still removes nothing
    for (let i = 0; i < 2; i++) {
      expect(await main(["backup"], makeIo(s, { clock }))).toBe(EXIT.OK);
      clock.advance(1000);
    }
    expect(readdirSync(bdir).filter((n) => prior.includes(n))).toHaveLength(3);
  });

  it("rotateWeeklyBackups counts distinct weeks, keeps every file of the newest ones, and never deletes an undatable name [QA-1-054]", () => {
    const s = sandbox({ create: true });
    sb = s;
    const files = [
      "store-2026-08-30.sqlite", // week of Mon 08-24 (the oldest of five weeks: removed)
      "store-2026-09-01.sqlite", // week of Mon 08-31
      "store-2026-09-06.sqlite", // same week (its Sunday)
      "store-2026-09-08.sqlite", // week of Mon 09-07
      "store-2026-09-14-101010.sqlite", // week of Mon 09-14 (three files)
      "store-2026-09-14.sqlite",
      "store-2026-09-15-090000.sqlite",
      "store-2026-09-22.sqlite", // week of Mon 09-21
      "store-2026-13-45.sqlite", // the name's shape, but no date: never deleted
    ];
    for (const n of files) writeFileSync(path.join(s.cacheDir, n), "x");
    expect(rotateWeeklyBackups(s.cacheDir)).toEqual(["store-2026-08-30.sqlite"]);
    expect(rotateWeeklyBackups(s.cacheDir)).toEqual([]);
    expect(rotateWeeklyBackups(s.cacheDir, 1)).toEqual([
      "store-2026-09-01.sqlite",
      "store-2026-09-06.sqlite",
      "store-2026-09-08.sqlite",
      "store-2026-09-14-101010.sqlite",
      "store-2026-09-14.sqlite",
      "store-2026-09-15-090000.sqlite",
    ]);
    expect(readdirSync(s.cacheDir).sort()).toEqual([
      "store-2026-09-22.sqlite",
      "store-2026-13-45.sqlite",
    ]);
    expect(backupWeekOf("store-2026-02-30.sqlite")).toBeNull();
    expect(backupWeekOf("notes.sqlite")).toBeNull();
    expect(backupWeekOf("store-2026-09-27.sqlite")).toBe(backupWeekOf("store-2026-09-21.sqlite"));
    expect(backupWeekOf("store-2026-09-28.sqlite")).toBe(
      (backupWeekOf("store-2026-09-27.sqlite") ?? 0) + 1,
    );
  });

  it("--to writes an explicit backup and refuses an existing or relative destination", async () => {
    const s = sandbox();
    sb = s;
    const dest = path.join(s.dir, "keep.sqlite");
    expect(await main(["backup", "--to", dest], makeIo(s))).toBe(EXIT.OK);
    expect(existsSync(dest)).toBe(true);
    const again = makeIo(s);
    expect(await main(["backup", "--to", dest], again)).toBe(EXIT.ERROR);
    expect(again.err.text).toMatch(/ff backup: /);
    const rel = makeIo(s);
    expect(await main(["backup", "--to", "relative.sqlite"], rel)).toBe(EXIT.ERROR);
    expect(rel.err.text).toContain("must be absolute");
    const fx = fakeExec();
    expect(
      await main(
        ["backup", "--to", dest, "--notify"],
        makeIo(s, { platform: "darwin", exec: fx.exec }),
      ),
    ).toBe(EXIT.ERROR);
    expect(fx.calls[0]?.args[1]).toContain("store-backup failed: backup");
  });
});
