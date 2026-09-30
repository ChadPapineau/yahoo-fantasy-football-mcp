// write-class.test.ts — plan 01 §5.3 (OBJ-11) / plan 03 L9, §1.2: best-effort writes wait at most
// BUSY_TIMEOUT_MS and turn a foreign writer lock into a counted miss (never an error); required
// writes retry in ≤ 100 ms steps, yielding to the event loop, then reject with StoreBusyError
// within REQUIRED_WRITE_BUDGET_MS; a lock released mid-budget lets the required write through.
// The lock is held by a SECOND process (tests/store/helpers/lock-holder.mjs).
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBusyError, WriteExecutor } from "../../src/store/sqlite.js";
import {
  BUSY_TIMEOUT_MS,
  REQUIRED_WRITE_BUDGET_MS,
  StoreBusyError,
  type Store,
} from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";
import { run, type Child } from "./helpers/spawn.js";

let t: TempCache;
let s: Store;
let holder: Child | null = null;
beforeEach(() => {
  t = tempCache();
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

async function holdLock(ms: number): Promise<Child> {
  holder = run("lock-holder.mjs", [t.storePath, String(ms)]);
  await holder.waitFor(/^LOCKED$/);
  return holder;
}

describe("best-effort writes under a foreign writer lock", () => {
  it("return {written:false, reason:'busy'} after ≤ ~100 ms, count a miss, never throw", async () => {
    await holdLock(3000);
    const t0 = performance.now();
    const out = s.repos.pointsCache.put("h", "00-0034857", 2026, 3, 10);
    const dt = performance.now() - t0;
    expect(out).toEqual({ written: false, reason: "busy" });
    expect(dt).toBeLessThan(BUSY_TIMEOUT_MS * 2.5);
    expect(s.stats().cache_misses_busy).toBe(1);
    // every best-effort family behaves the same; within the backoff window they do not even wait
    const t1 = performance.now();
    expect(s.repos.limiterState.setLast999("k", t.clock.nowIso())).toEqual({
      written: false,
      reason: "busy",
    });
    expect(
      s.repos.platformCache.put({
        key: "/k",
        body: "b",
        parsed_json: null,
        fetched_at: t.clock.nowIso(),
        refresh_rate_s: null,
        http_status: 200,
      }),
    ).toEqual({ written: false, reason: "busy" });
    expect(s.repos.crosswalk.touch("yahoo", ["1"], t.clock.nowIso())).toEqual({
      written: false,
      reason: "busy",
    });
    expect(
      s.repos.projections.put({
        subject: { kind: "player", gsis_id: "00-0034857" },
        season: 2026,
        week: 4,
        model_version: "v1-trailing",
        made_at: t.clock.nowIso(),
        inputs_as_of: t.clock.nowIso(),
        expectation: {},
        samples: [],
      }),
    ).toEqual({ written: false, reason: "busy" });
    expect(s.repos.platformCache.prune(t.clock.nowIso())).toBe(0);
    expect(performance.now() - t1).toBeLessThan(BUSY_TIMEOUT_MS);
    expect(s.stats().cache_misses_busy).toBe(6);
    // reads keep working (WAL)
    expect(s.repos.pointsCache.get("h", "00-0034857", 2026, 3)).toBeNull();
  });

  it("writes again once the lock is gone", async () => {
    const h = await holdLock(150);
    expect(s.repos.pointsCache.put("h", "00-0034857", 2026, 3, 10).written).toBe(false);
    await h.waitFor(/^RELEASED$/);
    await sleep(300); // past the backoff window
    expect(s.repos.pointsCache.put("h", "00-0034857", 2026, 3, 10)).toEqual({ written: true });
    expect(s.repos.pointsCache.get("h", "00-0034857", 2026, 3)).toBe(10);
  });
});

describe("required writes under a foreign writer lock", () => {
  it("reject with StoreBusyError (STORE_BUSY) within ≤ 1 s, having retried, and store nothing", async () => {
    await holdLock(3000);
    const t0 = performance.now();
    let err: unknown;
    try {
      await s.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    } catch (e) {
      err = e;
    }
    const dt = performance.now() - t0;
    expect(err).toBeInstanceOf(StoreBusyError);
    expect((err as StoreBusyError).ffCode).toBe("STORE_BUSY");
    expect((err as StoreBusyError).table).toBe("recommendation_log");
    expect(dt).toBeLessThanOrEqual(REQUIRED_WRITE_BUDGET_MS + 50);
    expect(dt).toBeGreaterThan(REQUIRED_WRITE_BUDGET_MS / 2);
    expect((err as StoreBusyError).waitedMs).toBeLessThanOrEqual(REQUIRED_WRITE_BUDGET_MS);
    expect(
      s.repos.recommendationLog.list({
        league_key: "manual.l.example",
        season: null,
        week: null,
        kind: null,
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(0);
  });

  it("poll without blocking: the event loop keeps turning while a required write waits", async () => {
    await holdLock(3000);
    const gaps: number[] = [];
    let last = performance.now();
    let ticking = true;
    const tick = async (): Promise<void> => {
      while (ticking) {
        await sleep(5);
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
    };
    const ticker = tick();
    await expect(
      s.repos.crosswalk.upsertDelta([
        {
          platform: "yahoo",
          platform_player_id: "30977",
          gsis_id: "00-0034857",
          method: "id",
          source: "nflverse:roster_weekly",
          confidence: 1,
          first_seen: t.clock.nowIso(),
          last_seen: t.clock.nowIso(),
        },
      ]),
    ).rejects.toBeInstanceOf(StoreBusyError);
    ticking = false;
    await ticker;
    expect(gaps.length).toBeGreaterThan(5);
    expect(Math.max(...gaps)).toBeLessThan(BUSY_TIMEOUT_MS);
  });

  it("succeed when the lock is released inside the budget", async () => {
    await holdLock(300);
    const r = await s.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    expect(r.deduplicated).toBe(false);
    expect(s.repos.recommendationLog.get(r.log_id)).not.toBeNull();
  });

  it("every required family surfaces StoreBusyError with its table", async () => {
    await holdLock(8000);
    const now = t.clock.nowIso();
    const cases: [string, () => Promise<unknown>][] = [
      [
        "refresh_log",
        () =>
          s.repos.refreshLog.record({
            source: "nflverse:injuries",
            file: null,
            file_version: null,
            release_updated_at: null,
            seasons: [],
            rows: null,
            columns_hash: null,
            started_at: now,
            finished_at: now,
            ok: false,
            error: "network",
            checked_at: now,
          }),
      ],
      ["job_lock", () => s.repos.jobLock.acquire("j", process.pid, now, 1000)],
      [
        "transactions_seen",
        () =>
          s.repos.transactionsSeen.appendNew(
            "manual.l.example",
            [
              {
                transaction_key: "t",
                type: "add",
                status: "successful",
                timestamp: now,
                faab_bid: null,
                waiver_priority: null,
                players: [],
                trader_team_key: null,
                tradee_team_key: null,
                note: null,
              },
            ],
            now,
          ),
      ],
      [
        "scoreboard_snapshot",
        () =>
          s.repos.scoreboardSnapshots.put({
            league_key: "manual.l.example",
            week: 1,
            taken_at: now,
            matchups_json: "[]",
          }),
      ],
    ];
    const results = await Promise.allSettled(cases.map(([, f]) => f()));
    results.forEach((r, i) => {
      expect(r.status).toBe("rejected");
      const reason = (r as PromiseRejectedResult).reason as StoreBusyError;
      expect(reason).toBeInstanceOf(StoreBusyError);
      expect(reason.table).toBe(cases[i]?.[0]);
    });
  }, 15_000);
});

describe("WriteExecutor unit", () => {
  const busy = Object.assign(new Error("database is locked"), { errcode: 5 });
  it("classifies busy/locked (incl. extended codes) only", () => {
    expect(isBusyError(busy)).toBe(true);
    expect(isBusyError({ errcode: 6 })).toBe(true);
    expect(isBusyError({ errcode: 517 })).toBe(true); // SQLITE_BUSY_SNAPSHOT
    expect(isBusyError({ errcode: 19 })).toBe(false);
    expect(isBusyError({ errcode: "5" })).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError("busy")).toBe(false);
  });
  it("non-busy errors propagate from both classes", async () => {
    const w = new WriteExecutor(200);
    expect(() =>
      w.bestEffort(() => {
        throw new TypeError("x");
      }),
    ).toThrow(TypeError);
    await expect(
      w.required("crosswalk", () => {
        throw new TypeError("y");
      }),
    ).rejects.toThrow(TypeError);
  });
  it("a required write that is busy once then succeeds resolves", async () => {
    const w = new WriteExecutor(500);
    let n = 0;
    await expect(
      w.required("crosswalk", () => {
        n += 1;
        if (n < 3) throw busy;
        return n;
      }),
    ).resolves.toBe(3);
  });
  it("gives up without overrunning a small budget", async () => {
    const w = new WriteExecutor(30);
    const t0 = performance.now();
    await expect(
      w.required("crosswalk", () => {
        const e = performance.now() + 10;
        while (performance.now() < e);
        throw busy;
      }),
    ).rejects.toBeInstanceOf(StoreBusyError);
    expect(performance.now() - t0).toBeLessThan(80);
  });
});
