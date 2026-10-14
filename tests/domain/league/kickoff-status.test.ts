// kickoff-status.test.ts — src/domain/league/kickoff-status.ts (season-fresh spec §5.2, §5.3): a
// final week published with placeholder kickoffs is tentative until the NFL sets it (data-driven, any
// year — the 2026 fixture release has all 16 Week-18 games at Sun 2027-01-10 13:00 ET); flex windows
// close at the notice deadline; a TBD time is tentative; the tentative weeks and the warning lines
// are fixed vocabulary (NFL abbreviations, ET, dates) and capped.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { flexDeadlineMs } from "../../../src/config/flex-rules.js";
import { easternClockOf, easternWallTimeMs } from "../../../src/config/game-calendar.js";
import type { NflTeam } from "../../../src/config/schema.js";
import type { NflGame, ScheduleChange } from "../../../src/domain/analytics/types.js";
import {
  PLACEHOLDER_MIN_GAMES,
  SCHEDULE_WARNING_MAX,
  SCHEDULE_WARNING_MAX_CHARS,
  easternDayLabel,
  easternLabel,
  kickoffChangeWarning,
  kickoffStatus,
  placeholderWeeks,
  scheduleWarnings,
  tentativeWeekWarning,
  tentativeWeeks,
  type TentativeWeek,
} from "../../../src/domain/league/kickoff-status.js";
import {
  seasonPhaseAt,
  seasonSchedule,
  type SeasonPhase,
} from "../../../src/domain/league/season.js";
import { loadFixtureGames } from "../../helpers/season/fixture.js";
import {
  SYNTHETIC_SEASONS,
  arbSeasonOptions,
  etIso,
  lastRegWeekOf,
  setWeek18,
  syntheticSeason,
} from "../../helpers/season/synthetic.js";

const H = 3_600_000;
const D = 24 * H;
const ms = (iso: string | null): number => Date.parse(iso ?? "");

const viewOf = (games: readonly NflGame[], phase: SeasonPhase) => ({
  games: (s: number) => games.filter((g) => g.season === s),
  schedule: (s: number) => seasonSchedule(games, s),
  phase,
});

describe("placeholderWeeks", () => {
  it("the 2026 fixture release's week 18 (16 games at one instant) is a placeholder; 2025 has none", async () => {
    const games = await loadFixtureGames();
    expect([...placeholderWeeks(games, 2026)]).toEqual([18]);
    expect([...placeholderWeeks(games, 2025)]).toEqual([]);
    const w18 = games.filter((g) => g.season === 2026 && g.week === 18);
    expect(new Set(w18.map((g) => g.kickoff))).toEqual(
      new Set([new Date(easternWallTimeMs("2027-01-10", 13, 0)).toISOString()]),
    );
  });

  it("any season's placeholder final week, until it is set", () => {
    fc.assert(
      fc.property(arbSeasonOptions, (o) => {
        const games = syntheticSeason({ ...o, week18Placeholder: true });
        const last = lastRegWeekOf(games, o.season);
        expect([...placeholderWeeks(games, o.season)]).toEqual([last]);
        expect([...placeholderWeeks(setWeek18(games), o.season)]).toEqual([]);
      }),
      { numRuns: 15 },
    );
  });

  it("all kickoffs unknown is a placeholder; fewer than 4 games at one instant is not; postseason never", () => {
    const games = syntheticSeason({ season: 2028 });
    const blank = games.map((g) => (g.week === 6 ? { ...g, kickoff: null } : g));
    expect(placeholderWeeks(blank, 2028).has(6)).toBe(true);
    const k = games.find((g) => g.week === 7)?.kickoff ?? null;
    const three = games
      .filter((g) => g.week === 7)
      .slice(0, PLACEHOLDER_MIN_GAMES - 1)
      .map((g) => ({ ...g, kickoff: k }));
    expect(placeholderWeeks(three, 2028).has(7)).toBe(false);
    const post = games.map((g) => (g.game_type === "DIV" ? { ...g, kickoff: k } : g));
    expect([...placeholderWeeks(post, 2028)]).toEqual([]);
    expect([...placeholderWeeks(games, 2031)]).toEqual([]);
  });
});

describe("kickoffStatus", () => {
  const games = syntheticSeason({ season: 2027, week18Placeholder: true, seed: 1 });
  const schedule = seasonSchedule(games, 2027);
  const placeholders = placeholderWeeks(games, 2027);
  const last = lastRegWeekOf(games, 2027);

  it("a placeholder week's games are tentative with no end; a game already kicked off is settled", () => {
    const g = games.find((x) => x.week === last)!;
    const k = ms(g.kickoff);
    expect(kickoffStatus(g, { nowMs: k - 20 * D, schedule, placeholders })).toEqual({
      tentative: true,
      reason: "placeholder_week",
      until: null,
    });
    expect(kickoffStatus(g, { nowMs: k, schedule, placeholders })).toEqual({
      tentative: false,
      reason: null,
      until: null,
    });
  });

  it("a TBD time is tentative; a game in its flex window is tentative until the deadline", () => {
    const tbd = games.find((x) => x.kickoff === null)!;
    expect(kickoffStatus(tbd, { nowMs: Date.UTC(2027, 8, 1), schedule, placeholders })).toEqual({
      tentative: true,
      reason: "tbd_time",
      until: null,
    });
    const snf = games.find((x) => {
      if (x.week !== 8 || x.kickoff === null) return false;
      const c = easternClockOf(ms(x.kickoff));
      return c.weekday === "Sun" && c.hour === 20;
    })!;
    const k = ms(snf.kickoff);
    const st = kickoffStatus(snf, { nowMs: k - 20 * D, schedule, placeholders });
    expect(st).toEqual({
      tentative: true,
      reason: "flex_window",
      until: new Date(k - 12 * D).toISOString(),
    });
    expect(kickoffStatus(snf, { nowMs: k - 12 * D, schedule, placeholders }).tentative).toBe(false);
    // weeks 1–4: no flex window
    const early = games.find((x) => x.week === 2 && x.kickoff !== null)!;
    expect(
      kickoffStatus(early, { nowMs: ms(early.kickoff) - 30 * D, schedule, placeholders }).tentative,
    ).toBe(false);
  });

  it("an unparseable kickoff is a TBD time; a game without game_type is judged regular", () => {
    const snf = games.find((x) => {
      if (x.week !== 9 || x.kickoff === null) return false;
      const c = easternClockOf(ms(x.kickoff));
      return c.weekday === "Sun" && c.hour === 20;
    })!;
    expect(
      kickoffStatus(
        { ...snf, kickoff: "TBA" },
        { nowMs: Date.UTC(2027, 8, 1), schedule, placeholders },
      ).reason,
    ).toBe("tbd_time");
    const { game_type: _t, ...untyped } = snf;
    expect(
      kickoffStatus(untyped, { nowMs: ms(snf.kickoff) - 20 * D, schedule, placeholders }).reason,
    ).toBe("flex_window");
  });

  it("without the schedule the final week's flex rule cannot apply", () => {
    const set = setWeek18(games);
    const sat = set.find(
      (x) => x.week === last && x.kickoff !== null && new Date(x.kickoff).getUTCDay() === 6,
    )!;
    const now = ms(sat.kickoff) - 10 * D;
    expect(
      kickoffStatus(sat, {
        nowMs: now,
        schedule: seasonSchedule(set, 2027),
        placeholders: new Set(),
      }).reason,
    ).toBe("flex_window");
    expect(
      kickoffStatus(sat, { nowMs: now, schedule: null, placeholders: new Set() }).tentative,
    ).toBe(false);
  });
});

describe("tentativeWeeks", () => {
  it("lists the phase season's weeks from the current one, strongest reason first, at most `limit`", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const games = syntheticSeason({ season, week18Placeholder: true, seed: season });
      const last = lastRegWeekOf(games, season);
      const lastK = Math.min(...games.filter((g) => g.week === last).map((g) => ms(g.kickoff)));
      const now = lastK - 15 * D;
      const phase = seasonPhaseAt(now, [seasonSchedule(games, season)]);
      expect(phase.phase).toBe("regular");
      const t = tentativeWeeks(viewOf(games, phase), now, 3);
      expect(t.length).toBeLessThanOrEqual(3);
      expect(t.every((w) => w.week >= (phase.week ?? 0))).toBe(true);
      expect(t).toContainEqual({ season, week: last, reason: "placeholder_week", until: null });
      expect(t).toContainEqual({ season, week: last - 1, reason: "tbd_time", until: null });
      const flex = t.find((w) => w.reason === "flex_window");
      if (flex !== undefined) {
        const deadlines = games
          .filter((g) => g.week === flex.week && g.kickoff !== null)
          .map((g) =>
            flexDeadlineMs({
              week: g.week,
              game_type: "REG",
              kickoff_ms: ms(g.kickoff),
              last_reg_week: last,
            }),
          )
          .filter((d): d is number => d !== null && d > now);
        expect(ms(flex.until)).toBe(Math.max(...deadlines));
      }
      expect(tentativeWeeks(viewOf(games, phase), now, 0)).toEqual([]);
      expect(tentativeWeeks(viewOf(games, phase), now, 1).length).toBe(1);
    }
  });

  it("preseason starts at week 1; postseason and offseason have none", () => {
    const games = syntheticSeason({ season: 2029, seed: 3 });
    const s = seasonSchedule(games, 2029);
    const pre = seasonPhaseAt(ms(s.first_kickoff) - 30 * D, [s]);
    expect(pre.phase).toBe("preseason");
    const t = tentativeWeeks(viewOf(games, pre), ms(s.first_kickoff) - 30 * D, 10);
    expect(t.length).toBeGreaterThan(0);
    for (const p of ["postseason", "offseason"] as const)
      expect(tentativeWeeks(viewOf(games, { ...pre, phase: p }), ms(s.first_kickoff), 10)).toEqual(
        [],
      );
    // a regular phase with no current week starts at week 1
    const none = tentativeWeeks(
      viewOf(games, { ...pre, phase: "regular", week: null }),
      ms(s.first_kickoff) - 30 * D,
      10,
    );
    expect(none).toEqual(t);
  });
});

describe("warning lines", () => {
  const change = (
    kind: ScheduleChange["kind"],
    o: string | null,
    n: string | null,
    extra: Partial<ScheduleChange> = {},
  ): ScheduleChange => ({
    detected_at: "2026-12-08T14:05:00.000Z",
    release_updated_at: null,
    season: 2026,
    week: 15,
    game_id: "2026_15_CHI_BUF",
    away: "CHI",
    home: "BUF",
    kind,
    old_value: o,
    new_value: n,
    ...extra,
  });

  it("names the game, the old and new Eastern kickoff and when it was detected", () => {
    const line = kickoffChangeWarning(
      change("kickoff", etIso("2026-12-19", "20:20"), etIso("2026-12-20", "13:00")),
    );
    expect(line).toBe(
      "kickoff changed for CHI@BUF (week 15): Sat 2026-12-19 20:20 ET → Sun 2026-12-20 13:00 ET (detected 2026-12-08T14:05:00Z); lock times use the new kickoff",
    );
  });

  it("every kind reads in fixed vocabulary; third-party text never passes", () => {
    const k = etIso("2026-12-20", "13:00");
    expect(kickoffChangeWarning(change("kickoff", null, k))).toContain(
      "TBD → Sun 2026-12-20 13:00 ET",
    );
    expect(kickoffChangeWarning(change("kickoff", "<b>soon</b>", k))).toContain("unknown → Sun");
    expect(kickoffChangeWarning(change("gameday", "2026-12-19", "2026-12-20"))).toBe(
      "game date changed for CHI@BUF (week 15): Sat 2026-12-19 → Sun 2026-12-20 (detected 2026-12-08T14:05:00Z); lock times use the new date",
    );
    expect(kickoffChangeWarning(change("gameday", null, "2026-13-40"))).toContain("TBD → unknown");
    expect(kickoffChangeWarning(change("venue", "BUF00", "LON00"))).toContain("BUF00 → LON00");
    expect(kickoffChangeWarning(change("venue", null, "Wembley Stadium, London"))).toContain(
      "none → unknown",
    );
    expect(kickoffChangeWarning(change("added", null, k))).toBe(
      "game added: CHI@BUF (week 15) at Sun 2026-12-20 13:00 ET (detected 2026-12-08T14:05:00Z); lock times include it",
    );
    expect(kickoffChangeWarning(change("removed", k, null))).toContain(
      "game removed: CHI@BUF (week 15), was Sun 2026-12-20 13:00 ET",
    );
    expect(kickoffChangeWarning(change("week", "15", "16", { week: 16 }))).toBe(
      "CHI@BUF moved from week 15 to week 16 (detected 2026-12-08T14:05:00Z); lock times use the new week",
    );
    expect(kickoffChangeWarning(change("week", "x", null, { detected_at: "yesterday" }))).toBe(
      "CHI@BUF moved from week ? to week ? (detected unknown); lock times use the new week",
    );
    expect(easternLabel(null)).toBe("TBD");
    expect(easternLabel("12345")).toBe("unknown");
    expect(easternDayLabel(null)).toBe("TBD");
  });

  it("tentative weeks read as placeholders, flex windows and TBD times", () => {
    const t = (reason: TentativeWeek["reason"], until: string | null = null): TentativeWeek => ({
      season: 2026,
      week: 18,
      reason,
      until,
    });
    expect(tentativeWeekWarning(t("placeholder_week"))).toBe(
      "week 18 kickoff times are placeholders until the NFL sets them; lock times may move",
    );
    expect(tentativeWeekWarning(t("flex_window", etIso("2027-01-04", "09:00")))).toBe(
      "week 18 kickoff times may still be flexed until Mon 2027-01-04 09:00 ET; re-check after then",
    );
    expect(tentativeWeekWarning(t("tbd_time"))).toBe(
      "week 18 has kickoff times still to be set (TBD); lock times may move once they are",
    );
  });

  it("every line is at most 400 characters (property over any fixed-vocabulary row)", () => {
    const team = fc.constantFrom<NflTeam>("CHI", "BUF", "NYJ", "JAX", "SF", "LA");
    fc.assert(
      fc.property(
        fc.constantFrom<ScheduleChange["kind"]>(
          "kickoff",
          "gameday",
          "venue",
          "added",
          "removed",
          "week",
        ),
        fc.option(fc.string({ maxLength: 2000 }), { nil: null }),
        fc.option(fc.string({ maxLength: 2000 }), { nil: null }),
        team,
        team,
        fc.integer({ min: 1, max: 30 }),
        (kind, o, n, away, home, week) => {
          const line = kickoffChangeWarning(change(kind, o, n, { away, home, week }));
          expect(line.length).toBeLessThanOrEqual(SCHEDULE_WARNING_MAX_CHARS);
          if (o !== null && o.length > 40) expect(line).not.toContain(o);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("scheduleWarnings", () => {
  const now = Date.UTC(2026, 11, 10);
  const base = (i: number, extra: Partial<ScheduleChange> = {}): ScheduleChange => ({
    detected_at: new Date(now - i * H).toISOString(),
    release_updated_at: null,
    season: 2026,
    week: 15,
    game_id: `2026_15_CHI_B${String.fromCharCode(65 + i)}F`,
    away: "CHI",
    home: "BUF",
    kind: "kickoff",
    old_value: etIso("2026-12-19", "20:20"),
    new_value: etIso("2026-12-20", `1${String(i % 10)}:00`),
    ...extra,
  });

  it("filters by season, weeks (a week move counts both weeks), teams and the 7-day lookback", () => {
    const changes = [
      base(0),
      base(1, { season: 2025 }),
      base(2, { week: 16 }),
      base(3, { kind: "week", week: 16, old_value: "15", new_value: "16" }),
      base(4, { away: "NYJ", home: "MIA" }),
      base(5, { detected_at: new Date(now - 8 * D).toISOString() }),
    ];
    const lines = scheduleWarnings({
      changes,
      tentative: [],
      season: 2026,
      weeks: [15],
      teams: new Set<NflTeam>(["CHI"]),
      nowMs: now,
    });
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("kickoff changed for CHI@BUF");
    expect(lines[1]).toContain("moved from week 15 to week 16");
    const any = scheduleWarnings({
      changes,
      tentative: [],
      season: 2026,
      weeks: [15],
      teams: null,
      nowMs: now,
    });
    expect(any.length).toBe(3);
    expect(any.some((l) => l.includes("NYJ@MIA"))).toBe(true);
  });

  it("at most 3 lines, then a count; newest first; duplicates once; tentative weeks after changes", () => {
    const tentative: TentativeWeek[] = [
      { season: 2026, week: 15, reason: "flex_window", until: etIso("2026-12-13", "13:00") },
    ];
    const one = scheduleWarnings({
      changes: [base(1)],
      tentative,
      season: 2026,
      weeks: [15],
      teams: null,
      nowMs: now,
    });
    expect(one.length).toBe(2);
    expect(one[1]).toContain("may still be flexed");
    const many = scheduleWarnings({
      changes: [base(3), base(0), base(1), base(2), base(0)],
      tentative,
      season: 2026,
      weeks: [15],
      teams: null,
      nowMs: now,
    });
    expect(many.length).toBe(SCHEDULE_WARNING_MAX + 1);
    expect(many[0]).toContain("Sun 2026-12-20 10:00 ET"); // the newest detection first
    expect(many[SCHEDULE_WARNING_MAX]).toBe("… 2 more schedule notes");
    const four = scheduleWarnings({
      changes: [base(0), base(1), base(2), base(3)],
      tentative: [],
      season: 2026,
      weeks: [15],
      teams: null,
      nowMs: now,
    });
    expect(four[SCHEDULE_WARNING_MAX]).toBe("… 1 more schedule note");
    // another season's tentative week, or a week not asked for, is not repeated
    expect(
      scheduleWarnings({
        changes: [],
        tentative: [
          { ...tentative[0]!, week: 16 },
          { ...tentative[0]!, season: 2025 },
        ],
        season: 2026,
        weeks: [15],
        teams: null,
        nowMs: now,
      }),
    ).toEqual([]);
  });

  it("an unreadable detection instant is never repeated", () => {
    expect(
      scheduleWarnings({
        changes: [base(0, { detected_at: "soon" })],
        tentative: [],
        season: 2026,
        weeks: [15],
        teams: null,
        nowMs: now,
      }),
    ).toEqual([]);
  });
});
