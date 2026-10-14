// cadence-politeness.test.ts — the refresh policy as a whole (season-fresh spec §4.2, §6, §12 B1):
// (1) politeness — for any history of tick and answer-time decisions from up to three processes
// sharing one refresh_log, two attempts for one source are never less than 14 min apart unless one is
// a repair; (2) freshness — a healthy 15-minute tick (launchd jitter and run time included) keeps
// every judged class fresh at every tick over synthetic seasons 2026–2030 of 18, 19 and 20 regular
// weeks, with Wednesday/Friday openers, Thanksgiving, Christmas, Saturday and international games, a
// Week-18 placeholder later set, and a flexed kickoff discovered by the tick itself.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DUE_SOURCES,
  MIN_RELEASE_GAP_MS,
  ON_DEMAND,
  SOURCE_CLASSES,
  TICK_MS,
  dueDecision,
  onDemandDecision,
  type DueSource,
  type SourceState,
} from "../../src/config/cadence.js";
import {
  freshnessClass,
  isExpired,
  stampState,
  type StampInstants,
} from "../../src/config/freshness.js";
import { easternClockOf, type GameCalendar } from "../../src/config/game-calendar.js";
import { gameCalendarFromGames } from "../../src/domain/league/calendar.js";
import {
  SYNTHETIC_SEASONS,
  etIso,
  flexMove,
  lastRegWeekOf,
  setWeek18,
  syntheticSeason,
  type SyntheticOptions,
} from "../helpers/season/synthetic.js";

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

interface Log {
  file: SourceState["file"];
  basisMs: number | null;
  lastAttemptMs: number | null;
  failures: number;
  lastBucketMs: number | null;
}

const stamps = new Map<number, StampInstants>();
/** A release stamp checked at `ms` (memoised: the simulation asks for the same few over and over). */
function stampOf(ms: number): StampInstants {
  let t = stamps.get(ms);
  if (t === undefined) {
    const iso = new Date(ms).toISOString();
    t = { as_of: iso, fetched_at: iso, checked_at: iso };
    if (stamps.size > 10_000) stamps.clear();
    stamps.set(ms, t);
  }
  return t;
}
const stateOf = (l: Log): SourceState => ({
  file: l.file,
  basis: l.basisMs === null ? null : stampOf(l.basisMs),
  lastAttemptMs: l.lastAttemptMs,
  consecutiveFailures: l.failures,
  backoffUntilMs: null,
});

const SEASON_CAL = new Map<number, GameCalendar>();
function seasonCal(season: number): GameCalendar {
  let c = SEASON_CAL.get(season);
  if (c === undefined) {
    c = gameCalendarFromGames(syntheticSeason({ season, seed: season }), "v");
    SEASON_CAL.set(season, c);
  }
  return c;
}

describe("politeness: the 14-minute floor holds across processes", () => {
  const arbEvent = fc.record({
    // mostly minutes apart (a busy conversation), sometimes hours
    dtS: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: 0, max: 20 * 60 }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 3 * 3600 }) },
    ),
    proc: fc.integer({ min: 0, max: 2 }),
    kind: fc.constantFrom("tick", "on_demand"),
    source: fc.constantFrom(...DUE_SOURCES),
    ok: fc.boolean(),
    required: fc.boolean(),
  });
  const arbStart = fc.record({
    season: fc.constantFrom(...SYNTHETIC_SEASONS),
    // start up to two days before some kickoff of the season (pregame and game-day windows)
    kickoffIndex: fc.nat(),
    leadMin: fc.integer({ min: 0, max: 48 * 60 }),
    file: fc.constantFrom<Log["file"]>("ok", "never_loaded", "unreadable"),
    basisAgoMin: fc.integer({ min: 0, max: 10 * 24 * 60 }),
    failures: fc.integer({ min: 0, max: 4 }),
  });

  it("two attempts for one source are never < 14 min apart unless one is a repair", () => {
    fc.assert(
      fc.property(
        arbStart,
        fc.array(arbEvent, { minLength: 1, maxLength: 120 }),
        (start, events) => {
          const cal = seasonCal(start.season);
          const ks = cal.kickoffs;
          let now = (ks[start.kickoffIndex % ks.length] ?? 0) - start.leadMin * MIN;
          const logs = new Map<DueSource, Log>();
          for (const s of DUE_SOURCES)
            logs.set(s, {
              file: start.file,
              basisMs: start.file === "ok" ? now - start.basisAgoMin * MIN : null,
              lastAttemptMs: start.file === "ok" ? now - start.basisAgoMin * MIN : null,
              failures: start.failures,
              lastBucketMs: null,
            });
          const attempts = new Map<DueSource, { at: number; repair: boolean }[]>();
          for (const e of events) {
            now += e.dtS * 1000;
            const log = logs.get(e.source)!;
            const state = stateOf(log);
            const weather = { lastBucketMs: log.lastBucketMs, horizonHours: 48 };
            let attempt = false;
            let repair = false;
            if (e.kind === "tick") {
              const d = dueDecision({ source: e.source, nowMs: now, cal, state, weather });
              attempt = d.due;
              repair = d.reason === "repair";
            } else {
              const expired =
                log.basisMs !== null &&
                isExpired(
                  freshnessClass(SOURCE_CLASSES[e.source][0] ?? "weather"),
                  stampOf(log.basisMs),
                  now,
                );
              const a = onDemandDecision({
                source: e.source,
                nowMs: now,
                cal,
                state,
                weather,
                required: e.required,
                expired,
              });
              attempt = a.kind === "wait" || a.kind === "background";
              repair = a.kind === "wait" && a.reason === "repair";
            }
            if (!attempt) continue;
            const list = attempts.get(e.source) ?? [];
            const prev = list[list.length - 1];
            if (prev !== undefined && now - prev.at < MIN_RELEASE_GAP_MS)
              expect(prev.repair || repair, `${e.source} ${String(now - prev.at)} ms`).toBe(true);
            list.push({ at: now, repair });
            attempts.set(e.source, list);
            // the run lock + refresh_log row are written at the start of the attempt
            log.lastAttemptMs = now;
            if (e.ok) {
              log.file = "ok";
              log.basisMs = now;
              log.failures = 0;
              log.lastBucketMs = Math.floor(now / H) * H;
            } else log.failures += 1;
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("answer-time budgets never exceed the per-call cap", () => {
    expect(Math.max(ON_DEMAND.waitFastMs, ON_DEMAND.waitRepairMs)).toBeLessThanOrEqual(
      ON_DEMAND.callCapMs,
    );
  });
});

describe("freshness: a healthy tick keeps every judged class fresh at every tick", () => {
  /** Runs the 15-minute tick from 1 August to 1 March; returns the stale observations. */
  function simulate(o: SyntheticOptions, seed: number): string[] {
    const season = o.season;
    const original = syntheticSeason({ ...o, week18Placeholder: true });
    // upstream: the final week is set three weeks before its kickoffs, and one Sunday-night game
    // of week 10 is flexed to Sunday 13:00 nine days before it
    const lastWeek = lastRegWeekOf(original, season);
    const finalKick = Date.parse(
      original.find((g) => g.week === lastWeek && g.kickoff !== null)?.kickoff ?? "",
    );
    const snf = original.find((g) => {
      if (g.week !== 10 || g.kickoff === null) return false;
      const c = easternClockOf(Date.parse(g.kickoff));
      return c.weekday === "Sun" && c.hour === 20;
    });
    if (snf === undefined) throw new Error("no Sunday-night game in week 10");
    const snfK = Date.parse(snf.kickoff ?? "");
    const flexAt = snfK - 9 * D;
    const setAt = finalKick - 21 * D;
    const flexed = flexMove(original, snf.game_id, etIso(snf.gameday ?? "", "13:00"));
    const versions = [
      { from: Number.NEGATIVE_INFINITY, cal: gameCalendarFromGames(original, "a") },
      { from: flexAt, cal: gameCalendarFromGames(flexed, "b") },
      { from: setAt, cal: gameCalendarFromGames(setWeek18(flexed), "c") },
    ].sort((a, b) => a.from - b.from);
    const upstreamAt = (ms: number): GameCalendar =>
      versions.filter((v) => v.from <= ms).at(-1)?.cal ??
      (versions[0] as { cal: GameCalendar }).cal;

    let r = seed >>> 0;
    const rand = (n: number): number => {
      r = (Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return r % n;
    };
    const start = Date.UTC(season, 7, 1);
    const end = Date.UTC(season + 1, 2, 1);
    let cal = upstreamAt(start);
    const logs = new Map<DueSource, Log>();
    for (const s of DUE_SOURCES)
      logs.set(s, {
        file: "ok",
        basisMs: start - 5 * MIN,
        lastAttemptMs: start - 5 * MIN,
        failures: 0,
        lastBucketMs: null,
      });
    const stale: string[] = [];
    for (let q = start; q < end; q += TICK_MS) {
      const now = q + rand(61) * 1000; // launchd fires within a minute of the quarter hour
      for (const source of DUE_SOURCES) {
        if (source === "weather") continue;
        const log = logs.get(source)!;
        for (const id of SOURCE_CLASSES[source]) {
          const st = stampState(freshnessClass(id), stampOf(log.basisMs ?? 0), now, cal);
          if (st.state !== "fresh")
            stale.push(`${source}/${id} ${new Date(now).toISOString()} age ${String(st.age_s)}s`);
        }
        const d = dueDecision({ source, nowMs: now, cal, state: stateOf(log) });
        if (!d.due) continue;
        const done = now + rand(31) * 1000;
        log.lastAttemptMs = now;
        log.basisMs = done;
        if (source === "nflverse:schedules") cal = upstreamAt(now);
      }
    }
    return stale;
  }

  const shapes: [number, SyntheticOptions][] = SYNTHETIC_SEASONS.map((season, i) => [
    i,
    {
      season,
      regWeeks: ([18, 19, 20, 18, 19] as const)[i] ?? 18,
      opener: (["wed", "thu", "fri", "thu", "wed"] as const)[i] ?? "thu",
      seed: i,
    },
  ]);

  it.each(shapes)("season shape %i: no judged class is stale at any tick", (i, o) => {
    expect(simulate(o, 1000 + i).slice(0, 5)).toEqual([]);
  });
});
