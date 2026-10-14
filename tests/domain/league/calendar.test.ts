// calendar.test.ts — src/domain/league/calendar.ts (season-fresh spec §2.1, §2.2, §8.8): the
// schedule view never throws and never under-refreshes — no file → `never_loaded` + the bootstrap
// phase; a reader that throws (the store's week bound included) → `unreadable`; a file past its hard
// limit → the `expired` fallback calendar with seasons and phase still from the file — and the file
// read is memoised per file version while the phase is recomputed per instant.
import { describe, expect, it } from "vitest";
import { isExpired, freshnessClass } from "../../../src/config/freshness.js";
import { easternWallTimeMs, inHotWindow } from "../../../src/config/game-calendar.js";
import {
  VIEW_TENTATIVE_MAX,
  gameCalendarFromGames,
  isOutdoorGame,
  scheduleView,
} from "../../../src/domain/league/calendar.js";
import {
  lastRegWeekOf,
  setWeek18,
  syntheticSeason,
  syntheticSeasons,
} from "../../helpers/season/synthetic.js";
import {
  mutableScheduleReader,
  neverLoadedScheduleReader,
  scheduleReaderOf,
  throwingScheduleReader,
} from "../../helpers/season/reader.js";

const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number): string => new Date(ms).toISOString();

describe("scheduleView: what a missing or broken schedule degrades to", () => {
  it("no file → never_loaded fallback, bootstrap phase, no games", () => {
    const now = Date.UTC(2028, 9, 1);
    const v = scheduleView(neverLoadedScheduleReader(), now);
    expect(v.stamp).toBeNull();
    expect(v.calendar).toMatchObject({ basis: "fallback", reason: "never_loaded" });
    expect(v.phase).toMatchObject({ season: 2028, phase: "regular", basis: "bootstrap" });
    expect(v.seasons).toEqual([]);
    expect(v.games(2028)).toEqual([]);
    expect(v.schedule(2028)).toBeNull();
    expect(v.tentative).toEqual([]);
    expect(inHotWindow(v.calendar, now)).toBe(true);
  });

  it("a reader that throws → unreadable; the store's week bound throws only past the probe (stamp kept)", () => {
    const now = Date.UTC(2027, 10, 1);
    const v = scheduleView(throwingScheduleReader(), now);
    expect(v.calendar.reason).toBe("unreadable");
    expect(v.stamp).toBeNull();
    expect(v.phase.basis).toBe("bootstrap");
    const games = syntheticSeason({ season: 2027 });
    const w = scheduleView(throwingScheduleReader({ afterProbe: { games } }), now);
    expect(w.calendar.reason).toBe("unreadable");
    expect(w.stamp?.file_version).toBe("v1");
  });

  it("a schedules file past its hard limit → the expired calendar, seasons and phase still from the file", () => {
    const games = syntheticSeasons([2026, 2027]);
    const now = Date.UTC(2027, 9, 20);
    const checked = now - 8 * D;
    const reader = scheduleReaderOf(games, {
      checkedAt: iso(checked),
      fetchedAt: iso(checked - D),
    });
    const v = scheduleView(reader, now);
    expect(
      isExpired(
        freshnessClass("nflverse_schedules"),
        v.stamp ?? { as_of: "", fetched_at: "", checked_at: null },
        now,
      ),
    ).toBe(true);
    expect(v.calendar).toMatchObject({ basis: "fallback", reason: "expired" });
    expect(v.seasons.map((s) => s.season)).toEqual([2026, 2027]);
    expect(v.phase).toMatchObject({ season: 2027, phase: "regular", basis: "schedule" });
    // a stamp whose instants cannot be read is never trusted as fresh
    const bad = scheduleView(
      scheduleReaderOf(games, { checkedAt: "not a date", fileVersion: "bad" }),
      now,
    );
    expect(bad.calendar.reason).toBe("expired");
  });

  it("a file holding no game with a kickoff or gameday → the no_kickoffs fallback", () => {
    const blank = syntheticSeason({ season: 2029 }).map((g) => ({
      ...g,
      kickoff: null,
      gameday: null,
    }));
    const now = Date.UTC(2029, 9, 1);
    const v = scheduleView(scheduleReaderOf(blank, { checkedAt: iso(now - H) }), now);
    expect(v.calendar.reason).toBe("no_kickoffs");
    expect(v.phase.basis).toBe("bootstrap");
  });
});

describe("scheduleView: the loaded schedule", () => {
  it("reads the stamp's seasons; without them the bootstrap season ± 1", () => {
    const games = syntheticSeasons([2025, 2026, 2027, 2028]);
    const now = Date.UTC(2027, 9, 20);
    const withSeasons = scheduleView(
      scheduleReaderOf(games, { checkedAt: iso(now - H), seasons: [2027, 2028] }),
      now,
    );
    expect(withSeasons.seasons.map((s) => s.season)).toEqual([2027, 2028]);
    const without = scheduleView(
      scheduleReaderOf(games, { checkedAt: iso(now - H), seasons: null }),
      now,
    );
    expect(without.seasons.map((s) => s.season)).toEqual([2026, 2027, 2028]);
    expect(without.games(2025)).toEqual([]);
    expect(without.games(2027).length).toBeGreaterThan(250);
    expect(without.schedule(2027)?.last_reg_week).toBe(18);
    expect(without.schedule(2031)).toBeNull();
    // a season named on the stamp but absent from the rows is not a loaded season
    const ghost = scheduleView(
      scheduleReaderOf(games, { checkedAt: iso(now - H), seasons: [2027, 2030] }),
      now,
    );
    expect(ghost.seasons.map((s) => s.season)).toEqual([2027]);
  });

  it("memoises the file read per file version; a republish re-reads; the phase follows the instant", () => {
    const g1 = syntheticSeason({ season: 2028, week18Placeholder: true });
    const now = Date.UTC(2028, 9, 25);
    // checked "later" than `now` (age 0), so the stamp is still inside its limit a week on
    const reader = mutableScheduleReader(g1, { checkedAt: iso(now + 2 * D), fileVersion: "a" });
    const v1 = scheduleView(reader, now);
    const afterFirst = reader.calls();
    expect(afterFirst).toBeGreaterThan(1); // the probe plus each season
    const v2 = scheduleView(reader, now + 7 * D);
    expect(reader.calls()).toBe(afterFirst + 1); // the probe only
    expect(v2.calendar).toBe(v1.calendar);
    expect(v2.phase.week).toBeGreaterThan(v1.phase.week ?? 0);
    reader.publish(setWeek18(g1), { checkedAt: iso(now + 7 * D), fileVersion: "b" });
    const v3 = scheduleView(reader, now + 7 * D);
    expect(reader.calls()).toBeGreaterThan(afterFirst + 2);
    expect(v3.calendar.file_version).toBe("b");
    expect(v3.calendar).not.toBe(v1.calendar);
  });

  it("TBD games add whole-Eastern-day pseudo-kickoffs; indoor games stay out of the outdoor list", () => {
    const games = syntheticSeason({ season: 2030, regWeeks: 19, seed: 7 });
    const tbd = games.find((g) => g.kickoff === null)!;
    const day = tbd.gameday ?? "";
    const c = gameCalendarFromGames(games, "v");
    expect(c.kickoffs).toEqual(
      expect.arrayContaining([easternWallTimeMs(day, 0, 0), easternWallTimeMs(day, 23, 59)]),
    );
    expect(isOutdoorGame({ ...tbd, roof: null })).toBe(true);
    expect(isOutdoorGame({ ...tbd, roof: "Dome" })).toBe(false);
    expect(isOutdoorGame({ ...tbd, roof: "closed" })).toBe(false);
    expect(isOutdoorGame({ ...tbd, roof: "open" })).toBe(true);
  });

  it("the tentative weeks: the placeholder final week until the NFL sets it", () => {
    const g = syntheticSeason({ season: 2027, week18Placeholder: true, seed: 3 });
    const last = lastRegWeekOf(g, 2027);
    const lastKick = Math.min(
      ...g.filter((x) => x.week === last).map((x) => Date.parse(x.kickoff ?? "")),
    );
    const now = lastKick - 10 * D;
    const v = scheduleView(scheduleReaderOf(g, { checkedAt: iso(now - H) }), now);
    expect(v.tentative.length).toBeLessThanOrEqual(VIEW_TENTATIVE_MAX);
    expect(v.tentative).toContainEqual({
      season: 2027,
      week: last,
      reason: "placeholder_week",
      until: null,
    });
    const set = scheduleView(
      scheduleReaderOf(setWeek18(g), { checkedAt: iso(now - H), fileVersion: "set" }),
      now,
    );
    expect(set.tentative.some((t) => t.reason === "placeholder_week")).toBe(false);
  });
});
