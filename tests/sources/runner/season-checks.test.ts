// season-checks.test.ts — a season upstream has not published yet is recorded per (source, season)
// in season_check (the tools then say "not published upstream yet", never "run ff refresh"), and a
// later publish of that season flips it to `published`. QA-1-037 kept: the not-published run never
// advances the current (other season's) file's checked_at. Seasons 2027–2030; real store for
// season_check; fake source and publisher.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import type { HttpGet, SourceContext, TempFile } from "../../../src/sources/source.js";
import type { Store } from "../../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "../../store/helpers/env.js";
import {
  fakePublisher,
  fakeRefreshLog,
  fakeSchedules,
  fakeSource,
  okRow,
  STATS,
} from "./helpers.js";

const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

let t: TempCache;
let store: Store;
let root = "";
beforeEach(async () => {
  t = tempCache("ff-season-checks-");
  store = openStore(t);
  root = await mkdtemp(join(tmpdir(), "ff-sc-tmp-"));
});
afterEach(async () => {
  store.close();
  t.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** A per-season source: `missing` seasons are reported not published, the rest fetched. */
function seasonal(missing: ReadonlySet<number>) {
  return fakeSource({
    fetch: (_v, ctx: SourceContext): Promise<readonly TempFile[]> => {
      const out: TempFile[] = [];
      for (const s of ctx.seasons) {
        if (missing.has(s)) ctx.notPublished?.(s);
        else
          out.push({
            path: join(ctx.tempDir ?? root, `${String(s)}.parquet`),
            bytes: 1,
            season: s,
          });
      }
      return Promise.resolve(out);
    },
    publish: (files) =>
      Promise.resolve({
        ...STATS,
        seasons: files.map((f) => f.season ?? 0).filter((s) => s > 0),
      }),
  });
}

function deps(now: string, over: Partial<RefreshDeps> = {}): RefreshDeps {
  return {
    http: noHttp,
    clock: fixedClock(now),
    rng: seededRng(9),
    publisher: fakePublisher(),
    refreshLog: fakeRefreshLog(),
    schedules: fakeSchedules([]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
    seasonChecks: store.repos.seasonChecks,
    ...over,
  };
}

describe("season_check follows upstream, season by season", () => {
  for (const S of [2027, 2028, 2029, 2030]) {
    it(`${String(S)}: not published in early September → recorded; published later → flipped`, async () => {
      const early = `${String(S)}-09-02T12:00:00.000Z`;
      const prev = { ...okRow("nflverse:injuries", "v-prev"), seasons: [S - 1] };
      const log = fakeRefreshLog([prev]);
      const pub = fakePublisher();
      const r = await runRefresh(
        { source: seasonal(new Set([S])), seasons: [S], week: null },
        deps(early, { refreshLog: log, publisher: pub }),
      );
      expect(r).toMatchObject({ status: "skipped", reason: "not_published", until: null });
      expect(store.repos.seasonChecks.latest("nflverse:injuries", S)).toEqual({
        source: "nflverse:injuries",
        season: S,
        checked_at: early,
        status: "not_published",
      });
      // QA-1-037: the S−1 file's check time is NOT advanced by a run that published nothing
      expect(pub.unchanged).toEqual([
        { source: "nflverse:injuries", version: "v-prev", at: prev.checked_at },
      ]);
      expect(log.rows).toEqual([prev]);

      const later = `${String(S)}-09-12T12:00:00.000Z`;
      const r2 = await runRefresh(
        { source: seasonal(new Set()), seasons: [S], week: null },
        deps(later),
      );
      expect(r2.status).toBe("published");
      expect(store.repos.seasonChecks.latest("nflverse:injuries", S)).toEqual({
        source: "nflverse:injuries",
        season: S,
        checked_at: later,
        status: "published",
      });
    });
  }

  it("every instant a run records is its START, however long the run takes (the floor counts from it)", async () => {
    // a run recorded when it ended (a slow download, a retry) left the next quarter-hour tick less
    // than 14 min after the "attempt": `min_gap`, and the pregame 15-minute cadence became 30
    for (const S of [2027, 2028, 2029, 2030])
      for (const slowS of [61, 90, 120]) {
        const start = `${String(S)}-09-01T12:00:00.000Z`;
        const clock = fixedClock(start);
        const slow = seasonal(new Set([S]));
        const fetch = slow.fetch.bind(slow);
        slow.fetch = async (v, ctx) => {
          clock.advance(slowS * 1000);
          return fetch(v, ctx);
        };
        const pub = fakePublisher();
        const r = await runRefresh(
          { source: slow, seasons: [S - 1, S], week: null },
          deps(start, { clock, publisher: pub }),
        );
        expect(r.status).toBe("published");
        // the refresh_log row's started_at, and both seasons' checks, are the run's start
        expect(pub.published.map((p) => p.startedAt)).toEqual([start]);
        expect(
          store.repos.seasonChecks
            .all()
            .filter((c) => c.season >= S - 1)
            .map((c) => c.checked_at),
        ).toEqual([start, start]);
        // an unchanged release whose version check is slow is checked at the run's start too
        const again = `${String(S)}-09-01T13:00:00.000Z`;
        const clock2 = fixedClock(again);
        const pub2 = fakePublisher();
        const src = fakeSource({
          version: () => {
            clock2.advance(slowS * 1000);
            return Promise.resolve({ version: "v-same", released_at: null });
          },
        });
        const r2 = await runRefresh(
          { source: src, seasons: [S], week: null },
          deps(again, {
            clock: clock2,
            publisher: pub2,
            refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "v-same")]),
            checkDataset: () => "ok",
          }),
        );
        expect(r2.status).toBe("unchanged");
        expect(pub2.unchanged).toEqual([
          { source: "nflverse:injuries", version: "v-same", at: again },
        ]);
      }
  });

  it("a mixed run records each season's own state", async () => {
    const r = await runRefresh(
      { source: seasonal(new Set([2028])), seasons: [2027, 2028], week: null },
      deps("2028-09-01T12:00:00.000Z"),
    );
    expect(r.status).toBe("published");
    expect(store.repos.seasonChecks.all().map((c) => [c.season, c.status])).toEqual([
      [2027, "published"],
      [2028, "not_published"],
    ]);
  });

  it("without a season_check port the run behaves as before (nothing recorded, same result)", async () => {
    const { seasonChecks: _dropped, ...without } = deps("2029-09-01T12:00:00.000Z");
    const r = await runRefresh(
      { source: seasonal(new Set([2029])), seasons: [2029], week: null },
      without,
    );
    expect(r).toMatchObject({ status: "skipped", reason: "not_published" });
    expect(store.repos.seasonChecks.all()).toEqual([]);
  });

  it("a failing season_check write never changes the result", async () => {
    const r = await runRefresh(
      { source: seasonal(new Set([2029])), seasons: [2029], week: null },
      {
        ...deps("2029-09-01T12:00:00.000Z"),
        seasonChecks: { record: () => Promise.reject(new Error("busy")) },
      },
    );
    expect(r).toMatchObject({ status: "skipped", reason: "not_published" });
  });
});
