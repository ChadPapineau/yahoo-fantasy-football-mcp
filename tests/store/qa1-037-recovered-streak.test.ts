// qa1-037-recovered-streak.test.ts — [QA-1-037] plan 01 §5.7: `ff status` shows per source "last
// success, last error, age, consecutive failures". A successful check — published OR unchanged —
// ends the failure streak: an "unchanged" check after a failed refresh must leave
// consecutiveFailures at 0 and the newest row a success (so last_error is cleared), while a check
// with no failure before it still only advances checked_at (refresh_log does not grow per check).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type { DatasetPublisher } from "../../src/store/types.js";
import { gamesRows, injuryRows, publishTables } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

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

const SRC: DatasetSourceId = "nflverse:injuries";

/** Reads the refresh_log view every consumer (ff status, ff_get_status, doctor) is built from. */
const view = (source: DatasetSourceId = SRC) => {
  const s = openStore(t);
  try {
    const r = s.repos.refreshLog;
    return {
      failures: r.consecutiveFailures(source),
      latest: r.latest(source),
      current: r.current().find((x) => x.source === source) ?? null,
    };
  } finally {
    s.close();
  }
};

/** Records one failed refresh of `source` (what a network failure leaves). */
const fail = async (code: string, source: DatasetSourceId = SRC): Promise<void> => {
  const s = openStore(t);
  try {
    const now = t.clock.nowIso();
    await s.repos.refreshLog.record({
      source,
      file: null,
      file_version: null,
      release_updated_at: null,
      seasons: [],
      rows: null,
      columns_hash: null,
      started_at: now,
      finished_at: now,
      ok: false,
      error: code,
      checked_at: now,
    });
  } finally {
    s.close();
  }
};

/** refresh_log rows of `source`, read through a separate read-only connection. */
const rowCount = (source: DatasetSourceId = SRC): number => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM refresh_log WHERE source = ?").get(source) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
};

describe("[QA-1-037] a successful 'unchanged' check ends the failure streak", () => {
  it("recordUnchanged after one network failure: 0 consecutive failures, newest row a success", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    t.clock.advance(60_000);
    await fail("network");
    expect(view().failures).toBe(1);
    t.clock.advance(60_000);
    await pub.recordUnchanged(SRC, "v1", t.clock.nowIso());
    const v = view();
    expect(v.failures).toBe(0);
    expect(v.latest?.ok).toBe(true);
    expect(v.latest?.error).toBeNull();
    expect(v.latest?.file_version).toBe("v1");
    expect(v.latest?.checked_at).toBe(t.clock.nowIso());
    // the publish instant (last success) is the publish's, not the check's
    expect(v.current?.finished_at).not.toBe(t.clock.nowIso());
    expect(v.current?.checked_at).toBe(t.clock.nowIso());
  });

  it("several failures in a row are all ended by one successful check; a later failure starts a fresh streak of 1", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    for (const code of ["network", "network", "http_5xx"]) {
      t.clock.advance(60_000);
      await fail(code);
    }
    expect(view().failures).toBe(3);
    t.clock.advance(60_000);
    await pub.recordUnchanged(SRC, "v1", t.clock.nowIso());
    expect(view().failures).toBe(0);
    t.clock.advance(60_000);
    await fail("network");
    expect(view().failures).toBe(1);
    expect(view().latest?.error).toBe("network");
  });

  it("the under-lock 'already current' check (skipIfCurrent) also ends the streak", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    t.clock.advance(60_000);
    await fail("network");
    t.clock.advance(60_000);
    const out = await pub.publish(
      SRC,
      "v1",
      null,
      () => Promise.reject(new Error("fill must not run")),
      { skipIfCurrent: true },
    );
    expect(out.ok).toBe(false);
    const v = view();
    expect(v.failures).toBe(0);
    expect(v.latest?.ok).toBe(true);
    expect(v.latest?.checked_at).toBe(t.clock.nowIso());
  });

  it("a failure of ANOTHER source is not ended by this source's check", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    await publishTables(pub, "nflverse:schedules", "s1", gamesRows());
    t.clock.advance(60_000);
    await fail("network", "nflverse:schedules");
    await pub.recordUnchanged(SRC, "v1", t.clock.nowIso());
    expect(view("nflverse:schedules").failures).toBe(1);
    expect(view("nflverse:schedules").latest?.ok).toBe(false);
  });

  it("checks with no failure before them only advance checked_at (no row per check)", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    const before = view();
    expect(rowCount()).toBe(1);
    for (let i = 0; i < 5; i++) {
      t.clock.advance(60_000);
      await pub.recordUnchanged(SRC, "v1", t.clock.nowIso());
    }
    const after = view();
    expect(after.failures).toBe(0);
    expect(after.latest?.checked_at).toBe(t.clock.nowIso());
    expect(after.current?.finished_at).toBe(before.current?.finished_at);
    // one success row for the one publish: the latest row IS the publish's row
    expect(after.latest?.started_at).toBe(before.latest?.started_at);
    expect(rowCount()).toBe(1);
  });

  it("a recovering check adds exactly one success row, however many failures it ends", async () => {
    await publishTables(pub, SRC, "v1", injuryRows());
    for (let i = 0; i < 4; i++) {
      t.clock.advance(60_000);
      await fail("network");
    }
    expect(rowCount()).toBe(5);
    for (let i = 0; i < 3; i++) {
      t.clock.advance(60_000);
      await pub.recordUnchanged(SRC, "v1", t.clock.nowIso());
    }
    expect(rowCount()).toBe(6);
    expect(view().failures).toBe(0);
  });
});
