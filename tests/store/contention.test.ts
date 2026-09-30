// contention.test.ts — plan 10 A4a / plan 05 §2 `store` (round 1 OBJ-11) and §4.1 row "SQLite write
// lock held 3 s by another process": while a second process holds the writer lock for 3 s, the
// server answers 50 fixture-mode reads (fixture datasets attached, the stats_player_week file
// ≤ 300 KB) that each miss the points cache and try to fill it — p95 latency < 300 ms measured
// from each request's arrival, zero errors, every cache write skipped and counted as a miss — and
// a concurrent ff_record_recommendation (a required write) returns STORE_BUSY within ≤ 1 s.
import { statSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REQUIRED_WRITE_BUDGET_MS, StoreBusyError, type Store } from "../../src/store/types.js";
import {
  GAME_BUF_MIA,
  PLAYERS,
  SEASON,
  gamesRows,
  injuryRows,
  playerWeekRows,
  publishTables,
  rosterRows,
  weatherRows,
} from "./helpers/datasets.js";
import { openPublisher, openStore, percentile, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
let holder: Child | null = null;
beforeEach(async () => {
  t = tempCache();
  const pub = openPublisher(t);
  for (const [src, v, tables] of [
    ["nflverse:schedules", "s", gamesRows()],
    ["nflverse:injuries", "i", injuryRows()],
    ["nflverse:roster_weekly", "r", rosterRows()],
    ["nflverse:stats_player_week", "p", playerWeekRows([1, 2, 3], 950)],
    ["weather:open_meteo", "w", weatherRows("open_meteo", [GAME_BUF_MIA], 70)],
  ] as const) {
    const o = await publishTables(pub, src, v, tables);
    if (!o.ok) throw new Error(o.error);
  }
  pub.close();
  s = openStore(t);
});
afterEach(async () => {
  if (holder !== null) {
    holder.proc.kill("SIGKILL");
    await holder.exited();
    holder = null;
  }
  s.close();
  t.cleanup();
});

/** One fixture-mode analytics read: dataset reads + a points-cache miss and best-effort fill. */
function fixtureRead(i: number): { written: boolean } {
  const p = PLAYERS[i % PLAYERS.length];
  if (p === undefined) throw new Error("roster");
  const ids = PLAYERS.map((x) => x.gsis_id);
  const lines = s.datasets.playerWeeks.lines(ids, SEASON, [1, 2, 3]);
  if (lines.stamp === null || lines.rows.length === 0) throw new Error("no lines");
  s.datasets.schedules.games(SEASON, [1]);
  s.datasets.injuries.reports(SEASON, 3, ids);
  s.datasets.weather.forGames([GAME_BUF_MIA]);
  s.rosterWeekly.latest(SEASON);
  const hash = `settings-${String(i)}`; // unique: every read misses the cache
  if (s.repos.pointsCache.get(hash, p.gsis_id, SEASON, 1) !== null)
    throw new Error("expected a miss");
  const out = s.repos.pointsCache.put(hash, p.gsis_id, SEASON, 1, 12.3);
  return { written: out.written };
}

describe("A4a contention: a 3-s foreign writer lock", () => {
  it("50 fixture-mode reads: p95 < 300 ms, zero errors, every cache write a counted miss; a required write → STORE_BUSY ≤ 1 s", async () => {
    const statsFile = path.join(t.datasetDir, "nflverse__stats_player_week.sqlite");
    expect(statSync(statsFile).size).toBeLessThanOrEqual(300 * 1024);
    fixtureRead(0); // warm (statement compilation), outside the measurement
    const missesBefore = s.stats().cache_misses_busy;

    holder = run("lock-holder.mjs", [t.storePath, "3000"]);
    await holder.waitFor(/^LOCKED$/);
    const lockedAt = performance.now();

    const latencies: number[] = [];
    const errors: unknown[] = [];
    let written = 0;
    const requests = Array.from({ length: 50 }, (_, i) =>
      (async () => {
        const arrival = performance.now() + i * 10; // one request every 10 ms
        await sleep(Math.max(0, arrival - performance.now()));
        try {
          if (fixtureRead(i + 1).written) written += 1;
        } catch (e) {
          errors.push(e);
        }
        latencies.push(performance.now() - arrival);
      })(),
    );
    const recordStart = performance.now();
    const record = s.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null).then(
      () => ({ ok: true as const, ms: performance.now() - recordStart }),
      (e: unknown) => ({ ok: false as const, e, ms: performance.now() - recordStart }),
    );
    await Promise.all(requests);
    const rec = await record;
    const doneAt = performance.now();

    const p95 = percentile(latencies, 95);
    const diag = `p95=${p95.toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms run=${(doneAt - lockedAt).toFixed(0)}ms record=${rec.ms.toFixed(0)}ms`;
    // the whole run happened inside the lock window (so "every write a miss" is meaningful)
    expect(holder.out, diag).not.toContain("RELEASED");
    expect(errors, diag).toEqual([]);
    expect(latencies).toHaveLength(50);
    expect(p95, diag).toBeLessThan(300);
    expect(written, diag).toBe(0);
    expect(s.stats().cache_misses_busy - missesBefore, diag).toBe(50);
    expect(rec.ok).toBe(false);
    if (!rec.ok) {
      expect(rec.e).toBeInstanceOf(StoreBusyError);
      expect((rec.e as StoreBusyError).ffCode).toBe("STORE_BUSY");
    }
    expect(rec.ms, diag).toBeLessThanOrEqual(REQUIRED_WRITE_BUDGET_MS + 50);

    // after the lock: writes go through again, nothing was silently dropped from the log
    await holder.waitFor(/^RELEASED$/, 10_000);
    await sleep(300);
    expect(s.repos.pointsCache.put("after", PLAYERS[0]?.gsis_id ?? "", SEASON, 1, 1).written).toBe(
      true,
    );
    const after = await s.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    expect(s.repos.recommendationLog.get(after.log_id)).not.toBeNull();
  }, 30_000);
});
