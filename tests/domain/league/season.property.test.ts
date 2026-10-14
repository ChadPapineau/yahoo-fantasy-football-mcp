// season.property.test.ts — src/domain/league/season.ts (season-fresh spec §2.3, §2.4): the season
// phase comes from the loaded schedule, never from a calendar month. Synthetic seasons 2026–2030 of
// 18, 19 and 20 regular weeks with Wednesday, Thursday and Friday openers, any instant from 1 January
// of the season to 31 December of the next, under every UTC-offset zone: the phase is total, the
// season never decreases, the phases run preseason → regular → postseason → offseason, the season
// holds from 7 days before its first kickoff to 14 days after its end, an April date is the
// offseason until the next schedule is published and its preseason after.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GAME_WINDOW_MS } from "../../../src/config/game-calendar.js";
import type { NflGame } from "../../../src/domain/analytics/types.js";
import {
  POSTSEASON_MAX_MS,
  POSTSEASON_TAIL_MS,
  PRESEASON_LEAD_MS,
  bootstrapSeason,
  isRegularGame,
  lastRegularWeek,
  refreshSeasons,
  seasonPhaseAt,
  seasonSchedule,
  type SeasonPhase,
  type SeasonPhaseName,
  type SeasonSchedule,
} from "../../../src/domain/league/season.js";
import {
  SYNTHETIC_SEASONS,
  arbSeasonOptions,
  etMs,
  syntheticSeason,
  type SyntheticOptions,
} from "../../helpers/season/synthetic.js";
import { ALL_UTC_OFFSET_ZONES, withTz } from "../../helpers/season/zones.js";

const H = 3_600_000;
const D = 24 * H;
const RANK: Readonly<Record<SeasonPhaseName, number>> = {
  preseason: 0,
  regular: 1,
  postseason: 2,
  offseason: 3,
};

const schedulesOf = (games: readonly NflGame[]): SeasonSchedule[] =>
  [...new Set(games.map((g) => g.season))]
    .sort((a, b) => a - b)
    .map((s) => seasonSchedule(games, s));
const ms = (iso: string | null): number => Date.parse(iso ?? "");
const endOf = (s: SeasonSchedule): number =>
  s.season_end === null ? ms(s.last_reg_end) + POSTSEASON_MAX_MS : ms(s.season_end);

/** The file the server sees: the previous season and season S (S+1 only once published). */
function fileOf(o: Required<SyntheticOptions>, withNext = false): NflGame[] {
  const prev = syntheticSeason({ ...o, season: o.season - 1, seed: o.seed + 1 });
  const next = withNext ? syntheticSeason({ ...o, season: o.season + 1, seed: o.seed + 2 }) : [];
  return [...prev, ...syntheticSeason(o), ...next];
}

describe("seasonSchedule: the facts come from the games", () => {
  it("regular and postseason weeks, the opener, the regular-season end and the Super Bowl", () => {
    fc.assert(
      fc.property(arbSeasonOptions, (o) => {
        const games = syntheticSeason(o);
        const s = seasonSchedule(games, o.season);
        const R = o.regWeeks;
        expect(s.reg_weeks).toEqual(Array.from({ length: R }, (_, i) => i + 1));
        expect(s.last_reg_week).toBe(R);
        expect(lastRegularWeek(s)).toBe(R);
        expect(s.post_weeks).toEqual([R + 1, R + 2, R + 3, R + 4]);
        expect(s.last_week).toBe(R + 4);
        const regKs = games
          .filter((g) => g.game_type === "REG" && g.kickoff !== null)
          .map((g) => ms(g.kickoff));
        expect(ms(s.first_kickoff)).toBe(Math.min(...regKs));
        const sb = games.find((g) => g.game_type === "SB");
        expect(s.has_final).toBe(true);
        expect(ms(s.season_end)).toBe(ms(sb?.kickoff ?? null) + GAME_WINDOW_MS);
        expect(sb?.gameday?.slice(5, 7)).toBe("02"); // the Super Bowl is in February
        expect(ms(s.last_reg_end)).toBeGreaterThanOrEqual(Math.max(...regKs) + GAME_WINDOW_MS);
        expect(s.week_spans?.length).toBe(R + 4);
        expect(s.kickoffs_ms).toEqual(
          [...new Set(games.filter((g) => g.kickoff !== null).map((g) => ms(g.kickoff)))]
            .concat(
              games.filter((g) => g.kickoff === null).map((g) => etMs(g.gameday ?? "", "00:00")),
            )
            .sort((a, b) => a - b),
        );
      }),
      { numRuns: 25 },
    );
  });

  it("without a Super Bowl the end is the last postseason game; without a postseason it is unknown", () => {
    const games = syntheticSeason({ season: 2027, regWeeks: 19 });
    const noSb = games.filter((g) => g.game_type !== "SB");
    const s = seasonSchedule(noSb, 2027);
    const con = noSb.filter((g) => g.game_type === "CON").map((g) => ms(g.kickoff));
    expect(s.has_final).toBe(false);
    expect(ms(s.season_end)).toBe(Math.max(...con) + GAME_WINDOW_MS);
    const regOnly = seasonSchedule(
      games.filter((g) => g.game_type === "REG"),
      2027,
    );
    expect(regOnly.season_end).toBeNull();
    expect(regOnly.post_weeks).toEqual([]);
    expect(regOnly.last_week).toBe(19);
  });

  it("a TBD opener counts at 00:00 ET of its gameday; an unknown game_type is judged regular", () => {
    const games = syntheticSeason({ season: 2028, opener: "thu" });
    const opener = games.reduce((a, g) =>
      g.game_type === "REG" && ms(g.kickoff) < ms(a.kickoff) ? g : a,
    );
    const tbd = games.map((g) => (g.game_id === opener.game_id ? { ...g, kickoff: null } : g));
    const s = seasonSchedule(tbd, 2028);
    expect(ms(s.first_kickoff)).toBe(etMs(opener.gameday ?? "", "00:00"));
    const untyped = games.map((g) => {
      const { game_type: _drop, ...rest } = g;
      return rest;
    });
    expect(isRegularGame(untyped[0] as NflGame)).toBe(true);
    const u = seasonSchedule(untyped, 2028);
    expect(u.post_weeks).toEqual([]);
    expect(u.last_reg_week).toBe(22);
    // a game with neither kickoff nor gameday has no instant, but its week still counts
    const lost = games.map((g) => (g.week === 3 ? { ...g, kickoff: null, gameday: null } : g));
    expect(seasonSchedule(lost, 2028).reg_weeks).toContain(3);
    expect(seasonSchedule(lost, 2028).week_spans?.some((w) => w.week === 3)).toBe(false);
    // one lost game in a week that has others keeps the week's span from the others
    const w4 = games.filter((g) => g.week === 4);
    const oneLost = games.map((g) =>
      g.game_id === w4[w4.length - 1]?.game_id ? { ...g, kickoff: null, gameday: null } : g,
    );
    const span4 = seasonSchedule(oneLost, 2028).week_spans?.find((w) => w.week === 4);
    expect(span4?.first_ms).toBe(Math.min(...w4.slice(0, -1).map((g) => ms(g.kickoff))));
    // an unparseable kickoff falls back to its gameday, as a TBD game does
    const garbled = games.map((g) => (g.game_id === opener.game_id ? { ...g, kickoff: "TBD" } : g));
    expect(ms(seasonSchedule(garbled, 2028).first_kickoff)).toBe(
      etMs(opener.gameday ?? "", "00:00"),
    );
  });

  it("a season absent from the games has no facts", () => {
    const s = seasonSchedule(syntheticSeason({ season: 2029 }), 2031);
    expect(s).toMatchObject({
      season: 2031,
      first_kickoff: null,
      reg_weeks: [],
      last_reg_week: null,
      last_week: null,
      last_reg_end: null,
      season_end: null,
      has_final: false,
    });
    expect(lastRegularWeek(null)).toBeNull();
  });
});

describe("seasonPhaseAt: total, monotone, in order — in every season shape", () => {
  it("over [1 Jan S, 31 Dec S+1]: season non-decreasing, phases in order, S held over its span", () => {
    fc.assert(
      fc.property(
        arbSeasonOptions.filter((o) => o.season <= 2030),
        (o) => {
          const seasons = schedulesOf(fileOf(o));
          const s = seasons.find((x) => x.season === o.season)!;
          const start = ms(s.first_kickoff) - PRESEASON_LEAD_MS;
          const end = endOf(s) + POSTSEASON_TAIL_MS;
          let prev: SeasonPhase | null = null;
          for (let t = Date.UTC(o.season, 0, 1); t <= Date.UTC(o.season + 1, 11, 31); t += 23 * H) {
            const p = seasonPhaseAt(t, seasons);
            expect(p.basis).toBe("schedule");
            if (prev !== null) {
              expect(p.season).toBeGreaterThanOrEqual(prev.season);
              if (p.season === prev.season)
                expect(RANK[p.phase]).toBeGreaterThanOrEqual(RANK[prev.phase]);
            }
            if (t >= start && t <= end) {
              expect(p.season).toBe(o.season);
              expect(["regular", "postseason"]).toContain(p.phase);
            }
            if (t < start && t > endOf(seasons[0]!) + POSTSEASON_TAIL_MS) {
              expect(p).toMatchObject({
                season: o.season,
                phase: "preseason",
                next_season_published: true,
              });
            }
            prev = p;
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it("an April date is the offseason until the next schedule is published, then its preseason", () => {
    for (const [i, season] of SYNTHETIC_SEASONS.entries()) {
      const o = {
        season,
        regWeeks: ([18, 19, 20] as const)[i % 3] ?? 18,
        opener: "wed",
        week18Placeholder: false,
        seed: i,
      } as const;
      const april = Date.UTC(season + 1, 3, 15);
      expect(seasonPhaseAt(april, schedulesOf(fileOf(o)))).toMatchObject({
        season,
        phase: "offseason",
        week: null,
        next_season_published: false,
      });
      expect(seasonPhaseAt(april, schedulesOf(fileOf(o, true)))).toMatchObject({
        season: season + 1,
        phase: "preseason",
        week: null,
        next_season_published: true,
      });
    }
  });

  it("before every loaded season it is the earliest one's preseason", () => {
    const seasons = schedulesOf(syntheticSeason({ season: 2029 }));
    expect(seasonPhaseAt(Date.UTC(2027, 0, 1), seasons)).toMatchObject({
      season: 2029,
      phase: "preseason",
    });
  });

  it("the week: 1 before the opener, then the first regular week not yet over; the playoff week", () => {
    fc.assert(
      fc.property(
        arbSeasonOptions.filter((o) => o.season <= 2030),
        (o) => {
          const games = syntheticSeason(o);
          const seasons = schedulesOf(games);
          const s = seasons[0]!;
          expect(seasonPhaseAt(ms(s.first_kickoff) - 3 * D, seasons).week).toBe(1);
          for (const span of s.week_spans ?? []) {
            const p = seasonPhaseAt(span.last_ms + GAME_WINDOW_MS - 1, seasons);
            expect(p.week).toBe(span.week);
            const after = seasonPhaseAt(span.last_ms + GAME_WINDOW_MS, seasons);
            if (!span.postseason && span.week < o.regWeeks) expect(after.week).toBe(span.week + 1);
          }
          // exactly at the end of the regular season: still regular, the last regular week
          expect(seasonPhaseAt(ms(s.last_reg_end), seasons)).toMatchObject({
            phase: "regular",
            week: o.regWeeks,
          });
          // after the Super Bowl: postseason with no current week, then the offseason
          expect(seasonPhaseAt(ms(s.season_end) + D, seasons)).toMatchObject({
            phase: "postseason",
            week: null,
          });
          expect(seasonPhaseAt(ms(s.season_end) + POSTSEASON_TAIL_MS + 1, seasons).phase).toBe(
            "offseason",
          );
        },
      ),
      { numRuns: 15 },
    );
  });

  it("next_kickoff is the first kickoff after now; regular/postseason say whether S+1 is loaded", () => {
    const games = [...syntheticSeason({ season: 2027 }), ...syntheticSeason({ season: 2028 })];
    const seasons = schedulesOf(games);
    const s27 = seasons[0]!;
    const t = ms(s27.first_kickoff) + 2 * D;
    const after = games.map((g) => ms(g.kickoff)).filter((k) => k > t);
    const p = seasonPhaseAt(t, seasons);
    expect(p).toMatchObject({ season: 2027, phase: "regular", next_season_published: true });
    expect(ms(p.next_kickoff)).toBe(Math.min(...after));
    expect(seasonPhaseAt(t, [s27]).next_season_published).toBe(false);
    // the last kickoff of the file has nothing after it
    expect(seasonPhaseAt(Date.UTC(2030, 0, 1), seasons).next_kickoff).toBeNull();
  });

  it("an unknown season end bounds the postseason structurally (42 + 14 days)", () => {
    const regOnly = syntheticSeason({ season: 2026 }).filter((g) => g.game_type === "REG");
    const seasons = schedulesOf(regOnly);
    const regEnd = ms((seasons[0]!).last_reg_end);
    expect(seasonPhaseAt(regEnd + 1, seasons).phase).toBe("postseason");
    expect(seasonPhaseAt(regEnd + POSTSEASON_MAX_MS + POSTSEASON_TAIL_MS, seasons).phase).toBe(
      "postseason",
    );
    expect(seasonPhaseAt(regEnd + POSTSEASON_MAX_MS + POSTSEASON_TAIL_MS + 1, seasons).phase).toBe(
      "offseason",
    );
  });

  it("schedules without week spans (built elsewhere) still give the phase, with no week", () => {
    const s = seasonSchedule(syntheticSeason({ season: 2027 }), 2027);
    const { week_spans: _w, kickoffs_ms: _k, ...bare } = s;
    const p = seasonPhaseAt(ms(s.first_kickoff) + D, [bare]);
    expect(p).toMatchObject({ season: 2027, phase: "regular", week: null, next_kickoff: null });
  });

  it("the phase is the same in every zone", () => {
    const seasons = schedulesOf(
      fileOf({ season: 2029, regWeeks: 20, opener: "fri", week18Placeholder: true, seed: 4 }),
    );
    const probe = (): string => {
      const out: string[] = [];
      for (let t = Date.UTC(2029, 0, 1); t < Date.UTC(2031, 0, 1); t += 3 * D + 5 * H)
        out.push(JSON.stringify(seasonPhaseAt(t, seasons)));
      out.push(String(bootstrapSeason(Date.UTC(2029, 7, 31, 23, 30))));
      return out.join("|");
    };
    const base = withTz("UTC", probe);
    for (const tz of ALL_UTC_OFFSET_ZONES) expect(withTz(tz, probe), tz).toBe(base);
  });
});

describe("bootstrap: only while no schedule is loaded", () => {
  it("the September (UTC) rule picks the season; the month picks the phase", () => {
    expect(bootstrapSeason(Date.UTC(2027, 7, 31, 23, 59))).toBe(2026);
    expect(bootstrapSeason(Date.UTC(2027, 8, 1))).toBe(2027);
    const at = (m: number) => seasonPhaseAt(Date.UTC(2028, m, 15), []);
    expect(at(0)).toMatchObject({
      season: 2027,
      phase: "regular",
      basis: "bootstrap",
      week: null,
      next_kickoff: null,
    });
    expect(at(1)).toMatchObject({ season: 2027, phase: "postseason", basis: "bootstrap" });
    for (const m of [2, 3, 4, 5, 6, 7])
      expect(at(m)).toMatchObject({ season: 2027, phase: "offseason" });
    for (const m of [8, 9, 10, 11]) expect(at(m)).toMatchObject({ season: 2028, phase: "regular" });
  });

  it("a schedule with no kickoff at all is still the bootstrap", () => {
    const blank = syntheticSeason({ season: 2027 }).map((g) => ({
      ...g,
      kickoff: null,
      gameday: null,
    }));
    expect(seasonPhaseAt(Date.UTC(2027, 9, 1), schedulesOf(blank)).basis).toBe("bootstrap");
  });
});

describe("refreshSeasons (§2.4)", () => {
  const phase = (season: number, p: SeasonPhaseName): SeasonPhase => ({
    season,
    phase: p,
    week: null,
    next_kickoff: null,
    next_season_published: false,
    basis: "schedule",
  });

  it("follows the table in every phase, for any season", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2026, max: 2060 }),
        fc.constantFrom<SeasonPhaseName>("preseason", "regular", "postseason", "offseason"),
        (S, p) => {
          const ph = phase(S, p);
          expect(refreshSeasons("nflverse:schedules", ph)).toEqual([S - 1, S, S + 1]);
          expect(refreshSeasons("nflverse:stats_player_week", ph)).toEqual([S - 1, S]);
          expect(refreshSeasons("nflverse:injuries", ph)).toEqual([S]);
          expect(refreshSeasons("weather:open_meteo", ph)).toEqual([S]);
          expect(refreshSeasons("weather:nws", ph)).toEqual([S]);
          expect(refreshSeasons("nflverse:depth_charts", ph)).toEqual([S]);
          expect(refreshSeasons("nflverse:roster_weekly", ph)).toEqual(
            p === "preseason" ? [S - 1, S] : p === "offseason" ? [S, S + 1] : [S],
          );
        },
      ),
    );
  });

  it("a schedule-derived phase drives it: an August file with S loaded refreshes S's rosters", () => {
    const seasons = schedulesOf(
      fileOf({ season: 2028, regWeeks: 18, opener: "thu", week18Placeholder: false, seed: 0 }),
    );
    const aug = seasonPhaseAt(Date.UTC(2028, 7, 1), seasons);
    expect(aug).toMatchObject({ season: 2028, phase: "preseason" });
    expect(refreshSeasons("nflverse:roster_weekly", aug)).toEqual([2027, 2028]);
    expect(refreshSeasons("nflverse:schedules", aug)).toEqual([2027, 2028, 2029]);
  });
});
