// launchd-cadence.test.ts — the ONE refresh tick (`refresh-due`, src/cli/launchd.ts) against the
// freshness classes its sources are judged by, over real and synthetic NFL calendars. launchd fires
// the tick at local minutes 0/15/30/45; every real UTC offset is a multiple of 15 minutes, so those
// are UTC quarter-hours in every zone — proven here minute by minute in local time for one zone per
// real offset, across each zone's DST changes (America/New_York 2026-11-01, Pacific/Auckland
// 2026-09-27 …). The tick's decision (src/config/cadence.ts `dueDecision`) is then replayed at every
// quarter-hour over the 2025/2026 fixture calendars and synthetic 2026–2030 seasons (Saturday,
// Wednesday, Thanksgiving Friday, Christmas on any weekday, international 09:30 ET games, a Week 18
// placeholder then set, a flexed kickoff):
//   * healthy: every judged class is fresh at every tick;
//   * one failed or one missed (asleep) tick: never expired;
//   * schedules/lines are at most 15 + 2 min old at every tick in [k − 2 h 45 m, k] of every kickoff;
//   * an off-season date checks schedules every 6 h.
// QA-1-036, QA-2-035, QA-2-037: no data refresh is tied to a weekday or a local hour any more.
import { describe, expect, it } from "vitest";
import { JOBS, type CalendarEntry } from "../../src/cli/launchd.js";
import {
  dueDecision,
  SOURCE_CLASSES,
  TICK_MS,
  TICK_SLACK_MS,
  type DueSource,
} from "../../src/config/cadence.js";
import { freshnessClass, stampState } from "../../src/config/freshness.js";
import type { GameCalendar } from "../../src/config/game-calendar.js";
import type { NflGame } from "../../src/domain/analytics/types.js";
import { gameCalendarFromGames } from "../../src/domain/league/calendar.js";
import { loadFixtureGames } from "../helpers/season/fixture.js";
import {
  flexMove,
  setWeek18,
  syntheticSeason,
  SYNTHETIC_SEASONS,
} from "../helpers/season/synthetic.js";
import { ALL_UTC_OFFSET_ZONES, withTz } from "../helpers/season/zones.js";

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
/** A replay of a whole season is CPU-bound: its own hang detector, above the unit project's 30 s. */
const REPLAY_TIMEOUT_MS = 120_000;

const tick = JOBS.find((j) => j.name === "refresh-due");
if (tick === undefined) throw new Error("no refresh-due job");
const TICK_CAL: readonly CalendarEntry[] = tick.calendar;

const matches = (c: CalendarEntry, d: Date): boolean =>
  (c.Weekday === undefined || c.Weekday === d.getDay()) &&
  (c.Hour === undefined || c.Hour === d.getHours()) &&
  (c.Minute === undefined || c.Minute === d.getMinutes());

/** Every instant in [fromMs, toMs) at which launchd fires `calendar` (local wall-clock minutes). */
function fires(calendar: readonly CalendarEntry[], fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let t = fromMs; t < toMs; t += MIN) {
    const d = new Date(t);
    if (calendar.some((c) => matches(c, d))) out.push(t);
  }
  return out;
}

/** The UTC quarter-hours in [fromMs, toMs). */
function quarterHours(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(fromMs / TICK_MS) * TICK_MS; t < toMs; t += TICK_MS) out.push(t);
  return out;
}

/** The instants a zone's UTC offset changes in [fromMs, toMs) (its DST transitions). */
function offsetChanges(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  let prev = new Date(fromMs).getTimezoneOffset();
  for (let t = fromMs; t < toMs; t += H) {
    const o = new Date(t).getTimezoneOffset();
    if (o !== prev) out.push(t);
    prev = o;
  }
  return out;
}

describe("the tick fires at the UTC quarter-hours in every zone (local minutes 0/15/30/45)", () => {
  it("the job: every quarter-hour, every day, at load; no weekday or hour", () => {
    expect(TICK_CAL).toEqual([{ Minute: 0 }, { Minute: 15 }, { Minute: 30 }, { Minute: 45 }]);
    expect(tick.runAtLoad).toBe(true);
    expect(TICK_MS).toBe(15 * MIN);
  });

  for (const zone of ALL_UTC_OFFSET_ZONES)
    it(zone, () => {
      withTz(zone, () => {
        const from = Date.parse("2026-01-01T00:00:00Z");
        const to = Date.parse("2028-01-01T00:00:00Z");
        // a plain week, plus two days around each DST change of this zone in 2026–2027
        const windows: [number, number][] = [[from, from + 7 * DAY]];
        for (const c of offsetChanges(from, to)) windows.push([c - DAY, c + DAY]);
        for (const [a, b] of windows) expect(fires(TICK_CAL, a, b)).toEqual(quarterHours(a, b));
      });
    });

  it("the DST changes named in the spec are exercised", () => {
    expect(
      withTz("America/New_York", () =>
        offsetChanges(Date.parse("2026-10-25T00:00:00Z"), Date.parse("2026-11-08T00:00:00Z")),
      ),
    ).toEqual([Date.parse("2026-11-01T06:00:00Z")]);
    expect(
      withTz("Pacific/Auckland", () =>
        offsetChanges(Date.parse("2026-09-20T00:00:00Z"), Date.parse("2026-10-04T00:00:00Z")),
      ),
    ).toEqual([Date.parse("2026-09-26T14:00:00Z")]);
  });
});

// --- the replay -----------------------------------------------------------------------------------

/** What one source's refresh_log says, as the replay evolves it. */
interface Sim {
  checked: number;
  lastAttempt: number;
  fails: number;
  /** Every successful check instant. */
  readonly checks: number[];
}

/** An old release: the release basis is the later of fetched_at and checked_at. */
const RELEASE = Date.parse("2020-01-01T00:00:00Z");
const NFLVERSE: readonly Exclude<DueSource, "weather">[] = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
];

const stampOf = (checked: number) => ({
  as_of: new Date(RELEASE).toISOString(),
  fetched_at: new Date(RELEASE).toISOString(),
  checked_at: new Date(checked).toISOString(),
});

/**
 * Replays the tick at every UTC quarter-hour in [from, to) for one source. `calAt(t)` is the
 * calendar the tick reads at t (a schedules release may move kickoffs); `failAt` ticks fail (an
 * attempt, no check); `asleep` ticks never run. `onTick(t, sim, cal, at)` sees the state BEFORE the
 * decision; `peak` says whether this tick is a point where a check's age peaks — the source is due
 * now, the calendar just changed, or it is the window's last tick (between those points the age only
 * grows and the TTL is fixed, so judging there judges every tick).
 */
function replay(
  source: Exclude<DueSource, "weather">,
  calAt: (t: number) => GameCalendar,
  from: number,
  to: number,
  o: {
    readonly failAt?: ReadonlySet<number>;
    readonly asleep?: ReadonlySet<number>;
    readonly onTick?: (t: number, sim: Sim, cal: GameCalendar, peak: boolean) => void;
    /** The last successful check before `from` (default: `from` itself). */
    readonly checkedAt?: number;
  } = {},
): Sim {
  const c0 = o.checkedAt ?? from;
  const sim: Sim = { checked: c0, lastAttempt: c0, fails: 0, checks: [c0] };
  const ticks = quarterHours(from + 1, to);
  let prevCal: GameCalendar | null = null;
  for (const [i, t] of ticks.entries()) {
    if (o.asleep?.has(t) === true) continue;
    const cal = calAt(t);
    const d = dueDecision({
      source,
      nowMs: t,
      cal,
      state: {
        file: "ok",
        basis: stampOf(sim.checked),
        lastAttemptMs: sim.lastAttempt,
        consecutiveFailures: sim.fails,
        backoffUntilMs: null,
      },
    });
    o.onTick?.(t, sim, cal, d.due || cal !== prevCal || i === ticks.length - 1);
    prevCal = cal;
    if (!d.due) continue;
    sim.lastAttempt = t;
    if (o.failAt?.has(t) === true) sim.fails++;
    else {
      sim.checked = t;
      sim.fails = 0;
      sim.checks.push(t);
    }
  }
  return sim;
}

/** The judged state of every class `source` feeds, at `t`, from a check at `checked`. */
function states(
  source: Exclude<DueSource, "weather">,
  checked: number,
  t: number,
  cal: GameCalendar,
): string[] {
  return SOURCE_CLASSES[source].map(
    (id) => stampState(freshnessClass(id), stampOf(checked), t, cal).state,
  );
}

/** A named calendar scenario: the games, the replay window, and (optionally) a mid-window release. */
interface Scenario {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly calAt: (t: number) => GameCalendar;
  /** Every kickoff in force at the window's end (the pregame property's targets). */
  readonly kickoffs: readonly number[];
}

function scenario(name: string, games: readonly NflGame[], from: string, to: string): Scenario {
  const cal = gameCalendarFromGames(games, name);
  return {
    name,
    from: Date.parse(from),
    to: Date.parse(to),
    calAt: () => cal,
    kickoffs: cal.kickoffs,
  };
}

/** A season whose release mid-window moves kickoffs (a flex or Week 18 set), discovered at `at`. */
function released(
  name: string,
  before: readonly NflGame[],
  after: readonly NflGame[],
  from: string,
  to: string,
  at: string,
): Scenario {
  const a = gameCalendarFromGames(before, `${name}-1`);
  const b = gameCalendarFromGames(after, `${name}-2`);
  const atMs = Date.parse(at);
  return {
    name,
    from: Date.parse(from),
    to: Date.parse(to),
    calAt: (t) => (t < atMs ? a : b),
    kickoffs: b.kickoffs.filter((k) => k > atMs + 3 * H),
  };
}

async function scenarios(): Promise<Scenario[]> {
  const fixture = await loadFixtureGames();
  const out: Scenario[] = [
    scenario(
      "fixture 2025",
      fixture.filter((g) => g.season === 2025),
      "2025-09-01T00:00:00Z",
      "2026-02-20T00:00:00Z",
    ),
    scenario(
      "fixture 2026",
      fixture.filter((g) => g.season === 2026),
      "2026-09-01T00:00:00Z",
      "2027-01-20T00:00:00Z",
    ),
  ];
  const openers = ["wed", "thu", "fri"] as const;
  const lengths = [18, 19, 20] as const;
  SYNTHETIC_SEASONS.forEach((season, i) => {
    const opener = openers[i % 3] ?? "thu";
    const regWeeks = lengths[i % 3] ?? 18;
    const games = syntheticSeason({
      season,
      regWeeks,
      opener,
      week18Placeholder: true,
      seed: i,
    });
    out.push(
      scenario(
        `synthetic ${String(season)} (${String(regWeeks)} weeks, ${opener} opener)`,
        games,
        `${String(season)}-08-25T00:00:00Z`,
        `${String(season + 1)}-02-25T00:00:00Z`,
      ),
    );
    // Week 18 set from its placeholders, discovered in early December
    out.push(
      released(
        `synthetic ${String(season)} week 18 set`,
        games,
        setWeek18(games),
        `${String(season)}-11-20T00:00:00Z`,
        `${String(season + 1)}-01-20T00:00:00Z`,
        `${String(season)}-12-05T14:05:00Z`,
      ),
    );
  });
  // a flexed kickoff: a late-season Sunday-night game moved to Sunday 13:00 ET, 12 days out
  const base = syntheticSeason({ season: 2027, seed: 5 });
  const snf = base
    .filter((g) => g.game_type === "REG" && g.week === 15 && g.kickoff !== null)
    .sort((a, b) => Date.parse(b.kickoff ?? "") - Date.parse(a.kickoff ?? ""))[0];
  if (snf?.kickoff == null) throw new Error("no week 15 game");
  const k = Date.parse(snf.kickoff);
  const moved = new Date(k - 7 * H - 20 * MIN).toISOString();
  out.push(
    released(
      "synthetic 2027 flexed kickoff",
      base,
      flexMove(base, snf.game_id, moved),
      new Date(k - 20 * DAY).toISOString(),
      new Date(k + 2 * DAY).toISOString(),
      new Date(k - 12 * DAY).toISOString(),
    ),
  );
  return out;
}

const SCENARIOS = await scenarios();

describe("the tick over real and synthetic calendars (zone-independent)", () => {
  it("covers the special games (non-vacuity)", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(13);
    for (const s of SCENARIOS) expect(s.kickoffs.length, s.name).toBeGreaterThan(0);
  });

  for (const s of SCENARIOS) {
    it(
      `${s.name}: healthy — every judged class fresh at every tick`,
      () => {
        const bad: string[] = [];
        for (const source of NFLVERSE)
          replay(source, s.calAt, s.from, s.to, {
            onTick: (t, sim, cal, peak) => {
              if (peak && states(source, sim.checked, t, cal).some((x) => x !== "fresh"))
                bad.push(`${source} at ${new Date(t).toISOString()}`);
            },
          });
        expect(bad.slice(0, 5)).toEqual([]);
      },
      REPLAY_TIMEOUT_MS,
    );

    it(
      `${s.name}: one failed or one missed tick — never expired`,
      () => {
        const bad: string[] = [];
        for (const source of NFLVERSE) {
          const healthy = replay(source, s.calAt, s.from, s.to);
          // fail / sleep through 12 of the healthy run's checks, spread over the window, plus the
          // last check before each of the first kickoffs (the tightest spot)
          const checks = healthy.checks;
          const picks = new Set<number>();
          for (let i = 1; i <= 12; i++) {
            const c = checks[Math.floor((i * (checks.length - 1)) / 13)];
            if (c !== undefined) picks.add(c);
          }
          for (const k of s.kickoffs.slice(0, 4)) {
            const before = checks.filter((c) => c < k).at(-1);
            if (before !== undefined) picks.add(before);
          }
          for (const t of picks) {
            const prev = checks.filter((c) => c < t).at(-1) ?? s.from;
            for (const mode of ["fail", "asleep"] as const) {
              const set = new Set([t]);
              replay(source, s.calAt, prev, Math.min(s.to, t + 2 * DAY), {
                checkedAt: prev,
                ...(mode === "fail" ? { failAt: set } : { asleep: set }),
                onTick: (now, sim, cal, peak) => {
                  if (peak && states(source, sim.checked, now, cal).includes("expired"))
                    bad.push(`${source} ${mode} at ${new Date(t).toISOString()}`);
                },
              });
            }
          }
        }
        expect(bad.slice(0, 5)).toEqual([]);
      },
      REPLAY_TIMEOUT_MS,
    );

    it(
      `${s.name}: schedules and lines ≤ 15 + 2 min old at every tick in [k − 2 h 45 m, k]`,
      () => {
        const bad: string[] = [];
        const ks = [...new Set(s.kickoffs)].sort((a, b) => a - b);
        let seen = 0;
        replay("nflverse:schedules", s.calAt, s.from, s.to, {
          onTick: (t, sim) => {
            // a kickoff k with t in [k − 2 h 45 m, k] ⇔ k in [t, t + 2 h 45 m]
            const k = ks.find((x) => x >= t && x <= t + 2 * H + 45 * MIN);
            if (k === undefined) return;
            seen++;
            if (t - sim.checked > TICK_MS + TICK_SLACK_MS)
              bad.push(`k ${new Date(k).toISOString()} at ${new Date(t).toISOString()}`);
          },
        });
        expect(seen).toBeGreaterThan(0);
        expect(bad.slice(0, 5)).toEqual([]);
      },
      REPLAY_TIMEOUT_MS,
    );
  }

  it("an off-season date checks schedules every 6 h (the spring release is seen within 6 h)", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const cal = gameCalendarFromGames(syntheticSeason({ season }), `off-${String(season)}`);
      const from = Date.parse(`${String(season + 1)}-04-10T00:00:00Z`);
      const sim = replay("nflverse:schedules", () => cal, from, from + 4 * DAY);
      const gaps = sim.checks.slice(1).map((t, i) => t - (sim.checks[i] ?? t));
      expect(gaps.length, String(season)).toBeGreaterThanOrEqual(15);
      for (const g of gaps) expect(g, String(season)).toBe(6 * H);
    }
  });

  it("the decisions are identical in every zone (one week of a synthetic season)", () => {
    const s = SCENARIOS.find((x) => x.name.startsWith("synthetic 2029"));
    if (s === undefined) throw new Error("no 2029 scenario");
    const from = Date.parse("2029-12-17T00:00:00Z");
    const run = (): number[] => replay("nflverse:schedules", s.calAt, from, from + 7 * DAY).checks;
    const want = withTz("UTC", run);
    expect(want.length).toBeGreaterThan(100);
    for (const zone of ALL_UTC_OFFSET_ZONES) expect(withTz(zone, run), zone).toEqual(want);
  });
});
