// refresh-due.test.ts — `ff refresh due`, the one 15-minute tick (fixture mode, a fake clock, a
// counting transport over the fixture tree): a fresh install repairs every source, schedules first;
// a tick with nothing due makes ZERO requests and still records its heartbeat (job_run); --dry-run
// fetches and writes nothing; a held tick lock exits 0 with zero requests; a second schedules
// release with a flexed kickoff (or Week 18 set) is diffed into schedule_change rows and ONE
// collapsed notification; the --json shape; the schedules seasons include S+1.
import { chmodSync, copyFileSync, cpSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { loadRuntime } from "../../src/cli/io.js";
import { OSASCRIPT } from "../../src/cli/notify.js";
import { refresh, TICK_JOB, type RefreshOptions } from "../../src/cli/refresh.js";
import { fixtureFetch } from "../../src/cli/fixture-fetch.js";
import { storePath } from "../../src/config/paths.js";
import { fixedClock, type FixedClock } from "../../src/domain/clock.js";
import type { FetchLike } from "../../src/http/client.js";
import { REL } from "../sources/nflverse/helpers/harness.js";
import { rewrite } from "../sources/nflverse/helpers/rewrite.js";
import {
  fakeExec,
  fixtureEnv,
  FIXTURE_LEAGUE,
  FIXTURES,
  makeIo,
  sandbox,
  type Sandbox,
  type TestIo,
} from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

const MIN = 60_000;
const GAMES = `${REL}/schedules/games.parquet`;
const SCHEDULES_TS = `${REL}/schedules/timestamp.txt`;

/** A counting transport over the fixture tree (or `root`); `over` replaces a URL's bytes. */
function spy(
  over: ReadonlyMap<string, Uint8Array | string> = new Map(),
  root: string = FIXTURES,
): {
  fetch: FetchLike;
  calls: string[];
} {
  const base = fixtureFetch(root);
  const calls: string[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push(url);
      const o = over.get(url);
      return o === undefined ? base(url, init) : Promise.resolve(new Response(o));
    },
  };
}

interface Tick {
  readonly code: number;
  readonly io: TestIo;
  readonly calls: readonly string[];
  readonly out: string;
}

async function tick(
  s: Sandbox,
  clock: FixedClock,
  o: Partial<RefreshOptions> & {
    over?: ReadonlyMap<string, Uint8Array | string>;
    env?: Record<string, string>;
    platform?: NodeJS.Platform;
    exec?: TestIo["exec"];
    /**
     * Serve this copy of the fixture tree and refresh the seasons the schedule's phase names
     * (no FF_FIXTURE_DIR: the league file is a private copy of the placeholder league).
     */
    upstream?: string;
  } = {},
): Promise<Tick> {
  const base = o.upstream === undefined ? fixtureEnv() : { FF_LEAGUE_FILE: privateLeague(s) };
  const io = makeIo(s, {
    env: { ...base, FF_WEATHER_SOURCE: "off", ...(o.env ?? {}) },
    clock,
    ...(o.platform === undefined ? {} : { platform: o.platform }),
    ...(o.exec === undefined ? {} : { exec: o.exec }),
  });
  const { config, log } = await loadRuntime(io);
  const t = spy(o.over, o.upstream);
  const code = await refresh(
    io,
    config,
    log,
    {
      targets: o.targets ?? ["due"],
      ...(o.seasons === undefined ? {} : { seasons: o.seasons }),
      force: false,
      notify: o.notify ?? false,
      json: o.json ?? false,
      onDemand: false,
      noMigrate: false,
      expectVersion: null,
      dryRun: o.dryRun ?? false,
      transport: t.fetch,
    },
    new AbortController().signal,
  );
  return { code, io, calls: t.calls, out: io.out.text };
}

/** A private (0600) copy of the placeholder league in the sandbox (outside fixture mode). */
function privateLeague(s: Sandbox): string {
  const league = path.join(s.dir, "league.yaml");
  copyFileSync(FIXTURE_LEAGUE, league);
  chmodSync(league, 0o600);
  return league;
}

/** A copy of the fixture tree without `remove` (relative paths): an upstream missing those files. */
function upstreamWithout(s: Sandbox, ...remove: string[]): string {
  const root = path.join(s.dir, "upstream");
  cpSync(FIXTURES, root, { recursive: true });
  for (const r of remove) rmSync(path.join(root, r));
  return root;
}

const db = (s: Sandbox): DatabaseSync =>
  new DatabaseSync(storePath(s.cacheDir), { readOnly: true });
const rows = <T>(s: Sandbox, sql: string): T[] => {
  const d = db(s);
  try {
    return d.prepare(sql).all() as unknown as T[];
  } finally {
    d.close();
  }
};

describe("a fresh install: the first tick repairs every source, schedules first", () => {
  it("publishes the four nflverse sources (weather off), records the heartbeat, exit 0", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    const t = await tick(sb, clock);
    expect(t.code, t.out + t.io.err.text).toBe(EXIT.OK);
    const lines = t.out.split("\n").filter((l) => l !== "" && !l.startsWith("  "));
    // each decision is printed, the run's result follows it
    expect(lines.filter((l) => l.includes(" due repair")).map((l) => l.split(/\s+/)[0])).toEqual([
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
    ]);
    expect(lines.filter((l) => l.includes(" published "))).toHaveLength(4);
    expect(t.calls.indexOf(SCHEDULES_TS)).toBe(0);
    expect(
      rows<{ job: string; exit: number; summary: string }>(
        sb,
        "SELECT job, exit, summary FROM job_run",
      ),
    ).toEqual([
      {
        job: TICK_JOB,
        exit: 0,
        summary: "due=4 published=4 unchanged=0 skipped=0 failed=0",
      },
    ]);
    // the job lock is released
    expect(rows(sb, "SELECT job FROM job_lock")).toEqual([]);
  }, 60_000);
});

describe("nothing due", () => {
  it("a tick minutes later makes zero requests, writes only the heartbeat, exit 0", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    expect((await tick(sb, clock)).code).toBe(EXIT.OK);
    // the fixture instant is 12 h before a Thursday kickoff (hot: 30-min TTL, so the TTL guard is
    // due 13 min after a check); inside the 14-min politeness gap nothing is due
    for (const minutes of [1, 5, 6]) {
      clock.advance(minutes * MIN);
      const t = await tick(sb, clock);
      expect(t.code).toBe(EXIT.OK);
      expect(t.calls, String(minutes)).toEqual([]);
      expect(t.out).toMatch(/nflverse:schedules\s+not_due min_gap next /);
    }
    const hb = rows<{ last_run_at: string; summary: string }>(
      sb,
      "SELECT last_run_at, summary FROM job_run",
    );
    expect(hb).toEqual([
      { last_run_at: clock.nowIso(), summary: "due=0 published=0 unchanged=0 skipped=0 failed=0" },
    ]);
  }, 60_000);

  it("--dry-run explains each decision, fetches nothing and writes nothing", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    // before anything exists: every source is a repair; the store is not created
    const fresh = await tick(sb, clock, { dryRun: true, json: true });
    expect(fresh.code).toBe(EXIT.OK);
    expect(fresh.calls).toEqual([]);
    const doc = JSON.parse(fresh.out) as {
      target: string;
      decisions: { source: string; due: boolean; reason: string; next_at: string | null }[];
      results: unknown[];
    };
    expect(doc.target).toBe("due");
    expect(doc.results).toEqual([]);
    expect(doc.decisions.map((d) => [d.source, d.due, d.reason])).toEqual([
      ["nflverse:schedules", true, "repair"],
      ["nflverse:injuries", true, "repair"],
      ["nflverse:roster_weekly", true, "repair"],
      ["nflverse:stats_player_week", true, "repair"],
      ["weather", false, "not_due"],
    ]);
    const s0 = sb;
    expect(() => db(s0)).toThrow();

    await tick(sb, clock);
    const before = rows(sb, "SELECT * FROM refresh_log");
    const hb = rows(sb, "SELECT * FROM job_run");
    clock.advance(90 * MIN);
    const t = await tick(sb, clock, { dryRun: true });
    expect(t.code).toBe(EXIT.OK);
    expect(t.calls).toEqual([]);
    expect(t.out).toMatch(/^nflverse:schedules\s+(due|not_due) \w+/m);
    expect(rows(sb, "SELECT * FROM refresh_log")).toEqual(before);
    expect(rows(sb, "SELECT * FROM job_run")).toEqual(hb);
  }, 60_000);

  it("a tick lock held by another live process: exit 0, 'locked', zero requests, no heartbeat", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    await tick(sb, clock);
    clock.advance(120 * MIN);
    const w = new DatabaseSync(storePath(sb.cacheDir));
    w.prepare("INSERT INTO job_lock (job, pid, acquired_at, acquired_ms) VALUES (?, ?, ?, ?)").run(
      TICK_JOB,
      process.ppid,
      new Date(clock.nowMs() - 5 * MIN).toISOString(),
      clock.nowMs() - 5 * MIN,
    );
    w.prepare("DELETE FROM job_run").run();
    w.close();
    const t = await tick(sb, clock);
    expect(t.code).toBe(EXIT.OK);
    expect(t.out).toMatch(/locked/);
    expect(t.calls).toEqual([]);
    expect(rows(sb, "SELECT * FROM job_run")).toEqual([]);
  }, 60_000);
});

describe("a schedules release that moves kickoffs", () => {
  /** games.parquet with `edit` applied to every row, and a newer schedules timestamp. */
  async function release(
    stamp: string,
    edit: (r: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Map<string, Uint8Array | string>> {
    const bytes = await rewrite("schedules/games.excerpt.parquet", { rows: (rs) => rs.map(edit) });
    return new Map<string, Uint8Array | string>([
      [GAMES, bytes],
      [SCHEDULES_TS, stamp],
    ]);
  }

  it("a flexed kickoff (CHI@BUF Sat 20:20 → Sun 13:00 ET): one schedule_change row and ONE notification", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-12-08T12:00:00.000Z");
    expect((await tick(sb, clock)).code).toBe(EXIT.OK);
    clock.advance(61 * MIN);
    const over = await release("2026-12-08 08:46:39 EST", (r) =>
      r.game_id === "2026_15_CHI_BUF"
        ? { ...r, gameday: "2026-12-20", gametime: "13:00", weekday: "Sunday" }
        : r,
    );
    const fx = fakeExec();
    const t = await tick(sb, clock, { over, notify: true, platform: "darwin", exec: fx.exec });
    expect(t.code, t.out + t.io.err.text).toBe(EXIT.OK);
    expect(t.out).toMatch(/nflverse:schedules\s+published/);
    const changes = rows<Record<string, unknown>>(
      sb,
      "SELECT season, week, game_id, away, home, kind, old_value, new_value FROM schedule_change ORDER BY kind",
    );
    expect(changes).toContainEqual({
      season: 2026,
      week: 15,
      game_id: "2026_15_CHI_BUF",
      away: "CHI",
      home: "BUF",
      kind: "kickoff",
      old_value: "2026-12-20T01:20:00.000Z",
      new_value: "2026-12-20T18:00:00.000Z",
    });
    const shown = fx.calls.filter((c) => c.file === OSASCRIPT);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.args[1]).toMatch(/NFL schedule changed: CHI@BUF/);
    // the same release again (an on-demand child or a manual run): no duplicate rows
    clock.advance(61 * MIN);
    await tick(sb, clock, { over });
    expect(
      rows(
        sb,
        "SELECT * FROM schedule_change WHERE game_id = '2026_15_CHI_BUF' AND kind = 'kickoff'",
      ),
    ).toHaveLength(1);
  }, 90_000);

  it("Week 18 set from its placeholders: one row per moved game, no notification beyond 14 days", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-12-08T12:00:00.000Z");
    await tick(sb, clock);
    clock.advance(61 * MIN);
    let n = 0;
    const over = await release("2026-12-08 08:46:39 EST", (r) => {
      if (r.season !== 2026 || r.week !== 18) return r;
      n++;
      return n <= 2
        ? {
            ...r,
            gameday: "2027-01-09",
            gametime: n === 1 ? "16:30" : "20:00",
            weekday: "Saturday",
          }
        : n <= 8
          ? { ...r, gametime: "16:25" }
          : r;
    });
    const fx = fakeExec();
    const t = await tick(sb, clock, { over, notify: true, platform: "darwin", exec: fx.exec });
    expect(t.code).toBe(EXIT.OK);
    const moved = rows<{ game_id: string }>(
      sb,
      "SELECT DISTINCT game_id FROM schedule_change WHERE season = 2026 AND week = 18",
    );
    expect(moved).toHaveLength(8);
    expect(fx.calls.filter((c) => c.file === OSASCRIPT)).toEqual([]);
  }, 90_000);
});

describe("a season upstream has not published yet (injuries [S] from the May release to its first report)", () => {
  // The run of such a season writes no refresh_log row, only season_check rows. Before 2026-10-14
  // nothing the floor read saw it: the tick re-polled the season every quarter-hour (timestamp.txt
  // plus a 404, ~190 GitHub requests a day for months) and every answer reading injuries spawned a
  // child that polled it again.
  const INJ = (u: string): boolean => u.includes("/injuries/");

  it("a tick a minute later makes no injuries request; the next poll is the phase cadence later", async () => {
    sb = sandbox();
    const upstream = upstreamWithout(sb, "nflverse/injuries/injuries_2026.parquet");
    const clock = fixedClock("2026-06-01T12:00:00.000Z");
    const manual = (targets: string[], seasons: string) =>
      tick(sb!, clock, { upstream, targets, seasons });
    expect((await manual(["nflverse:schedules"], "2025,2026")).code).toBe(EXIT.OK);
    expect((await manual(["nflverse:injuries"], "2025")).code).toBe(EXIT.OK);

    clock.set("2026-09-05T12:00:00.000Z");
    // (the fixture tree has no 2025 stats file, so that source fails here: not what this test is about)
    const t1 = await tick(sb, clock, { upstream });
    expect(t1.out).toMatch(/nflverse:injuries\s+skipped\s+not_published/);
    expect(t1.calls.filter(INJ).length).toBeGreaterThan(0);

    clock.set("2026-09-05T12:01:00.000Z");
    const t2 = await tick(sb, clock, { upstream });
    expect(t2.calls.filter(INJ)).toEqual([]);
    expect(t2.out).toMatch(/nflverse:injuries\s+not_due min_gap/);
    clock.set("2026-09-05T12:02:00.000Z");
    const dry = await tick(sb, clock, { upstream, dryRun: true });
    expect(dry.out).toMatch(/nflverse:injuries\s+not_due min_gap/);

    // past the 14-minute floor the season is still not re-polled: the next check is the phase
    // cadence after the attempt (2 h around games, 6 h otherwise), and the tick then polls it
    clock.set("2026-09-05T12:16:00.000Z");
    const t3 = await tick(sb, clock, { upstream });
    expect(t3.calls.filter(INJ)).toEqual([]);
    clock.set("2026-09-05T12:17:00.000Z");
    const plan = JSON.parse(
      (await tick(sb, clock, { upstream, dryRun: true, json: true })).out,
    ) as { decisions: { source: string; due: boolean; reason: string; next_at: string | null }[] };
    const inj = plan.decisions.find((d) => d.source === "nflverse:injuries");
    expect(inj?.due).toBe(false);
    expect(inj?.reason).toBe("not_published");
    const next = Date.parse(inj?.next_at ?? "");
    expect(next - Date.parse("2026-09-05T12:00:00.000Z")).toBeGreaterThanOrEqual(118 * MIN);
    clock.set(Math.ceil(next / (15 * MIN)) * 15 * MIN);
    const t4 = await tick(sb, clock, { upstream });
    expect(t4.calls.filter(INJ).length).toBeGreaterThan(0);
    expect(t4.out).toMatch(/nflverse:injuries\s+skipped\s+not_published/);
  }, 120_000);
});

describe("the seasons each source asks for come from the schedule's phase (outside fixture mode)", () => {
  it("schedules S−1, S, S+1; injuries S; the phase season from the loaded schedule", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    const io = makeIo(sb, { env: { FF_WEATHER_SOURCE: "off" }, clock });
    const { config, log } = await loadRuntime(io);
    expect(config.fixtureDir).toBeNull();
    const t = spy();
    const code = await refresh(
      io,
      config,
      log,
      {
        targets: ["nflverse:schedules", "nflverse:injuries"],
        force: false,
        notify: false,
        json: true,
        onDemand: false,
        noMigrate: false,
        expectVersion: null,
        dryRun: false,
        transport: t.fetch,
      },
      new AbortController().signal,
    );
    expect(code, io.out.text + io.err.text).toBe(EXIT.OK);
    const doc = JSON.parse(io.out.text) as { results: { source: string; file_version: string }[] };
    // 2027 is not in the file yet: asked for, not held (the version names what was asked)
    expect(doc.results.find((r) => r.source === "nflverse:schedules")?.file_version).toMatch(
      /_2025-2026-2027$/,
    );
    expect(doc.results.find((r) => r.source === "nflverse:injuries")?.file_version).toMatch(
      /_2026$/,
    );
  }, 60_000);
});

describe("--json", () => {
  it("decisions + results, fixed fields", async () => {
    sb = sandbox();
    const clock = fixedClock("2026-10-01T12:00:00.000Z");
    const t = await tick(sb, clock, { json: true });
    const doc = JSON.parse(t.out) as {
      target: string;
      decisions: Record<string, unknown>[];
      results: Record<string, unknown>[];
    };
    expect(doc.target).toBe("due");
    expect(Object.keys(doc.decisions[0] ?? {}).sort()).toEqual([
      "due",
      "next_at",
      "reason",
      "source",
    ]);
    expect(Object.keys(doc.results[0] ?? {}).sort()).toEqual([
      "attempts",
      "file_version",
      "rows",
      "seasons",
      "source",
      "status",
      "warnings",
    ]);
  }, 60_000);
});
