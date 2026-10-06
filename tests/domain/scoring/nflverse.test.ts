// nflverse.test.ts — src/domain/scoring/nflverse.ts: `toStatLine(nflverse)` (plan 08 §3.2, A-1 column
// names asserted against the store's dataset contract), the DT line, kick lists → league bins (§4.1).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { score } from "../../../src/domain/scoring/engine.js";
import { ScoringError } from "../../../src/domain/scoring/errors.js";
import {
  defensiveFumbleReturnTds,
  DST_FUMBLE_RETURN_TD_COLUMN,
  DST_TD_COLUMNS,
  makeStatLine,
  NFLVERSE_PLAYER_COLUMNS,
  parseKickList,
  positionTypeForLeaguePosition,
  positionTypeForNflPosition,
  rebinKickLine,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
  withPositionType,
  yardsAllowed,
} from "../../../src/domain/scoring/nflverse.js";
import { normalizeSettings } from "../../../src/domain/scoring/settings.js";
import {
  DS_TEAM_DEFENSE_WEEK,
  PLAYER_WEEK_STAT_COLUMNS,
} from "../../../src/store/datasets/tables.js";
import { sampleSettings } from "./fixtures.js";

const S = sampleSettings();

describe("column map (A-1)", () => {
  it("every nflverse column the translator reads is in ds_player_week's stat columns", () => {
    const cols = new Set(PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name));
    for (const [canonical, sources] of Object.entries(NFLVERSE_PLAYER_COLUMNS)) {
      for (const s of sources)
        expect({ canonical, s, ok: cols.has(s) }).toEqual({ canonical, s, ok: true });
    }
  });

  it("every team-defence column the DT line reads is in ds_team_defense_week", () => {
    const cols = new Set(DS_TEAM_DEFENSE_WEEK.columns.map((c) => c.name));
    for (const c of [
      "def_sacks",
      "def_interceptions",
      "fumble_recovery_opp",
      "def_tds",
      "special_teams_tds",
      "def_safeties",
      "def_fg_blocks",
      "def_punt_blocks",
      "def_pat_blocks",
      "opp_passing_yards",
      "opp_sack_yards_lost",
      "opp_rushing_yards",
      ...DST_TD_COLUMNS, // QA-1-017: the fumble-return TD column must exist, or dst_td loses it
    ]) {
      expect({ c, ok: cols.has(c) }).toEqual({ c, ok: true });
    }
  });
});

describe("positionTypeForNflPosition", () => {
  it.each([
    ["QB", "O"],
    ["rb", "O"],
    [" WR ", "O"],
    ["TE", "O"],
    ["FB", "O"],
    ["K", "K"],
    ["PK", "K"],
    ["CB", "D"],
    ["SAF", "D"],
    ["OLB", "D"],
    ["DT", "D"],
    ["P", null],
    ["LS", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s → %s", (pos, pt) => {
    expect(positionTypeForNflPosition(pos)).toBe(pt);
  });
});

describe("positionTypeForLeaguePosition (QA-1-018: the league's position types the line)", () => {
  it.each([
    ["QB", "O"],
    [" wr ", "O"],
    ["RB", "O"],
    ["TE", "O"],
    ["K", "K"],
    ["DEF", "DT"],
    ["def", "DT"],
    ["DST", "DT"],
    ["D/ST", "DT"],
    ["D", "D"],
    ["DT", "D"], // the IDP defensive tackle, not the team defence
    ["CB", "D"],
    ["LB", "D"],
    ["W/R/T", null], // a slot, not a position
    ["BN", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("%s → %s", (pos, pt) => {
    expect(positionTypeForLeaguePosition(pos)).toBe(pt);
  });
});

describe("QA-1-018: a two-way player the league lists as a WR scores his offence", () => {
  // Travis Hunter, 2026 week 1 as nflverse ships it: position CB (group DB), 1 rec for 8 yds and
  // 1 carry for 3 yds. Typed from nflverse's position the line is D and every stat is ignored.
  const hunter = {
    player_id: "00-0040718",
    position: "CB",
    position_group: "DB",
    receptions: 1,
    targets: 2,
    receiving_yards: 8,
    carries: 1,
    rushing_yards: 3,
    receiving_tds: 0,
  };

  it("typed by the league position (WR → O) it scores 0.5 + 0.8 + 0.3 = 1.6, not 0", () => {
    const pt = positionTypeForLeaguePosition("WR");
    expect(pt).toBe("O");
    if (pt === null) return;
    const asNflverse = statLineFromPlayerWeek(hunter);
    expect(asNflverse.position_type).toBe("D");
    expect(score(asNflverse, S).points).toBe(0);
    expect(score(asNflverse, S).ignored).toEqual(expect.arrayContaining(["rec", "rec_yd"]));
    const retyped = withPositionType(asNflverse, pt);
    expect(score(retyped, S).points).toBe(1.6);
    expect(score(statLineFromPlayerWeek(hunter, { positionType: pt }), S).points).toBe(1.6);
  });

  it("withPositionType keeps values, labels and frozenness; only the type changes", () => {
    const base = statLineFromPlayerWeek(hunter, { provisional: true, source: "nflverse:x" });
    const l = withPositionType(base, "O");
    expect(l.values).toEqual(base.values);
    expect(l.present).toEqual(base.present);
    expect(l).toMatchObject({ position_type: "O", provisional: true, source: "nflverse:x" });
    expect(Object.isFrozen(l) && Object.isFrozen(l.values)).toBe(true);
    expect(base.position_type).toBe("D"); // the input is not mutated
    expect(() => withPositionType(base, "QB" as "O")).toThrow(ScoringError);
  });
});

describe("statLineFromPlayerWeek", () => {
  const allen = {
    player_id: "00-0034857",
    player_display_name: "Josh Allen",
    position: "QB",
    season: 2026,
    week: 2,
    passing_yards: 262,
    passing_tds: 2,
    passing_interceptions: 1,
    carries: 8,
    rushing_yards: 45n,
    rushing_tds: 1,
    sack_fumbles_lost: 1,
    rushing_fumbles_lost: null,
    receiving_fumbles_lost: null,
    passing_2pt_conversions: 0,
    rushing_2pt_conversions: "1",
    receiving_2pt_conversions: null,
    receptions: null,
    targets: null,
    special_teams_tds: 0,
    fg_made_0_19: null,
    fantasy_points: 27.18,
  };

  it("maps and sums columns; null columns are absent, a present 0 stays", () => {
    const l = statLineFromPlayerWeek(allen);
    expect(l.position_type).toBe("O");
    expect(l.values).toEqual({
      pass_yd: 262,
      pass_td: 2,
      pass_int: 1,
      rush_att: 8,
      rush_yd: 45,
      rush_td: 1,
      fum_lost: 1,
      two_pt: 1,
      ret_td_off: 0,
    });
    expect(l.present).toEqual(Object.keys(l.values).sort());
    expect(l).toMatchObject({ provisional: false, source: "nflverse" });
    expect(Object.isFrozen(l) && Object.isFrozen(l.values)).toBe(true);
    // 10.48 + 8 - 1 + 4.5 + 6 - 2 + 2 = 27.98
    expect(score(l, S).points).toBe(27.98);
  });

  it("takes an explicit position type and labels", () => {
    const l = statLineFromPlayerWeek(
      { position: "P", pat_made: 1 },
      { positionType: "K", provisional: true, source: "nflverse:test" },
    );
    expect(l).toMatchObject({
      position_type: "K",
      provisional: true,
      source: "nflverse:test",
      values: { pat_made: 1 },
    });
  });

  it("sums FG 50+ from the 50-59 and 60+ columns", () => {
    const l = statLineFromPlayerWeek({
      position: "K",
      fg_made_50_59: 1,
      fg_made_60_: 1,
      fg_made_40_49: 0,
    });
    expect(l.values).toMatchObject({ fg_50p: 2, fg_40_49: 0 });
    expect(score(l, S).points).toBe(10);
  });

  it("refuses a row with no fantasy position; unparseable values are not present", () => {
    expect(() => statLineFromPlayerWeek({ position: "LS", passing_yards: 1 })).toThrow(
      ScoringError,
    );
    const l = statLineFromPlayerWeek({
      position: "WR",
      receptions: "",
      receiving_yards: "1e2",
      targets: NaN,
      receiving_tds: {},
    });
    expect(l.values).toEqual({});
    const proto = statLineFromPlayerWeek(
      JSON.parse('{"position":"WR","__proto__":{"receptions":5}}') as Record<string, unknown>,
    );
    expect(proto.values).toEqual({});
  });
});

describe("statLineFromTeamDefense", () => {
  const row = {
    team: "DET",
    def_sacks: 2.5,
    def_interceptions: 2,
    fumble_recovery_opp: 0,
    def_tds: 1,
    special_teams_tds: 1,
    def_safeties: 1,
    def_fg_blocks: 1,
    def_punt_blocks: 0,
    def_pat_blocks: 1,
    opp_passing_yards: 180,
    opp_sack_yards_lost: null,
    opp_rushing_yards: 70,
  };

  it("maps every field; PAT blocks only on request; yards allowed net of sacks", () => {
    const l = statLineFromTeamDefense(row, { pointsAllowed: 13 });
    expect(l.values).toEqual({
      dst_sack: 2.5,
      dst_int: 2,
      dst_fum_rec: 0,
      dst_td: 1,
      dst_ret_td: 1,
      dst_safety: 1,
      dst_blk: 1,
      dst_pa: 13,
      dst_ya: 250,
    });
    expect(l.position_type).toBe("DT");
    expect(
      statLineFromTeamDefense(row, { pointsAllowed: 13, includePatBlocks: true }).values.dst_blk,
    ).toBe(2);
    expect(
      statLineFromTeamDefense({ ...row, opp_sack_yards_lost: 15 }, { pointsAllowed: 13 }).values
        .dst_ya,
    ).toBe(235);
    // 2.5 + 4 + 0 + 6 + 6 + 2 + 2 + 4 (7-13) = 26.5
    expect(score(l, S).points).toBe(26.5);
  });

  it("QA-2-032: dst_ya is net yards whatever sign the sack yardage carries (nflverse stores it negative)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 700 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: -30, max: 400 }),
        fc.boolean(),
        (pass, lost, rush, negative) => {
          const signed = negative ? -lost : lost;
          const ya = statLineFromTeamDefense(
            {
              ...row,
              opp_passing_yards: pass,
              opp_sack_yards_lost: signed,
              opp_rushing_yards: rush,
            },
            { pointsAllowed: 13 },
          ).values.dst_ya;
          expect(ya).toBe(pass - lost + rush);
          expect(ya).toBe(yardsAllowed(pass, signed, rush));
          // a sack never adds yards: net ≤ gross
          expect(ya).toBeLessThanOrEqual(pass + rush);
        },
      ),
    );
    // the upstream shape: PIT 2026 week 1 allowed ATL 143 gross passing, 4 sacks for −25, 120 rushing
    expect(
      statLineFromTeamDefense(
        { ...row, opp_passing_yards: 143, opp_sack_yards_lost: -25, opp_rushing_yards: 120 },
        { pointsAllowed: 13 },
      ).values.dst_ya,
    ).toBe(238);
  });

  it("QA-1-017: a fumble-return TD is a defensive TD (dst_td = def_tds + fumble-return TDs)", () => {
    // CIN 2026 week 1: 4 sacks, 4 opponent fumble recoveries, one returned 27 yds for a TD
    // (nflverse: fumble_recovery_tds = 1, def_tds = 0), 27 points allowed.
    const cin = {
      def_sacks: 4,
      def_interceptions: 0,
      fumble_recovery_opp: 4,
      def_tds: 0,
      [DST_FUMBLE_RETURN_TD_COLUMN]: 1,
      special_teams_tds: 0,
      def_safeties: 0,
      def_fg_blocks: 0,
      def_punt_blocks: 0,
    };
    const l = statLineFromTeamDefense(cin, { pointsAllowed: 27 });
    expect(l.values.dst_td).toBe(1);
    // 4 sacks + 4 × 2 fumble recoveries + 6 TD + PA 27 → 0 = 18 (was 12 without the TD)
    expect(score(l, S).points).toBe(18);
    // an interception-return TD and a fumble-return TD in one game are two TDs
    expect(
      statLineFromTeamDefense({ ...cin, def_tds: 1 }, { pointsAllowed: 27 }).values.dst_td,
    ).toBe(2);
    // a row without the column (an older publish) still reads def_tds; neither → absent
    expect(statLineFromTeamDefense({ def_tds: 1 }, { pointsAllowed: 7 }).values.dst_td).toBe(1);
    expect(
      statLineFromTeamDefense({ [DST_FUMBLE_RETURN_TD_COLUMN]: 1 }, { pointsAllowed: 7 }).values
        .dst_td,
    ).toBe(1);
    expect(
      statLineFromTeamDefense({ def_sacks: 1 }, { pointsAllowed: 7 }).values,
    ).not.toHaveProperty("dst_td");
  });

  it("a game without a final score has no dst_pa; missing yardage leaves dst_ya absent", () => {
    const l = statLineFromTeamDefense(
      { ...row, opp_rushing_yards: null },
      { pointsAllowed: null, provisional: true },
    );
    expect(l.values).not.toHaveProperty("dst_pa");
    expect(l.values).not.toHaveProperty("dst_ya");
    expect(score(l, S).complete).toBe(false);
    expect(
      statLineFromTeamDefense({ ...row, opp_passing_yards: null }, { pointsAllowed: 0 }).values,
    ).not.toHaveProperty("dst_ya");
    expect(statLineFromTeamDefense({}, { pointsAllowed: NaN }).values).toEqual({});
  });
});

describe("defensiveFumbleReturnTds (QA-1-017: one player row's defensive fumble-return TDs)", () => {
  it.each<[string, Record<string, unknown>, number]>([
    [
      "a defender's opponent-fumble return TD (nflverse: def_tds 0)",
      { fumble_recovery_opp: 1, fumble_recovery_tds: 1, def_tds: 0 },
      1,
    ],
    [
      "an offence recovering its own fumble in the end zone",
      { fumble_recovery_own: 1, fumble_recovery_opp: 0, fumble_recovery_tds: 1 },
      0,
    ],
    ["a recovery without a TD", { fumble_recovery_opp: 2, fumble_recovery_tds: 0 }, 0],
    ["TDs capped at opponent recoveries", { fumble_recovery_opp: 1, fumble_recovery_tds: 2 }, 1],
    ["two returned recoveries", { fumble_recovery_opp: 2, fumble_recovery_tds: 2 }, 2],
    [
      "own and opponent recoveries with a TD (credited to the defence)",
      { fumble_recovery_own: 1, fumble_recovery_opp: 1, fumble_recovery_tds: 1 },
      1,
    ],
    ["bigint columns", { fumble_recovery_opp: 1n, fumble_recovery_tds: 1n }, 1],
    ["nulls", { fumble_recovery_opp: null, fumble_recovery_tds: null }, 0],
    ["absent columns", {}, 0],
    ["NaN", { fumble_recovery_opp: NaN, fumble_recovery_tds: 1 }, 0],
    ["Infinity", { fumble_recovery_opp: 1, fumble_recovery_tds: Infinity }, 0],
    ["negative", { fumble_recovery_opp: -1, fumble_recovery_tds: 1 }, 0],
    ["negative TDs", { fumble_recovery_opp: 1, fumble_recovery_tds: -1 }, 0],
    ["garbage strings", { fumble_recovery_opp: "x", fumble_recovery_tds: {} }, 0],
  ])("%s", (_, row, n) => {
    expect(defensiveFumbleReturnTds(row)).toBe(n);
  });

  it("an inherited (prototype) column is not read", () => {
    const row = JSON.parse(
      '{"__proto__":{"fumble_recovery_opp":1,"fumble_recovery_tds":1}}',
    ) as Record<string, unknown>;
    expect(defensiveFumbleReturnTds(row)).toBe(0);
  });
});

describe("makeStatLine", () => {
  it("drops null/undefined, sorts present, defaults labels", () => {
    const l = makeStatLine({ b: 1, a: 0, c: null, d: undefined }, "O");
    expect(l).toEqual({
      values: { b: 1, a: 0 },
      present: ["a", "b"],
      position_type: "O",
      provisional: false,
      source: "nflverse",
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["bad name", { "Pass Yds": 1 }, "O"],
    ["NaN", { a: NaN }, "O"],
    ["absurd", { a: 1e12 }, "O"],
    ["numeric string", { a: "3" }, "O"],
    ["unknown position type", { a: 1 }, "QB"],
  ])("refuses %s", (_, values, pt) => {
    expect(() => makeStatLine(values as Record<string, number>, pt as "O")).toThrow(ScoringError);
  });
});

describe("parseKickList / rebinKickLine (plan 08 §4.1)", () => {
  it("parses nflverse kick lists", () => {
    expect(parseKickList("51;43")).toEqual([51, 43]);
    expect(parseKickList(" 20 ; 0 ;120")).toEqual([20, 0, 120]);
    expect(parseKickList("")).toEqual([]);
    expect(parseKickList("  ")).toEqual([]);
    expect(parseKickList(null)).toEqual([]);
    expect(parseKickList(undefined)).toEqual([]);
  });

  it.each([["51;;43"], ["51;x"], ["45.5"], ["-3"], ["121"], ["1e2"], [`${"40;".repeat(200)}40`]])(
    "refuses %s",
    (list) => {
      expect(() => parseKickList(list)).toThrow(ScoringError);
    },
  );

  const custom = normalizeSettings({
    platform: "manual",
    uses_fractional_points: true,
    uses_negative_points: true,
    rules: [
      { platform_id: "1", name: "Field Goals 0-29 Yards", position_types: ["K"], modifier: 3 },
      { platform_id: "2", name: "Field Goals 30-39 Yards", position_types: ["K"], modifier: 3 },
      { platform_id: "3", name: "Field Goals 40+ Yards", position_types: ["K"], modifier: 5 },
      {
        platform_id: "4",
        name: "Field Goals Missed 0-39 Yards",
        position_types: ["K"],
        modifier: -2,
      },
      {
        platform_id: "5",
        name: "Field Goals Missed 40+ Yards",
        position_types: ["K"],
        modifier: -1,
      },
      { platform_id: "6", name: "Point After Attempt Made", position_types: ["K"], modifier: 1 },
    ],
  });

  it("re-bins made and missed kicks to the league's own bins, replacing nflverse's", () => {
    const nfl = statLineFromPlayerWeek({
      position: "K",
      fg_made_20_29: 1,
      fg_made_50_59: 1,
      fg_missed_30_39: 1,
      pat_made: 2,
    });
    expect(score(nfl, custom).points).toBe(2); // nflverse bins do not exist in this league
    const l = rebinKickLine(nfl, custom, "25;52", "33");
    expect(l.values).toEqual({
      fg_0_29: 1,
      fg_30_39: 0,
      fg_40p: 1,
      fg_miss_0_39: 1,
      fg_miss_40p: 0,
      pat_made: 2,
    });
    expect(score(l, custom).points).toBe(3 + 5 - 2 + 2);
    expect(rebinKickLine(nfl, custom, "", null).values).toMatchObject({
      fg_0_29: 0,
      fg_40p: 0,
      fg_miss_30_39: 1,
    });
  });

  it("leaves the line alone when lists are null or the league has no such family", () => {
    const nfl = statLineFromPlayerWeek(
      { position: "K", fg_made_40_49: 1 },
      { provisional: true, source: "x" },
    );
    expect(rebinKickLine(nfl, custom, null, null)).toEqual(nfl);
    const std = rebinKickLine(nfl, S, "44", "33");
    expect(std.values).toEqual({ fg_0_19: 0, fg_20_29: 0, fg_30_39: 0, fg_40_49: 1, fg_50p: 0 });
    expect(std).toMatchObject({ provisional: true, source: "x" });
  });
});
