// schedule.test.ts — byes, lock instants, the lock schedule, latest execution time and the league
// calendar (plan 07 B1/A2; research 05 §3.4, §14 item 2; research 03 §D.2) over real 2026 week-1
// kickoffs: the Wednesday opener, the Melbourne Thursday game, Sunday windows, Monday night, and a
// week-4 London morning game.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NFL_TEAMS, type NflTeam } from "../../../src/config/schema.js";
import {
  byeWeekOf,
  byeWeeks,
  easternDate,
  firstKickoff,
  GAME_WINDOW_MS,
  gamesOfWeek,
  isLocked,
  kickoffMs,
  lastKickoff,
  latestExecutionTime,
  leagueWeeks,
  lockAtFor,
  lockSchedule,
  opponentOf,
  scheduledWeeks,
  shiftDate,
  teamGame,
  weekEndsAt,
  weekPosition,
} from "../../../src/domain/league/schedule.js";
import { game, WEEK1, WEEK4_PART } from "./fixtures.js";

const ms = (iso: string): number => Date.parse(iso);

describe("per-player lock times (per_game)", () => {
  it("locks each player at their own game's kickoff: Wed, Thu (Melbourne), Sun early/late/night, Mon", () => {
    expect(lockAtFor("SEA", WEEK1, "per_game")).toBe("2026-09-10T00:20:00.000Z");
    expect(lockAtFor("NE", WEEK1, "per_game")).toBe("2026-09-10T00:20:00.000Z");
    expect(lockAtFor("SF", WEEK1, "per_game")).toBe("2026-09-11T00:35:00.000Z");
    expect(lockAtFor("DET", WEEK1, "per_game")).toBe("2026-09-13T17:00:00.000Z");
    expect(lockAtFor("MIN", WEEK1, "per_game")).toBe("2026-09-13T20:25:00.000Z");
    expect(lockAtFor("NYG", WEEK1, "per_game")).toBe("2026-09-14T00:20:00.000Z");
    expect(lockAtFor("KC", WEEK1, "per_game")).toBe("2026-09-15T00:15:00.000Z");
  });

  it("locks the London 09:30 ET game hours before the Sunday 13:00 window", () => {
    expect(lockAtFor("IND", WEEK4_PART, "per_game")).toBe("2026-10-04T13:30:00.000Z");
    expect(lockAtFor("BUF", WEEK4_PART, "per_game")).toBe("2026-10-04T20:25:00.000Z");
    expect(ms("2026-10-04T13:30:00.000Z")).toBeLessThan(ms("2026-10-04T17:00:00.000Z"));
  });

  it("a team on bye, a free agent, or an unknown kickoff has no lock under per_game", () => {
    const partial = WEEK1.filter((g) => g.home !== "KC");
    expect(lockAtFor("KC", partial, "per_game")).toBeNull();
    expect(lockAtFor(null, WEEK1, "per_game")).toBeNull();
    const tbd = [game("2026_09_TBD", 9, "PIT", "TEN", null)];
    expect(lockAtFor("PIT", tbd, "per_game")).toBeNull();
    expect(lockAtFor("PIT", [game("bad", 9, "PIT", "TEN", "not a date")], "per_game")).toBeNull();
  });

  it("uses the earliest known kickoff when the data holds two games for a team", () => {
    const two = [
      game("a", 1, "DET", "GB", "2026-09-13T20:25:00.000Z"),
      game("b", 1, "DET", "CHI", null),
      game("c", 1, "CHI", "DET", "2026-09-13T17:00:00.000Z"),
    ];
    expect(teamGame("DET", two)?.game_id).toBe("c");
    expect(
      teamGame("DET", [two[1]!, two[0]!])?.game_id,
    ).toBe("a");
    expect(teamGame("KC", two)).toBeNull();
  });
});

describe("weekly lock variant", () => {
  it("locks every player (bye or free agent included) at the week's first kickoff", () => {
    for (const t of ["KC", "SEA", "DET"] as const)
      expect(lockAtFor(t, WEEK1, "weekly")).toBe("2026-09-10T00:20:00.000Z");
    expect(lockAtFor(null, WEEK1, "weekly")).toBe("2026-09-10T00:20:00.000Z");
    expect(lockAtFor("KC", [], "weekly")).toBeNull();
  });
});

describe("lockSchedule / isLocked / latestExecutionTime", () => {
  const subjects = [
    { player_key: "manual.p.00-0000002", nfl_team: "KC" as NflTeam },
    { player_key: "manual.p.00-0000001", nfl_team: "SEA" as NflTeam },
    { player_key: "manual.p.def-det", nfl_team: "DET" as NflTeam },
    { player_key: "manual.p.00-0000003", nfl_team: "DET" as NflTeam },
    { player_key: "manual.p.fa", nfl_team: null },
  ];

  it("groups by lock instant, ascending, keys sorted, no-lock players omitted", () => {
    expect(lockSchedule(subjects, WEEK1, "per_game")).toEqual([
      { lock_at: "2026-09-10T00:20:00.000Z", player_keys: ["manual.p.00-0000001"] },
      {
        lock_at: "2026-09-13T17:00:00.000Z",
        player_keys: ["manual.p.00-0000003", "manual.p.def-det"],
      },
      { lock_at: "2026-09-15T00:15:00.000Z", player_keys: ["manual.p.00-0000002"] },
    ]);
    const weekly = lockSchedule(subjects, WEEK1, "weekly");
    expect(weekly).toHaveLength(1);
    expect(weekly[0]?.player_keys).toHaveLength(5);
    expect(lockSchedule(subjects, [], "per_game")).toEqual([]);
  });

  it("isLocked is inclusive at the instant and false for no lock", () => {
    const at = "2026-09-13T17:00:00.000Z";
    expect(isLocked(at, ms(at) - 1)).toBe(false);
    expect(isLocked(at, ms(at))).toBe(true);
    expect(isLocked(null, ms(at))).toBe(false);
  });

  it("latest execution time is the next future lock; null once every lock has passed", () => {
    const sched = lockSchedule(subjects, WEEK1, "per_game");
    expect(latestExecutionTime(sched, ms("2026-09-09T12:00:00Z"))).toBe("2026-09-10T00:20:00.000Z");
    // Thursday: SEA locked already → next is Sunday 13:00 ET
    expect(latestExecutionTime(sched, ms("2026-09-11T12:00:00Z"))).toBe("2026-09-13T17:00:00.000Z");
    // Sunday evening: only Monday night remains
    expect(latestExecutionTime(sched, ms("2026-09-14T03:00:00Z"))).toBe("2026-09-15T00:15:00.000Z");
    expect(latestExecutionTime(sched, ms("2026-09-15T00:15:00.000Z"))).toBeNull();
    expect(latestExecutionTime([{ lock_at: "garbage", player_keys: [] }], 0)).toBeNull();
  });

  it("lock schedule is a partition of the locked subjects, ascending (property)", () => {
    const teams = fc.constantFrom(...NFL_TEAMS);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            k: fc.string({ minLength: 1, maxLength: 6 }),
            t: fc.option(teams, { nil: null }),
          }),
          { maxLength: 30 },
        ),
        (xs) => {
          const subs = xs.map((x) => ({ player_key: x.k, nfl_team: x.t }));
          const sched = lockSchedule(subs, WEEK1, "per_game");
          const times = sched.map((e) => ms(e.lock_at));
          expect([...times].sort((a, b) => a - b)).toEqual(times);
          const keys = sched.flatMap((e) => e.player_keys);
          const expected = new Set(
            subs.filter((s) => s.nfl_team !== null).map((s) => s.player_key),
          );
          expect(new Set(keys)).toEqual(expected);
        },
      ),
    );
  });
});

describe("byes", () => {
  const season = [
    game("w1a", 1, "BUF", "KC", "2026-09-13T17:00:00Z"),
    game("w1b", 1, "DET", "SEA", "2026-09-13T17:00:00Z"),
    game("w2a", 2, "BUF", "DET", "2026-09-20T17:00:00Z"),
    game("w3a", 3, "KC", "SEA", "2026-09-27T17:00:00Z"),
    game("w3b", 3, "DET", "BUF", "2026-09-27T17:00:00Z"),
    game("w5a", 5, "KC", "BUF", "2026-10-11T17:00:00Z"),
    game("other", 2, "KC", "SEA", "2025-09-20T17:00:00Z", { season: 2025 }),
  ];
  const teams: NflTeam[] = ["BUF", "KC", "DET", "SEA"];

  it("a team with no game in a scheduled week is on bye; unscheduled weeks are not byes", () => {
    const b = byeWeeks(season, 2026, teams);
    expect(b.get("BUF")).toEqual([]);
    expect(b.get("KC")).toEqual([2]);
    expect(b.get("SEA")).toEqual([2, 5]);
    expect(b.get("DET")).toEqual([5]);
    expect(byeWeekOf("SEA", b)).toBe(2);
    expect(byeWeekOf("BUF", b)).toBeNull();
    expect(byeWeekOf("MIA", b)).toBeNull();
    expect(scheduledWeeks(season, 2026)).toEqual([1, 2, 3, 5]);
  });

  it("the real 2026 week 1 has every team playing (no week-1 byes)", () => {
    const b = byeWeeks(WEEK1, 2026, NFL_TEAMS);
    expect(NFL_TEAMS.every((t) => (b.get(t) ?? []).length === 0)).toBe(true);
  });

  it("opponentOf and gamesOfWeek", () => {
    const g = WEEK1[0];
    expect(g && opponentOf("NE", g)).toBe("SEA");
    expect(g && opponentOf("SEA", g)).toBe("NE");
    expect(gamesOfWeek(season, 2026, 2)).toHaveLength(1);
    expect(gamesOfWeek(season, 2025, 2)).toHaveLength(1);
  });
});

describe("league weeks and the current week", () => {
  const season = [
    ...WEEK1,
    ...WEEK4_PART,
    game("w2", 2, "BUF", "MIA", "2026-09-20T17:00:00.000Z", { is_final: true }),
  ];
  const range = { start_week: 1, end_week: 17 };

  it("first/last kickoff and week end", () => {
    expect(firstKickoff(WEEK1)).toBe("2026-09-10T00:20:00.000Z");
    expect(lastKickoff(WEEK1)).toBe("2026-09-15T00:15:00.000Z");
    expect(weekEndsAt(WEEK1)).toBe(ms("2026-09-15T00:15:00.000Z") + GAME_WINDOW_MS);
    expect(firstKickoff([])).toBeNull();
    expect(weekEndsAt([game("x", 1, "BUF", "KC", null)])).toBeNull();
    expect(kickoffMs("nope")).toBeNull();
  });

  it("current week: week 1 before the season and until Monday night ends, then week 2", () => {
    expect(weekPosition(season, 2026, range, ms("2026-08-01T00:00:00Z"))).toEqual({
      current: 1,
      next: 2,
      is_finished: false,
    });
    expect(weekPosition(season, 2026, range, ms("2026-09-15T02:00:00Z"))?.current).toBe(1);
    expect(weekPosition(season, 2026, range, ms("2026-09-15T04:15:00.000Z"))).toEqual({
      current: 2,
      next: 4,
      is_finished: false,
    });
    expect(weekPosition(season, 2026, range, ms("2026-09-30T12:00:00Z"))).toEqual({
      current: 4,
      next: null,
      is_finished: false,
    });
  });

  it("after the last scheduled week the league is finished on its last week", () => {
    expect(weekPosition(season, 2026, range, ms("2027-01-01T00:00:00Z"))).toEqual({
      current: 4,
      next: null,
      is_finished: true,
    });
  });

  it("respects the league's week range and returns null with no usable schedule", () => {
    expect(
      weekPosition(season, 2026, { start_week: 2, end_week: 3 }, ms("2026-08-01T00:00:00Z")),
    ).toEqual({ current: 2, next: null, is_finished: false });
    expect(weekPosition([], 2026, range, 0)).toBeNull();
    expect(weekPosition(season, 2030, range, 0)).toBeNull();
    expect(weekPosition([game("tbd", 1, "BUF", "KC", null)], 2026, range, 0)).toBeNull();
  });

  it("builds the calendar: Eastern end date of the last kickoff, start six days earlier", () => {
    const weeks = leagueWeeks(season, 2026, range, ms("2026-09-16T12:00:00Z"));
    expect(weeks.map((w) => w.week)).toEqual([1, 2, 4]);
    // Monday night 20:15 ET on Sep 14 is 00:15Z Sep 15 — the Eastern date is still the 14th
    expect(weeks[0]).toEqual({
      week: 1,
      start: "2026-09-08",
      end: "2026-09-14",
      is_current: false,
      provisional: true,
    });
    expect(weeks[1]).toMatchObject({ week: 2, is_current: true, provisional: false });
    expect(leagueWeeks(season, 2026, { start_week: 2, end_week: 2 }, 0).map((w) => w.week)).toEqual(
      [2],
    );
    expect(leagueWeeks([game("tbd", 1, "BUF", "KC", null)], 2026, range, 0)).toEqual([]);
    const done = leagueWeeks(season, 2026, range, ms("2027-02-01T00:00:00Z"));
    expect(done.every((w) => !w.is_current)).toBe(true);
  });

  it("easternDate handles both DST states; shiftDate crosses months and years", () => {
    expect(easternDate(ms("2026-09-15T00:15:00Z"))).toBe("2026-09-14");
    expect(easternDate(ms("2026-12-01T04:59:00Z"))).toBe("2026-11-30"); // EST = UTC−5
    expect(easternDate(ms("2026-12-01T05:00:00Z"))).toBe("2026-12-01");
    expect(shiftDate("2026-09-03", -6)).toBe("2026-08-28");
    expect(shiftDate("2026-12-29", 6)).toBe("2027-01-04");
  });
});
