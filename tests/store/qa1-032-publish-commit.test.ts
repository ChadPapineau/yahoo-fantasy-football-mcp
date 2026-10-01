// qa1-032-publish-commit.test.ts — [QA-1-032] the publisher's outcome matches the on-disk state.
// The rename that makes a dataset file live and the refresh_log row that records it are one commit:
// the store's writer lock is taken BEFORE the rename (so a busy store fails the publish with the
// previous file really intact), the wait for it is long enough for plan 05 §4.1's "SQLite write lock
// held 3 s by another process" row, and a file made live but left unrecorded (a crash or a failed
// insert after the rename) is reported as such — never as "the previous file is intact" — and is
// recorded by the next publish of that source instead of being fetched and written again.
import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DS_INJURIES } from "../../src/store/datasets/tables.js";
import {
  PUBLISH_ALREADY_CURRENT,
  PUBLISH_UNRECORDED,
  type DatasetPublisher,
  type DatasetWriter,
  type PublishStats,
} from "../../src/store/types.js";
import { row, SEASON } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
const open: DatasetPublisher[] = [];
const holders: DatabaseSync[] = [];
beforeEach(() => {
  t = tempCache();
});
afterEach(() => {
  for (const h of holders.splice(0)) {
    if (h.isTransaction) h.exec("ROLLBACK");
    h.close();
  }
  for (const p of open.splice(0)) p.close();
  t.cleanup();
});

const SRC = "nflverse:injuries" as const;
const INJ = (): string => path.join(t.datasetDir, "nflverse__injuries.sqlite");
const pubWith = (internals: Parameters<typeof openPublisher>[1] = {}): DatasetPublisher => {
  const p = openPublisher(t, internals);
  open.push(p);
  return p;
};
const fillWith =
  (tag: string, n = 3, seasons: readonly number[] = [SEASON]) =>
  (w: DatasetWriter): Promise<PublishStats> => {
    w.createTable(DS_INJURIES);
    w.insert(
      "ds_injuries",
      Array.from({ length: n }, (_, i) =>
        row(DS_INJURIES, {
          season: SEASON,
          game_type: "REG",
          week: 3,
          team: "BUF",
          gsis_id: `00-${String(1_000_000 + i)}`,
          full_name: tag,
        }),
      ),
    );
    return Promise.resolve({
      rows: n,
      tables: [{ name: "ds_injuries", rows: n }],
      seasons: [...seasons],
      columns_hash: `h-${tag}`,
    });
  };
/** The version the live file says it is (dataset_meta), or null when there is no file. */
const liveVersion = (): string | null => {
  try {
    const db = new DatabaseSync(INJ(), { readOnly: true });
    try {
      return (
        db.prepare("SELECT value FROM dataset_meta WHERE key = 'file_version'").get() as {
          value: string;
        }
      ).value;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
};
const logView = () => {
  const s = openStore(t);
  try {
    return {
      current: s.repos.refreshLog.current().find((r) => r.source === SRC) ?? null,
      latest: s.repos.refreshLog.latest(SRC),
      failures: s.repos.refreshLog.consecutiveFailures(SRC),
    };
  } finally {
    s.close();
  }
};
/** Takes the store's writer lock on a second connection (what another process's writer does). */
const holdStoreLock = (): DatabaseSync => {
  const h = new DatabaseSync(t.storePath, { timeout: 5000 });
  holders.push(h);
  h.exec("BEGIN IMMEDIATE");
  h.exec(
    "INSERT INTO limiter_state (client_key, last999) VALUES ('holder', '2026-09-30T00:00:00.000Z') ON CONFLICT (client_key) DO UPDATE SET last999 = excluded.last999",
  );
  return h;
};
/** Releases a held lock later, unless the test already tore the connection down. */
const releaseAfter = (h: DatabaseSync, ms: number): void => {
  setTimeout(() => {
    if (h.isOpen && h.isTransaction) h.exec("COMMIT");
  }, ms);
};
/** One read of the store through its own read-only connection. */
const storeAll = (sql: string, ...params: string[]): Record<string, unknown>[] => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
};
const tmpDebris = (): string[] => readdirSync(t.datasetDir).filter((n) => n.includes(".tmp"));

describe("[QA-1-032] a publish's outcome matches the file that is live", () => {
  it("plan 05 §4.1: the store writer lock held 3 s at the commit point — the publish waits, then is live AND recorded", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    const p = pubWith({
      beforeRename: () => {
        releaseAfter(holdStoreLock(), 3000);
      },
    });
    const out = await p.publish(SRC, "v2", null, fillWith("v2"));
    expect(out.ok).toBe(true);
    expect(liveVersion()).toBe("v2");
    const v = logView();
    expect(v.current?.file_version).toBe("v2");
    expect(v.failures).toBe(0);
    expect(tmpDebris()).toEqual([]);
  }, 20_000);

  it("a busy store that outlasts the commit budget fails the publish BEFORE the rename: the previous file is really intact", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    const p = pubWith({
      commitBudgetMs: 400,
      beforeRename: () => {
        releaseAfter(holdStoreLock(), 1500);
      },
    });
    const out = await p.publish(SRC, "v2", null, fillWith("v2"));
    expect(out).toEqual({ ok: false, error: "store_busy" });
    // the claim the runner prints ("the previous dataset file is intact") is true
    expect(liveVersion()).toBe("v1");
    await new Promise((r) => setTimeout(r, 1300));
    expect(logView().current?.file_version).toBe("v1");
    expect(tmpDebris()).toEqual([]);
  }, 20_000);

  it("whatever fails, a non-ok outcome other than published_unrecorded always leaves the previous file live", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    const faults: Parameters<typeof openPublisher>[1][] = [
      {
        beforeRename: () => {
          throw new Error("power cut");
        },
      },
      {
        commitBudgetMs: 200,
        beforeRename: () => {
          releaseAfter(holdStoreLock(), 600);
        },
      },
    ];
    for (const f of faults) {
      const out = await pubWith(f).publish(SRC, "v2", null, fillWith("v2"));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).not.toBe(PUBLISH_UNRECORDED);
      expect(liveVersion()).toBe("v1");
      await new Promise((r) => setTimeout(r, 700));
    }
  }, 20_000);

  it("a failure AFTER the rename is reported as published_unrecorded (never 'intact'); the next publish records the live file without refetching", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    t.clock.advance(60_000);
    const p = pubWith({
      afterRename: () => {
        throw new Error("disk full");
      },
    });
    const out = await p.publish(
      SRC,
      "v2",
      "2026-09-30T13:00:00.000Z",
      fillWith("v2", 4, [2025, SEASON]),
    );
    expect(out).toEqual({ ok: false, error: PUBLISH_UNRECORDED });
    expect(liveVersion()).toBe("v2"); // the file IS live …
    expect(logView().current?.file_version).toBe("v1"); // … and not yet recorded
    expect(tmpDebris()).toEqual([]);

    // the next run (the runner sees v1 as current, upstream says v2 → publishes with skipIfCurrent)
    t.clock.advance(60_000);
    let filled = 0;
    const next = await pubWith().publish(
      SRC,
      "v2",
      "2026-09-30T13:00:00.000Z",
      (w) => {
        filled += 1;
        return fillWith("v2-again")(w);
      },
      { skipIfCurrent: true },
    );
    expect(next).toEqual({ ok: false, error: PUBLISH_ALREADY_CURRENT });
    expect(filled).toBe(0);
    const v = logView();
    expect(v.current).toMatchObject({
      file: INJ(),
      file_version: "v2",
      release_updated_at: "2026-09-30T13:00:00.000Z",
      seasons: [2025, SEASON],
      rows: 4,
      columns_hash: "h-v2",
      ok: true,
    });
    expect(v.failures).toBe(0);
  });

  it("without skipIfCurrent (--force) the unrecorded live file is still recorded first, then the new one", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    await pubWith({
      afterRename: () => {
        throw new Error("disk full");
      },
    }).publish(SRC, "v2", null, fillWith("v2"));
    t.clock.advance(60_000);
    const out = await pubWith().publish(SRC, "v3", null, fillWith("v3"));
    expect(out.ok).toBe(true);
    const versions = storeAll(
      "SELECT file_version FROM refresh_log WHERE source = ? AND ok = 1 ORDER BY id",
      SRC,
    ).map((r) => r.file_version);
    expect(versions).toEqual(["v1", "v2", "v3"]);
  });

  it("a live file that is already recorded, of another source, or of another layout is never 're-recorded'", async () => {
    await pubWith().publish(SRC, "v1", null, fillWith("v1"));
    const count = (): unknown =>
      storeAll("SELECT COUNT(*) AS n FROM refresh_log WHERE source = ?", SRC)[0]?.n;
    expect(count()).toBe(1);
    // already recorded: a skipIfCurrent publish adds nothing but its check
    await pubWith().publish(SRC, "v1", null, fillWith("x"), { skipIfCurrent: true });
    expect(count()).toBe(1);
    // another layout: not recorded as current
    const db = new DatabaseSync(INJ());
    db.exec("UPDATE dataset_meta SET value = 'v9' WHERE key = 'file_version'");
    db.exec("UPDATE dataset_meta SET value = '99' WHERE key = 'ds_schema'");
    db.close();
    await pubWith().publish(SRC, "v9", null, fillWith("v9b"), { skipIfCurrent: true });
    expect(liveVersion()).toBe("v9"); // republished (in this layout) under the same version
    const cur = logView().current;
    expect(cur?.file_version).toBe("v9");
    expect(cur?.columns_hash).toBe("h-v9b"); // the row is the republish's, not a re-record
  });
});
