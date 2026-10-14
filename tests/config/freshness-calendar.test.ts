// freshness-calendar.test.ts — the calendar-based TTL of src/config/freshness.ts (season-fresh spec
// §3.1; closes QA-2-037): schedules and lines get their 30-minute TTL inside every kickoff's hot
// window and outside it stay fresh until the next window opens (at most 6.5 h), whatever the weekday,
// season or zone; expiry never depends on the calendar.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FRESHNESS_CLASS_IDS,
  FRESHNESS_TABLE,
  freshUntilMs,
  freshnessClass,
  isExpired,
  stampState,
  ttlAt,
  type StampInstants,
} from "../../src/config/freshness.js";
import {
  GAMEDAY_LEAD_MS,
  easternClockOf,
  easternWallTimeMs,
  fallbackCalendar,
  inHotWindow,
  scheduleCalendar,
  type GameCalendar,
} from "../../src/config/game-calendar.js";
import { gameCalendarFromGames } from "../../src/domain/league/calendar.js";
import { loadFixtureGames } from "../helpers/season/fixture.js";
import { arbSeasonOptions, syntheticSeason } from "../helpers/season/synthetic.js";
import { ALL_UTC_OFFSET_ZONES, withTz } from "../helpers/season/zones.js";

const MIN = 60;
const H = 3_600_000;
const D = 24 * H;
const SCHEDULES = freshnessClass("nflverse_schedules");
const LINES = freshnessClass("lines");
const THIRTY_MIN = 30 * MIN;
const OFF = 6 * 3600 + 30 * MIN;

const at = (ms: number): StampInstants => {
  const iso = new Date(ms).toISOString();
  return {
    as_of: "2026-09-01T00:00:00.000Z",
    fetched_at: "2026-09-01T00:00:00.000Z",
    checked_at: iso,
  };
};
const cal = (ks: readonly number[]): GameCalendar =>
  scheduleCalendar({ kickoffs: ks, outdoorKickoffs: ks, fileVersion: "v" });

describe("QA-2-037: game days come from the schedule", () => {
  it("lines checked Sat 2026-12-19 12:00 ET and judged 16:59 ET read stale (fresh under the weekday rule)", async () => {
    const c = gameCalendarFromGames(await loadFixtureGames(), "fixture");
    const checked = easternWallTimeMs("2026-12-19", 12, 0);
    const judged = easternWallTimeMs("2026-12-19", 16, 59);
    for (const tz of ALL_UTC_OFFSET_ZONES)
      withTz(tz, () => {
        expect(stampState(LINES, at(checked), judged, c).state, tz).toBe("stale");
        expect(stampState(SCHEDULES, at(checked), judged, c).state, tz).toBe("stale");
      });
    // the weekday rule this replaces calls a US Saturday an off day (the reproduction)
    expect(withTz("America/New_York", () => stampState(LINES, at(checked), judged).state)).toBe(
      "fresh",
    );
  });

  it("a check 1 h before each off-weekday kickoff of the fixtures gets 30 min", async () => {
    const games = await loadFixtureGames();
    const c = gameCalendarFromGames(games, "fixture");
    const off = games.filter((g) => {
      const day = easternClockOf(Date.parse(g.kickoff ?? "")).weekday;
      return day !== "Sun" && day !== "Mon" && day !== "Thu";
    });
    expect(off.length).toBeGreaterThanOrEqual(20);
    for (const g of off) {
      const k = Date.parse(g.kickoff ?? "");
      expect(ttlAt(SCHEDULES, k - H, c), g.game_id).toBe(THIRTY_MIN);
      expect(ttlAt(LINES, k - H, c), g.game_id).toBe(THIRTY_MIN);
    }
  });

  it("an off-season check with the next kickoff 20 days away gets 6.5 h", () => {
    const now = Date.UTC(2027, 7, 1, 12);
    const c = cal([now - 180 * D, now + 20 * D]);
    expect(ttlAt(SCHEDULES, now, c)).toBe(OFF);
    expect(stampState(SCHEDULES, at(now), now + 6 * H, c).state).toBe("fresh");
    expect(stampState(SCHEDULES, at(now), now + 6.6 * H, c).state).toBe("stale");
  });

  it("a check 2 h before a hot window gets 2 h; 10 min before gets the 30-min floor", () => {
    const k = Date.UTC(2028, 9, 15, 17);
    const c = cal([k]);
    const windowOpens = k - GAMEDAY_LEAD_MS;
    expect(ttlAt(SCHEDULES, windowOpens - 2 * H, c)).toBe(2 * 3600);
    expect(ttlAt(SCHEDULES, windowOpens - 10 * 60_000, c)).toBe(THIRTY_MIN);
    // and it expires when the window opens
    expect(stampState(SCHEDULES, at(windowOpens - 2 * H), windowOpens, c).state).toBe("fresh");
    expect(stampState(SCHEDULES, at(windowOpens - 2 * H), windowOpens + 1000, c).state).toBe(
      "stale",
    );
  });

  it("no next window at all (after the last kickoff of the file) gets the off-window TTL", () => {
    const k = Date.UTC(2027, 1, 7, 23);
    expect(ttlAt(SCHEDULES, k + 2 * D, cal([k]))).toBe(OFF);
  });

  it("a fallback calendar keeps the 30-minute TTL at every instant (never under-refresh)", () => {
    for (const reason of ["never_loaded", "unreadable", "expired", "no_kickoffs"] as const)
      expect(ttlAt(SCHEDULES, Date.UTC(2027, 3, 15), fallbackCalendar(reason))).toBe(THIRTY_MIN);
  });

  it("every class without an off-window TTL ignores the calendar", () => {
    const c = cal([Date.UTC(2027, 3, 1)]);
    for (const id of FRESHNESS_CLASS_IDS) {
      const cls = FRESHNESS_TABLE[id];
      if (cls.offDayTtlSeconds !== null) continue;
      expect(ttlAt(cls, Date.UTC(2027, 3, 15), c), id).toBe(cls.ttlSeconds);
      expect(ttlAt(cls, Date.UTC(2027, 3, 15), fallbackCalendar("expired")), id).toBe(
        cls.ttlSeconds,
      );
    }
  });
});

describe("properties over synthetic seasons and zones", () => {
  it("ttlAt lies in [ttl, offDayTtl], equals ttl inside a hot window, and extra kickoffs never loosen it", () => {
    fc.assert(
      fc.property(
        arbSeasonOptions,
        fc.integer({ min: 0, max: 400 * 96 }),
        fc.array(fc.integer({ min: -48, max: 48 * 4 }), { maxLength: 4 }),
        (o, q, extra) => {
          const games = syntheticSeason(o);
          const c = gameCalendarFromGames(games, "v");
          const b = Date.UTC(o.season, 6, 1) + q * 15 * 60_000;
          const t = ttlAt(SCHEDULES, b, c) ?? -1;
          expect(t).toBeGreaterThanOrEqual(THIRTY_MIN);
          expect(t).toBeLessThanOrEqual(OFF);
          if (inHotWindow(c, b)) expect(t).toBe(THIRTY_MIN);
          const more = cal([...c.kickoffs, ...extra.map((x) => b + x * 15 * 60_000)]);
          expect(ttlAt(SCHEDULES, b, more) ?? -1).toBeLessThanOrEqual(t);
          // never looser than a calendar with no kickoff anywhere near
          expect(t).toBeLessThanOrEqual(ttlAt(SCHEDULES, b, cal([b + 400 * D])) ?? -1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("expired is identical under every calendar and equals isExpired, for every class", () => {
    const cals: GameCalendar[] = [
      fallbackCalendar("never_loaded"),
      cal([Date.UTC(2027, 9, 3, 17)]),
      gameCalendarFromGames(syntheticSeason({ season: 2027 }), "v"),
    ];
    const NOW = Date.UTC(2027, 9, 4, 12);
    fc.assert(
      fc.property(
        fc.constantFrom(...FRESHNESS_CLASS_IDS),
        fc.integer({ min: 0, max: 40 * 86_400 }),
        fc.integer({ min: 0, max: 40 * 86_400 }),
        (id, fetchedAgo, checkedAgo) => {
          const cls = FRESHNESS_TABLE[id];
          const t: StampInstants = {
            as_of: new Date(NOW - fetchedAgo * 1000).toISOString(),
            fetched_at: new Date(NOW - fetchedAgo * 1000).toISOString(),
            checked_at: new Date(NOW - checkedAgo * 1000).toISOString(),
          };
          const want = isExpired(cls, t, NOW);
          expect(stampState(cls, t, NOW).state === "expired").toBe(want);
          for (const c of cals) expect(stampState(cls, t, NOW, c).state === "expired").toBe(want);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("ttlAt, stampState and freshUntilMs are the same in every zone", () => {
    const c = gameCalendarFromGames(syntheticSeason({ season: 2029, regWeeks: 19, seed: 5 }), "v");
    const probe = (): string => {
      const out: unknown[] = [];
      for (let b = Date.UTC(2029, 7, 25); b < Date.UTC(2030, 1, 20); b += 29 * H + 7 * 60_000)
        out.push(
          ttlAt(SCHEDULES, b, c),
          stampState(LINES, at(b), b + 45 * 60_000, c).state,
          freshUntilMs(SCHEDULES, at(b), c),
        );
      return JSON.stringify(out);
    };
    const base = withTz("UTC", probe);
    for (const tz of ALL_UTC_OFFSET_ZONES) expect(withTz(tz, probe), tz).toBe(base);
  });
});

describe("isExpired and freshUntilMs", () => {
  it("isExpired is past the hard limit only; never for immutable or limitless classes", () => {
    const NOW = Date.UTC(2027, 0, 1);
    const old = at(NOW - 400 * D);
    expect(isExpired(SCHEDULES, at(NOW - 7 * D), NOW)).toBe(false);
    expect(isExpired(SCHEDULES, at(NOW - 7 * D - 1000), NOW)).toBe(true);
    expect(isExpired(freshnessClass("crosswalk"), old, NOW)).toBe(false);
    expect(isExpired(freshnessClass("manual_league"), old, NOW)).toBe(false);
    expect(() => isExpired(SCHEDULES, old, Number.NaN)).toThrow(RangeError);
  });

  it("freshUntilMs is the basis plus the calendar TTL; null for immutable classes", () => {
    const k = Date.UTC(2028, 11, 3, 18);
    const c = cal([k]);
    const b = k - 30 * H;
    expect(freshUntilMs(SCHEDULES, at(b), c)).toBe(b + (ttlAt(SCHEDULES, b, c) ?? 0) * 1000);
    expect(freshUntilMs(SCHEDULES, at(b), c)).toBe(k - GAMEDAY_LEAD_MS);
    expect(freshUntilMs(freshnessClass("crosswalk"), at(b), c)).toBeNull();
    const inj = freshnessClass("nflverse_injuries");
    expect(freshUntilMs(inj, at(b), c)).toBe(b + 12 * H);
  });
});
