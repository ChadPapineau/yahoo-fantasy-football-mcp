// run-start-lock.test.ts — the run-start lock (`refresh:<source>`, src/store/run-lock.ts) taken by
// the runner BEFORE its first request: two concurrent runs of one source make one release check and
// one download — the other is `skipped: locked` with zero requests — and the lock is released on
// every path (success, schema failure, network failure, abort). A dead pid's lock is taken over.
// Real store + job_lock; a fake source counts the requests it would make.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import type { HttpGet } from "../../../src/sources/source.js";
import { createRunLock, runLockJob, type RunLock } from "../../../src/store/run-lock.js";
import { storeInternalsOf } from "../../../src/store/store.js";
import type { Store } from "../../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import { fakePublisher, fakeRefreshLog, fakeSchedules, fakeSource } from "./helpers.js";

const NOW = "2026-10-01T12:00:00.000Z";
const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

let t: TempCache;
let store: Store;
let root = "";
beforeEach(async () => {
  t = tempCache("ff-run-lock-");
  store = openStore(t);
  root = await mkdtemp(join(tmpdir(), "ff-rl-tmp-"));
});
afterEach(async () => {
  store.close();
  t.cleanup();
  await rm(root, { recursive: true, force: true });
});

const lockOf = (): RunLock =>
  createRunLock({
    jobLock: store.repos.jobLock,
    clock: fixedClock(NOW),
    pid: process.pid,
    scope: t.storePath,
  });

function deps(lock: RunLock | undefined): RefreshDeps {
  return {
    http: noHttp,
    clock: fixedClock(NOW),
    rng: seededRng(5),
    publisher: fakePublisher(),
    refreshLog: fakeRefreshLog(),
    schedules: fakeSchedules([]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
    ...(lock === undefined ? {} : { runLock: lock }),
  };
}

const lockRows = (): { job: string; pid: number }[] => {
  const db = storeInternalsOf(store)?.db;
  if (db === undefined) throw new Error("no db");
  return db.prepare("SELECT job, pid FROM job_lock ORDER BY job").all() as unknown as {
    job: string;
    pid: number;
  }[];
};

/** A deferred promise. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

describe("two concurrent runs of one source", () => {
  for (const id of [
    "nflverse:schedules",
    "nflverse:injuries",
    "nflverse:stats_player_week",
  ] as DatasetSourceId[]) {
    it(`${id}: one release check + one download; the other skipped locked with zero requests`, async () => {
      const hold = gate();
      const src = fakeSource({
        id,
        fetch: async (_v, ctx) => {
          await hold.promise; // the first run is mid-download when the second starts
          return [{ path: join(ctx.tempDir ?? root, "f.parquet"), bytes: 1, season: 2026 }];
        },
      });
      // two processes' worth of runs (two locks over one store, one per run)
      const first = runRefresh({ source: src, seasons: [2026], week: null }, deps(lockOf()));
      await new Promise((r) => setTimeout(r, 20));
      const pending = runRefresh({ source: src, seasons: [2026], week: null }, deps(lockOf()));
      // without the lock the second run would wait on the same download: bounded, never a hang
      const second = await Promise.race([
        pending,
        new Promise((r) => {
          setTimeout(() => {
            r("still downloading");
          }, 2_000);
        }),
      ]);
      hold.open();
      await pending;
      expect(second).toEqual({ status: "skipped", source: id, reason: "locked", until: null });
      expect(src.calls.version).toBe(1);
      expect((await first).status).toBe("published");
      expect(src.calls).toMatchObject({ version: 1, fetch: 1, publish: 1 });
      expect(lockRows()).toEqual([]);
    });
  }

  it("without a run lock both runs check the release (what the lock prevents)", async () => {
    const hold = gate();
    const src = fakeSource({
      fetch: async (_v, ctx) => {
        await hold.promise;
        return [{ path: join(ctx.tempDir ?? root, "f.parquet"), bytes: 1, season: 2026 }];
      },
    });
    const a = runRefresh({ source: src, seasons: [2026], week: null }, deps(undefined));
    const b = runRefresh({ source: src, seasons: [2026], week: null }, deps(undefined));
    await new Promise((r) => setTimeout(r, 20));
    hold.open();
    await Promise.all([a, b]);
    expect(src.calls.version).toBe(2);
  });

  it("different sources never block each other", async () => {
    const lock = lockOf();
    const a = fakeSource({ id: "nflverse:injuries" });
    const b = fakeSource({ id: "nflverse:roster_weekly" });
    const [ra, rb] = await Promise.all([
      runRefresh({ source: a, seasons: [2026], week: null }, deps(lock)),
      runRefresh({ source: b, seasons: [2026], week: null }, deps(lock)),
    ]);
    expect([ra.status, rb.status]).toEqual(["published", "published"]);
  });
});

describe("the lock is released on every path", () => {
  const cases: [string, Parameters<typeof fakeSource>[0], string][] = [
    ["success", {}, "published"],
    [
      "schema failure",
      {
        assertSchema: () =>
          Promise.resolve({
            ok: false,
            missing_columns: ["gsis_id"],
            extra_columns: [],
            bad_codecs: [],
            rows: 0,
            warnings: [],
          }),
      },
      "failed",
    ],
    [
      "network failure",
      { version: () => Promise.reject(new HttpError({ kind: "dns", host: "github.com" })) },
      "failed",
    ],
    ["a throwing source", { fetch: () => Promise.reject(new TypeError("boom")) }, "failed"],
  ];
  for (const [label, opts, status] of cases)
    it(label, async () => {
      const r = await runRefresh(
        { source: fakeSource(opts), seasons: [2026], week: null },
        deps(lockOf()),
      );
      expect(r.status).toBe(status);
      expect(lockRows()).toEqual([]);
    });

  it("abort mid-download: aborted, lock released, temp directory removed", async () => {
    const ac = new AbortController();
    const src = fakeSource({
      fetch: (_v, ctx) =>
        new Promise((_res, rej) => {
          ctx.signal.addEventListener("abort", () => {
            rej(new HttpError({ kind: "aborted", host: "github.com" }));
          });
          setTimeout(() => {
            ac.abort();
          }, 10);
        }),
    });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null, signal: ac.signal },
      deps(lockOf()),
    );
    expect(r).toMatchObject({ status: "failed", error: "aborted" });
    expect(lockRows()).toEqual([]);
  });
});

describe("a stale or dead holder", () => {
  it("a lock left by a dead pid is taken over", async () => {
    const db = storeInternalsOf(store)?.db;
    if (db === undefined) throw new Error("no db");
    const ms = Date.parse(NOW) - 60_000;
    db.prepare("INSERT INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)").run(
      runLockJob("nflverse:injuries"),
      2 ** 31 - 2,
      new Date(ms).toISOString(),
      ms,
    );
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps(lockOf()),
    );
    expect(r.status).toBe("published");
    expect(lockRows()).toEqual([]);
  });

  it("a live holder in another process: skipped locked, zero requests, its lock untouched", async () => {
    const db = storeInternalsOf(store)?.db;
    if (db === undefined) throw new Error("no db");
    const ms = Date.parse(NOW) - 60_000;
    db.prepare("INSERT INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)").run(
      runLockJob("nflverse:injuries"),
      process.ppid,
      new Date(ms).toISOString(),
      ms,
    );
    const src = fakeSource();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps(lockOf()));
    expect(r).toMatchObject({ status: "skipped", reason: "locked" });
    expect(src.calls.version).toBe(0);
    expect(lockRows()).toEqual([{ job: runLockJob("nflverse:injuries"), pid: process.ppid }]);
  });

  it("a run lock that cannot be taken (store failure) fails as store, with zero requests", async () => {
    const src = fakeSource();
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      {
        ...deps(undefined),
        runLock: {
          acquire: () => Promise.reject(new Error("busy")),
          release: () => Promise.resolve(),
        },
      },
    );
    expect(r).toMatchObject({ status: "failed", error: "store" });
    expect(src.calls.version).toBe(0);
  });
});

describe("the gate runs under the lock, before any request", () => {
  it("a closed gate skips with its reason and until, zero requests, lock released", async () => {
    const src = fakeSource();
    const seen: DatasetSourceId[] = [];
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      {
        ...deps(lockOf()),
        gate: (s) => {
          seen.push(s);
          // the gate sees the lock held by this run
          expect(lockRows()).toEqual([{ job: runLockJob(s), pid: process.pid }]);
          return { run: false, reason: "provider_backoff", until: "2026-10-01T13:00:00.000Z" };
        },
      },
    );
    expect(r).toEqual({
      status: "skipped",
      source: "nflverse:injuries",
      reason: "provider_backoff",
      until: "2026-10-01T13:00:00.000Z",
    });
    expect(seen).toEqual(["nflverse:injuries"]);
    expect(src.calls.version).toBe(0);
    expect(lockRows()).toEqual([]);
  });

  it("an open gate lets the run go ahead", async () => {
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      { ...deps(lockOf()), gate: () => ({ run: true }) },
    );
    expect(r.status).toBe("published");
  });
});
