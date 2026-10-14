// flex-rules.test.ts — src/config/flex-rules.ts (season-fresh spec §5.3): the flex deadline of every
// game of synthetic seasons 2026–2030 follows the vintage-stamped notice table — weeks 5–13 twelve
// days before kickoff, 14–17 six, the final regular week six (every game, Saturday ones included),
// Thursday night 13–17 twenty-one; weeks 1–4, the postseason and TBD kickoffs have none. The slot
// comes from the Eastern weekday and time, so the result is the same in every zone.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FLEX_RULES, flexDeadlineMs, flexSlotOf } from "../../src/config/flex-rules.js";
import { easternClockOf, easternWallTimeMs } from "../../src/config/game-calendar.js";
import { REFERENCE_VINTAGES } from "../../src/config/reference-vintage.js";
import type { NflGame } from "../../src/domain/analytics/types.js";
import {
  SYNTHETIC_SEASONS,
  arbSeasonOptions,
  lastRegWeekOf,
  syntheticSeason,
} from "../helpers/season/synthetic.js";
import { ALL_UTC_OFFSET_ZONES, withTz } from "../helpers/season/zones.js";

const D = 86_400_000;

/** The oracle: the notice (days) the table gives a game, or null. */
function expectedNotice(g: NflGame, lastReg: number): number | null {
  if (g.game_type !== "REG" || g.kickoff === null) return null;
  if (g.week === lastReg) return 6;
  const c = easternClockOf(Date.parse(g.kickoff));
  const night = c.hour >= 19;
  const w = g.week;
  if (c.weekday === "Sun") return w >= 5 && w <= 13 ? 12 : w >= 14 && w <= 17 ? 6 : null;
  if (c.weekday === "Mon") return w >= 12 && w <= 17 ? 12 : null;
  if (c.weekday === "Thu" && night) return w >= 13 && w <= 17 ? 21 : null;
  return null;
}

describe("FLEX_RULES", () => {
  it("is vintage-stamped and registered with the same vintage", () => {
    expect(FLEX_RULES.verified_through_season).toBeGreaterThanOrEqual(2026);
    expect(FLEX_RULES.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(REFERENCE_VINTAGES.flex_rules.verified_through_season).toBe(
      FLEX_RULES.verified_through_season,
    );
    for (const r of FLEX_RULES.rules) {
      expect(r.notice_days).toBeGreaterThan(0);
      if (r.weeks !== "last_reg_week") expect(r.weeks[0]).toBeLessThanOrEqual(r.weeks[1]);
    }
  });
});

describe("flexSlotOf: the Eastern weekday and hour", () => {
  it("names Sunday day/night, Monday night, Thursday night; nothing else", () => {
    const at = (date: string, hh: number) => flexSlotOf(easternWallTimeMs(date, hh, 0));
    expect(at("2027-11-07", 13)).toBe("sun_day");
    expect(at("2027-11-07", 9)).toBe("sun_day"); // a London game
    expect(at("2027-11-07", 20)).toBe("sun_night");
    expect(at("2027-11-08", 20)).toBe("mon_night");
    expect(at("2027-11-04", 20)).toBe("thu_night");
    expect(at("2027-11-25", 12)).toBeNull(); // Thanksgiving afternoon
    for (const d of ["2027-11-02", "2027-11-03", "2027-11-05", "2027-11-06"])
      expect(at(d, 20)).toBeNull();
  });
});

describe("flexDeadlineMs over synthetic seasons", () => {
  it("every game's deadline is kickoff − the table's notice, or null", () => {
    fc.assert(
      fc.property(arbSeasonOptions, (o) => {
        const games = syntheticSeason(o);
        const last = lastRegWeekOf(games, o.season);
        for (const g of games) {
          const k = g.kickoff === null ? null : Date.parse(g.kickoff);
          const got = flexDeadlineMs({
            week: g.week,
            game_type: g.game_type ?? null,
            kickoff_ms: k,
            last_reg_week: last,
          });
          const notice = expectedNotice(g, last);
          expect(got, g.game_id).toBe(notice === null || k === null ? null : k - notice * D);
        }
      }),
      { numRuns: 25 },
    );
  });

  it("the named cases: 12 d, 6 d, the final week's Saturday games, weeks 1–4 and the postseason", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const games = syntheticSeason({ season, seed: season });
      const last = lastRegWeekOf(games, season);
      const pick = (week: number, weekday: string, minHour = 0) =>
        games.find(
          (g) =>
            g.week === week &&
            g.kickoff !== null &&
            easternClockOf(Date.parse(g.kickoff)).weekday === weekday &&
            easternClockOf(Date.parse(g.kickoff)).hour >= minHour,
        )!;
      const dl = (g: NflGame, lastReg: number | null = last) =>
        flexDeadlineMs({
          week: g.week,
          game_type: g.game_type ?? null,
          kickoff_ms: Date.parse(g.kickoff ?? ""),
          last_reg_week: lastReg,
        });
      const k = (g: NflGame) => Date.parse(g.kickoff ?? "");
      expect(dl(pick(9, "Sun", 19))).toBe(k(pick(9, "Sun", 19)) - 12 * D);
      expect(dl(pick(15, "Sun", 19))).toBe(k(pick(15, "Sun", 19)) - 6 * D);
      expect(dl(pick(14, "Mon"))).toBe(k(pick(14, "Mon")) - 12 * D);
      expect(dl(pick(14, "Thu", 19))).toBe(k(pick(14, "Thu", 19)) - 21 * D);
      expect(dl(pick(last, "Sat"))).toBe(k(pick(last, "Sat")) - 6 * D);
      expect(dl(pick(3, "Sun", 19))).toBeNull();
      // the final-week rule needs the schedule's last regular week
      expect(dl(pick(last, "Sat"), null)).toBeNull();
      const sb = games.find((g) => g.game_type === "SB")!;
      expect(dl(sb)).toBeNull();
    }
  });

  it("an unknown game_type is judged regular; a TBD or non-finite kickoff has no deadline", () => {
    const k = easternWallTimeMs("2028-11-05", 20, 20);
    expect(flexDeadlineMs({ week: 9, game_type: null, kickoff_ms: k, last_reg_week: 18 })).toBe(
      k - 12 * D,
    );
    expect(
      flexDeadlineMs({ week: 9, game_type: null, kickoff_ms: null, last_reg_week: 18 }),
    ).toBeNull();
    expect(
      flexDeadlineMs({ week: 9, game_type: "REG", kickoff_ms: Number.NaN, last_reg_week: 18 }),
    ).toBeNull();
  });

  it("is the same in every zone", () => {
    const games = syntheticSeason({ season: 2030, regWeeks: 20, seed: 9 });
    const probe = () =>
      JSON.stringify(
        games.map((g) =>
          flexDeadlineMs({
            week: g.week,
            game_type: g.game_type ?? null,
            kickoff_ms: g.kickoff === null ? null : Date.parse(g.kickoff),
            last_reg_week: 20,
          }),
        ),
      );
    const base = withTz("UTC", probe);
    for (const tz of ALL_UTC_OFFSET_ZONES) expect(withTz(tz, probe), tz).toBe(base);
  });
});
