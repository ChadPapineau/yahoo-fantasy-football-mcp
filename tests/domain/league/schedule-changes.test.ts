// schedule-changes.test.ts — src/domain/league/schedule-changes.ts (season-fresh spec §5.1): a flexed
// kickoff (Sunday night ↔ Sunday 13:00), a Saturday ↔ Sunday move, a TBD date move, venue moves,
// added and removed games, week moves (a removed + added pair within ±3 weeks), history corrections
// ignored, seasons not in both files ignored, and the collapsed notification (a set final week reads
// as one line). Every value is an ISO instant, an Eastern date, a venue id or a week number.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { easternClockOf } from "../../../src/config/game-calendar.js";
import type { NflGame, ScheduleChange } from "../../../src/domain/analytics/types.js";
import {
  CHANGE_LOOKBACK_MS,
  NOTIFICATION_MAX_CHARS,
  WEEK_SET_COLLAPSE,
  changeNotificationText,
  diffSchedules,
} from "../../../src/domain/league/schedule-changes.js";
import {
  arbSeasonOptions,
  etIso,
  flexMove,
  lastRegWeekOf,
  moveToWeek,
  setWeek18,
  syntheticSeason,
} from "../../helpers/season/synthetic.js";

const H = 3_600_000;
const D = 24 * H;
const ctx = (nowMs: number) => ({
  nowMs,
  detectedAt: new Date(nowMs).toISOString(),
  releaseUpdatedAt: "2027-10-01T10:00:00.000Z",
});
const ms = (iso: string | null): number => Date.parse(iso ?? "");
const VALUE_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z|\d{4}-\d{2}-\d{2}|[A-Z]{3}\d{2}|\d{1,2})$/;

/** The week-10 Sunday-night game of a synthetic season. */
function sundayNight(games: readonly NflGame[], week = 10): NflGame {
  const g = games.find((x) => {
    if (x.week !== week || x.kickoff === null) return false;
    const c = easternClockOf(ms(x.kickoff));
    return c.weekday === "Sun" && c.hour === 20;
  });
  if (g === undefined) throw new Error("no Sunday-night game");
  return g;
}

describe("diffSchedules", () => {
  const before = syntheticSeason({ season: 2027, seed: 4 });
  const snf = sundayNight(before);
  const now = ms(snf.kickoff) - 10 * D;

  it("a flexed kickoff (Sunday night → Sunday 13:00) is one kickoff row with both instants", () => {
    const newK = etIso(snf.gameday ?? "", "13:00");
    const rows = diffSchedules(before, flexMove(before, snf.game_id, newK), ctx(now));
    expect(rows).toEqual([
      {
        detected_at: new Date(now).toISOString(),
        release_updated_at: "2027-10-01T10:00:00.000Z",
        season: 2027,
        week: 10,
        game_id: snf.game_id,
        away: snf.away,
        home: snf.home,
        kind: "kickoff",
        old_value: snf.kickoff,
        new_value: newK,
      },
    ]);
    // and back again
    const back = diffSchedules(flexMove(before, snf.game_id, newK), before, ctx(now));
    expect(back.map((r) => [r.kind, r.old_value, r.new_value])).toEqual([
      ["kickoff", newK, snf.kickoff],
    ]);
  });

  it("a Saturday ↔ Sunday move is a kickoff row (the date moves with it)", () => {
    const last = lastRegWeekOf(before, 2027);
    const sat = before.find(
      (g) =>
        g.week === last - 1 &&
        g.kickoff !== null &&
        easternClockOf(ms(g.kickoff)).weekday === "Sat",
    );
    expect(sat).toBeDefined();
    const g = sat!;
    const sun = etIso(new Date(ms(g.kickoff) + D).toISOString().slice(0, 10), "13:00");
    const rows = diffSchedules(
      before,
      flexMove(before, g.game_id, sun),
      ctx(ms(g.kickoff) - 8 * D),
    );
    expect(rows.map((r) => r.kind)).toEqual(["kickoff"]);
    expect(easternClockOf(ms(rows[0]?.new_value ?? null)).weekday).toBe("Sun");
  });

  it("a TBD game: its date move is a gameday row; its time being set is a kickoff row", () => {
    const tbd = before.find((g) => g.kickoff === null)!;
    const t = ms(etIso(tbd.gameday ?? "", "12:00"));
    const moved = before.map((g) =>
      g.game_id === tbd.game_id ? { ...g, gameday: "2027-12-26" } : g,
    );
    expect(
      diffSchedules(before, moved, ctx(t - 9 * D)).map((r) => [r.kind, r.old_value, r.new_value]),
    ).toEqual([["gameday", tbd.gameday, "2027-12-26"]]);
    const set = flexMove(before, tbd.game_id, etIso(tbd.gameday ?? "", "16:25"));
    expect(diffSchedules(before, set, ctx(t - 9 * D)).map((r) => [r.kind, r.old_value])).toEqual([
      ["kickoff", null],
    ]);
    // a set time withdrawn to TBD on another date: kickoff (→ null) and gameday rows
    const withdrawn = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, kickoff: null, gameday: "2027-11-15" } : g,
    );
    expect(diffSchedules(before, withdrawn, ctx(now)).map((r) => r.kind)).toEqual([
      "kickoff",
      "gameday",
    ]);
  });

  it("venue moves carry venue ids only (an id that is not one reads null)", () => {
    const moved = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, stadium_id: "LON00" } : g,
    );
    const rows = diffSchedules(before, moved, ctx(now));
    expect(rows.map((r) => [r.kind, r.old_value, r.new_value])).toEqual([
      ["venue", snf.stadium_id, "LON00"],
    ]);
    const junk = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, stadium_id: "<b>Somewhere</b>" } : g,
    );
    expect(diffSchedules(before, junk, ctx(now)).map((r) => [r.kind, r.new_value])).toEqual([
      ["venue", null],
    ]);
    const same = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, stadium_id: "also junk" } : g,
    );
    expect(diffSchedules(junk, same, ctx(now))).toEqual([]);
  });

  it("a week move within ±3 weeks is a week row plus its kickoff row, under the new id and week", () => {
    const newK = ms(snf.kickoff) + 14 * D;
    const after = moveToWeek(before, snf.game_id, 12, new Date(newK).toISOString());
    const rows = diffSchedules(before, after, ctx(now));
    expect(rows.map((r) => [r.kind, r.week, r.game_id.slice(5, 7), r.old_value])).toEqual([
      ["week", 12, "12", "10"],
      ["kickoff", 12, "12", snf.kickoff],
    ]);
    // beyond ±3 weeks: a removed game and an added one
    const far = moveToWeek(
      before,
      snf.game_id,
      15,
      new Date(ms(snf.kickoff) + 35 * D).toISOString(),
    );
    expect(diffSchedules(before, far, ctx(now)).map((r) => [r.kind, r.week])).toEqual([
      ["removed", 10],
      ["added", 15],
    ]);
  });

  it("pairs the closest same-matchup game when several are added", () => {
    const k = ms(snf.kickoff);
    const a = moveToWeek(before, snf.game_id, 13, new Date(k + 21 * D).toISOString());
    const twice = [
      ...a,
      {
        ...(a.find((g) => g.week === 13 && g.away === snf.away && g.home === snf.home)!),
        week: 11,
        game_id: `2027_11_${snf.away}_${snf.home}`,
        kickoff: new Date(k + 7 * D).toISOString(),
      },
    ];
    const rows = diffSchedules(before, twice, ctx(now));
    expect(rows.filter((r) => r.kind === "week").map((r) => r.new_value)).toEqual(["11"]);
    expect(rows.filter((r) => r.kind === "added").map((r) => r.week)).toEqual([13]);
  });

  it("an unparseable kickoff reads as no kickoff", () => {
    const garbled = before.map((g) => (g.game_id === snf.game_id ? { ...g, kickoff: "TBA" } : g));
    expect(
      diffSchedules(garbled, before, ctx(now)).map((r) => [r.kind, r.old_value, r.new_value]),
    ).toEqual([["kickoff", null, snf.kickoff]]);
  });

  it("an unrelated added game is never paired with a moved one", () => {
    const k = ms(snf.kickoff);
    const moved = moveToWeek(before, snf.game_id, 11, new Date(k + 7 * D).toISOString());
    const stranger: NflGame = {
      ...snf,
      game_id: `2027_11_${snf.home}_${snf.away}`,
      away: snf.home,
      home: snf.away,
      week: 11,
    };
    const rows = diffSchedules(before, [...moved, stranger], ctx(now));
    expect(rows.map((r) => `${r.kind} ${r.game_id}`).sort()).toEqual(
      [
        `week 2027_11_${snf.away}_${snf.home}`,
        `kickoff 2027_11_${snf.away}_${snf.home}`,
        `added ${stranger.game_id}`,
      ].sort(),
    );
  });

  it("a game without a gameday field takes its date from the kickoff (older readers)", () => {
    const bare = before.map((g) => {
      if (g.game_id !== snf.game_id) return g;
      const { gameday: _d, ...rest } = g;
      return rest;
    });
    const withdrawn = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, kickoff: null, gameday: "2027-11-15" } : g,
    );
    const rows = diffSchedules(bare, withdrawn, ctx(now));
    expect(rows.map((r) => [r.kind, r.old_value, r.new_value])).toEqual([
      ["kickoff", snf.kickoff, null],
      ["gameday", snf.gameday, "2027-11-15"],
    ]);
    // neither a kickoff nor a date on either side: nothing to compare but the venue
    const blank = before.map((g) =>
      g.game_id === snf.game_id ? { ...g, kickoff: null, gameday: null } : g,
    );
    expect(
      diffSchedules(
        blank,
        blank.map((g) => ({ ...g })),
        ctx(now),
      ),
    ).toEqual([]);
  });

  it("history corrections (old and new kickoff older than 24 h) are ignored", () => {
    const past = before.find((g) => g.week === 3)!;
    const after = flexMove(before, past.game_id, new Date(ms(past.kickoff) + H).toISOString());
    expect(
      diffSchedules(before, after, ctx(ms(past.kickoff) + CHANGE_LOOKBACK_MS + 2 * H)),
    ).toEqual([]);
    expect(diffSchedules(before, after, ctx(ms(past.kickoff) + CHANGE_LOOKBACK_MS)).length).toBe(1);
    const gone = before.filter((g) => g.game_id !== past.game_id);
    expect(diffSchedules(before, gone, ctx(ms(past.kickoff) + 3 * D))).toEqual([]);
    expect(diffSchedules(gone, before, ctx(ms(past.kickoff) + 3 * D))).toEqual([]);
  });

  it("only seasons present in both files are compared; invalid game ids are skipped", () => {
    const two = [...before, ...syntheticSeason({ season: 2028 })];
    expect(diffSchedules(before, two, ctx(now))).toEqual([]);
    expect(diffSchedules(two, before, ctx(now))).toEqual([]);
    const bad = [...before, { ...snf, game_id: "2027_10_<script>" }];
    expect(diffSchedules(before, bad, ctx(now))).toEqual([]);
  });

  it("a game removed or added with no time is reported with a null value", () => {
    const tbd = before.find((g) => g.kickoff === null)!;
    const t = ms(etIso(tbd.gameday ?? "", "00:00")) - 5 * D;
    expect(
      diffSchedules(
        before,
        before.filter((g) => g !== tbd),
        ctx(t),
      ).map((r) => [r.kind, r.old_value]),
    ).toEqual([["removed", null]]);
    expect(
      diffSchedules(
        before.filter((g) => g !== tbd),
        before,
        ctx(t),
      ).map((r) => [r.kind, r.new_value]),
    ).toEqual([["added", null]]);
  });

  it("property: identical files differ in nothing; every value is fixed-vocabulary; rows are sorted", () => {
    fc.assert(
      fc.property(
        arbSeasonOptions,
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 1, max: 20 }),
        (o, pick, shiftH) => {
          const a = syntheticSeason(o);
          expect(diffSchedules(a, a, ctx(Date.UTC(o.season, 8, 1)))).toEqual([]);
          const target = a[pick % a.length]!;
          const base = ms(target.kickoff ?? etIso(target.gameday ?? "", "13:00"));
          const b = flexMove(a, target.game_id, new Date(base + shiftH * H).toISOString());
          const rows = diffSchedules(a, b, ctx(base - 3 * D));
          expect(rows.length).toBeGreaterThan(0);
          for (const r of rows) {
            for (const v of [r.old_value, r.new_value]) if (v !== null) expect(v).toMatch(VALUE_RE);
            expect(r.game_id).toMatch(/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/);
          }
          const sorted = [...rows].sort(
            (x, y) => x.week - y.week || x.game_id.localeCompare(y.game_id),
          );
          expect(rows.map((r) => r.game_id)).toEqual(sorted.map((r) => r.game_id));
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe("changeNotificationText", () => {
  const games = syntheticSeason({ season: 2029, week18Placeholder: true, seed: 2 });
  const snf = sundayNight(games);
  const nowFlex = ms(snf.kickoff) - 10 * D;

  it("one flexed game: NFL abbreviations and Eastern times only", () => {
    const rows = diffSchedules(
      games,
      flexMove(games, snf.game_id, etIso(snf.gameday ?? "", "13:00")),
      ctx(nowFlex),
    );
    expect(changeNotificationText(rows, nowFlex)).toBe(
      `NFL schedule changed: ${snf.away}@${snf.home} Sun 20:20 → Sun 13:00 ET`,
    );
  });

  it("several games: the earliest first, then (+n more)", () => {
    const other = sundayNight(games, 11);
    let after = flexMove(games, snf.game_id, etIso(snf.gameday ?? "", "16:25"));
    after = flexMove(after, other.game_id, etIso(other.gameday ?? "", "13:00"));
    const now = ms(snf.kickoff) - 5 * D; // both games inside the 14-day horizon
    const rows = diffSchedules(games, after, ctx(now));
    expect(changeNotificationText(rows, now)).toBe(
      `NFL schedule changed: ${snf.away}@${snf.home} Sun 20:20 → Sun 16:25 ET (+1 more)`,
    );
    // the later game alone is past the horizon ten days out
    expect(changeNotificationText(rows, ms(snf.kickoff) - 10 * D)).toBe(
      `NFL schedule changed: ${snf.away}@${snf.home} Sun 20:20 → Sun 16:25 ET`,
    );
  });

  it("the final week set from its placeholders collapses to one line", () => {
    const last = lastRegWeekOf(games, 2029);
    const lastK = ms(games.find((g) => g.week === last)?.kickoff ?? null);
    const now = lastK - 9 * D;
    const rows = diffSchedules(games, setWeek18(games), ctx(now));
    const moved = new Set(rows.map((r) => r.game_id)).size;
    expect(moved).toBeGreaterThanOrEqual(WEEK_SET_COLLAPSE);
    expect(changeNotificationText(rows, now)).toBe(
      `Week ${String(last)} schedule set: ${String(moved)} games moved`,
    );
  });

  it("nothing kicking off within 14 days (or only venue/week rows) → null", () => {
    const rows = diffSchedules(
      games,
      flexMove(games, snf.game_id, etIso(snf.gameday ?? "", "13:00")),
      ctx(nowFlex),
    );
    expect(changeNotificationText(rows, nowFlex - 20 * D)).toBeNull();
    expect(changeNotificationText([], nowFlex)).toBeNull();
    const venueOnly: ScheduleChange = {
      ...(rows[0]!),
      kind: "venue",
      old_value: "BUF00",
      new_value: "LON00",
    };
    expect(changeNotificationText([venueOnly], nowFlex)).toBeNull();
  });

  it("added, removed, TBD and date-only rows read plainly", () => {
    const row = (
      kind: ScheduleChange["kind"],
      o: string | null,
      n: string | null,
    ): ScheduleChange => ({
      detected_at: "2029-11-01T00:00:00.000Z",
      release_updated_at: null,
      season: 2029,
      week: 9,
      game_id: "2029_09_CHI_BUF",
      away: "CHI",
      home: "BUF",
      kind,
      old_value: o,
      new_value: n,
    });
    const now = Date.UTC(2029, 10, 1);
    const k = etIso("2029-11-04", "13:00");
    expect(changeNotificationText([row("added", null, k)], now)).toBe(
      "NFL schedule changed: CHI@BUF added Sun 13:00 ET",
    );
    expect(changeNotificationText([row("removed", k, null)], now)).toBe(
      "NFL schedule changed: CHI@BUF removed (was Sun 13:00 ET)",
    );
    expect(changeNotificationText([row("kickoff", null, k)], now)).toBe(
      "NFL schedule changed: CHI@BUF TBD → Sun 13:00 ET",
    );
    expect(changeNotificationText([row("kickoff", k, null)], now)).toBe(
      "NFL schedule changed: CHI@BUF Sun 13:00 → TBD",
    );
    expect(changeNotificationText([row("gameday", "2029-11-04", "2029-11-05")], now)).toBe(
      "NFL schedule changed: CHI@BUF 2029-11-04 → 2029-11-05",
    );
    expect(changeNotificationText([row("gameday", null, "2029-11-05")], now)).toBe(
      "NFL schedule changed: CHI@BUF TBD → 2029-11-05",
    );
    expect(changeNotificationText([row("gameday", "2029-11-05", null)], now)).toBe(
      "NFL schedule changed: CHI@BUF 2029-11-05 → TBD",
    );
    expect(changeNotificationText([row("gameday", "2029-11-05", "<i>soon</i>")], now)).toBe(
      "NFL schedule changed: CHI@BUF 2029-11-05 → TBD",
    );
    // a value that is not an instant is no instant; a kickoff row leads rows that follow it
    expect(changeNotificationText([row("kickoff", "garbage", k)], now)).toBe(
      "NFL schedule changed: CHI@BUF TBD → Sun 13:00 ET",
    );
    expect(
      changeNotificationText([row("kickoff", k, null), row("gameday", "2029-11-04", null)], now),
    ).toBe("NFL schedule changed: CHI@BUF Sun 13:00 → TBD");
    // a game's kickoff row leads its other rows
    expect(
      changeNotificationText(
        [
          row("gameday", "2029-11-03", "2029-11-04"),
          row("kickoff", null, k),
          row("week", "8", "9"),
        ],
        now,
      ),
    ).toBe("NFL schedule changed: CHI@BUF TBD → Sun 13:00 ET");
  });

  it("property: one line, never longer than 200 characters, for any set of changes", () => {
    fc.assert(
      fc.property(
        arbSeasonOptions,
        fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: -30, max: 30 }),
        (o, picks, shiftH) => {
          let after = syntheticSeason(o);
          const before = after;
          for (const p of picks) {
            const g = before[p % before.length]!;
            after = flexMove(
              after,
              g.game_id,
              new Date(ms(g.kickoff ?? etIso(g.gameday ?? "", "13:00")) + shiftH * H).toISOString(),
            );
          }
          const first = Math.min(...after.map((g) => ms(g.kickoff)).filter(Number.isFinite));
          for (const now of [first - 5 * D, first + 60 * D, first + 120 * D]) {
            const text = changeNotificationText(diffSchedules(before, after, ctx(now)), now);
            if (text !== null) {
              expect(text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
              expect(text).not.toContain("\n");
            }
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
