// statline.test.ts — the store's nflverse → canonical translation (plan 08 §3.2 column map, §3.3
// position types; READER_QUERIES["PlayerWeekReader.defenseLines"] DT mapping): sums over present
// components, NULL → absent (never a fabricated 0), `present` sorted and equal to the value keys,
// every mapped canonical name matches the registry grammar.
import { describe, expect, it } from "vitest";
import { CANONICAL_NAME_RE } from "../../src/domain/scoring/types.js";
import { PLAYER_WEEK_STAT_COLUMNS } from "../../src/store/datasets/tables.js";
import {
  DEFENSE_STAT_MAP,
  PLAYER_STAT_MAP,
  defenseRowToStatLine,
  playerRowToStatLine,
  positionTypeOf,
} from "../../src/store/datasets/statline.js";

describe("maps", () => {
  it("every canonical name is well-formed and every source column exists in the contract", () => {
    const cols = new Set(PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name));
    for (const [canon, from] of Object.entries(PLAYER_STAT_MAP)) {
      expect(canon).toMatch(CANONICAL_NAME_RE);
      for (const f of from) expect(cols.has(f), f).toBe(true);
    }
    for (const canon of Object.keys(DEFENSE_STAT_MAP)) expect(canon).toMatch(CANONICAL_NAME_RE);
  });
});

describe("playerRowToStatLine", () => {
  it("sums components, keeps present zeros, omits all-null stats", () => {
    const l = playerRowToStatLine({
      position: "WR",
      position_group: "WR",
      receptions: 7,
      receiving_yards: 0,
      passing_2pt_conversions: null,
      rushing_2pt_conversions: 1,
      receiving_2pt_conversions: 1,
      sack_fumbles_lost: null,
      rushing_fumbles_lost: null,
      receiving_fumbles_lost: null,
      carries: 2n,
    });
    expect(l.values).toEqual({ rec: 7, rec_yd: 0, two_pt: 2, rush_att: 2 });
    expect(l.present).toEqual(["rec", "rec_yd", "rush_att", "two_pt"]);
    expect(l).toMatchObject({ position_type: "O", provisional: false, source: "nflverse" });
  });

  it("FG bins: 50+ = 50–59 + 60+; misses and PATs", () => {
    const l = playerRowToStatLine({
      position: "K",
      fg_made_50_59: 1,
      fg_made_60_: 1,
      fg_missed_40_49: 1,
      pat_made: 4,
      pat_missed: 1,
    });
    expect(l.values).toEqual({ fg_50p: 2, fg_miss_40_49: 1, pat_made: 4, pat_miss: 1 });
    expect(l.position_type).toBe("K");
  });

  it("ignores non-finite and non-numeric values", () => {
    const l = playerRowToStatLine({
      position: "RB",
      rushing_yards: Number.NaN,
      rushing_tds: "3",
      receptions: Number.POSITIVE_INFINITY,
    });
    expect(l.present).toEqual([]);
  });
});

describe("positionTypeOf (plan 08 §3.3)", () => {
  it.each([
    ["QB", null, "O"],
    ["FB", null, "O"],
    ["K", "SPEC", "K"],
    ["PK", null, "K"],
    ["CB", "DB", "D"],
    ["P", "SPEC", "D"],
    [null, "WR", "O"],
    [null, null, "D"],
  ])("%s / %s → %s", (pos, group, want) => {
    expect(positionTypeOf(pos, group)).toBe(want);
  });
});

describe("defenseRowToStatLine", () => {
  it("DT line with points allowed and yards allowed", () => {
    const l = defenseRowToStatLine(
      {
        def_sacks: 3.5,
        def_interceptions: 2,
        fumble_recovery_opp: 1,
        def_tds: 1,
        special_teams_tds: 0,
        def_safeties: 0,
        def_fg_blocks: 1,
        def_punt_blocks: 1,
        def_pat_blocks: 1,
        opp_passing_yards: 300,
        opp_sack_yards_lost: null,
        opp_rushing_yards: 50,
      },
      14,
    );
    expect(l.values).toEqual({
      dst_sack: 3.5,
      dst_int: 2,
      dst_fum_rec: 1,
      dst_td: 1,
      dst_ret_td: 0,
      dst_safety: 0,
      dst_blk: 2,
      dst_pa: 14,
      dst_ya: 350,
    });
    expect(l.position_type).toBe("DT");
  });

  it("no points allowed when not final; no yards allowed without the opponent's rows", () => {
    const l = defenseRowToStatLine(
      { def_sacks: 0, opp_passing_yards: 100, opp_rushing_yards: null },
      null,
    );
    expect(l.present).toEqual(["dst_sack"]);
  });
});
