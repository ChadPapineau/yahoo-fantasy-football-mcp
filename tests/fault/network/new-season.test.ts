// new-season.test.ts — the new-season window on the REFRESH path (QA-1-033; plan 06 §2 season
// awareness; plan 01 §5.7 "serve the last good data, fail loudly only on real failures"). From 1
// September the current season flips, and its per-season nflverse files do not exist until the
// season produces data (stats_player_week_2027.parquet answers 404 before the 2027 opener). A 404
// for a season that has not started yet is "not published yet": that season is dropped with a
// warning and the rest — the previous season E1's week-1 trailing window needs — is published;
// when nothing is published yet the run is skipped, not failed. A 404 for a past season, or for
// the current one well after its first kickoff, is a real failure, labelled `not_found` (never
// `network`). Real nflverse sources + real src/http client over a fake fetch serving the fixtures.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { scheduleView } from "../../../src/domain/league/calendar.js";
import { createHttpClient } from "../../../src/http/client.js";
import { injuriesSource, statsPlayerWeekSource } from "../../../src/sources/nflverse/index.js";
import {
  fsTempArea,
  isRefreshSuccess,
  runRefresh,
  type RefreshResult,
} from "../../../src/sources/runner.js";
import type { DataSource } from "../../../src/sources/source.js";
import type { ScheduleReader, SeasonCheckRow } from "../../../src/domain/analytics/types.js";
import { fakeFetch } from "../../http/helpers.js";
import { fixtureRoutes, REL } from "../../sources/nflverse/helpers/harness.js";
import { rewrite } from "../../sources/nflverse/helpers/rewrite.js";
import { scheduleReaderOf } from "../../helpers/season/reader.js";
import { syntheticSeasons } from "../../helpers/season/synthetic.js";
import { fakePublisher, fakeRefreshLog, fakeSchedules } from "../../sources/runner/helpers.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ff-new-season-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Schedules whose week-1 first kickoff per season is `kickoffs[season]` (else unknown). */
function schedulesWith(kickoffs: Record<number, string>): ScheduleReader {
  const base = fakeSchedules([]);
  return {
    games: base.games.bind(base),
    firstKickoff: (s, w) => (w === 1 ? (kickoffs[s] ?? null) : null),
  };
}

/** An in-memory season_check repository (record only, as the runner gets it). */
function seasonChecks(): {
  rows: SeasonCheckRow[];
  record(row: SeasonCheckRow): Promise<void>;
} {
  const rows: SeasonCheckRow[] = [];
  return {
    rows,
    record(row) {
      rows.push(row);
      return Promise.resolve();
    },
  };
}

async function refresh(
  source: DataSource,
  seasons: number[],
  now: string,
  schedules: ScheduleReader = fakeSchedules([]),
  extraRoutes: ReadonlyMap<string, Uint8Array | null> = new Map(),
) {
  const routes = fixtureRoutes();
  for (const [u, b] of extraRoutes) {
    if (b === null) routes.delete(u);
    else routes.set(u, b);
  }
  const checks = seasonChecks();
  const f = fakeFetch((url) => {
    const body = routes.get(url);
    return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
  });
  const client = createHttpClient({ fetch: f.fetch });
  const publisher = fakePublisher();
  const refreshLog = fakeRefreshLog();
  const result: RefreshResult = await runRefresh(
    { source, seasons, week: null },
    {
      http: client.get,
      download: client.download,
      clock: fixedClock(now),
      rng: seededRng(3),
      publisher,
      refreshLog,
      schedules,
      temp: fsTempArea(join(root, "tmp")),
      sleep: () => Promise.resolve(),
      seasonChecks: checks,
    },
  );
  return {
    result,
    publisher,
    refreshLog,
    checks: checks.rows,
    calls: f.calls.map((c) => c.url),
  };
}

describe("[QA-1-033] a season whose files are not published yet", () => {
  it("stats on 1 Sept 2027: 2027 answers 404 → dropped with a warning; 2026 is published (exit 0)", async () => {
    const r = await refresh(statsPlayerWeekSource, [2026, 2027], "2027-09-01T12:00:00.000Z");
    expect(r.result.status).toBe("published");
    if (r.result.status !== "published") return;
    expect(r.result.stats.seasons).toEqual([2026]);
    expect(r.result.warnings.join("\n")).toMatch(/2027.*not published/);
    // the version names only the seasons the file holds, so a later run (2027 published) is never
    // skipped as "unchanged" against a file without 2027
    expect(r.result.file_version).toMatch(/_2026$/);
    expect(r.publisher.published.map((p) => p.version)).toEqual([r.result.file_version]);
    expect(r.refreshLog.rows).toEqual([]); // no failure row
    expect(r.calls.some((u) => u.endsWith("stats_player_week_2027.parquet"))).toBe(true);
  });

  it("the same in week 1, with schedules loaded (first kickoff a day ago)", async () => {
    const r = await refresh(
      statsPlayerWeekSource,
      [2026, 2027],
      "2027-09-10T12:00:00.000Z",
      schedulesWith({ 2027: "2027-09-10T00:20:00.000Z" }),
    );
    expect(r.result.status).toBe("published");
  });

  it("injuries on 1 Sept 2027 (only 2027 asked for): nothing published yet → skipped, not failed", async () => {
    const r = await refresh(injuriesSource, [2027], "2027-09-01T12:00:00.000Z");
    expect(r.result).toMatchObject({ status: "skipped", reason: "not_published" });
    expect(r.publisher.published).toEqual([]);
    expect(r.refreshLog.rows).toEqual([]);
    expect(r.checks).toEqual([
      {
        source: "nflverse:injuries",
        season: 2027,
        checked_at: "2027-09-01T12:00:00.000Z",
        status: "not_published",
      },
    ]);
  });
});

describe("[QA-1-033] a 404 that IS a failure is labelled not_found, never network", () => {
  it("a past season's file answering 404", async () => {
    const r = await refresh(injuriesSource, [2024, 2026], "2026-10-01T12:00:00.000Z");
    expect(r.result).toMatchObject({ status: "failed", error: "not_found" });
    expect(r.publisher.published).toEqual([]);
    expect(r.refreshLog.rows[0]).toMatchObject({ ok: false, error: "not_found" });
  });

  it("the current season's file still 404 weeks after its first kickoff", async () => {
    const r = await refresh(
      statsPlayerWeekSource,
      [2026, 2027],
      "2027-10-30T12:00:00.000Z",
      schedulesWith({ 2027: "2027-09-10T00:20:00.000Z" }),
    );
    expect(r.result).toMatchObject({ status: "failed", error: "not_found" });
    expect(r.publisher.published).toEqual([]);
  });
});

describe("a new season's file that exists upstream with zero rows is not published yet, never `schema`", () => {
  const url = (season: number): string => `${REL}/injuries/injuries_${String(season)}.parquet`;
  const empty = async (): Promise<Uint8Array> =>
    rewrite("injuries/injuries_2026.parquet", { rows: () => [] });

  for (const season of [2027, 2028, 2030]) {
    it(`injuries ${String(season)} in early September: skipped not_published (exit 0), season_check recorded, no failure row`, async () => {
      const now = `${String(season)}-09-03T12:00:00.000Z`;
      const r = await refresh(
        injuriesSource,
        [season],
        now,
        fakeSchedules([]),
        new Map([[url(season), await empty()]]),
      );
      expect(r.result).toMatchObject({ status: "skipped", reason: "not_published", until: null });
      expect(isRefreshSuccess(r.result)).toBe(true);
      expect(r.calls).toContain(url(season)); // it was fetched: upstream answered
      expect(r.publisher.published).toEqual([]);
      expect(r.refreshLog.rows).toEqual([]);
      expect(r.checks).toEqual([
        { source: "nflverse:injuries", season, checked_at: now, status: "not_published" },
      ]);
    });
  }

  it("published seasons beside it are published and flipped to `published` in season_check", async () => {
    const r = await refresh(
      statsPlayerWeekSource,
      [2026, 2027],
      "2027-09-01T12:00:00.000Z",
      fakeSchedules([]),
    );
    expect(r.result.status).toBe("published");
    expect(r.checks.map((c) => [c.season, c.status])).toEqual([
      [2027, "not_published"],
      [2026, "published"],
    ]);
  });

  it("a past season's empty file is still a schema failure (no data must never replace data)", async () => {
    const r = await refresh(
      injuriesSource,
      [2025],
      "2026-10-01T12:00:00.000Z",
      fakeSchedules([]),
      new Map([[url(2025), await empty()]]),
    );
    expect(r.result).toMatchObject({ status: "failed", error: "schema" });
    expect(r.checks).toEqual([]);
  });
});

describe("the season in progress comes from the loaded schedule's phase, never the calendar month", () => {
  for (const S of [2027, 2028, 2029, 2030]) {
    it(`${String(S)}: in August with ${String(S)}'s schedule loaded (preseason ${String(S)}), a 404 for ${String(S - 1)} is a real failure`, async () => {
      const schedule = scheduleReaderOf(syntheticSeasons([S]));
      const now = `${String(S)}-08-20T12:00:00.000Z`;
      expect(scheduleView(schedule, Date.parse(now)).phase).toMatchObject({
        season: S,
        phase: "preseason",
      });
      const gone = new Map([[`${REL}/injuries/injuries_${String(S - 1)}.parquet`, null]]);
      const r = await refresh(injuriesSource, [S - 1], now, schedule, gone);
      expect(r.result).toMatchObject({ status: "failed", error: "not_found" });
      // and S itself, not out yet, is "not published" (a skip, exit 0)
      const r2 = await refresh(injuriesSource, [S], now, schedule);
      expect(r2.result).toMatchObject({ status: "skipped", reason: "not_published" });
    });

    it(`${String(S)}: with no schedule loaded the bootstrap rule applies (August belongs to ${String(S - 1)})`, async () => {
      const gone = new Map([[`${REL}/injuries/injuries_${String(S - 1)}.parquet`, null]]);
      const r = await refresh(
        injuriesSource,
        [S - 1],
        `${String(S)}-08-20T12:00:00.000Z`,
        fakeSchedules([]),
        gone,
      );
      expect(r.result).toMatchObject({ status: "skipped", reason: "not_published" });
    });
  }
});
