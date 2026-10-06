// columns.test.ts — `toStatLine(nflverse)` (plan 08 §3.2, §3.3; plan 10 A1a "scores every
// player-week without NaN"): the mapping names real columns, every fixture player-week translates
// with no issue and no NaN, the mapping reproduces nflverse's own PPR points exactly on every
// offensive line of the real 2026 file (an independent check of A-1), and hostile rows never leak a
// non-finite value.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KNOWN_CANONICAL, CANONICAL_NAME_RE } from "../../../src/domain/scoring/types.js";
import {
  MAPPED_STAT_COLUMNS,
  NFLVERSE_STAT_MAP,
  kickDistances,
  pointsAllowedFor,
  positionTypeOf,
  toDefenseStatLine,
  toStatLine,
  translatePlayerWeek,
  unmappedStatColumns,
} from "../../../src/sources/nflverse/columns.js";
import { yardsAllowed } from "../../../src/domain/scoring/nflverse.js";
import { UNMAPPED_PLAYER_WEEK_COLUMNS } from "../../../src/sources/nflverse/index.js";
import { PLAYER_WEEK_STAT_COLUMNS } from "../../../src/store/datasets/tables.js";
import { fixtureRows } from "./helpers/rewrite.js";

const STATS = "stats_player/stats_player_week_2026.parquet";
const roster = (
  await import("../../../fixtures/players/fixture-roster.json", { with: { type: "json" } })
).default as { players: { gsis_id: string; name: string; position: string }[] };
const rows = await fixtureRows(STATS);

describe("the mapping table", () => {
  it("reads only columns ds_player_week stores (so the store's reader can apply it too)", () => {
    const stored = new Set(PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name));
    for (const c of MAPPED_STAT_COLUMNS) expect(stored.has(c), c).toBe(true);
  });

  it("emits well-formed canonical names, each once per position type", () => {
    const seen = new Set<string>();
    for (const m of NFLVERSE_STAT_MAP) {
      expect(m.canonical).toMatch(CANONICAL_NAME_RE);
      for (const pt of m.position_types) {
        expect(seen.has(`${pt}:${m.canonical}`)).toBe(false);
        seen.add(`${pt}:${m.canonical}`);
      }
    }
    const known = new Set<string>(KNOWN_CANONICAL);
    const learned = NFLVERSE_STAT_MAP.filter((m) => !known.has(m.canonical)).map(
      (m) => m.canonical,
    );
    expect(learned.every((c) => c.startsWith("fg_miss_"))).toBe(true); // [U-3] family only
    expect(NFLVERSE_STAT_MAP.some((m) => m.canonical === "off_fum_ret_td")).toBe(false); // pbp only
  });

  it("lists every stored stat column it does not read", () => {
    expect(UNMAPPED_PLAYER_WEEK_COLUMNS).toEqual(
      PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name).filter((c) => !MAPPED_STAT_COLUMNS.includes(c)),
    );
    for (const c of [
      "target_share",
      "wopr",
      "fantasy_points_ppr",
      "fg_made_list",
      "fumble_recovery_tds",
    ]) {
      expect(UNMAPPED_PLAYER_WEEK_COLUMNS).toContain(c);
    }
    expect(unmappedStatColumns([])).toEqual([]);
  });
});

describe("toStatLine over the fixture players (real 2026 weeks 1–3)", () => {
  const ids = new Set(roster.players.map((p) => p.gsis_id));
  const mine = rows.filter((r) => ids.has(r.player_id as string));

  it("covers every fixture player in every week", () => {
    expect(mine).toHaveLength(roster.players.length * 3);
  });

  it("produces no NaN, no issue, and the expected position type", () => {
    for (const r of mine) {
      const t = translatePlayerWeek(r);
      const who = `${String(r.player_display_name)} w${String(r.week)}`;
      expect(t.issues, who).toEqual([]);
      const p = roster.players.find((x) => x.gsis_id === r.player_id);
      expect(t.line.position_type, who).toBe(p?.position === "K" ? "K" : "O");
      for (const v of Object.values(t.line.values)) expect(Number.isFinite(v), who).toBe(true);
      expect(t.line.present).toEqual(Object.keys(t.line.values).sort());
      expect(t.line.source).toBe("nflverse");
      expect(t.line.provisional).toBe(false);
      expect(Object.isFrozen(t.line.values)).toBe(true);
    }
  });

  it("a kicker's FG bins are counts that sum to fg_made; 60+ folds into fg_50p", () => {
    for (const r of mine.filter((x) => x.position === "K")) {
      const l = toStatLine(r);
      const bins = ["fg_0_19", "fg_20_29", "fg_30_39", "fg_40_49", "fg_50p"].map(
        (k) => l.values[k] ?? 0,
      );
      expect(bins.reduce((a, b) => a + b, 0)).toBe(r.fg_made);
      expect(l.values.fg_50p).toBe(Number(r.fg_made_50_59 ?? 0) + Number(r.fg_made_60_ ?? 0));
      expect(kickDistances(r.fg_made_list)).toHaveLength(Number(r.fg_made ?? 0));
      expect(l.values.pass_yd).toBeUndefined(); // O stats are not emitted for K lines
    }
  });

  it("reproduces nflverse's own fantasy_points_ppr on every offensive line of the file", () => {
    let n = 0;
    for (const r of rows) {
      const l = toStatLine(r);
      if (l.position_type !== "O") continue;
      const g = (k: string): number => l.values[k] ?? 0;
      const ppr =
        0.04 * g("pass_yd") +
        4 * g("pass_td") -
        2 * g("pass_int") +
        0.1 * g("rush_yd") +
        6 * g("rush_td") +
        g("rec") +
        0.1 * g("rec_yd") +
        6 * g("rec_td") +
        2 * g("two_pt") -
        2 * g("fum_lost") +
        6 * g("ret_td_off");
      expect(
        Math.abs(ppr - Number(r.fantasy_points_ppr ?? 0)),
        String(r.player_display_name),
      ).toBeLessThan(0.01);
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it("flags only the expected non-fantasy rows across the whole file", () => {
    const kinds = new Set<string>();
    for (const r of rows) for (const i of translatePlayerWeek(r).issues) kinds.add(i.issue);
    expect([...kinds].sort()).toEqual([
      "IDP line: no canonical mapping (plan 08 §3.1 [U-5])",
      "non-fantasy position LS → O",
      "non-fantasy position P → O",
      "position unknown → O",
    ]);
  });
});

describe("translation rules", () => {
  it("null is absent, 0 is present; a sum is present when any part is", () => {
    const l = toStatLine({
      position: "RB",
      position_group: "RB",
      rushing_yards: 0,
      rushing_tds: null,
      rushing_2pt_conversions: 1,
    });
    expect(l.values).toEqual({ rush_yd: 0, two_pt: 1 });
    expect(l.present).toEqual(["rush_yd", "two_pt"]);
  });

  it("negative yards are legitimate; a negative or fractional count is flagged but kept finite", () => {
    const t = translatePlayerWeek({
      position: "WR",
      rushing_yards: -7,
      receptions: -1,
      targets: 2.5,
    });
    expect(t.line.values.rush_yd).toBe(-7);
    expect(t.issues).toEqual([
      { column: "targets", issue: "count is 2.5" },
      { column: "receptions", issue: "count is -1" },
    ]);
  });

  it("non-numeric and non-finite values never reach the line", () => {
    const t = translatePlayerWeek({
      position: "QB",
      passing_yards: "300",
      passing_tds: Number.NaN,
      passing_interceptions: Infinity,
      carries: 2n,
      rushing_yards: 2n ** 60n,
      receptions: {},
    });
    expect(t.line.values).toEqual({ rush_att: 2 });
    expect(t.issues.map((i) => i.column).sort()).toEqual([
      "passing_interceptions",
      "passing_tds",
      "passing_yards",
      "receptions",
      "rushing_yards",
    ]);
  });

  it("position types: K, O, D, and the non-fantasy fallbacks", () => {
    expect(positionTypeOf("K", "SPEC")).toEqual({ type: "K", issue: null });
    expect(positionTypeOf(" qb ", null)).toEqual({ type: "O", issue: null });
    expect(positionTypeOf("FB", "RB")).toEqual({ type: "O", issue: null });
    expect(positionTypeOf("FB", null)).toEqual({ type: "O", issue: null });
    expect(positionTypeOf("OT", "OL")).toEqual({ type: "O", issue: null });
    expect(positionTypeOf("CB", "DB")).toEqual({ type: "D", issue: null });
    expect(positionTypeOf("P", "SPEC")).toEqual({ type: "O", issue: "non-fantasy position P → O" });
    expect(positionTypeOf(null, undefined)).toEqual({ type: "O", issue: "position unknown → O" });
    const idp = translatePlayerWeek({ position: "LB", position_group: "LB", def_sacks: 2 });
    expect(idp.line.position_type).toBe("D");
    expect(idp.line.present).toEqual([]);
    const forced = translatePlayerWeek(
      { position: "P", fg_made_40_49: 1 },
      { positionType: "K", provisional: true },
    );
    expect(forced.issues).toEqual([]);
    expect(forced.line.values).toEqual({ fg_40_49: 1 });
    expect(forced.line.provisional).toBe(true);
  });

  it("property: any row of arbitrary values yields a NaN-free line whose present = sorted keys", () => {
    const value = fc.oneof(
      fc.constant(null),
      fc.integer({ min: -100, max: 1000 }),
      fc.double(),
      fc.string({ maxLength: 4 }),
      fc.bigInt({ min: -(2n ** 64n), max: 2n ** 64n }),
      fc.constant(undefined),
    );
    const col = fc.constantFrom(...MAPPED_STAT_COLUMNS, "position", "junk");
    fc.assert(
      fc.property(
        fc.dictionary(col, value, { maxKeys: 30 }),
        fc.constantFrom("QB", "K", "LB", "P", ""),
        (row, pos) => {
          const l = toStatLine({ ...row, position: pos });
          return (
            Object.values(l.values).every((v) => Number.isFinite(v)) &&
            JSON.stringify(l.present) === JSON.stringify(Object.keys(l.values).sort())
          );
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe("team defence (DT) lines", () => {
  const row = {
    def_sacks: 3.5,
    def_interceptions: 1,
    fumble_recovery_opp: 2,
    def_tds: 1,
    special_teams_tds: 0,
    def_safeties: 0,
    def_fg_blocks: 1,
    def_punt_blocks: 0,
    def_pat_blocks: 1,
    opp_passing_yards: 250,
    opp_sack_yards_lost: 20,
    opp_rushing_yards: 90,
  };

  it("maps the reader contract's columns; dst_ya = pass − sack yards + rush; half sacks are fine", () => {
    const t = toDefenseStatLine(row, { pointsAllowed: 17 });
    expect(t.issues).toEqual([]);
    expect(t.line.position_type).toBe("DT");
    expect(t.line.values).toEqual({
      dst_sack: 3.5,
      dst_int: 1,
      dst_fum_rec: 2,
      dst_td: 1,
      dst_ret_td: 0,
      dst_safety: 0,
      dst_blk: 1,
      dst_pa: 17,
      dst_ya: 320,
    });
    expect(toDefenseStatLine(row, { includePatBlocks: true }).line.values.dst_blk).toBe(2);
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
          const t = toDefenseStatLine({
            ...row,
            opp_passing_yards: pass,
            opp_sack_yards_lost: signed,
            opp_rushing_yards: rush,
          });
          expect(t.issues).toEqual([]);
          expect(t.line.values.dst_ya).toBe(pass - lost + rush);
          expect(t.line.values.dst_ya).toBe(yardsAllowed(pass, signed, rush));
          expect(t.line.values.dst_ya).toBeLessThanOrEqual(pass + rush);
        },
      ),
    );
  });

  it("no points allowed / missing opponent yardage → those stats are absent", () => {
    const l = toDefenseStatLine({ ...row, opp_rushing_yards: null }).line;
    expect(l.values.dst_pa).toBeUndefined();
    expect(l.values.dst_ya).toBeUndefined();
    expect(
      toDefenseStatLine(row, { pointsAllowed: Number.NaN }).line.values.dst_pa,
    ).toBeUndefined();
    expect(
      toDefenseStatLine(row, { pointsAllowed: null, provisional: true }).line.provisional,
    ).toBe(true);
  });

  it("pointsAllowedFor picks the opponent's score, and only from a final game", () => {
    const g = { away_team: "DET", home_team: "GB", away_score: 27, home_score: 20 };
    expect(pointsAllowedFor("DET", g)).toBe(20);
    expect(pointsAllowedFor("GB", g)).toBe(27);
    expect(pointsAllowedFor("SEA", g)).toBeNull();
    expect(pointsAllowedFor("DET", { ...g, home_score: null })).toBeNull();
    expect(pointsAllowedFor("DET", { ...g, away_score: "27" })).toBeNull();
  });
});

describe("kickDistances", () => {
  it("parses nflverse's `;` lists and skips junk", () => {
    expect(kickDistances("51;43")).toEqual([51, 43]);
    expect(kickDistances(" 22 ; 60;")).toEqual([22, 60]);
    expect(kickDistances("0;100;-5;4x;;3.5;33")).toEqual([33]);
    for (const v of [null, undefined, 42, "", "1;".repeat(300)])
      expect(kickDistances(v)).toEqual([]);
  });

  it("property: never throws, only integers 1–99", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) =>
        kickDistances(s).every((n) => Number.isInteger(n) && n >= 1 && n <= 99),
      ),
    );
  });
});
