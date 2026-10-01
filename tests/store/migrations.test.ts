// migrations.test.ts — the shipped forward-only migrations beyond 001 (plan 03 §7): migration 002
// (QA-1-061) replaces the (league_key, client_ref) unique index with one over RECORD_DEDUP_SCOPE,
// upgrades a v1 store that already holds keyed rows, and the store then records the same key in a
// later week as a new row instead of failing on the old index.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECORD_DEDUP_SCOPE } from "../../src/domain/reclog/types.js";
import { MIGRATION_002_SQL } from "../../src/store/migrations/002_reclog_dedup_scope.js";
import { MIGRATIONS, readSchemaVersion } from "../../src/store/migrations/index.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";

let t: TempCache;
beforeEach(() => {
  t = tempCache("ff-migr-");
});
afterEach(() => {
  t.cleanup();
});

const ISO = "2026-09-30T12:00:00.000Z";

/** Every index on recommendation_log with its columns, in index order. */
function indexes(file: string): Record<string, { unique: boolean; columns: string[] }> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const list = db.prepare("PRAGMA index_list(recommendation_log)").all() as unknown as {
      name: string;
      unique: number;
    }[];
    const out: Record<string, { unique: boolean; columns: string[] }> = {};
    for (const i of list) {
      if (i.name.startsWith("sqlite_autoindex")) continue;
      const cols = db.prepare(`PRAGMA index_info("${i.name}")`).all() as unknown as {
        seqno: number;
        name: string;
      }[];
      out[i.name] = {
        unique: i.unique === 1,
        columns: cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name),
      };
    }
    return out;
  } finally {
    db.close();
  }
}

describe("migration 002: reclog dedup scope [QA-1-061]", () => {
  it("is registered as version 2 after 001", () => {
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, "initial"],
      [2, "reclog_dedup_scope"],
    ]);
    expect(MIGRATION_002_SQL).toHaveLength(2);
  });

  it("a fresh store's unique client_ref index covers exactly RECORD_DEDUP_SCOPE", () => {
    openStore(t).close();
    const ix = indexes(t.storePath);
    expect(ix.recommendation_log__league_key__client_ref).toBeUndefined();
    expect(ix.recommendation_log__dedup_scope).toEqual({
      unique: true,
      columns: [...RECORD_DEDUP_SCOPE],
    });
  });

  it("upgrades a v1 store holding keyed rows; the same key in another week is then a new row", async () => {
    const first = MIGRATIONS[0];
    if (first === undefined) throw new Error("no migration 001");
    const v1 = openStore(t, {}, { migrations: [first] });
    const a = await v1.repos.recommendationLog.record(
      recordInput({ client_ref: "start-sit-2026-w4-flex", week: 4 }),
      ISO,
      null,
    );
    v1.close();
    const before = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(before)).toBe(1);
    before.close();

    const s = openStore(t);
    try {
      expect(s.schemaVersion).toBe(2);
      const again = await s.repos.recommendationLog.record(
        recordInput({ client_ref: "start-sit-2026-w4-flex", week: 4 }),
        ISO,
        null,
      );
      expect(again).toEqual({ ...a, deduplicated: true });
      const w5 = await s.repos.recommendationLog.record(
        recordInput({ client_ref: "start-sit-2026-w4-flex", week: 5 }),
        ISO,
        null,
      );
      expect(w5.deduplicated).toBe(false);
      expect(w5.week).toBe(5);
    } finally {
      s.close();
    }
  });
});
