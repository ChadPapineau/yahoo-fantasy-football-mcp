// season-fresh.test.ts — migration 003 and its repositories (the schedule-driven refresh): the four
// tables (STRICT, CHECK constraints, the expression dedup index), the upgrade of a v2 store, a newer
// store refused by an older binary; schedule_change (idempotent append, validation, ordering — as a
// property over seasons, weeks and detection instants), job_run, season_check, provider_backoff,
// their prunes; and the run-start lock (`refresh:<source>`) with its read-only view.
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduleChange } from "../../src/domain/analytics/types.js";
import { MIGRATION_003_SQL } from "../../src/store/migrations/003_season_fresh.js";
import { MIGRATIONS, readSchemaVersion } from "../../src/store/migrations/index.js";
import { RECENT_CHANGES_MAX } from "../../src/store/repos/season-fresh.js";
import { createRunLock, RUN_LOCK_STALE_MS, runLockJob } from "../../src/store/run-lock.js";
import { storeInternalsOf } from "../../src/store/store.js";
import {
  MIGRATION_003_TABLES,
  StoreVersionError,
  WRITE_CLASS_003,
  type Store,
} from "../../src/store/types.js";
import { openStore, tempCache, type TempCache } from "./helpers/env.js";
import { recordInput } from "./helpers/records.js";

let t: TempCache;
let s: Store;
beforeEach(() => {
  t = tempCache("ff-sfresh-");
  s = openStore(t);
});
afterEach(() => {
  s.close();
  t.cleanup();
});

const db = (): DatabaseSync => {
  const i = storeInternalsOf(s);
  if (i === null) throw new Error("no internals");
  return i.db;
};

const iso = (ms: number): string => new Date(ms).toISOString();

const change = (over: Partial<ScheduleChange> = {}): ScheduleChange => ({
  detected_at: "2026-12-08T14:05:00.000Z",
  release_updated_at: "2026-12-08T13:46:39.000Z",
  season: 2026,
  week: 15,
  game_id: "2026_15_CHI_BUF",
  away: "CHI",
  home: "BUF",
  kind: "kickoff",
  old_value: "2026-12-20T01:20:00.000Z",
  new_value: "2026-12-20T18:00:00.000Z",
  ...over,
});

describe("migration 003: season_fresh", () => {
  it("is registered as version 3 after 002, creating the four tables", () => {
    expect(MIGRATIONS.map((m) => [m.version, m.name])).toEqual([
      [1, "initial"],
      [2, "reclog_dedup_scope"],
      [3, "season_fresh"],
    ]);
    expect(Object.keys(WRITE_CLASS_003).sort()).toEqual([...MIGRATION_003_TABLES].sort());
    const tables = db()
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as { name: string; sql: string }[];
    for (const name of MIGRATION_003_TABLES) {
      const sql = tables.find((x) => x.name === name)?.sql ?? "";
      expect(sql, name).toMatch(/\) STRICT$/);
    }
    for (const sql of MIGRATION_003_SQL) expect(sql).not.toMatch(/\bds_/);
  });

  it("CHECK constraints refuse an unknown kind, status or reason", () => {
    const d = db();
    expect(() =>
      d
        .prepare(
          "INSERT INTO schedule_change (detected_at, season, week, game_id, away, home, kind) VALUES ('x', 2026, 1, 'g', 'A', 'B', 'moved')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      d
        .prepare(
          "INSERT INTO season_check (source, season, checked_at, status) VALUES ('s', 2026, 'x', 'maybe')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      d
        .prepare(
          "INSERT INTO provider_backoff (provider, until_at, reason, set_at) VALUES ('p', 'x', 'bored', 'x')",
        )
        .run(),
    ).toThrow(/CHECK/);
    // STRICT: a text season is refused
    expect(() =>
      d
        .prepare(
          "INSERT INTO season_check (source, season, checked_at, status) VALUES ('s', 'twenty', 'x', 'published')",
        )
        .run(),
    ).toThrow();
  });

  it("the dedup index folds NULL old/new/release values, so a repeated change is one row", () => {
    const d = db();
    const ins = d.prepare(
      "INSERT INTO schedule_change (detected_at, release_updated_at, season, week, game_id, away, home, kind, old_value, new_value) VALUES (?, NULL, 2026, 1, 'g', 'A', 'B', 'added', NULL, ?)",
    );
    ins.run("2026-09-01T00:00:00.000Z", "x");
    expect(() => ins.run("2026-09-02T00:00:00.000Z", "x")).toThrow(/UNIQUE/);
  });

  it("upgrades a v2 store holding records (pre-migration backup, nothing lost); an older binary then refuses it", async () => {
    s.close();
    t.cleanup();
    t = tempCache("ff-sfresh-up-");
    const v2 = openStore(t, {}, { migrations: MIGRATIONS.slice(0, 2) });
    const r = await v2.repos.recommendationLog.record(recordInput(), t.clock.nowIso(), null);
    expect(v2.schemaVersion).toBe(2);
    v2.close();

    s = openStore(t);
    expect(s.schemaVersion).toBe(3);
    expect(s.repos.recommendationLog.get(r.log_id)?.log_id).toBe(r.log_id);
    await s.repos.jobRuns.record({
      job: "refresh-due",
      last_run_at: t.clock.nowIso(),
      exit: 0,
      summary: null,
    });
    s.close();
    const raw = new DatabaseSync(t.storePath, { readOnly: true });
    expect(readSchemaVersion(raw)).toBe(3);
    raw.close();

    // the binary before this migration refuses the store instead of misreading it
    expect(() => openStore(t, {}, { migrations: MIGRATIONS.slice(0, 2) })).toThrow(
      StoreVersionError,
    );
    s = openStore(t);
  });
});

describe("scheduleChanges", () => {
  it("append is idempotent on (game, kind, old, new, release) and resolves to rows inserted", async () => {
    expect(await s.repos.scheduleChanges.append([change()])).toBe(1);
    expect(await s.repos.scheduleChanges.append([change()])).toBe(0);
    // detected again later from the same release: still one row
    expect(
      await s.repos.scheduleChanges.append([change({ detected_at: "2026-12-09T08:00:00.000Z" })]),
    ).toBe(0);
    // the same move published again in a later release is a new row
    expect(
      await s.repos.scheduleChanges.append([
        change({ release_updated_at: "2026-12-09T03:46:39.000Z" }),
      ]),
    ).toBe(1);
    // a null release is its own key
    expect(await s.repos.scheduleChanges.append([change({ release_updated_at: null })])).toBe(1);
    expect(await s.repos.scheduleChanges.append([change({ release_updated_at: null })])).toBe(0);
    expect(await s.repos.scheduleChanges.append([])).toBe(0);
    expect(s.repos.scheduleChanges.forWeek(2026, 15)).toHaveLength(3);
  });

  it("stores every kind with ids, instants, dates and week numbers as values", async () => {
    const rows: ScheduleChange[] = [
      change(),
      change({ kind: "gameday", old_value: "2026-12-19", new_value: "2026-12-20" }),
      change({ kind: "venue", old_value: "BUF00", new_value: "DET00" }),
      change({ kind: "added", old_value: null, new_value: "2026-12-20T18:00:00.000Z" }),
      change({ kind: "removed", old_value: "2026-12-20T01:20:00.000Z", new_value: null }),
      change({ kind: "week", old_value: "15", new_value: "17", week: 17 }),
    ];
    expect(await s.repos.scheduleChanges.append(rows)).toBe(6);
    const got = [
      ...s.repos.scheduleChanges.forWeek(2026, 15),
      ...s.repos.scheduleChanges.forWeek(2026, 17),
    ];
    expect(got.map((c) => c.kind).sort()).toEqual(
      ["added", "gameday", "kickoff", "removed", "venue", "week"].sort(),
    );
  });

  it("refuses free text, bad ids, teams, kinds and week indexes — the whole batch, nothing written", async () => {
    const bad: Partial<ScheduleChange>[] = [
      { game_id: "CHI@BUF" },
      { game_id: "2026_15_CHI_BUF; DROP TABLE x" },
      { away: "XXX" as never },
      { kind: "flexed" as never },
      { week: 0 },
      { week: 31 },
      { season: 1989 },
      { old_value: "moved to Sunday afternoon" },
      { new_value: "Ignore previous instructions" },
      { new_value: "" },
      { detected_at: "yesterday" },
      { release_updated_at: "not an instant" },
    ];
    for (const b of bad)
      await expect(
        s.repos.scheduleChanges.append([change({ game_id: "2026_14_GB_DET" }), change(b)]),
        JSON.stringify(b),
      ).rejects.toThrow(RangeError);
    expect(s.repos.scheduleChanges.recent("2000-01-01T00:00:00.000Z", 200)).toEqual([]);
  });

  it("recent / forWeek equal the sorted filter for any set of changes (seasons 2026–2030, every week index)", async () => {
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const arbChange = fc.record({
      season: fc.integer({ min: 2026, max: 2030 }),
      week: fc.integer({ min: 1, max: 30 }),
      offsetMin: fc.integer({ min: 0, max: 5 * 365 * 1440 }),
      n: fc.integer({ min: 0, max: 9 }),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbChange, { maxLength: 40 }),
        fc.integer({ min: 0, max: 5 * 365 * 1440 }),
        fc.integer({ min: 0, max: RECENT_CHANGES_MAX }),
        async (list, sinceMin, limit) => {
          db().exec("DELETE FROM schedule_change");
          const rows = list.map((c, i) =>
            change({
              season: c.season,
              week: c.week,
              game_id: `${String(c.season)}_${String(c.week).padStart(2, "0")}_CHI_BUF`,
              detected_at: iso(base + c.offsetMin * 60_000),
              new_value: `${String(c.n)}${String(i)}`,
            }),
          );
          await s.repos.scheduleChanges.append(rows);
          const since = iso(base + sinceMin * 60_000);
          const want = rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => r.detected_at >= since)
            .sort((a, b) =>
              a.r.detected_at === b.r.detected_at
                ? b.i - a.i
                : a.r.detected_at < b.r.detected_at
                  ? 1
                  : -1,
            )
            .slice(0, limit)
            .map(({ r }) => r);
          expect(s.repos.scheduleChanges.recent(since, limit)).toEqual(want);
          for (const c of list.slice(0, 3)) {
            const wk = rows.filter((r) => r.season === c.season && r.week === c.week);
            expect(new Set(s.repos.scheduleChanges.forWeek(c.season, c.week))).toEqual(new Set(wk));
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it("instants are stored canonically, so a non-canonical `since` still compares right", async () => {
    await s.repos.scheduleChanges.append([change({ detected_at: "2026-12-08T09:05:00-05:00" })]);
    expect(s.repos.scheduleChanges.recent("2026-12-08T14:05:00Z", 10)).toHaveLength(1);
    expect(s.repos.scheduleChanges.recent("2026-12-08T14:05:00.001Z", 10)).toHaveLength(0);
    expect(s.repos.scheduleChanges.recent("2026-12-08T14:05:00Z", 10)[0]?.detected_at).toBe(
      "2026-12-08T14:05:00.000Z",
    );
    expect(() => s.repos.scheduleChanges.recent("2026-12-08", RECENT_CHANGES_MAX + 1)).toThrow(
      RangeError,
    );
    expect(() => s.repos.scheduleChanges.forWeek(2026, 31)).toThrow(RangeError);
  });

  it("prune removes changes detected before the cut only", async () => {
    await s.repos.scheduleChanges.append([
      change({ detected_at: "2025-09-01T00:00:00.000Z", game_id: "2025_01_CHI_BUF", season: 2025 }),
      change({ detected_at: "2026-12-08T14:05:00.000Z" }),
    ]);
    expect(await s.repos.scheduleChanges.prune("2026-01-01T00:00:00.000Z")).toBe(1);
    expect(s.repos.scheduleChanges.recent("2000-01-01T00:00:00.000Z", 10)).toHaveLength(1);
  });
});

describe("jobRuns", () => {
  it("keeps one row per job (the newest run), listed by job", async () => {
    await s.repos.jobRuns.record({
      job: "store-prune",
      last_run_at: "2026-10-11T07:00:00Z",
      exit: 0,
      summary: null,
    });
    await s.repos.jobRuns.record({
      job: "refresh-due",
      last_run_at: "2026-10-14T12:00:00.000Z",
      exit: 1,
      summary: "due=2 published=1 unchanged=0 skipped=0 failed=1",
    });
    await s.repos.jobRuns.record({
      job: "refresh-due",
      last_run_at: "2026-10-14T12:15:00.000Z",
      exit: 0,
      summary: "due=0 published=0 unchanged=0 skipped=0 failed=0",
    });
    expect(s.repos.jobRuns.list()).toEqual([
      {
        job: "refresh-due",
        last_run_at: "2026-10-14T12:15:00.000Z",
        exit: 0,
        summary: "due=0 published=0 unchanged=0 skipped=0 failed=0",
      },
      { job: "store-prune", last_run_at: "2026-10-11T07:00:00.000Z", exit: 0, summary: null },
    ]);
  });

  it("refuses a bad job name, exit code, instant or summary", async () => {
    const ok = { job: "refresh-due", last_run_at: t.clock.nowIso(), exit: 0, summary: null };
    for (const bad of [
      { job: "Refresh Due" },
      { job: "" },
      { exit: -1 },
      { exit: 256 },
      { exit: 1.5 },
      { last_run_at: "soon" },
      { summary: "x".repeat(201) },
      { summary: "line\nbreak" },
    ])
      await expect(s.repos.jobRuns.record({ ...ok, ...bad }), JSON.stringify(bad)).rejects.toThrow(
        RangeError,
      );
    expect(s.repos.jobRuns.list()).toEqual([]);
  });
});

describe("seasonChecks", () => {
  it("upserts on (source, season): not_published flips to published; latest/all read it back", async () => {
    for (const season of [2027, 2028, 2029, 2030]) {
      await s.repos.seasonChecks.record({
        source: "nflverse:injuries",
        season,
        checked_at: iso(Date.parse(`${String(season)}-09-05T12:00:00Z`)),
        status: "not_published",
      });
      expect(s.repos.seasonChecks.latest("nflverse:injuries", season)?.status).toBe(
        "not_published",
      );
      await s.repos.seasonChecks.record({
        source: "nflverse:injuries",
        season,
        checked_at: iso(Date.parse(`${String(season)}-09-12T12:00:00Z`)),
        status: "published",
      });
      expect(s.repos.seasonChecks.latest("nflverse:injuries", season)).toEqual({
        source: "nflverse:injuries",
        season,
        checked_at: `${String(season)}-09-12T12:00:00.000Z`,
        status: "published",
      });
      expect(s.repos.seasonChecks.latest("nflverse:stats_player_week", season)).toBeNull();
    }
    expect(s.repos.seasonChecks.all().map((r) => r.season)).toEqual([2027, 2028, 2029, 2030]);
  });

  it("refuses an unknown source/status and a bad season; prune drops old checks", async () => {
    const ok = {
      source: "nflverse:injuries" as const,
      season: 2027,
      checked_at: t.clock.nowIso(),
      status: "not_published" as const,
    };
    for (const bad of [
      { source: "nflverse:nope" },
      { status: "maybe" },
      { season: 1989 },
      { season: 2027.5 },
      { checked_at: "" },
    ])
      await expect(
        s.repos.seasonChecks.record({ ...ok, ...bad } as never),
        JSON.stringify(bad),
      ).rejects.toThrow(RangeError);
    expect(() => s.repos.seasonChecks.latest("x" as never, 2027)).toThrow(RangeError);
    await s.repos.seasonChecks.record({ ...ok, checked_at: "2025-09-01T00:00:00.000Z" });
    await s.repos.seasonChecks.record({ ...ok, season: 2028 });
    expect(await s.repos.seasonChecks.prune("2026-01-01T00:00:00.000Z")).toBe(1);
    expect(s.repos.seasonChecks.all().map((r) => r.season)).toEqual([2028]);
  });
});

describe("providerBackoff", () => {
  it("set / get / clear per provider; prune drops pauses that ended", async () => {
    await s.repos.providerBackoff.set({
      provider: "nflverse",
      until_at: "2026-10-14T13:00:00Z",
      reason: "rate_limited",
      set_at: "2026-10-14T12:00:00Z",
    });
    await s.repos.providerBackoff.set({
      provider: "weather:nws",
      until_at: "2026-10-14T12:30:00Z",
      reason: "server_error",
      set_at: "2026-10-14T12:00:00Z",
    });
    expect(s.repos.providerBackoff.get("nflverse")).toEqual({
      provider: "nflverse",
      until_at: "2026-10-14T13:00:00.000Z",
      reason: "rate_limited",
      set_at: "2026-10-14T12:00:00.000Z",
    });
    expect(s.repos.providerBackoff.get("weather:open_meteo")).toBeNull();
    expect(await s.repos.providerBackoff.prune("2026-10-14T12:45:00Z")).toBe(1);
    expect(s.repos.providerBackoff.get("weather:nws")).toBeNull();
    await s.repos.providerBackoff.clear("nflverse");
    expect(s.repos.providerBackoff.get("nflverse")).toBeNull();
  });

  it("refuses an unknown provider or reason", async () => {
    const ok = {
      provider: "nflverse" as const,
      until_at: t.clock.nowIso(),
      reason: "rate_limited" as const,
      set_at: t.clock.nowIso(),
    };
    for (const bad of [{ provider: "github" }, { reason: "bored" }, { until_at: "later" }])
      await expect(s.repos.providerBackoff.set({ ...ok, ...bad } as never)).rejects.toThrow(
        RangeError,
      );
    expect(() => s.repos.providerBackoff.get("github" as never)).toThrow(RangeError);
    await expect(s.repos.providerBackoff.clear("github" as never)).rejects.toThrow(RangeError);
  });
});

describe("run-start lock (refresh:<source>)", () => {
  /** A live pid that is not ours (the test runner's parent). */
  const other = process.ppid;
  /** A pid with no process. */
  const dead = 2 ** 31 - 2;

  const insertLock = (source: string, pid: number, ms: number): void => {
    db()
      .prepare(
        "INSERT OR REPLACE INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)",
      )
      .run(`refresh:${source}`, pid, iso(ms), ms);
  };

  it("one holder per source: a second acquire (another run in this process) is refused until release", async () => {
    const a = createRunLock({
      jobLock: s.repos.jobLock,
      clock: t.clock,
      pid: process.pid,
      scope: t.storePath,
    });
    const b = createRunLock({
      jobLock: s.repos.jobLock,
      clock: t.clock,
      pid: process.pid,
      scope: t.storePath,
    });
    expect(await a.acquire("nflverse:injuries")).toBe(true);
    expect(await b.acquire("nflverse:injuries")).toBe(false);
    expect(await b.acquire("nflverse:schedules")).toBe(true);
    // b never held injuries: its release changes nothing
    await b.release("nflverse:injuries");
    expect(await b.acquire("nflverse:injuries")).toBe(false);
    await a.release("nflverse:injuries");
    expect(await b.acquire("nflverse:injuries")).toBe(true);
    await b.release("nflverse:injuries");
    await b.release("nflverse:schedules");
    expect(db().prepare("SELECT COUNT(*) AS n FROM job_lock").get()).toEqual({ n: 0 });
  });

  it("another live process's lock is respected; a dead pid's or a stale one is taken over", async () => {
    const lock = createRunLock({
      jobLock: s.repos.jobLock,
      clock: t.clock,
      pid: process.pid,
      scope: t.storePath,
    });
    const now = t.clock.nowMs();
    insertLock("nflverse:injuries", other, now - 60_000);
    expect(await lock.acquire("nflverse:injuries")).toBe(false);
    insertLock("nflverse:injuries", dead, now - 60_000);
    expect(await lock.acquire("nflverse:injuries")).toBe(true);
    await lock.release("nflverse:injuries");
    insertLock("nflverse:roster_weekly", other, now - RUN_LOCK_STALE_MS - 1);
    expect(await lock.acquire("nflverse:roster_weekly")).toBe(true);
    await lock.release("nflverse:roster_weekly");
  });

  it("runLocks.held sees only another live process's fresh lock", () => {
    const now = t.clock.nowMs();
    expect(s.repos.runLocks.held("nflverse:injuries")).toBeNull();
    insertLock("nflverse:injuries", other, now - 60_000);
    expect(s.repos.runLocks.held("nflverse:injuries")).toEqual({
      pid: other,
      acquired_at: iso(now - 60_000),
    });
    // the publisher's commit lock is not a run lock
    expect(runLockJob("nflverse:injuries")).toBe("refresh:nflverse:injuries");
    insertLock("nflverse:schedules", dead, now);
    expect(s.repos.runLocks.held("nflverse:schedules")).toBeNull();
    insertLock("nflverse:stats_player_week", other, now - RUN_LOCK_STALE_MS - 1);
    expect(s.repos.runLocks.held("nflverse:stats_player_week")).toBeNull();
    insertLock("weather:nws", process.pid, now);
    expect(s.repos.runLocks.held("weather:nws")).toBeNull();
    expect(() => s.repos.runLocks.held("nope" as never)).toThrow(RangeError);
  });
});
