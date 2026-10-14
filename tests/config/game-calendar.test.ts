// game-calendar.test.ts — src/config/game-calendar.ts (season-fresh spec §2.2; QA-2-037): the
// kickoff-relative windows as properties over any kickoff set, the real 2025/2026 fixture calendars
// (every game off Thursday/Sunday/Monday is hot from k − 24 h), synthetic seasons 2026–2040, zone
// invariance under every UTC offset, the Eastern wall-time conversion against the store's own on
// every DST transition 2026–2030, and the "everything hot" fallback.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_PHASES,
  GAMEDAY_LEAD_MS,
  GAME_WINDOW_MS,
  IN_SEASON_MS,
  POSTGAME_MS,
  PREGAME_MS,
  REPORT_LEAD_MS,
  anyKickoffIn,
  easternClockOf,
  easternDateOf,
  easternWallTimeMs,
  fallbackCalendar,
  firstAfter,
  inHotWindow,
  isIsoDate,
  nextHotStart,
  nextKickoffAfter,
  phasesAt,
  scheduleCalendar,
  type CalendarFallbackReason,
  type CalendarPhase,
  type GameCalendar,
} from "../../src/config/game-calendar.js";
import { gameCalendarFromGames } from "../../src/domain/league/calendar.js";
import { kickoffUtcFromEastern } from "../../src/store/datasets/derive.js";
import { loadFixtureGames } from "../helpers/season/fixture.js";
import {
  SYNTHETIC_SEASONS,
  addDays,
  arbSeasonOptions,
  nextWeekday,
  syntheticSeason,
} from "../helpers/season/synthetic.js";
import { ALL_UTC_OFFSET_ZONES, withTz } from "../helpers/season/zones.js";

const H = 3_600_000;
const cal = (kickoffs: readonly number[], outdoor: readonly number[] = kickoffs): GameCalendar =>
  scheduleCalendar({ kickoffs, outdoorKickoffs: outdoor, fileVersion: "v" });

/** The oracle: the phases of `ms` straight from the §2.2 definitions. */
function oraclePhases(ks: readonly number[], ms: number): Set<CalendarPhase> {
  const out = new Set<CalendarPhase>();
  for (const k of ks) {
    if (Math.abs(ms - k) <= IN_SEASON_MS) out.add("in_season");
    if (ms >= k - PREGAME_MS && ms < k + GAME_WINDOW_MS) out.add("pregame");
    if (ms >= k - GAMEDAY_LEAD_MS && ms < k - PREGAME_MS) out.add("gameday");
    if (ms >= k - REPORT_LEAD_MS && ms < k) out.add("report");
    if (ms >= k + GAME_WINDOW_MS && ms < k + POSTGAME_MS) out.add("postgame");
  }
  if (out.size === 0) out.add("off_season");
  return out;
}
const oracleHot = (ks: readonly number[], ms: number): boolean =>
  ks.some((k) => ms >= k - GAMEDAY_LEAD_MS && ms < k + GAME_WINDOW_MS);
function oracleNextHot(ks: readonly number[], ms: number): number | null {
  if (oracleHot(ks, ms)) return ms;
  const starts = ks.map((k) => k - GAMEDAY_LEAD_MS).filter((s) => s > ms);
  return starts.length === 0 ? null : Math.min(...starts);
}

const BASE = Date.UTC(2027, 8, 1);
const arbKickoffs = fc
  .array(fc.integer({ min: 0, max: 120 * 96 }), { maxLength: 60 })
  .map((qs) => qs.map((q) => BASE + q * 15 * 60_000));
const arbInstant = fc.integer({ min: -10 * 96, max: 130 * 96 }).map((q) => BASE + q * 15 * 60_000);

describe("windows over any kickoff set (properties)", () => {
  it("inHotWindow, nextHotStart, phasesAt and nextKickoffAfter equal the per-kickoff definitions", () => {
    fc.assert(
      fc.property(arbKickoffs, arbInstant, fc.integer({ min: -3, max: 3 }), (ks, at, jitter) => {
        const ms = at + jitter; // off the quarter-hour grid too
        const c = cal(ks);
        if (ks.length === 0) {
          expect(c.basis).toBe("fallback");
          return;
        }
        expect(inHotWindow(c, ms)).toBe(oracleHot(ks, ms));
        expect(nextHotStart(c, ms)).toBe(oracleNextHot(ks, ms));
        expect([...phasesAt(c, ms)].sort()).toEqual([...oraclePhases(ks, ms)].sort());
        const after = ks.filter((k) => k > ms);
        expect(nextKickoffAfter(c, ms)).toBe(after.length === 0 ? null : Math.min(...after));
        expect(anyKickoffIn(c.kickoffs, ms - H, ms + H)).toBe(
          ks.some((k) => k >= ms - H && k <= ms + H),
        );
      }),
      { numRuns: 400 },
    );
  });

  it("the hot set is exactly the union of [k − 24 h, k + 4 h)", () => {
    const k = Date.UTC(2028, 10, 23, 17, 30);
    const c = cal([k]);
    expect(inHotWindow(c, k - GAMEDAY_LEAD_MS)).toBe(true);
    expect(inHotWindow(c, k - GAMEDAY_LEAD_MS - 1)).toBe(false);
    expect(inHotWindow(c, k + GAME_WINDOW_MS - 1)).toBe(true);
    expect(inHotWindow(c, k + GAME_WINDOW_MS)).toBe(false);
    expect(nextHotStart(c, k - 30 * H)).toBe(k - GAMEDAY_LEAD_MS);
    expect(nextHotStart(c, k + GAME_WINDOW_MS)).toBeNull();
  });

  it("each phase boundary is half-open at the documented offsets", () => {
    const k = Date.UTC(2029, 0, 6, 21, 30);
    const c = cal([k]);
    const at = (dt: number): string[] => [...phasesAt(c, k + dt)].sort();
    expect(at(-PREGAME_MS)).toEqual(["in_season", "pregame", "report"]);
    expect(at(-PREGAME_MS - 1)).toEqual(["gameday", "in_season", "report"]);
    expect(at(-GAMEDAY_LEAD_MS)).toEqual(["gameday", "in_season", "report"]);
    expect(at(-GAMEDAY_LEAD_MS - 1)).toEqual(["in_season", "report"]);
    expect(at(-REPORT_LEAD_MS)).toEqual(["in_season", "report"]);
    expect(at(-REPORT_LEAD_MS - 1)).toEqual(["in_season"]);
    expect(at(0)).toEqual(["in_season", "pregame"]);
    expect(at(GAME_WINDOW_MS)).toEqual(["in_season", "postgame"]);
    expect(at(POSTGAME_MS)).toEqual(["in_season"]);
    expect(at(IN_SEASON_MS)).toEqual(["in_season"]);
    expect(at(IN_SEASON_MS + 1)).toEqual(["off_season"]);
    expect(at(-IN_SEASON_MS - 1)).toEqual(["off_season"]);
  });

  it("phase vocabulary is the documented one, tightest first", () => {
    expect(CALENDAR_PHASES).toEqual([
      "pregame",
      "gameday",
      "report",
      "postgame",
      "in_season",
      "off_season",
    ]);
  });

  it("firstAfter is the index of the first element > x", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 })),
        fc.integer({ min: -60, max: 60 }),
        (xs, x) => {
          const sorted = [...xs].sort((a, b) => a - b);
          const i = firstAfter(sorted, x);
          expect(sorted.slice(0, i).every((v) => v <= x)).toBe(true);
          expect(sorted.slice(i).every((v) => v > x)).toBe(true);
        },
      ),
    );
  });
});

describe("scheduleCalendar and the fallback", () => {
  it("sorts, dedups and drops non-finite kickoffs; outdoor is a subset of kickoffs", () => {
    const c = cal([3, 1, 2, 2, Number.NaN, Number.POSITIVE_INFINITY], [2, 9, 2]);
    expect(c.basis).toBe("schedule");
    expect(c.reason).toBeNull();
    expect(c.kickoffs).toEqual([1, 2, 3]);
    expect(c.outdoor_kickoffs).toEqual([2]);
    expect(c.file_version).toBe("v");
  });

  it("no kickoff at all is the no_kickoffs fallback (never under-refresh)", () => {
    const c = cal([Number.NaN]);
    expect(c).toEqual(fallbackCalendar("no_kickoffs"));
  });

  it.each(["never_loaded", "unreadable", "expired", "no_kickoffs"] as CalendarFallbackReason[])(
    "a %s fallback is hot at every instant, its phases are {pregame}",
    (reason) => {
      const c = fallbackCalendar(reason);
      expect(c).toMatchObject({ basis: "fallback", reason, file_version: null });
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
          expect(inHotWindow(c, ms)).toBe(true);
          expect(nextHotStart(c, ms)).toBe(ms);
          expect([...phasesAt(c, ms)]).toEqual(["pregame"]);
          expect(nextKickoffAfter(c, ms)).toBeNull();
        }),
        { numRuns: 50 },
      );
    },
  );

  it("an off-season file (every kickoff far from now) is a schedule calendar, not a fallback", () => {
    const games = syntheticSeason({ season: 2027 });
    const c = gameCalendarFromGames(games, "v");
    const april = Date.UTC(2028, 3, 15);
    expect(c.basis).toBe("schedule");
    expect([...phasesAt(c, april)]).toEqual(["off_season"]);
    expect(inHotWindow(c, april)).toBe(false);
    expect(nextHotStart(c, april)).toBeNull();
  });
});

describe("the fixture calendars: game days come from the schedule (QA-2-037)", () => {
  it("every 2025 and 2026 game off Thursday/Sunday/Monday is hot from k − 24 h to k + 4 h", async () => {
    const games = await loadFixtureGames();
    const c = gameCalendarFromGames(games, "fixture");
    const odd = games.filter((g) => {
      const day = easternClockOf(Date.parse(g.kickoff ?? "")).weekday;
      return day !== "Thu" && day !== "Sun" && day !== "Mon";
    });
    // 2026: Wed 09-09, Wed 11-25, Fri 11-27, Sat 12-19 ×2, Fri 12-25 ×3; 2025: the Fri/Sat games
    expect(odd.filter((g) => g.season === 2026).map((g) => g.gameday)).toEqual([
      "2026-09-09",
      "2026-11-25",
      "2026-11-27",
      "2026-12-19",
      "2026-12-19",
      "2026-12-25",
      "2026-12-25",
      "2026-12-25",
    ]);
    expect(odd.filter((g) => g.season === 2025).length).toBe(12);
    for (const g of odd) {
      const k = Date.parse(g.kickoff ?? "");
      for (const dt of [-GAMEDAY_LEAD_MS, -PREGAME_MS, -1, 0, GAME_WINDOW_MS - 1])
        expect(inHotWindow(c, k + dt), `${g.game_id} ${String(dt)}`).toBe(true);
      expect(phasesAt(c, k - H).has("pregame"), g.game_id).toBe(true);
    }
  });

  it("the QA-2-037 instant (Sat 2026-12-19 12:00 ET) is inside a hot window", async () => {
    const c = gameCalendarFromGames(await loadFixtureGames(), "fixture");
    expect(inHotWindow(c, easternWallTimeMs("2026-12-19", 12, 0))).toBe(true);
    // and a Tuesday morning between weeks is not
    expect(inHotWindow(c, easternWallTimeMs("2026-12-15", 9, 0))).toBe(false);
  });
});

describe("synthetic seasons 2026–2040: Saturday, Wednesday, Thanksgiving, Christmas, international", () => {
  it("every kickoff of any synthetic season is pregame at k − 1 h and hot from k − 24 h", () => {
    fc.assert(
      fc.property(arbSeasonOptions, (o) => {
        const games = syntheticSeason(o);
        const c = gameCalendarFromGames(games, "v");
        for (const g of games) {
          if (g.kickoff === null) continue;
          const k = Date.parse(g.kickoff);
          expect(inHotWindow(c, k - GAMEDAY_LEAD_MS)).toBe(true);
          expect(phasesAt(c, k - H).has("pregame")).toBe(true);
          expect(phasesAt(c, k + 5 * H).has("postgame") || inHotWindow(c, k + 5 * H)).toBe(true);
        }
      }),
      { numRuns: 15 },
    );
  });

  it("a TBD game makes its whole Eastern gameday hot (00:00 and 23:59 ET pseudo-kickoffs)", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const games = syntheticSeason({ season });
      const tbd = games.find((g) => g.kickoff === null);
      expect(tbd, String(season)).toBeDefined();
      const day = tbd?.gameday ?? "";
      const c = gameCalendarFromGames(games, "v");
      expect(c.kickoffs).toContain(easternWallTimeMs(day, 0, 0));
      expect(c.kickoffs).toContain(easternWallTimeMs(day, 23, 59));
      for (let m = 0; m < 24 * 60; m += 37)
        expect(inHotWindow(c, easternWallTimeMs(day, Math.floor(m / 60), m % 60))).toBe(true);
    }
  });

  it("indoor games never reach outdoor_kickoffs; outdoor ones do", () => {
    const games = syntheticSeason({ season: 2028, seed: 3 });
    const c = gameCalendarFromGames(games, "v");
    for (const g of games) {
      if (g.kickoff === null) continue;
      const k = Date.parse(g.kickoff);
      const sameInstant = games.filter((x) => x.kickoff !== null && Date.parse(x.kickoff) === k);
      const anyOutdoor = sameInstant.some((x) => x.roof !== "dome" && x.roof !== "closed");
      expect(c.outdoor_kickoffs.includes(k), g.game_id).toBe(anyOutdoor);
    }
  });
});

describe("zone invariance: every function, every UTC offset", () => {
  it("returns identical results under every zone of ALL_UTC_OFFSET_ZONES", () => {
    const games = [
      ...syntheticSeason({ season: 2026, opener: "wed", seed: 1 }),
      ...syntheticSeason({ season: 2029, regWeeks: 20, opener: "fri", seed: 2 }),
    ];
    const probe = (): string => {
      const c = gameCalendarFromGames(games, "v");
      const out: unknown[] = [c.kickoffs.length, c.outdoor_kickoffs.length];
      for (let ms = Date.UTC(2026, 7, 20); ms < Date.UTC(2030, 2, 1); ms += 41 * H + 13 * 60_000)
        out.push(
          inHotWindow(c, ms),
          nextHotStart(c, ms),
          [...phasesAt(c, ms)].sort().join(","),
          nextKickoffAfter(c, ms),
          easternDateOf(ms),
          easternClockOf(ms).weekday,
        );
      out.push(easternWallTimeMs("2029-11-04", 1, 30), easternWallTimeMs("2027-03-14", 2, 30));
      return JSON.stringify(out);
    };
    const baseline = withTz("UTC", probe);
    for (const tz of ALL_UTC_OFFSET_ZONES) expect(withTz(tz, probe), tz).toBe(baseline);
  });

  it("the zone switch is real (non-vacuity)", () => {
    const ms = Date.UTC(2026, 9, 10, 11, 30);
    expect(withTz("UTC", () => new Date(ms).getHours())).toBe(11);
    expect(withTz("Pacific/Kiritimati", () => new Date(ms).getHours())).toBe(1);
    expect(withTz("Asia/Kathmandu", () => new Date(ms).getMinutes())).toBe(15);
  });
});

describe("Eastern wall time", () => {
  /** The DST transition dates of America/New_York: 2nd Sunday of March, 1st Sunday of November. */
  const transitions = (year: number): string[] => [
    addDays(nextWeekday(`${String(year)}-03-01`, 0), 7),
    nextWeekday(`${String(year)}-11-01`, 0),
  ];

  it("equals kickoffUtcFromEastern on every DST transition day 2026–2030 (each minute 00:00–03:59, then every 5 min)", () => {
    for (const year of [2026, 2027, 2028, 2029, 2030])
      for (const day of transitions(year))
        for (let m = 0; m < 24 * 60; m += m < 4 * 60 ? 1 : 5) {
          const hh = Math.floor(m / 60);
          const mm = m % 60;
          const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
          const want = Date.parse(kickoffUtcFromEastern(day, time) ?? "");
          if (easternWallTimeMs(day, hh, mm) !== want)
            expect(easternWallTimeMs(day, hh, mm), `${day} ${time}`).toBe(want);
        }
  });

  it("round-trips through easternClockOf away from the transitions", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 365 * 5 }),
        fc.integer({ min: 4, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        (dayOffset, hh, mm) => {
          const day = addDays("2026-01-01", dayOffset);
          const ms = easternWallTimeMs(day, hh, mm);
          const c = easternClockOf(ms);
          expect([c.date, c.hour, c.minute]).toEqual([day, hh, mm]);
          expect(easternDateOf(ms)).toBe(day);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("names the Eastern weekday, not the local one", () => {
    // Saturday 2026-12-19 20:20 ET is Sunday 01:20 UTC
    const ms = easternWallTimeMs("2026-12-19", 20, 20);
    expect(new Date(ms).toISOString()).toBe("2026-12-20T01:20:00.000Z");
    expect(withTz("Asia/Tokyo", () => easternClockOf(ms))).toEqual({
      date: "2026-12-19",
      weekday: "Sat",
      hour: 20,
      minute: 20,
    });
  });

  it("refuses malformed dates and times", () => {
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2026-1-01")).toBe(false);
    expect(() => easternWallTimeMs("2026-13-01", 0, 0)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", 24, 0)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", 0, 60)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", -1, 0)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", 0, -1)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", 1.5, 0)).toThrow(RangeError);
    expect(() => easternWallTimeMs("2026-12-01", 1, 0.5)).toThrow(RangeError);
  });
});
