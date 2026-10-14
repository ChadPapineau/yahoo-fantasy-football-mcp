// cadence.test.ts — src/config/cadence.ts (season-fresh spec §4.2, §6, §8.4): every rule of the
// tick decision in order (provider backoff, repair, the 14-minute floor counting any process's
// attempt, the failure backoff, the TTL guard, the tightest calendar phase's cadence), the weather
// hour-bucket rule, both backoff formulas, the answer-time decision and its budgets, and the weather
// version parser. Calendars come from synthetic kickoffs, so no rule depends on a weekday or a year.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CADENCE_MS,
  DUE_ORDER,
  DUE_SOURCES,
  FAILURE_BACKOFF_CAP_MS,
  MIN_RELEASE_GAP_MS,
  ON_DEMAND,
  ON_DEMAND_TIER,
  RATE_LIMIT_BACKOFF_CAP_MS,
  SOURCE_CLASSES,
  TICK_MS,
  TICK_SLACK_MS,
  cadenceIntervalMs,
  dueDecision,
  failureBackoffMs,
  onDemandDecision,
  rateLimitBackoffMs,
  weatherBucketMs,
  type DueInput,
  type DueSource,
  type OnDemandInput,
  type SourceState,
} from "../../src/config/cadence.js";
import { freshUntilMs, freshnessClass, type StampInstants } from "../../src/config/freshness.js";
import {
  CALENDAR_PHASES,
  GAMEDAY_LEAD_MS,
  fallbackCalendar,
  scheduleCalendar,
  type GameCalendar,
} from "../../src/config/game-calendar.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const SCHED: DueSource = "nflverse:schedules";

/** A kickoff far from the instants used below unless a test places one. */
const K = Date.UTC(2028, 9, 15, 17, 0);
const cal = (ks: readonly number[], outdoor: readonly number[] = ks): GameCalendar =>
  scheduleCalendar({ kickoffs: ks, outdoorKickoffs: outdoor, fileVersion: "v" });
const stamp = (checkedMs: number): StampInstants => ({
  as_of: new Date(checkedMs - 30 * D).toISOString(),
  fetched_at: new Date(checkedMs - 30 * D).toISOString(),
  checked_at: new Date(checkedMs).toISOString(),
});
const ok = (checkedMs: number, o: Partial<SourceState> = {}): SourceState => ({
  file: "ok",
  basis: stamp(checkedMs),
  lastAttemptMs: checkedMs,
  consecutiveFailures: 0,
  backoffUntilMs: null,
  ...o,
});
const due = (i: Partial<DueInput> & Pick<DueInput, "nowMs" | "state">) =>
  dueDecision({ source: SCHED, cal: cal([K]), ...i });

describe("tables", () => {
  it("DUE_ORDER is every source, schedules first; each source names the classes it feeds", () => {
    expect(DUE_ORDER).toEqual([...DUE_SOURCES]);
    expect(DUE_ORDER[0]).toBe("nflverse:schedules");
    expect(SOURCE_CLASSES["nflverse:schedules"]).toEqual(["nflverse_schedules", "lines"]);
    for (const s of DUE_SOURCES) expect(SOURCE_CLASSES[s].length).toBeGreaterThan(0);
  });

  it("every cadence row covers every phase and the fallback, never looser than the off-season", () => {
    for (const [source, row] of Object.entries(CADENCE_MS)) {
      for (const p of [...CALENDAR_PHASES, "fallback" as const]) {
        expect(row[p], `${source} ${p}`).toBeGreaterThanOrEqual(TICK_MS);
        expect(row[p], `${source} ${p}`).toBeLessThanOrEqual(row.off_season);
      }
    }
    // schedules (with lines) are checked every tick before a kickoff and at least hourly in season
    expect(CADENCE_MS["nflverse:schedules"].pregame).toBe(TICK_MS);
    expect(CADENCE_MS["nflverse:schedules"].in_season).toBeLessThanOrEqual(H);
  });

  it("schedules, injuries and weather are waited on at answer time; rosters and stats are not", () => {
    expect(ON_DEMAND_TIER).toEqual({
      "nflverse:schedules": "fast",
      "nflverse:injuries": "fast",
      "nflverse:roster_weekly": "slow",
      "nflverse:stats_player_week": "slow",
      weather: "fast",
    });
    expect(ON_DEMAND.waitFastMs).toBeLessThan(ON_DEMAND.waitRepairMs);
    expect(ON_DEMAND.waitRepairMs).toBeLessThanOrEqual(ON_DEMAND.callCapMs);
  });
});

describe("backoff", () => {
  it("failureBackoffMs: 0, then 15/30/60/60 min, capped", () => {
    expect([0, -1, Number.NaN].map(failureBackoffMs)).toEqual([0, 0, 0]);
    expect([1, 2, 3, 4, 50, 5000].map((n) => failureBackoffMs(n) / MIN)).toEqual([
      15, 30, 60, 60, 60, 60,
    ]);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (n) => {
        const b = failureBackoffMs(n);
        expect(b).toBeGreaterThanOrEqual(15 * MIN);
        expect(b).toBeLessThanOrEqual(FAILURE_BACKOFF_CAP_MS);
        expect(failureBackoffMs(n + 1)).toBeGreaterThanOrEqual(b);
      }),
    );
  });

  it("rateLimitBackoffMs: max(Retry-After, 15 min × 2^(n−1)), capped at 2 h", () => {
    expect(rateLimitBackoffMs(null, 1)).toBe(15 * MIN);
    expect(rateLimitBackoffMs(600, 1)).toBe(15 * MIN);
    expect(rateLimitBackoffMs(3600, 1)).toBe(H);
    expect(rateLimitBackoffMs(99_999, 1)).toBe(2 * H);
    expect(rateLimitBackoffMs(null, 3)).toBe(H);
    expect(rateLimitBackoffMs(null, 4)).toBe(2 * H);
    expect(rateLimitBackoffMs(null, 400)).toBe(2 * H);
    expect(rateLimitBackoffMs(-5, 0)).toBe(15 * MIN);
    expect(rateLimitBackoffMs(Number.NaN, Number.NaN)).toBe(15 * MIN);
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
        fc.integer({ min: 1, max: 60 }),
        (ra, n) => {
          const b = rateLimitBackoffMs(ra, n);
          expect(b).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_CAP_MS);
          expect(b).toBeGreaterThanOrEqual(Math.min(RATE_LIMIT_BACKOFF_CAP_MS, (ra ?? 0) * 1000));
          expect(b).toBeGreaterThanOrEqual(15 * MIN);
        },
      ),
    );
  });
});

describe("dueDecision: the rules in order", () => {
  const now = K - 5 * D; // in season, outside every window but in_season

  it("a provider backoff wins over everything, a repair included", () => {
    const until = now + 40 * MIN;
    for (const file of ["ok", "never_loaded", "unreadable"] as const)
      expect(
        due({ nowMs: now, state: { ...ok(now - 7 * H), file, backoffUntilMs: until } }),
      ).toEqual({
        source: SCHED,
        due: false,
        reason: "provider_backoff",
        next_at_ms: until,
      });
    expect(due({ nowMs: until, state: ok(now - 7 * H, { backoffUntilMs: until }) }).due).toBe(true);
  });

  it("a never-loaded or unreadable file is due at once (repair), ignoring the floor and failures", () => {
    for (const file of ["never_loaded", "unreadable"] as const)
      expect(
        due({
          nowMs: now,
          state: {
            file,
            basis: null,
            lastAttemptMs: now - MIN,
            consecutiveFailures: 5,
            backoffUntilMs: null,
          },
        }),
      ).toEqual({ source: SCHED, due: true, reason: "repair", next_at_ms: null });
    // "ok" with no instants is a repair too
    expect(due({ nowMs: now, state: { ...ok(now), basis: null } }).reason).toBe("repair");
  });

  it("an attempt less than 14 min ago — by any process — blocks (min_gap)", () => {
    // the file was checked 7 h ago (stale), but another process attempted 13 min ago
    const st = ok(now - 7 * H, { lastAttemptMs: now - 13 * MIN });
    expect(due({ nowMs: now, state: st })).toEqual({
      source: SCHED,
      due: false,
      reason: "min_gap",
      next_at_ms: now - 13 * MIN + MIN_RELEASE_GAP_MS,
    });
    expect(due({ nowMs: now + MIN, state: st }).due).toBe(true);
  });

  it("a failure streak waits 15/30/60/60 min from the last attempt, then the other rules decide", () => {
    for (const [n, wait] of [
      [1, 15],
      [2, 30],
      [3, 60],
      [4, 60],
    ] as const) {
      const last = now - 20 * MIN;
      const st = ok(now - 10 * H, { lastAttemptMs: last, consecutiveFailures: n });
      const d = due({ nowMs: now, state: st });
      if (wait <= 20) expect(d.reason, String(n)).toBe("ttl_guard");
      else
        expect(d, String(n)).toEqual({
          source: SCHED,
          due: false,
          reason: "failure_backoff",
          next_at_ms: last + wait * MIN,
        });
      expect(due({ nowMs: last + wait * MIN, state: st }).due, String(n)).toBe(true);
    }
  });

  it("TTL guard: due when the next tick (plus its tolerance) could find a fed class stale", () => {
    // checked 50 min before the game-day window opens: fresh until the window opens (TTL 50 min),
    // while the in-season cadence would wait an hour
    const opens = K - GAMEDAY_LEAD_MS;
    const checked = opens - 50 * MIN;
    const c = cal([K]);
    const until = freshUntilMs(freshnessClass("lines"), stamp(checked), c) ?? 0;
    expect(until).toBe(opens);
    const guardAt = until - TICK_MS - TICK_SLACK_MS;
    const before = dueDecision({ source: SCHED, cal: c, nowMs: guardAt - 1, state: ok(checked) });
    expect(before).toEqual({ source: SCHED, due: false, reason: "not_due", next_at_ms: guardAt });
    expect(dueDecision({ source: SCHED, cal: c, nowMs: guardAt, state: ok(checked) }).reason).toBe(
      "ttl_guard",
    );
  });

  it("cadence: the tightest phase's interval, less the tick tolerance", () => {
    const c = cal([K]);
    const cases: [number, number][] = [
      [K - 2 * H, 15 * MIN], // pregame
      [K - 10 * H, 30 * MIN], // gameday
      [K - 30 * H, H], // report
      [K + 6 * H, H], // postgame
      [K - 4 * D, H], // in_season
    ];
    for (const [nowMs, interval] of cases) {
      expect(cadenceIntervalMs(SCHED, c, nowMs), new Date(nowMs).toISOString()).toBe(interval);
      // checked exactly interval − slack ago (no other attempt since): due
      const st = ok(nowMs - interval + TICK_SLACK_MS, { lastAttemptMs: null });
      const d = dueDecision({ source: "nflverse:roster_weekly", cal: c, nowMs, state: st });
      expect(d.due).toBe(false); // rosters are 6-hourly in every phase
      const s = dueDecision({ source: SCHED, cal: c, nowMs, state: st });
      expect(s.due, new Date(nowMs).toISOString()).toBe(true);
      expect(["cadence", "ttl_guard"]).toContain(s.reason);
    }
    // off-season: 6 h, and nothing earlier
    const far = K + 60 * D;
    expect(cadenceIntervalMs(SCHED, c, far)).toBe(6 * H);
    const off = dueDecision({ source: SCHED, cal: c, nowMs: far, state: ok(far - 5 * H) });
    expect(off).toEqual({
      source: SCHED,
      due: false,
      reason: "not_due",
      next_at_ms: far - 5 * H + 6 * H - TICK_SLACK_MS,
    });
    expect(dueDecision({ source: SCHED, cal: c, nowMs: far, state: ok(far - 6 * H) }).reason).toBe(
      "cadence",
    );
    // a fallback calendar uses the fallback column (30 min for schedules) and the 30-min TTL
    expect(cadenceIntervalMs(SCHED, fallbackCalendar("expired"), far)).toBe(30 * MIN);
    expect(
      cadenceIntervalMs("nflverse:stats_player_week", fallbackCalendar("unreadable"), far),
    ).toBe(H);
  });

  it("stats are hourly in a post-game window, 6-hourly otherwise", () => {
    const c = cal([K]);
    const st = (nowMs: number) => ok(nowMs - 70 * MIN);
    expect(
      dueDecision({
        source: "nflverse:stats_player_week",
        cal: c,
        nowMs: K + 6 * H,
        state: st(K + 6 * H),
      }).due,
    ).toBe(true);
    expect(
      dueDecision({
        source: "nflverse:stats_player_week",
        cal: c,
        nowMs: K - 3 * D,
        state: st(K - 3 * D),
      }).due,
    ).toBe(false);
  });

  it("a stamp without checked_at is judged from fetched_at", () => {
    const st: SourceState = {
      ...ok(0),
      basis: {
        as_of: new Date(K - 5 * D - 7 * H).toISOString(),
        fetched_at: new Date(K - 5 * D - 7 * H).toISOString(),
        checked_at: null,
      },
      lastAttemptMs: null,
    };
    expect(due({ nowMs: K - 5 * D, state: st }).due).toBe(true);
    // off-season, downloaded an hour ago, never re-checked: due 6 h after the download
    const far = K + 60 * D;
    const fetched = {
      as_of: new Date(far - H).toISOString(),
      fetched_at: new Date(far - H).toISOString(),
      checked_at: null,
    };
    expect(due({ nowMs: far, state: { ...st, basis: fetched } }).next_at_ms).toBe(
      far - H + 6 * H - TICK_SLACK_MS,
    );
    // a checked_at older than the download is ignored (the later instant is the basis)
    const older = { ...fetched, checked_at: new Date(far - 3 * H).toISOString() };
    expect(due({ nowMs: far, state: { ...st, basis: older } }).next_at_ms).toBe(
      far - H + 6 * H - TICK_SLACK_MS,
    );
  });
});

describe("dueDecision: weather (hourly, only with an outdoor game in the window)", () => {
  const w = (lastBucketMs: number | null, horizonHours = 48) => ({ lastBucketMs, horizonHours });
  const outdoorK = K;
  const c = cal([outdoorK, outdoorK + 7 * D], [outdoorK]);

  it("no outdoor kickoff in [now − 1 h, now + horizon] → no_games, next when one enters it", () => {
    const now = outdoorK - 50 * H;
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: now,
        state: ok(now - 3 * H),
        weather: w(null),
      }),
    ).toEqual({
      source: "weather",
      due: false,
      reason: "no_games",
      next_at_ms: outdoorK - 48 * H,
    });
    // after the last outdoor kickoff: never again in this file
    const after = outdoorK + 2 * H;
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: after,
        state: ok(after - 3 * H),
        weather: w(null),
      }).next_at_ms,
    ).toBeNull();
    // an indoor kickoff in the window does not count
    const indoor = outdoorK + 7 * D - 2 * H;
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: indoor,
        state: ok(indoor - 3 * H),
        weather: w(null),
      }).reason,
    ).toBe("no_games");
  });

  it("a kickoff that started less than an hour ago still counts; same bucket → same_bucket", () => {
    const now = outdoorK + 50 * MIN;
    const bucket = Math.floor(now / H) * H;
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: now,
        state: ok(now - 2 * H),
        weather: w(bucket - H),
      }).due,
    ).toBe(true);
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: now,
        state: ok(now - 2 * H),
        weather: w(bucket),
      }),
    ).toEqual({
      source: "weather",
      due: false,
      reason: "same_bucket",
      next_at_ms: bucket + H,
    });
  });

  it("a fallback calendar assumes games (never under-refresh); missing WeatherState is a programming error", () => {
    const now = outdoorK + 40 * D;
    expect(
      dueDecision({
        source: "weather",
        cal: fallbackCalendar("expired"),
        nowMs: now,
        state: ok(now - 2 * H),
        weather: w(null),
      }).due,
    ).toBe(true);
    expect(() => dueDecision({ source: "weather", cal: c, nowMs: now, state: ok(now) })).toThrow(
      TypeError,
    );
    expect(() =>
      onDemandDecision({
        source: "weather",
        cal: c,
        nowMs: now,
        state: ok(now),
        required: false,
        expired: false,
      }),
    ).toThrow(TypeError);
  });

  it("a never-loaded weather file is repaired only while games are in the window", () => {
    const st: SourceState = {
      file: "never_loaded",
      basis: null,
      lastAttemptMs: null,
      consecutiveFailures: 0,
      backoffUntilMs: null,
    };
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: outdoorK - 2 * H,
        state: st,
        weather: w(null),
      }).reason,
    ).toBe("repair");
    expect(
      dueDecision({
        source: "weather",
        cal: c,
        nowMs: outdoorK + 30 * D,
        state: st,
        weather: w(null),
      }).reason,
    ).toBe("no_games");
  });
});

describe("onDemandDecision", () => {
  const base = (
    o: Partial<OnDemandInput> & Pick<OnDemandInput, "nowMs" | "state">,
  ): OnDemandInput => ({
    source: SCHED,
    cal: cal([K]),
    required: true,
    expired: false,
    ...o,
  });
  const now = K - 3 * D;

  it("provider and failure backoff skip (an offline machine answers at once), even for a repair", () => {
    const st = ok(now - H, { backoffUntilMs: now + 30 * MIN });
    expect(onDemandDecision(base({ nowMs: now, state: { ...st, file: "never_loaded" } }))).toEqual({
      kind: "skip",
      reason: "provider_backoff",
      until_ms: now + 30 * MIN,
    });
    const failing = ok(now - 2 * H, { lastAttemptMs: now - 5 * MIN, consecutiveFailures: 1 });
    expect(
      onDemandDecision(base({ nowMs: now, state: { ...failing, file: "unreadable" } })),
    ).toEqual({
      kind: "skip",
      reason: "failure_backoff",
      until_ms: now + 10 * MIN,
    });
  });

  it("a required source that is never loaded, unreadable or expired waits up to the repair budget", () => {
    const wait = { kind: "wait", reason: "repair", budget_ms: ON_DEMAND.waitRepairMs };
    expect(
      onDemandDecision(
        base({
          nowMs: now,
          state: { ...ok(now), file: "never_loaded", basis: null, lastAttemptMs: null },
        }),
      ),
    ).toEqual(wait);
    expect(
      onDemandDecision(base({ nowMs: now, state: { ...ok(now - MIN), file: "unreadable" } })),
    ).toEqual(wait);
    expect(onDemandDecision(base({ nowMs: now, state: ok(now - MIN), expired: true }))).toEqual(
      wait,
    );
    // not required: the ordinary tier rules
    expect(
      onDemandDecision(base({ nowMs: now, state: ok(now - MIN), expired: true, required: false })),
    ).toEqual({ kind: "none", reason: "min_gap" });
  });

  it("fast tier: waits when the last attempt is ≥ 15 min old; min_gap under 14; fresh_enough between", () => {
    expect(onDemandDecision(base({ nowMs: now, state: ok(now - 15 * MIN) }))).toEqual({
      kind: "wait",
      reason: "revalidate",
      budget_ms: ON_DEMAND.waitFastMs,
    });
    expect(onDemandDecision(base({ nowMs: now, state: ok(now - 13 * MIN) }))).toEqual({
      kind: "none",
      reason: "min_gap",
    });
    expect(onDemandDecision(base({ nowMs: now, state: ok(now - 14.5 * MIN) }))).toEqual({
      kind: "none",
      reason: "fresh_enough",
    });
    // never attempted (optional, never loaded) → wait
    const never: SourceState = {
      file: "never_loaded",
      basis: null,
      lastAttemptMs: null,
      consecutiveFailures: 0,
      backoffUntilMs: null,
    };
    expect(
      onDemandDecision(
        base({ source: "nflverse:injuries", nowMs: now, state: never, required: false }),
      ).kind,
    ).toBe("wait");
  });

  it("slow tier: background after 6 h (stats: 1 h in a post-game window, or under a fallback)", () => {
    const roster = (ago: number) =>
      onDemandDecision(
        base({
          source: "nflverse:roster_weekly",
          nowMs: now,
          state: ok(now - ago),
          required: false,
        }),
      );
    expect(roster(6 * H)).toEqual({ kind: "background", reason: "slow_tier" });
    expect(roster(5 * H)).toEqual({ kind: "none", reason: "fresh_enough" });
    const stats = (nowMs: number, ago: number, c: GameCalendar = cal([K])) =>
      onDemandDecision(
        base({
          source: "nflverse:stats_player_week",
          cal: c,
          nowMs,
          state: ok(nowMs - ago),
          required: true,
        }),
      );
    expect(stats(K + 6 * H, 61 * MIN).kind).toBe("background");
    expect(stats(K - 3 * D, 2 * H)).toEqual({ kind: "none", reason: "fresh_enough" });
    expect(stats(K - 3 * D, 2 * H, fallbackCalendar("expired")).kind).toBe("background");
    // a broken optional slow source is revalidated in the background
    expect(
      onDemandDecision(
        base({
          source: "nflverse:roster_weekly",
          nowMs: now,
          state: { ...ok(now - 20 * MIN), file: "unreadable" },
          required: false,
        }),
      ),
    ).toEqual({ kind: "background", reason: "slow_tier" });
  });

  it("weather: waits once per hour bucket while an outdoor kickoff is in its window", () => {
    const c = cal([K]);
    const nowW = K - 3 * H;
    const bucket = Math.floor(nowW / H) * H;
    const wx = (lastBucketMs: number | null, ago = 2 * H, nowMs = nowW) =>
      onDemandDecision(
        base({
          source: "weather",
          cal: c,
          nowMs,
          state: ok(nowMs - ago),
          required: false,
          weather: { lastBucketMs, horizonHours: 48 },
        }),
      );
    expect(wx(bucket - H)).toEqual({
      kind: "wait",
      reason: "revalidate",
      budget_ms: ON_DEMAND.waitFastMs,
    });
    expect(wx(bucket)).toEqual({ kind: "none", reason: "same_bucket" });
    expect(wx(bucket - H, 5 * MIN)).toEqual({ kind: "none", reason: "min_gap" });
    expect(wx(null, 2 * H, K + 3 * D)).toEqual({ kind: "none", reason: "no_games" });
  });

  it("property: every wait fits the per-call cap; only fast or repair sources wait", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DUE_SOURCES),
        fc.constantFrom<SourceState["file"]>("ok", "never_loaded", "unreadable"),
        fc.integer({ min: 0, max: 30 * 24 * 4 }),
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: -48, max: 48 * 7 }),
        (source, file, agoQ, n, required, expired, kq) => {
          const nowMs = K + kq * 15 * MIN;
          const st: SourceState = {
            file,
            basis: file === "ok" ? stamp(nowMs - agoQ * 15 * MIN) : null,
            lastAttemptMs: nowMs - agoQ * 15 * MIN,
            consecutiveFailures: n,
            backoffUntilMs: null,
          };
          const a = onDemandDecision({
            source,
            cal: cal([K]),
            nowMs,
            state: st,
            required,
            expired,
            weather: { lastBucketMs: null, horizonHours: 48 },
          });
          if (a.kind === "wait") {
            expect(a.budget_ms).toBeLessThanOrEqual(ON_DEMAND.callCapMs);
            if (a.reason === "revalidate") expect(ON_DEMAND_TIER[source]).toBe("fast");
          }
          if (a.kind === "skip") expect(a.until_ms).toBeGreaterThan(nowMs);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("weatherBucketMs", () => {
  it("parses the weather version (YYYY-MM-DDTHH, UTC) and refuses anything else", () => {
    expect(weatherBucketMs("2026-10-14T05")).toBe(Date.UTC(2026, 9, 14, 5));
    expect(weatherBucketMs(new Date(Date.UTC(2031, 0, 1, 23)).toISOString().slice(0, 13))).toBe(
      Date.UTC(2031, 0, 1, 23),
    );
    for (const bad of [
      "",
      "2026-10-14",
      "2026-10-14T5",
      "2026-13-01T00",
      "2026-02-30T00",
      "2026-10-14T24",
      "2026-00-10T00",
      "2026-10-00T00",
      "x2026-10-14T05",
    ])
      expect(weatherBucketMs(bad), bad).toBeNull();
  });
});
