// qa2-032-dst-ya.test.ts — [QA-2-032] the store's DT translator computes yards allowed as the
// opponent's NET yards: gross passing − the yards lost on sacks + rushing, the loss taken as a
// magnitude (nflverse stores `sack_yards_lost` negative). Every dst_ya translator goes through the
// scoring domain's `yardsAllowed()`, so the store, the sources and the backtest agree on every row.
// End to end: a ds_team_defense_week row published to a dataset file → PlayerWeekReader.defenseLines
// → the league's yards-allowed bracket → points. A file of the layout that may hold the signed
// value (ds_schema 2, written before the sign was fixed) is refused, so `ff refresh` republishes it.
import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { score, statLineFromTeamDefense, yardsAllowed } from "../../src/domain/scoring/index.js";
import { buildScoringSettings } from "../../src/providers/manual/scoring.js";
import { DS_TEAM_DEFENSE_WEEK } from "../../src/store/datasets/tables.js";
import { defenseRowToStatLine } from "../../src/store/datasets/statline.js";
import type { DatasetPublisher, Store } from "../../src/store/types.js";
import { SEASON, playerWeekRows, publishTables, row } from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

const DEFENSE_ROW = {
  def_sacks: 2,
  def_interceptions: 0,
  fumble_recovery_opp: 0,
  def_tds: 0,
  fumble_recovery_tds_opp: 0,
  special_teams_tds: 0,
  def_safeties: 0,
  def_fg_blocks: 0,
  def_punt_blocks: 0,
  def_pat_blocks: 0,
};

describe("[QA-2-032] defenseRowToStatLine: dst_ya is net yards whatever sign the stored sack yardage has", () => {
  it("property: pass − |sack| + rush, never above gross, the same as the domain translator", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 700 }),
        fc.integer({ min: 1, max: 120 }),
        fc.integer({ min: -30, max: 400 }),
        fc.boolean(),
        (pass, lost, rush, negative) => {
          const signed = negative ? -lost : lost;
          const r = {
            ...DEFENSE_ROW,
            opp_passing_yards: pass,
            opp_sack_yards_lost: signed,
            opp_rushing_yards: rush,
          };
          const ya = defenseRowToStatLine(r, 13).values.dst_ya;
          expect(ya).toBe(pass - lost + rush);
          expect(ya).toBe(yardsAllowed(pass, signed, rush));
          // a sack never adds yards
          expect(ya).toBeLessThan(pass + rush + 1);
          // one formula across translators: store and domain read the same row the same way
          expect(ya).toBe(statLineFromTeamDefense(r, { pointsAllowed: 13 }).values.dst_ya);
          // the sign the row was stored with does not change the answer
          expect(ya).toBe(
            defenseRowToStatLine({ ...r, opp_sack_yards_lost: -signed }, 13).values.dst_ya,
          );
        },
      ),
    );
  });

  it("the upstream shape: PIT 2026 week 1 — 143 gross passing, 4 sacks for −25, 120 rushing → 238", () => {
    const l = defenseRowToStatLine(
      {
        ...DEFENSE_ROW,
        opp_passing_yards: 143,
        opp_sack_yards_lost: -25,
        opp_rushing_yards: 120,
      },
      13,
    );
    expect(l.values.dst_ya).toBe(238);
  });
});

describe("[QA-2-032] end to end: a stored team-defence row → defenseLines → the yards-allowed bracket → points", () => {
  let t: TempCache;
  let pub: DatasetPublisher;
  let s: Store | null;
  beforeEach(() => {
    t = tempCache();
    pub = openPublisher(t);
    s = null;
  });
  afterEach(() => {
    s?.close();
    pub.close();
    t.cleanup();
  });

  // 250 gross passing, 30 yards lost on sacks, 60 rushing: net 280 (the 200–299 bracket). Adding
  // the stored negative instead of subtracting the loss reads 340 (the 300–399 bracket).
  const BRACKETS = {
    dst_ya_0_99: 5,
    dst_ya_100_199: 3,
    dst_ya_200_299: 2,
    dst_ya_300_399: -1,
    dst_ya_400_499: -3,
    dst_ya_500p: -5,
  };
  const settings = buildScoringSettings({ preset: "half_ppr", overrides: BRACKETS });

  it.each([
    ["stored negative (nflverse's sign)", -30],
    ["stored as the magnitude", 30],
  ])("%s: dst_ya 280 scores the 200–299 bracket", async (_label, stored) => {
    const [players] = playerWeekRows([1]);
    if (players === undefined) throw new Error("fixture");
    await publishTables(pub, "nflverse:stats_player_week", "v1", [
      players,
      {
        spec: DS_TEAM_DEFENSE_WEEK,
        rows: [
          row(DS_TEAM_DEFENSE_WEEK, {
            ...DEFENSE_ROW,
            season: SEASON,
            week: 1,
            season_type: "REG",
            team: "PIT",
            opponent_team: "ATL",
            game_id: "2026_01_PIT_ATL",
            opp_passing_yards: 250,
            opp_sack_yards_lost: stored,
            opp_rushing_yards: 60,
            player_rows: 22,
          }),
        ],
      },
    ]);
    s = openStore(t);
    const out = s.datasets.playerWeeks.defenseLines(["PIT"], SEASON, [1]);
    expect(out.stamp).not.toBeNull();
    const line = out.rows.find((r) => r.nfl_team === "PIT")?.line;
    if (line === undefined) throw new Error("no PIT line");
    expect(line.values.dst_ya).toBe(280);
    const ya = score(line, settings).contributions.filter((c) => c.canonical.startsWith("dst_ya"));
    expect(ya.map((c) => [c.canonical, c.points])).toEqual([["dst_ya_200_299", 2]]);
  });
});

describe("[QA-2-032] a dataset file of the layout before the sign fix is refused", () => {
  let t: TempCache;
  let pub: DatasetPublisher;
  let s: Store | null;
  const warnings: string[] = [];
  beforeEach(() => {
    t = tempCache();
    pub = openPublisher(t);
    s = null;
    warnings.length = 0;
  });
  afterEach(() => {
    s?.close();
    pub.close();
    t.cleanup();
  });

  it("a stats file stamped ds_schema 2 (opp_sack_yards_lost may be upstream's negative) is never served", async () => {
    await publishTables(pub, "nflverse:stats_player_week", "v1", playerWeekRows([1]));
    const db = new DatabaseSync(`${t.datasetDir}/nflverse__stats_player_week.sqlite`);
    db.exec("UPDATE dataset_meta SET value = '2' WHERE key = 'ds_schema'");
    db.close();
    s = openStore(t, { onWarning: (c) => warnings.push(c) });
    expect(s.datasets.playerWeeks.defenseLines(["MIA"], SEASON, [1])).toEqual({
      rows: [],
      stamp: null,
    });
    expect(warnings).toContain("dataset_schema_mismatch");
  });

  it("control: the same file in this binary's layout serves its rows", async () => {
    await publishTables(pub, "nflverse:stats_player_week", "v1", playerWeekRows([1]));
    s = openStore(t, { onWarning: (c) => warnings.push(c) });
    expect(s.datasets.playerWeeks.defenseLines(["MIA"], SEASON, [1]).rows).toHaveLength(1);
    expect(warnings).not.toContain("dataset_schema_mismatch");
  });
});
