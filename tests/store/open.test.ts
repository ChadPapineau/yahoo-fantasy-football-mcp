// open.test.ts — StoreFactory.open (plan 01 §5.1; plan 03 §1.1 step 3, §7; plan 02 §3.3 modes):
// dir 0700 / file 0600, WAL + pragmas, migration 001 from an empty file with its never-pruned
// comments, refusal of a newer schema and of a pending migration without `migrate`, refusal of a
// group-writable cache dir and of a symlinked store file, idempotent close, stats.
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathSecurityError } from "../../src/config/paths.js";
import { MIGRATION_001_SQL } from "../../src/store/migrations/001_initial.js";
import { MIGRATIONS, readSchemaVersion, targetVersion } from "../../src/store/migrations/index.js";
import {
  MIGRATION_001_TABLES,
  NEVER_PRUNED_TABLES,
  StoreMigrationPendingError,
  StoreVersionError,
} from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  t.cleanup();
});

const mode = (p: string): number => statSync(p).mode & 0o777;

describe("open: files, modes, pragmas", () => {
  it("creates the cache dir 0700, the store 0600, the ds dir 0700; WAL + foreign keys + trusted_schema off", () => {
    const store = openStore(t);
    try {
      expect(mode(t.cache)).toBe(0o700);
      expect(mode(t.storePath)).toBe(0o600);
      expect(mode(t.datasetDir)).toBe(0o700);
      expect(store.schemaVersion).toBe(targetVersion(MIGRATIONS));
      const raw = new DatabaseSync(t.storePath);
      expect(
        (raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      ).toBe("wal");
      raw.close();
      expect(existsSync(`${t.storePath}-wal`)).toBe(true);
      expect(mode(`${t.storePath}-wal`) & 0o077).toBe(0);
    } finally {
      store.close();
    }
  });

  it("a fresh store gets exactly the migration-001 tables, each never-pruned table commented in its DDL", () => {
    const store = openStore(t);
    store.close();
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as unknown as { name: string; sql: string }[];
    db.close();
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual([...MIGRATION_001_TABLES, "league_settings_flag"].sort());
    expect(names.some((n) => n.startsWith("ds_"))).toBe(false);
    for (const tname of NEVER_PRUNED_TABLES) {
      const sql = rows.find((r) => r.name === tname)?.sql ?? "";
      expect(sql, tname).toMatch(/NEVER PRUNED/);
    }
    for (const s of MIGRATION_001_SQL) expect(s).not.toMatch(/\bds_/);
    expect(readSchemaVersion(new DatabaseSync(t.storePath, { readOnly: true }))).toBe(1);
  });

  it("migrates a pre-existing empty 0600 file (version 0) without a backup", () => {
    writeFileSync(t.storePath, "", { mode: 0o600 });
    const store = openStore(t);
    expect(store.schemaVersion).toBe(1);
    store.close();
    expect(existsSync(t.backupDir)).toBe(false);
  });

  it("re-opening an up-to-date store runs nothing and keeps data", async () => {
    const a = openStore(t);
    await a.repos.refreshLog.record({
      source: "nflverse:injuries",
      file: null,
      file_version: null,
      release_updated_at: null,
      seasons: [],
      rows: null,
      columns_hash: null,
      started_at: t.clock.nowIso(),
      finished_at: t.clock.nowIso(),
      ok: false,
      error: "network",
      checked_at: t.clock.nowIso(),
    });
    a.close();
    const b = openStore(t);
    expect(b.repos.refreshLog.latest("nflverse:injuries")?.error).toBe("network");
    b.close();
  });

  it("close is idempotent and checkpoints the WAL", () => {
    const store = openStore(t);
    store.close();
    store.close();
    expect(existsSync(`${t.storePath}-wal`) ? statSync(`${t.storePath}-wal`).size : 0).toBe(0);
  });

  it("stats reports path, size, version, misses and attachments", () => {
    const store = openStore(t);
    const s = store.stats();
    expect(s.path).toBe(t.storePath);
    expect(s.size_bytes).toBeGreaterThan(0);
    expect(s.schema_version).toBe(1);
    expect(s.cache_misses_busy).toBe(0);
    expect(s.attached).toEqual([]);
    store.close();
  });
});

describe("open: version refusal and migrate:false", () => {
  it("refuses a store written by a newer binary (StoreVersionError, exit 1) and leaves it untouched", () => {
    openStore(t).close();
    const db = new DatabaseSync(t.storePath);
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      7,
      t.clock.nowIso(),
    );
    db.close();
    const before = statSync(t.storePath).size;
    let err: unknown;
    try {
      openStore(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreVersionError);
    expect((err as StoreVersionError).storeVersion).toBe(7);
    expect((err as StoreVersionError).binaryVersion).toBe(1);
    expect((err as StoreVersionError).exitCode).toBe(1);
    expect(statSync(t.storePath).size).toBe(before);
  });

  it("migrate:false on an older store refuses without changing it", () => {
    let err: unknown;
    try {
      openStore(t, { migrate: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreMigrationPendingError);
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(0);
    db.close();
  });

  it("migrate:false on a current store opens normally", () => {
    openStore(t).close();
    const s = openStore(t, { migrate: false });
    expect(s.schemaVersion).toBe(1);
    s.close();
  });

  it("a migration list with a gap is rejected", () => {
    expect(() => targetVersion([{ version: 2, name: "x", up: () => undefined }])).toThrow(
      /contiguous/,
    );
  });

  it("a migration that throws rolls back entirely and leaves the version", () => {
    openStore(t).close();
    const bad = [
      ...MIGRATIONS,
      {
        version: 2,
        name: "broken",
        up: (db: DatabaseSync) => {
          db.exec("CREATE TABLE half_done (x INTEGER)");
          throw new Error("boom");
        },
      },
    ];
    expect(() => openStore(t, {}, { migrations: bad })).toThrow(/boom/);
    const db = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(db)).toBe(1);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half_done'").get(),
    ).toBeUndefined();
    db.close();
  });
});

describe("open: path security (plan 02 §3.3)", () => {
  it("refuses a group-writable cache directory", () => {
    chmodSync(t.cache, 0o770);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });

  it("refuses a symlinked store file", () => {
    const real = path.join(t.root, "elsewhere.sqlite");
    writeFileSync(real, "", { mode: 0o600 });
    symlinkSync(real, t.storePath);
    let err: unknown;
    try {
      openStore(t);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PathSecurityError);
    expect((err as PathSecurityError).reason).toBe("symlink");
  });

  it("refuses a group-readable store file", () => {
    openStore(t).close();
    chmodSync(t.storePath, 0o640);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });

  it("refuses a symlinked -wal", () => {
    openStore(t).close();
    symlinkSync(path.join(t.root, "x"), `${t.storePath}-wal`);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });

  it("refuses a relative store, dataset or backup path", () => {
    expect(() => openStore(t, { path: "store.sqlite" })).toThrow(PathSecurityError);
    expect(() => openStore(t, { datasetDir: "ds" })).toThrow(PathSecurityError);
    expect(() => openStore(t, { backupDir: "backups" })).toThrow(PathSecurityError);
  });

  it("refuses a symlinked dataset directory", () => {
    const real = path.join(t.root, "realds");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, t.datasetDir);
    expect(() => openStore(t)).toThrow(PathSecurityError);
  });
});
