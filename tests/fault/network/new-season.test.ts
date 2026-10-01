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
import { createHttpClient } from "../../../src/http/client.js";
import { injuriesSource, statsPlayerWeekSource } from "../../../src/sources/nflverse/index.js";
import { fsTempArea, runRefresh, type RefreshResult } from "../../../src/sources/runner.js";
import type { DataSource } from "../../../src/sources/source.js";
import type { ScheduleReader } from "../../../src/domain/analytics/types.js";
import { fakeFetch } from "../../http/helpers.js";
import { fixtureRoutes } from "../../sources/nflverse/helpers/harness.js";
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

async function refresh(
  source: DataSource,
  seasons: number[],
  now: string,
  schedules: ScheduleReader = fakeSchedules([]),
) {
  const routes = fixtureRoutes();
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
    },
  );
  return { result, publisher, refreshLog, calls: f.calls.map((c) => c.url) };
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
