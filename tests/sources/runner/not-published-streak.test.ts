// not-published-streak.test.ts — QA-1-037 (reopened): a successful run that reaches upstream and ends
// "skipped: not_published" (a new season before its first file — QA-1-033, plan 06 §2; exit 0) ends a
// failure streak like "published" and "unchanged" do (plan 01 §5.7: `ff status` shows per source
// "last success, last error, age, consecutive failures"), WITHOUT claiming the current file was
// checked: the file it keeps serving is the previous season's, so its checked_at — and with it the
// age and freshness every tool reports — stays what it was. Driven against the REAL publisher,
// refresh log and dataset file.
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seededRng, type FixedClock } from "../../../src/domain/clock.js";
import {
  fsTempArea,
  runRefresh,
  type RefreshDeps,
  type RefreshResult,
} from "../../../src/sources/runner.js";
import type { HttpGet } from "../../../src/sources/source.js";
import type { DatasetPublisher, Store } from "../../../src/store/types.js";
import { captureLog, netError } from "../../http/helpers.js";
import { injuryRows } from "../../store/helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import {
  fakePublisher,
  fakeRefreshLog,
  fakeSchedules,
  fakeSource,
  game,
  okRow,
  STATS,
} from "./helpers.js";

const SRC = "nflverse:injuries" as const;
const V2025 = "20260815T090000Z_2025";
const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

let t: TempCache;
let store: Store;
let pub: DatasetPublisher;
let clock: FixedClock;
let root = "";
beforeEach(async () => {
  t = tempCache("ff-np-streak-");
  store = openStore(t);
  pub = openPublisher(t);
  // one clock for the runner and the publisher, so every refresh_log instant is on one timeline
  clock = t.clock;
  root = await mkdtemp(join(tmpdir(), "ff-np-streak-tmp-"));
});
afterEach(async () => {
  pub.close();
  store.close();
  t.cleanup();
  await rm(root, { recursive: true, force: true });
});

function deps(): RefreshDeps {
  return {
    http: noHttp,
    clock,
    rng: seededRng(7),
    publisher: pub,
    refreshLog: store.repos.refreshLog,
    schedules: fakeSchedules([game("2026_01_NE_SEA", "2026-09-10T00:20:00.000Z")]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
}

const released = "2026-08-15T09:00:00.000Z";
const tmpFile = (ctx: { tempDir?: string }, season: number) => ({
  path: join(ctx.tempDir ?? root, `${String(season)}.parquet`),
  bytes: 1,
  season,
});

/** Last season's injuries, published: the file the new-season gap keeps serving. */
const publish2025 = () =>
  runRefresh(
    {
      source: fakeSource({
        version: () => Promise.resolve({ version: V2025, released_at: released }),
        fetch: (_v, ctx) => Promise.resolve([tmpFile(ctx, 2025)]),
        publish: (_f, w) => {
          let n = 0;
          for (const tr of injuryRows()) {
            w.createTable(tr.spec);
            n += w.insert(tr.spec.name, tr.rows);
          }
          return Promise.resolve({ ...STATS, rows: n, tables: [{ name: "ds_injuries", rows: n }] });
        },
      }),
      seasons: [2025],
      week: null,
    },
    deps(),
  );

/** The ways a run fails before publishing: each records one ok=0 row. */
const FAILURES = {
  network: () => fakeSource({ version: () => Promise.reject(netError("ECONNREFUSED")) }),
  internal: () => fakeSource({ version: () => Promise.reject(new Error("boom")) }),
  schema: () =>
    fakeSource({
      version: () => Promise.resolve({ version: "20260901T000000Z", released_at: released }),
      fetch: (_v, ctx) => Promise.resolve([tmpFile(ctx, 2026)]),
      assertSchema: () =>
        Promise.resolve({
          ok: false,
          missing_columns: ["gsis_id"],
          extra_columns: [],
          bad_codecs: [],
          rows: 0,
          warnings: [],
        }),
    }),
} as const;
type Failure = keyof typeof FAILURES;

const failRun = async (kind: Failure): Promise<RefreshResult> =>
  runRefresh({ source: FAILURES[kind](), seasons: [2026], week: null }, deps());

/** A run for the new season, which upstream has not published yet. */
const notPublishedRun = () =>
  runRefresh(
    {
      source: fakeSource({
        version: () => Promise.resolve({ version: "20260901T000000Z", released_at: released }),
        fetch: (_v, ctx) => {
          ctx.notPublished?.(2026);
          return Promise.resolve([]);
        },
      }),
      seasons: [2026],
      week: null,
    },
    deps(),
  );

const view = () => {
  const r = store.repos.refreshLog;
  const latest = r.latest(SRC);
  return {
    failures: r.consecutiveFailures(SRC),
    latestOk: latest?.ok ?? null,
    latestError: latest?.error ?? null,
    current: r.current().find((x) => x.source === SRC) ?? null,
  };
};
/** refresh_log rows of the source, read through a separate read-only connection. */
const rowCount = (): number => {
  const db = new DatabaseSync(t.storePath, { readOnly: true });
  try {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM refresh_log WHERE source = ?").get(SRC) as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
};

describe("[QA-1-037] a not_published run ends the failure streak and leaves the served file's age alone", () => {
  const SEQUENCES: readonly (readonly Failure[])[] = [
    ["network"],
    ["internal"],
    ["schema"],
    ["network", "network"],
    ["schema", "network", "internal"],
  ];

  it.each(SEQUENCES.map((seq) => ({ seq, name: seq.join(" → ") })))(
    "after $name: 0 consecutive failures, newest row a success, checked_at kept",
    async ({ seq }) => {
      expect((await publish2025()).status).toBe("published");
      const before = view().current;
      expect(before?.file_version).toBe(V2025);
      const fileBefore = statSync(before?.file ?? "").mtimeMs;
      for (const [i, kind] of seq.entries()) {
        clock.set(`2026-10-0${String(1 + i)}T10:30:00.000Z`);
        expect((await failRun(kind)).status).toBe("failed");
      }
      expect(view().failures).toBe(seq.length);
      expect(view().latestOk).toBe(false);
      const rows = rowCount();

      clock.set("2026-10-05T10:30:00.000Z");
      const r = await notPublishedRun();
      expect(r).toEqual({ status: "skipped", source: SRC, reason: "not_published" });
      const after = view();
      expect(after.failures).toBe(0);
      expect(after.latestOk).toBe(true);
      expect(after.latestError).toBeNull();
      // the same file, the same release, the same check time: last season's data does not turn fresh
      expect(after.current?.file_version).toBe(V2025);
      expect(after.current?.file).toBe(before?.file);
      expect(after.current?.checked_at).toBe(before?.checked_at);
      expect(after.current?.finished_at).toBe(before?.finished_at);
      expect(statSync(after.current?.file ?? "").mtimeMs).toBe(fileBefore);
      // exactly one recovery row; another not_published run adds none
      expect(rowCount()).toBe(rows + 1);
      clock.set("2026-10-06T10:30:00.000Z");
      expect((await notPublishedRun()).status).toBe("skipped");
      expect(rowCount()).toBe(rows + 1);
      expect(view().current?.checked_at).toBe(before?.checked_at);
      // a new failure starts a new streak of one
      expect((await failRun("network")).status).toBe("failed");
      expect(view().failures).toBe(1);
    },
  );

  it("control: with no failure before it, a not_published run writes nothing and changes nothing", async () => {
    expect((await publish2025()).status).toBe("published");
    const before = view();
    const rows = rowCount();
    clock.set("2026-10-02T10:30:00.000Z");
    expect((await notPublishedRun()).status).toBe("skipped");
    expect(rowCount()).toBe(rows);
    expect(view()).toEqual(before);
  });

  it("control: a source never published keeps its failures (there is no success to restore)", async () => {
    expect((await failRun("network")).status).toBe("failed");
    expect((await notPublishedRun()).status).toBe("skipped");
    expect(view().failures).toBe(1);
    expect(view().current).toBeNull();
  });

  it("the recovery is given the current row's own version and checked_at; a store that refuses it leaves the skip a success", async () => {
    const prev = okRow(SRC, V2025);
    const ok = fakePublisher();
    const r1 = await runRefresh(
      {
        source: fakeSource({
          fetch: (_v, ctx) => {
            ctx.notPublished?.(2026);
            return Promise.resolve([]);
          },
        }),
        seasons: [2026],
        week: null,
      },
      { ...deps(), publisher: ok, refreshLog: fakeRefreshLog([prev]) },
    );
    expect(r1.status).toBe("skipped");
    expect(ok.unchanged).toEqual([{ source: SRC, version: V2025, at: prev.checked_at }]);

    const cap = captureLog();
    const busy = fakePublisher(undefined, { throwOnUnchanged: true });
    const r2 = await runRefresh(
      {
        source: fakeSource({
          fetch: (_v, ctx) => {
            ctx.notPublished?.(2026);
            return Promise.resolve([]);
          },
        }),
        seasons: [2026],
        week: null,
      },
      { ...deps(), publisher: busy, refreshLog: fakeRefreshLog([prev]), log: cap.log },
    );
    expect(r2).toEqual({ status: "skipped", source: SRC, reason: "not_published" });
    expect(cap.lines.map((l) => l.event)).toContain("refresh.streak_not_ended");
  });
});
