// lock-check.test.ts — src/domain/reclog/lock-check.ts (season-fresh spec §5.4): a logged
// recommendation whose lock time came from a kickoff that later moved (a flex, a date move, a week
// move, a removed game) reads `moved` with the old and new lock; an unrelated team's move leaves it
// `current`; no deadline or no games is `unknown`. Over synthetic seasons 2026–2030.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { easternClockOf } from "../../../src/config/game-calendar.js";
import type { NflTeam } from "../../../src/config/schema.js";
import type { NflGame, ScheduleChange } from "../../../src/domain/analytics/types.js";
import { diffSchedules } from "../../../src/domain/league/schedule-changes.js";
import { lockCheck } from "../../../src/domain/reclog/lock-check.js";
import {
  SYNTHETIC_SEASONS,
  etIso,
  flexMove,
  moveToWeek,
  syntheticSeason,
} from "../../helpers/season/synthetic.js";

const H = 3_600_000;
const D = 24 * H;
const ms = (iso: string | null): number => Date.parse(iso ?? "");

function sundayNight(games: readonly NflGame[], week: number): NflGame {
  const g = games.find((x) => {
    if (x.week !== week || x.kickoff === null) return false;
    const c = easternClockOf(ms(x.kickoff));
    return c.weekday === "Sun" && c.hour === 20;
  });
  if (g === undefined) throw new Error("no Sunday-night game");
  return g;
}

describe("lockCheck", () => {
  it("a flexed game that set the rec's deadline → moved, with the old and new lock", () => {
    for (const season of SYNTHETIC_SEASONS) {
      const before = syntheticSeason({ season, seed: season });
      const snf = sundayNight(before, 9);
      const newK = etIso(snf.gameday ?? "", "13:00");
      const after = flexMove(before, snf.game_id, newK);
      const detectedMs = ms(snf.kickoff) - 10 * D;
      const changes = diffSchedules(before, after, {
        nowMs: detectedMs,
        detectedAt: new Date(detectedMs).toISOString(),
        releaseUpdatedAt: null,
      });
      const rec = {
        season,
        week: 9,
        latest_execution_time: snf.kickoff,
        recorded_at: new Date(detectedMs - 2 * D).toISOString(),
        subject_teams: new Set<NflTeam>([snf.away]),
      };
      const week = after.filter((g) => g.week === 9);
      expect(lockCheck(rec, week, changes)).toEqual({
        status: "moved",
        old_lock: snf.kickoff,
        new_lock: newK,
        detected_at: new Date(detectedMs).toISOString(),
      });
      // without the change rows the current games still show the deadline is gone
      expect(lockCheck(rec, week, [])).toEqual({
        status: "moved",
        old_lock: snf.kickoff,
        new_lock: newK,
        detected_at: null,
      });
      // before the flex: current
      expect(
        lockCheck(
          rec,
          before.filter((g) => g.week === 9),
          [],
        ),
      ).toEqual({ status: "current", old_lock: null, new_lock: null, detected_at: null });
    }
  });

  it("an unrelated team's move leaves the rec current when its teams are known", () => {
    const before = syntheticSeason({ season: 2028, seed: 5 });
    const snf = sundayNight(before, 9);
    const other =
      before.find((g) => g.week === 9 && g.kickoff === snf.kickoff && g !== snf) ??
      (before.find(
        (g) => g.week === 9 && g.game_id !== snf.game_id && g.kickoff !== null,
      )!);
    // a change row for the other game that happens to carry the same old instant
    const row: ScheduleChange = {
      detected_at: "2028-10-20T00:00:00.000Z",
      release_updated_at: null,
      season: 2028,
      week: 9,
      game_id: other.game_id,
      away: other.away,
      home: other.home,
      kind: "kickoff",
      old_value: snf.kickoff,
      new_value: etIso(snf.gameday ?? "", "16:25"),
    };
    const rec = (teams: ReadonlySet<NflTeam> | null) => ({
      season: 2028,
      week: 9,
      latest_execution_time: snf.kickoff,
      recorded_at: "2028-10-01T00:00:00.000Z",
      subject_teams: teams,
    });
    const week = before.filter((g) => g.week === 9);
    expect(lockCheck(rec(new Set<NflTeam>([snf.home])), week, [row]).status).toBe("current");
    expect(lockCheck(rec(null), week, [row]).status).toBe("moved");
  });

  it("gameday, week and removed rows mark the move with no new kickoff; the newest detection wins", () => {
    const before = syntheticSeason({ season: 2029, seed: 1 });
    const snf = sundayNight(before, 10);
    const base = {
      release_updated_at: null,
      season: 2029,
      week: 10,
      game_id: snf.game_id,
      away: snf.away,
      home: snf.home,
      old_value: snf.kickoff,
      new_value: null,
    } as const;
    const rec = {
      season: 2029,
      week: 10,
      latest_execution_time: snf.kickoff,
      recorded_at: "2029-10-01T00:00:00.000Z",
      subject_teams: null,
    };
    const week = before.filter((g) => g.week === 10);
    for (const kind of ["gameday", "week", "removed"] as const)
      expect(
        lockCheck(rec, week, [{ ...base, kind, detected_at: "2029-11-01T00:00:00.000Z" }]),
      ).toEqual({
        status: "moved",
        old_lock: snf.kickoff,
        new_lock: null,
        detected_at: "2029-11-01T00:00:00.000Z",
      });
    const two: ScheduleChange[] = [
      {
        ...base,
        kind: "kickoff",
        new_value: etIso(snf.gameday ?? "", "13:00"),
        detected_at: "2029-11-01T00:00:00.000Z",
      },
      {
        ...base,
        kind: "kickoff",
        new_value: etIso(snf.gameday ?? "", "16:25"),
        detected_at: "2029-11-03T00:00:00.000Z",
      },
      {
        ...base,
        kind: "kickoff",
        new_value: etIso(snf.gameday ?? "", "16:05"),
        detected_at: "not an instant",
      },
    ];
    expect(lockCheck(rec, week, two).new_lock).toBe(etIso(snf.gameday ?? "", "16:25"));
    // a venue change never moves a lock; another week's change never applies
    expect(
      lockCheck(rec, week, [
        {
          ...base,
          kind: "venue",
          old_value: snf.kickoff,
          new_value: "LON00",
          detected_at: "2029-11-01T00:00:00.000Z",
        },
      ]).status,
    ).toBe("current");
    expect(
      lockCheck(rec, week, [
        { ...base, week: 11, kind: "kickoff", detected_at: "2029-11-01T00:00:00.000Z" },
      ]).status,
    ).toBe("current");
    expect(
      lockCheck(rec, week, [
        { ...base, season: 2028, kind: "kickoff", detected_at: "2029-11-01T00:00:00.000Z" },
      ]).status,
    ).toBe("current");
  });

  it("a deadline matching no kickoff names the week's newest detection (unreadable instants last)", () => {
    const before = syntheticSeason({ season: 2029, seed: 6 });
    const snf = sundayNight(before, 11);
    const row = (detected_at: string): ScheduleChange => ({
      detected_at,
      release_updated_at: null,
      season: 2029,
      week: 11,
      game_id: snf.game_id,
      away: snf.away,
      home: snf.home,
      kind: "venue",
      old_value: "AAA00",
      new_value: "BBB00",
    });
    const rec = {
      season: 2029,
      week: 11,
      latest_execution_time: "2029-01-01T00:00:00.000Z",
      recorded_at: "2029-01-01T00:00:00.000Z",
      subject_teams: null,
    };
    const week = before.filter((g) => g.week === 11);
    const got = lockCheck(rec, week, [
      row("garbage"),
      row("2029-11-02T00:00:00.000Z"),
      row("2029-11-01T00:00:00.000Z"),
    ]);
    expect(got).toMatchObject({ status: "moved", detected_at: "2029-11-02T00:00:00.000Z" });
    expect(lockCheck(rec, week, [row("garbage")]).detected_at).toBe("garbage");
  });

  it("a week move: the old week's games no longer hold the deadline", () => {
    const before = syntheticSeason({ season: 2027, seed: 2 });
    const snf = sundayNight(before, 8);
    const after = moveToWeek(
      before,
      snf.game_id,
      10,
      new Date(ms(snf.kickoff) + 14 * D).toISOString(),
    );
    const rec = {
      season: 2027,
      week: 8,
      latest_execution_time: snf.kickoff,
      recorded_at: new Date(ms(snf.kickoff) - 5 * D).toISOString(),
      subject_teams: new Set<NflTeam>([snf.away, snf.home]),
    };
    expect(
      lockCheck(
        rec,
        after.filter((g) => g.week === 8),
        [],
      ).status,
    ).toBe("unknown"); // the teams no longer play week 8
    expect(
      lockCheck(
        { ...rec, subject_teams: null },
        after.filter((g) => g.week === 8),
        [],
      ).status,
    ).toBe("moved");
  });

  it("unknown: no deadline, no games, or none of the subject teams playing that week", () => {
    const games = syntheticSeason({ season: 2026 });
    const g = games.find((x) => x.week === 5)!;
    const rec = {
      season: 2026,
      week: 5,
      latest_execution_time: g.kickoff,
      recorded_at: "2026-09-01T00:00:00.000Z",
      subject_teams: null,
    };
    const unknown = { status: "unknown", old_lock: null, new_lock: null, detected_at: null };
    expect(lockCheck({ ...rec, latest_execution_time: null }, games, [])).toEqual(unknown);
    expect(lockCheck({ ...rec, latest_execution_time: "soon" }, games, [])).toEqual(unknown);
    expect(lockCheck(rec, [], [])).toEqual(unknown);
    const bye = games.filter((x) => x.week === 5);
    const resting = (
      [
        "ARI",
        "ATL",
        "BAL",
        "BUF",
        "CAR",
        "CHI",
        "CIN",
        "CLE",
        "DAL",
        "DEN",
        "DET",
        "GB",
        "HOU",
        "IND",
        "JAX",
        "KC",
        "LA",
        "LAC",
        "LV",
        "MIA",
        "MIN",
        "NE",
        "NO",
        "NYG",
        "NYJ",
        "PHI",
        "PIT",
        "SEA",
        "SF",
        "TB",
        "TEN",
        "WAS",
      ] as NflTeam[]
    ).find((t) => !bye.some((x) => x.away === t || x.home === t))!;
    expect(lockCheck({ ...rec, subject_teams: new Set([resting]) }, bye, [])).toEqual(unknown);
  });

  it("the new lock is the earliest subject kickoff after the recording; none when all are earlier or TBD", () => {
    const games = syntheticSeason({ season: 2030, seed: 4 });
    const week = games.filter((x) => x.week === 6);
    const rec = {
      season: 2030,
      week: 6,
      latest_execution_time: "2030-01-01T00:00:00.000Z",
      recorded_at: "2031-01-01T00:00:00.000Z",
      subject_teams: null,
    };
    expect(lockCheck(rec, week, [])).toMatchObject({ status: "moved", new_lock: null });
    expect(lockCheck({ ...rec, recorded_at: "garbage" }, week, []).new_lock).toBe(
      new Date(Math.min(...week.map((x) => ms(x.kickoff)))).toISOString(),
    );
    const tbd = week.map((x) => ({ ...x, kickoff: null }));
    expect(lockCheck({ ...rec, recorded_at: "2030-01-01T00:00:00.000Z" }, tbd, [])).toMatchObject({
      status: "moved",
      new_lock: null,
    });
  });

  it("property: a rec made from the current kickoffs is current; after any change of its game's kickoff it is moved", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SYNTHETIC_SEASONS),
        fc.integer({ min: 1, max: 17 }),
        fc.nat(),
        fc.integer({ min: 1, max: 48 }),
        (season, week, pick, shiftH) => {
          const games = syntheticSeason({ season, seed: week });
          const wk = games.filter((g) => g.week === week && g.kickoff !== null);
          const g = wk[pick % wk.length]!;
          const rec = {
            season,
            week,
            latest_execution_time: g.kickoff,
            recorded_at: new Date(ms(g.kickoff) - 3 * D).toISOString(),
            subject_teams: new Set<NflTeam>([g.home]),
          };
          expect(
            lockCheck(
              rec,
              games.filter((x) => x.week === week),
              [],
            ).status,
          ).toBe("current");
          const moved = flexMove(
            games,
            g.game_id,
            new Date(ms(g.kickoff) + shiftH * H).toISOString(),
          );
          const doubled = wk.some(
            (x) => x !== g && (x.home === g.home || x.away === g.home) && x.kickoff === g.kickoff,
          );
          if (!doubled)
            expect(
              lockCheck(
                rec,
                moved.filter((x) => x.week === week),
                [],
              ).status,
            ).toBe("moved");
        },
      ),
      { numRuns: 100 },
    );
  });
});
