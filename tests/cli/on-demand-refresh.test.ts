// on-demand-refresh.test.ts — src/cli/on-demand-refresh.ts (season-fresh spec §6.3): the
// answer-time orchestrator with an injected spawner and fake timers (systemClock + setTimeout under
// vi.useFakeTimers, so the clock and every wait move together). Single-flight per source, the 6 s /
// 15 s budgets, stale-while-revalidate (an unfinished child is never killed by a budget), the
// 3-children and 20-spawns-per-hour caps, joining another process's run lock through refresh_log,
// outcomes from the child's JSON cross-checked with refresh_log, a spawn or version failure disabling
// the process's on-demand refresh, `background` never waiting and `off` never spawning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleCalendar, type GameCalendar } from "../../src/config/game-calendar.js";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type { OnDemandMode, WeatherSource } from "../../src/config/schema.js";
import type {
  BackoffProvider,
  ProviderBackoffRow,
  RefreshLogRow,
  StoreStats,
} from "../../src/domain/analytics/types.js";
import { systemClock } from "../../src/domain/clock.js";
import type { ScheduleView } from "../../src/domain/league/calendar.js";
import {
  CHILD_ENV_KEYS,
  createOnDemandRefresher,
  type ChildHandle,
  type OnDemandPorts,
  type OnDemandRefresher,
  type Spawner,
} from "../../src/cli/on-demand-refresh.js";
import type { RefreshReport, RefreshSourceReport } from "../../src/mcp/services.js";

const H = 3_600_000;
const MIN = 60_000;
/** Sunday 2026-11-29 15:00 UTC (10:00 ET): a 13:00 ET kickoff is 3 h away — a game-day window. */
const T0 = Date.parse("2026-11-29T15:00:00.000Z");
const KICKOFF = Date.parse("2026-11-29T18:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

// --- fakes ----------------------------------------------------------------------------------------------

/** An in-memory refresh_log with the repository's read semantics. */
class FakeLog {
  readonly rows: RefreshLogRow[] = [];
  current(): RefreshLogRow[] {
    const out = new Map<string, RefreshLogRow>();
    for (const r of this.rows) if (r.ok) out.set(r.source, r);
    return [...out.values()];
  }
  latest(source: DatasetSourceId): RefreshLogRow | null {
    return this.rows.filter((r) => r.source === source).at(-1) ?? null;
  }
  consecutiveFailures(source: DatasetSourceId): number {
    let n = 0;
    for (const r of this.rows.filter((x) => x.source === source).reverse()) {
      if (r.ok) break;
      n += 1;
    }
    return n;
  }
  /** A published (or re-checked) file. */
  ok(source: DatasetSourceId, version: string, atMs: number, checkedMs = atMs): void {
    this.rows.push({
      source,
      file: `ds/${source}.sqlite`,
      file_version: version,
      release_updated_at: iso(atMs - H),
      seasons: [2026],
      rows: 10,
      columns_hash: "h",
      started_at: iso(atMs - 1000),
      finished_at: iso(atMs),
      ok: true,
      error: null,
      checked_at: iso(checkedMs),
    });
  }
  /** The release re-checked, unchanged. */
  check(source: DatasetSourceId, atMs: number): void {
    const cur = this.current().find((r) => r.source === source);
    if (cur === undefined) throw new Error("check of a never-loaded source");
    this.rows.push({ ...cur, started_at: iso(atMs - 500), checked_at: iso(atMs) });
  }
  fail(source: DatasetSourceId, error: string, atMs: number): void {
    this.rows.push({
      source,
      file: null,
      file_version: null,
      release_updated_at: null,
      seasons: [],
      rows: null,
      columns_hash: null,
      started_at: iso(atMs - 1000),
      finished_at: iso(atMs),
      ok: false,
      error,
      checked_at: iso(atMs),
    });
  }
}

interface FakeChild {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly kills: string[];
  exit(code: number | null, stdout?: string): void;
  fail(code: string): void;
}

function fakeSpawner(): { spawn: Spawner; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: Spawner = (cmd, args, opts) => {
    let resolve!: (r: { code: number | null; stdout: string }) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<{ code: number | null; stdout: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const kills: string[] = [];
    children.push({
      cmd,
      args,
      env: opts.env,
      kills,
      exit: (code, stdout = "") => {
        resolve({ code, stdout });
      },
      fail: (code) => {
        reject(Object.assign(new Error("spawn failed"), { code }));
      },
    });
    const handle: ChildHandle = {
      pid: 4000 + children.length,
      done,
      kill: (signal) => {
        kills.push(signal);
      },
    };
    return handle;
  };
  return { spawn, children };
}

/** The `ff refresh --json` stdout for some results. */
function json(...results: Record<string, unknown>[]): string {
  return JSON.stringify({ target: "x", results });
}

interface Rig {
  log: FakeLog;
  locks: Map<DatasetSourceId, { pid: number; acquired_at: string }>;
  backoff: Map<BackoffProvider, ProviderBackoffRow>;
  spawner: ReturnType<typeof fakeSpawner>;
  lines: { level: string; event: string; fields: unknown }[];
  calendar: GameCalendar;
  make(mode?: OnDemandMode, weather?: WeatherSource): OnDemandRefresher;
}

function rig(): Rig {
  const log = new FakeLog();
  const locks = new Map<DatasetSourceId, { pid: number; acquired_at: string }>();
  const backoff = new Map<BackoffProvider, ProviderBackoffRow>();
  const spawner = fakeSpawner();
  const lines: Rig["lines"] = [];
  const logger = Object.fromEntries(
    (["error", "warn", "info", "debug"] as const).map((level) => [
      level,
      (event: string, fields?: unknown) => lines.push({ level, event, fields }),
    ]),
  ) as unknown as Parameters<typeof createOnDemandRefresher>[0]["logger"];
  const calendar = scheduleCalendar({
    kickoffs: [KICKOFF, KICKOFF + 3 * H],
    outdoorKickoffs: [KICKOFF, KICKOFF + 3 * H],
    fileVersion: "sched-v1",
  });
  const r: Rig = {
    log,
    locks,
    backoff,
    spawner,
    lines,
    calendar,
    make: (mode = "wait", weather = "open-meteo") => {
      const ports: OnDemandPorts = {
        refreshLog: log,
        providerBackoff: { get: (p) => backoff.get(p) ?? null },
        runLocks: { held: (s) => locks.get(s) ?? null },
        storeStats: (): StoreStats => ({
          path: "x",
          size_bytes: 0,
          schema_version: 3,
          cache_misses_busy: 0,
          attached: log.current().map((c) => ({
            source: c.source,
            schema: "s",
            file: c.file ?? "",
            file_version: c.file_version ?? "",
            inode: 1,
            mtime_ms: 0,
            size_bytes: 1,
            attached_at: c.finished_at,
          })),
        }),
        scheduleView: () => ({ calendar: r.calendar }) as unknown as ScheduleView,
      };
      return createOnDemandRefresher(
        {
          mode,
          entry: "/pkg/dist/cli.js",
          execPath: "/opt/node/bin/node",
          env: {
            HOME: "/home/u",
            FF_CACHE_DIR: "/home/u/.cache/ff",
            YAHOO_CLIENT_SECRET: "never-passed",
            ODDS_API_KEY: "never-passed",
            PATH: "/usr/bin",
          },
          version: "9.9.9",
          weatherSource: weather,
          clock: systemClock,
          logger,
          spawn: spawner.spawn,
        },
        ports,
      );
    },
  };
  return r;
}

const row = (rep: RefreshReport | null, source: string): RefreshSourceReport | undefined =>
  rep?.sources.find((s) => s.source === source);

let t: Rig;
beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  t = rig();
  // every source loaded and last checked 2 h ago (the fast tier is due a revalidation)
  for (const s of [
    "nflverse:schedules",
    "nflverse:injuries",
    "nflverse:roster_weekly",
    "nflverse:stats_player_week",
  ] as const)
    t.log.ok(s, `${s}-v1`, T0 - 2 * H);
});
afterEach(() => {
  vi.useRealTimers();
});

const RID = (i: number): string => `r-${String(i).padStart(12, "0")}`;

describe("single flight per source", () => {
  it("5 concurrent calls for injuries start 1 child; all resolve on its exit", async () => {
    const r = t.make();
    const calls = Array.from({ length: 5 }, (_, i) =>
      r.ensureFresh(["nflverse:injuries"], { requestId: RID(i) }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.spawner.children).toHaveLength(1);
    t.log.check("nflverse:injuries", Date.now());
    t.spawner.children[0]!.exit(
      0,
      json({ source: "nflverse:injuries", status: "unchanged", version: "v", attempts: 1 }),
    );
    const reports = await Promise.all(calls);
    for (const rep of reports) {
      expect(rep?.mode).toBe("wait");
      expect(row(rep, "nflverse:injuries")).toMatchObject({
        outcome: "revalidated",
        code: null,
        started_at: iso(T0),
      });
    }
    // answered at ~1 s, long before the 6 s budget
    expect(Date.now() - T0).toBeLessThan(2_000);
  });

  it("a child that never exits: in_progress at 6 000 ms, never killed by the budget; a call 2 min later joins it", async () => {
    const r = t.make();
    const first = r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(5_999);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const rep = await first;
    expect(Date.now() - T0).toBe(6_000);
    expect(row(rep, "nflverse:injuries")).toMatchObject({
      outcome: "in_progress",
      started_at: iso(T0),
    });
    const child = t.spawner.children[0]!;
    expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    const later = r.ensureFresh(["nflverse:injuries"], { requestId: RID(2) });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(row(await later, "nflverse:injuries")?.outcome).toBe("in_progress");
    expect(t.spawner.children).toHaveLength(1);
    // the backstop: SIGKILL 90 s after the spawn
    await vi.advanceTimersByTimeAsync(90_000);
    expect(child.kills).toEqual(["SIGKILL"]);
  });

  it("the call's answer reflects a child that finishes after an earlier call gave up (stale-while-revalidate)", async () => {
    const r = t.make();
    const first = r.ensureFresh(["nflverse:schedules"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(row(await first, "nflverse:schedules")?.outcome).toBe("in_progress");
    t.log.ok("nflverse:schedules", "sched-v2", Date.now());
    t.spawner.children[0]!.exit(
      0,
      json({ source: "nflverse:schedules", status: "published", file_version: "sched-v2" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    // the published release is the new current row: nothing is due now (min gap)
    expect(await r.ensureFresh(["nflverse:schedules"], { requestId: RID(2) })).toBeNull();
    expect(t.spawner.children).toHaveLength(1);
  });
});

describe("caps", () => {
  it("≤ 3 concurrent children per server; a 4th source is throttled", async () => {
    // the slow sources last checked 7 h ago: past their 6 h floor, revalidated in the background
    t.log.check("nflverse:roster_weekly", T0 - 7 * H);
    t.log.check("nflverse:stats_player_week", T0 - 7 * H);
    const r = t.make();
    const calls = (
      [
        "nflverse:schedules",
        "nflverse:injuries",
        "weather",
        "nflverse:roster_weekly",
        "nflverse:stats_player_week",
      ] as const
    ).map((s, i) => r.ensureFresh([s], { requestId: RID(i) }));
    await vi.advanceTimersByTimeAsync(6_000);
    const reports = await Promise.all(calls);
    expect(t.spawner.children).toHaveLength(3);
    const outcomes = reports.map((rep) => rep?.sources[0]?.outcome);
    expect(outcomes.slice(0, 3)).toEqual(["in_progress", "in_progress", "in_progress"]);
    expect(outcomes.slice(3)).toEqual(["throttled", "throttled"]);
  });

  it("the 21st spawn within an hour is throttled; an hour later spawning resumes", async () => {
    const r = t.make();
    for (let i = 0; i < 20; i++) {
      const call = r.ensureFresh(["nflverse:injuries"], { requestId: RID(i) });
      await vi.advanceTimersByTimeAsync(10);
      // the child dies without a word and without a log row: the source stays due
      t.spawner.children[i]!.exit(1, "");
      expect(row(await call, "nflverse:injuries")).toMatchObject({
        outcome: "failed",
        code: "internal",
      });
      await vi.advanceTimersByTimeAsync(MIN);
    }
    const blocked = await r.ensureFresh(["nflverse:injuries"], { requestId: RID(20) });
    expect(row(blocked, "nflverse:injuries")?.outcome).toBe("throttled");
    expect(t.spawner.children).toHaveLength(20);
    await vi.advanceTimersByTimeAsync(H);
    const again = r.ensureFresh(["nflverse:injuries"], { requestId: RID(21) });
    await vi.advanceTimersByTimeAsync(10);
    expect(t.spawner.children).toHaveLength(21);
    t.spawner.children[20]!.exit(1, "");
    await again;
  });
});

describe("joining another process's run (no spawn)", () => {
  it("polls refresh_log while the other process holds refresh:<source>; its outcome is reported", async () => {
    t.locks.set("nflverse:injuries", { pid: 777, acquired_at: iso(T0 - 2_000) });
    const r = t.make();
    const call = r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(1_000);
    t.log.ok("nflverse:injuries", "inj-v2", Date.now());
    t.locks.delete("nflverse:injuries");
    await vi.advanceTimersByTimeAsync(250);
    const rep = await call;
    expect(t.spawner.children).toHaveLength(0);
    expect(row(rep, "nflverse:injuries")).toMatchObject({
      outcome: "updated",
      started_at: iso(T0 - 2_000),
    });
    expect(Date.now() - T0).toBeLessThanOrEqual(1_500);
  });

  it("a lock still held at the budget's end reads `joined` (locked)", async () => {
    t.locks.set("nflverse:schedules", { pid: 777, acquired_at: iso(T0) });
    const r = t.make();
    const call = r.ensureFresh(["nflverse:schedules"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(row(await call, "nflverse:schedules")).toMatchObject({
      outcome: "joined",
      code: "locked",
    });
    expect(t.spawner.children).toHaveLength(0);
  });
});

describe("outcomes: the child's JSON, cross-checked with refresh_log", () => {
  const run = async (
    sources: Parameters<OnDemandRefresher["ensureFresh"]>[0],
    stdout: string,
    writes: () => void,
    code = 0,
  ): Promise<RefreshReport | null> => {
    const r = t.make();
    const call = r.ensureFresh(sources, { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(500);
    writes();
    t.spawner.children[0]!.exit(code, stdout);
    return call;
  };

  it("published + a new current version = updated; unchanged + a moved check = revalidated", async () => {
    const rep = await run(
      ["nflverse:schedules", "nflverse:injuries"],
      json(
        { source: "nflverse:schedules", status: "published", file_version: "s2" },
        { source: "nflverse:injuries", status: "unchanged", version: "i1" },
      ),
      () => {
        t.log.ok("nflverse:schedules", "s2", Date.now());
        t.log.check("nflverse:injuries", Date.now());
      },
    );
    // one child carries both, schedules first
    expect(t.spawner.children).toHaveLength(1);
    expect(t.spawner.children[0]!.args.slice(-2)).toEqual([
      "nflverse:schedules",
      "nflverse:injuries",
    ]);
    expect(rep?.sources.map((s) => [s.source, s.outcome])).toEqual([
      ["nflverse:schedules", "updated"],
      ["nflverse:injuries", "revalidated"],
    ]);
  });

  it("a claim the log does not back is failed:internal; a source missing from the JSON is read from the log", async () => {
    const rep = await run(
      ["nflverse:schedules", "nflverse:injuries"],
      json({ source: "nflverse:schedules", status: "published", file_version: "s2" }),
      () => {
        t.log.fail("nflverse:injuries", "rate_limited", Date.now());
      },
      1,
    );
    expect(row(rep, "nflverse:schedules")).toMatchObject({ outcome: "failed", code: "internal" });
    expect(row(rep, "nflverse:injuries")).toMatchObject({
      outcome: "failed",
      code: "rate_limited",
    });
    expect(t.lines.some((l) => l.event === "refresh.child_mismatch")).toBe(true);
  });

  it("failed codes map to the fixed vocabulary; skips map to joined / backoff / skipped", async () => {
    const until = iso(T0 + 30 * MIN);
    const rep = await run(
      ["nflverse:schedules", "nflverse:injuries", "weather"],
      json(
        {
          source: "nflverse:schedules",
          status: "failed",
          error: "network",
          message: "x",
          attempts: 2,
        },
        { source: "nflverse:injuries", status: "skipped", reason: "locked", until: null },
        {
          source: "weather:open_meteo",
          status: "skipped",
          reason: "provider_backoff",
          until,
        },
      ),
      () => undefined,
      1,
    );
    expect(row(rep, "nflverse:schedules")).toMatchObject({ outcome: "failed", code: "network" });
    expect(row(rep, "nflverse:injuries")).toMatchObject({ outcome: "joined", code: "locked" });
    expect(row(rep, "weather:open_meteo")).toMatchObject({
      outcome: "backoff",
      next_retry_at: until,
    });
  });

  it("an unknown failure code or unparseable stdout never leaks: internal", async () => {
    const rep = await run(
      ["nflverse:injuries"],
      json({ source: "nflverse:injuries", status: "failed", error: "weird_new_code" }),
      () => undefined,
      1,
    );
    expect(row(rep, "nflverse:injuries")).toMatchObject({ outcome: "failed", code: "internal" });
  });
});

describe("decisions before any spawn", () => {
  it("a provider backoff is reported with its end and starts nothing", async () => {
    t.backoff.set("nflverse", {
      provider: "nflverse",
      until_at: iso(T0 + 40 * MIN),
      reason: "rate_limited",
      set_at: iso(T0 - MIN),
    });
    const rep = await t.make().ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    expect(row(rep, "nflverse:injuries")).toMatchObject({
      outcome: "backoff",
      code: "rate_limited",
      next_retry_at: iso(T0 + 40 * MIN),
    });
    expect(t.spawner.children).toHaveLength(0);
  });

  it("recently checked sources: nothing attempted, no report", async () => {
    t.log.check("nflverse:injuries", T0 - 5 * MIN);
    expect(await t.make().ensureFresh(["nflverse:injuries"], { requestId: RID(1) })).toBeNull();
    expect(t.spawner.children).toHaveLength(0);
  });

  it("weather off: weather is never refreshed", async () => {
    const rep = await t.make("wait", "off").ensureFresh(["weather"], { requestId: RID(1) });
    expect(rep).toBeNull();
    expect(t.spawner.children).toHaveLength(0);
  });
});

describe("failures that disable on-demand refresh for the process", () => {
  it("ENOENT (async spawn error) → failed:spawn, disabled, one warning; later calls do nothing", async () => {
    const r = t.make();
    const call = r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(10);
    t.spawner.children[0]!.fail("ENOENT");
    expect(row(await call, "nflverse:injuries")).toMatchObject({
      outcome: "failed",
      code: "spawn",
    });
    expect(r.state()).toBe("disabled_spawn");
    expect(await r.ensureFresh(["nflverse:schedules"], { requestId: RID(2) })).toBeNull();
    expect(t.spawner.children).toHaveLength(1);
    expect(t.lines.filter((l) => l.event === "refresh.on_demand_disabled")).toHaveLength(1);
  });

  it("a spawner that throws synchronously (EACCES, a sandbox) is the same", async () => {
    const r = createOnDemandRefresherThrowing();
    const rep = await r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    expect(row(rep, "nflverse:injuries")).toMatchObject({ outcome: "failed", code: "spawn" });
    expect(r.state()).toBe("disabled_spawn");
  });

  it("exit 2 (version mismatch / pending migration) → failed:version, disabled", async () => {
    const r = t.make();
    const call = r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(10);
    t.spawner.children[0]!.exit(2, "");
    expect(row(await call, "nflverse:injuries")).toMatchObject({
      outcome: "failed",
      code: "version",
    });
    expect(r.state()).toBe("disabled_version");
    expect(await r.ensureFresh(["nflverse:injuries"], { requestId: RID(2) })).toBeNull();
  });
});

function createOnDemandRefresherThrowing(): OnDemandRefresher {
  return createOnDemandRefresher(
    {
      mode: "wait",
      entry: "/pkg/dist/cli.js",
      execPath: "/opt/node/bin/node",
      env: {},
      version: "9.9.9",
      weatherSource: "open-meteo",
      clock: systemClock,
      logger: {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
      },
      spawn: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    },
    {
      refreshLog: t.log,
      providerBackoff: { get: () => null },
      runLocks: { held: () => null },
      storeStats: () => ({
        path: "x",
        size_bytes: 0,
        schema_version: 3,
        cache_misses_busy: 0,
        attached: t.log.current().map((c) => ({
          source: c.source,
          schema: "s",
          file: "f",
          file_version: c.file_version ?? "",
          inode: 1,
          mtime_ms: 0,
          size_bytes: 1,
          attached_at: c.finished_at,
        })),
      }),
      scheduleView: () => ({ calendar: t.calendar }) as unknown as ScheduleView,
    },
  );
}

describe("modes", () => {
  it("background never waits: the call returns at once with the refresh in progress", async () => {
    const r = t.make("background");
    const rep = await r.ensureFresh(["nflverse:injuries", "nflverse:schedules"], {
      requestId: RID(1),
    });
    expect(Date.now()).toBe(T0);
    expect(rep?.mode).toBe("background");
    expect(rep?.sources.map((s) => s.outcome)).toEqual(["in_progress", "in_progress"]);
    expect(t.spawner.children).toHaveLength(1);
  });

  it("off never spawns and never reports", async () => {
    const r = t.make("off");
    expect(r.state()).toBe("off");
    expect(
      await r.ensureFresh(["nflverse:schedules", "nflverse:injuries", "weather"], {
        requestId: RID(1),
      }),
    ).toBeNull();
    expect(t.spawner.children).toHaveLength(0);
  });

  it("slow sources are revalidated in the background; a never-loaded required source waits up to 15 s", async () => {
    t.log.check("nflverse:stats_player_week", T0 - 7 * H);
    const r = t.make();
    const slow = await r.ensureFresh(["nflverse:stats_player_week"], { requestId: RID(1) });
    expect(Date.now()).toBe(T0);
    expect(row(slow, "nflverse:stats_player_week")?.outcome).toBe("in_progress");
    // a fresh rig: roster_weekly never loaded → a 15 s repair wait
    t = rig();
    const r2 = t.make();
    const repair = r2.ensureFresh(["nflverse:roster_weekly"], { requestId: RID(2) });
    await vi.advanceTimersByTimeAsync(14_999);
    let done = false;
    void repair.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(row(await repair, "nflverse:roster_weekly")?.outcome).toBe("in_progress");
    expect(Date.now() - T0).toBe(15_000);
  });
});

describe("the child process", () => {
  it("argv is fixed and env is the allow-list (no credentials, no PATH)", async () => {
    const r = t.make();
    const call = r.ensureFresh(["weather", "nflverse:injuries", "nflverse:schedules"], {
      requestId: RID(1),
    });
    await vi.advanceTimersByTimeAsync(10);
    const c = t.spawner.children[0]!;
    expect(c.cmd).toBe("/opt/node/bin/node");
    expect(c.args).toEqual([
      "/pkg/dist/cli.js",
      "refresh",
      "--on-demand",
      "--no-migrate",
      "--expect-version",
      "9.9.9",
      "--json",
      "--notify",
      "nflverse:schedules",
      "nflverse:injuries",
      "weather",
    ]);
    expect(Object.keys(c.env).every((k) => CHILD_ENV_KEYS.includes(k))).toBe(true);
    expect(c.env).toEqual({ HOME: "/home/u", FF_CACHE_DIR: "/home/u/.cache/ff" });
    c.exit(1, "");
    await call;
  });

  it("shutdown sends SIGTERM to live children and turns later calls off", async () => {
    const r = t.make();
    const call = r.ensureFresh(["nflverse:injuries"], { requestId: RID(1) });
    await vi.advanceTimersByTimeAsync(10);
    r.shutdown();
    expect(t.spawner.children[0]!.kills).toEqual(["SIGTERM"]);
    // the store is closed after the server's shutdown: the child's late exit never reads it
    t.log.current = () => {
      throw new Error("database is not open");
    };
    t.spawner.children[0]!.exit(null, "");
    expect(row(await call, "nflverse:injuries")).toMatchObject({
      outcome: "failed",
      code: "aborted",
    });
    expect(await r.ensureFresh(["nflverse:schedules"], { requestId: RID(2) })).toBeNull();
    expect(t.spawner.children).toHaveLength(1);
  });
});
