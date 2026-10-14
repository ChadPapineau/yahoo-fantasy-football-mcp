// status-blocks.test.ts — src/domain/league/status-blocks.ts (season-fresh spec §4.5, §5.2, §8.9):
// the `season` and `schedule` blocks G1 and `ff status` both print — shapes, caps (10 changes plus a
// count, 3 tentative weeks), `league_matches` across the phases, the not-published list, vintage
// warnings for seasons 2026–2030 and the tool-input week bound for a 20-week season (last week 24).
import { describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../../src/config/freshness.js";
import type { ScheduleChange, SeasonCheckRow } from "../../../src/domain/analytics/types.js";
import { scheduleView, type ScheduleView } from "../../../src/domain/league/calendar.js";
import type { SeasonPhaseName } from "../../../src/domain/league/season.js";
import {
  NOT_PUBLISHED_MAX,
  RECENT_CHANGES_MAX,
  scheduleBlock,
  seasonBlock,
} from "../../../src/domain/league/status-blocks.js";
import {
  SYNTHETIC_SEASONS,
  lastRegWeekOf,
  syntheticSeason,
  syntheticSeasons,
} from "../../helpers/season/synthetic.js";
import { neverLoadedScheduleReader, scheduleReaderOf } from "../../helpers/season/reader.js";

const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number): string => new Date(ms).toISOString();

function viewAt(games: ReturnType<typeof syntheticSeason>, nowMs: number): ScheduleView {
  return scheduleView(scheduleReaderOf(games, { checkedAt: iso(nowMs - H) }), nowMs);
}
const withPhase = (v: ScheduleView, phase: SeasonPhaseName): ScheduleView => ({
  ...v,
  phase: { ...v.phase, phase },
});

describe("seasonBlock", () => {
  it("names the NFL season, phase, week and next kickoff from the schedule", () => {
    const games = syntheticSeasons([2026, 2027]);
    const now = Date.UTC(2027, 9, 14, 12);
    const v = viewAt(games, now);
    const b = seasonBlock(v, 2027, [], now);
    expect(b).toMatchObject({
      nfl_season: 2027,
      phase: "regular",
      basis: "schedule",
      league_season: 2027,
      league_matches: true,
      not_published: [],
      week_bound_exceeded: false,
    });
    expect(b.week).toBe(v.phase.week);
    expect(b.next_kickoff).toBe(v.phase.next_kickoff);
  });

  it("league_matches: equal seasons in season; the finished or the next one in the offseason; null without a league", () => {
    const v = viewAt(syntheticSeasons([2027, 2028]), Date.UTC(2028, 9, 1));
    for (const p of ["preseason", "regular", "postseason"] as const) {
      expect(seasonBlock(withPhase(v, p), 2028, [], 0).league_matches, p).toBe(true);
      expect(seasonBlock(withPhase(v, p), 2027, [], 0).league_matches, p).toBe(false);
      expect(seasonBlock(withPhase(v, p), 2029, [], 0).league_matches, p).toBe(false);
    }
    const off = withPhase(v, "offseason");
    expect(seasonBlock(off, 2028, [], 0).league_matches).toBe(true);
    expect(seasonBlock(off, 2029, [], 0).league_matches).toBe(true);
    expect(seasonBlock(off, 2027, [], 0).league_matches).toBe(false);
    expect(seasonBlock(v, null, [], 0)).toMatchObject({
      league_season: null,
      league_matches: null,
    });
  });

  it("lists the phase season's not-published files checked within their hard limit, sorted, at most 10", () => {
    const now = Date.UTC(2029, 8, 8);
    const v = viewAt(syntheticSeasons([2028, 2029]), now);
    expect(v.phase.season).toBe(2029);
    const check = (
      source: DatasetSourceId,
      season: number,
      agoH: number,
      status: SeasonCheckRow["status"] = "not_published",
    ): SeasonCheckRow => ({
      source,
      season,
      checked_at: iso(now - agoH * H),
      status,
    });
    const checks = [
      check("nflverse:stats_player_week", 2029, 2),
      check("nflverse:injuries", 2029, 3),
      check("nflverse:injuries", 2030, 1), // a future season: expected to be missing
      check("nflverse:roster_weekly", 2029, 1, "published"),
      check("weather:nws", 2029, 13), // past the 12 h weather limit
      { ...check("nflverse:pbp", 2029, 1), checked_at: "garbage" },
      check("dynastyprocess:ids", 2029, 24 * 29), // 30-day limit
    ];
    expect(seasonBlock(v, null, checks, now).not_published).toEqual([
      { source: "dynastyprocess:ids", season: 2029, checked_at: iso(now - 24 * 29 * H) },
      { source: "nflverse:injuries", season: 2029, checked_at: iso(now - 3 * H) },
      { source: "nflverse:stats_player_week", season: 2029, checked_at: iso(now - 2 * H) },
    ]);
    const many = Array.from({ length: 14 }, (_, i) => check("nflverse:schedules", 2029, i + 1));
    expect(seasonBlock(v, null, many, now).not_published.length).toBe(NOT_PUBLISHED_MAX);
  });

  it("names the reference tables past their vintage for the season in progress (2026–2030)", () => {
    const want: Record<number, string[]> = {
      2026: [],
      2027: ["venues", "flex_rules"],
      2028: ["venues", "flex_rules"],
      2029: ["venues", "flex_rules", "analytics_base_rates"],
      2030: ["venues", "flex_rules", "analytics_base_rates"],
    };
    for (const season of SYNTHETIC_SEASONS) {
      const now = Date.UTC(season, 9, 1);
      const b = seasonBlock(viewAt(syntheticSeason({ season }), now), season, [], now);
      expect(b.nfl_season).toBe(season);
      expect(
        b.reference_past_vintage.map((w) => w.id),
        String(season),
      ).toEqual(want[season]);
    }
  });

  it("flags a loaded season whose last week exceeds the tool-input bound (20 regular weeks → week 24)", () => {
    const now = Date.UTC(2029, 9, 1);
    expect(
      seasonBlock(viewAt(syntheticSeason({ season: 2029, regWeeks: 20 }), now), null, [], now)
        .week_bound_exceeded,
    ).toBe(true);
    expect(
      seasonBlock(viewAt(syntheticSeason({ season: 2029, regWeeks: 18 }), now), null, [], now)
        .week_bound_exceeded,
    ).toBe(false);
  });

  it("without a schedule: the bootstrap phase", () => {
    const now = Date.UTC(2030, 2, 1);
    expect(
      seasonBlock(scheduleView(neverLoadedScheduleReader(), now), 2029, [], now),
    ).toMatchObject({
      nfl_season: 2029,
      phase: "offseason",
      basis: "bootstrap",
      week: null,
      next_kickoff: null,
      league_matches: true,
    });
  });
});

describe("scheduleBlock", () => {
  const change = (i: number): ScheduleChange => ({
    detected_at: iso(Date.UTC(2027, 10, 1) + i * H),
    release_updated_at: null,
    season: 2027,
    week: 9 + (i % 3),
    game_id: `2027_${String(9 + (i % 3)).padStart(2, "0")}_CHI_BUF`,
    away: "CHI",
    home: "BUF",
    kind: "kickoff",
    old_value: iso(Date.UTC(2027, 10, 7, 18)),
    new_value: iso(Date.UTC(2027, 10, 7, 21) + i * 60_000),
  });

  it("the calendar state, the newest 10 changes and how many more, the tentative weeks", () => {
    const games = syntheticSeason({ season: 2027, week18Placeholder: true });
    const last = lastRegWeekOf(games, 2027);
    const lastK = Math.min(
      ...games.filter((g) => g.week === last).map((g) => Date.parse(g.kickoff ?? "")),
    );
    const now = lastK - 12 * D;
    const v = viewAt(games, now);
    const changes = Array.from({ length: 13 }, (_, i) => change(i));
    const b = scheduleBlock(v, changes, now);
    expect(b.calendar).toBe("schedule");
    expect(b.fallback_reason).toBeNull();
    expect(typeof b.in_window).toBe("boolean");
    expect(b.next_kickoff).toBe(v.phase.next_kickoff);
    expect(b.recent_changes.length).toBe(RECENT_CHANGES_MAX);
    expect(b.recent_changes_more).toBe(3);
    expect(b.recent_changes[0]).toEqual({
      game: "CHI@BUF",
      season: 2027,
      week: 9 + (12 % 3),
      kind: "kickoff",
      old: change(12).old_value,
      new: change(12).new_value,
      detected_at: change(12).detected_at,
    });
    expect(b.tentative_weeks.length).toBeLessThanOrEqual(3);
    expect(b.tentative_weeks).toContainEqual({
      season: 2027,
      week: last,
      reason: "placeholder_week",
      until: null,
    });
    expect(scheduleBlock(v, changes.slice(0, 2), now).recent_changes_more).toBe(0);
  });

  it("ties on detection order by season, week, game and kind", () => {
    const now = Date.UTC(2027, 10, 1);
    const v = viewAt(syntheticSeason({ season: 2027 }), now);
    const a = { ...change(0), detected_at: "2027-11-01T00:00:00.000Z" };
    const rows: ScheduleChange[] = [
      { ...a, kind: "venue", old_value: "BUF00", new_value: "LON00" },
      { ...a, game_id: "2027_09_ARI_BUF", away: "ARI" },
      { ...a, week: 8, game_id: "2027_08_CHI_BUF" },
      { ...a, season: 2026, game_id: "2026_09_CHI_BUF" },
      a,
    ];
    expect(
      scheduleBlock(v, rows, now).recent_changes.map(
        (r) => `${String(r.season)} ${String(r.week)} ${r.game} ${r.kind}`,
      ),
    ).toEqual([
      "2026 9 CHI@BUF kickoff",
      "2027 8 CHI@BUF kickoff",
      "2027 9 ARI@BUF kickoff",
      "2027 9 CHI@BUF kickoff",
      "2027 9 CHI@BUF venue",
    ]);
  });

  it("a fallback calendar is reported with its reason and is always in the window", () => {
    const now = Date.UTC(2027, 10, 1);
    const b = scheduleBlock(scheduleView(neverLoadedScheduleReader(), now), [], now);
    expect(b).toEqual({
      calendar: "fallback",
      fallback_reason: "never_loaded",
      in_window: true,
      next_kickoff: null,
      recent_changes: [],
      recent_changes_more: 0,
      tentative_weeks: [],
    });
  });
});
