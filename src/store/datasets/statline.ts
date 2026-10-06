// statline.ts — `toStatLine(nflverse)` for the store's PlayerWeekReader (plan 08 §3.2 column map,
// §3.3 position types) and the team-defence DT line (READER_QUERIES["PlayerWeekReader.defenseLines"]
// mapping). Lives in src/store because the store may not import src/sources (plan 01 §1.1): the
// plan names src/sources/nflverse/columns.ts, which the store cannot reach.
import { DST_TD_COLUMNS, yardsAllowed } from "../../domain/scoring/nflverse.js";
import type { Canonical, PositionType, StatLine } from "../../domain/scoring/types.js";

/** A row as SQLite returns it. */
export type SqlRow = Readonly<Record<string, unknown>>;

/** canonical ← the SUM of these ds_player_week columns (present when any is non-null). */
export const PLAYER_STAT_MAP: Readonly<Record<Canonical, readonly string[]>> = Object.freeze({
  pass_yd: ["passing_yards"],
  pass_td: ["passing_tds"],
  pass_int: ["passing_interceptions"],
  pass_1d: ["passing_first_downs"],
  rush_att: ["carries"],
  rush_yd: ["rushing_yards"],
  rush_td: ["rushing_tds"],
  rush_1d: ["rushing_first_downs"],
  targets: ["targets"],
  rec: ["receptions"],
  rec_yd: ["receiving_yards"],
  rec_td: ["receiving_tds"],
  rec_1d: ["receiving_first_downs"],
  two_pt: ["passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions"],
  fum_lost: ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"],
  fum: ["sack_fumbles", "rushing_fumbles", "receiving_fumbles"],
  ret_td_off: ["special_teams_tds"],
  fg_0_19: ["fg_made_0_19"],
  fg_20_29: ["fg_made_20_29"],
  fg_30_39: ["fg_made_30_39"],
  fg_40_49: ["fg_made_40_49"],
  fg_50p: ["fg_made_50_59", "fg_made_60_"],
  fg_miss_0_19: ["fg_missed_0_19"],
  fg_miss_20_29: ["fg_missed_20_29"],
  fg_miss_30_39: ["fg_missed_30_39"],
  fg_miss_40_49: ["fg_missed_40_49"],
  fg_miss_50p: ["fg_missed_50_59", "fg_missed_60_"],
  pat_made: ["pat_made"],
  pat_miss: ["pat_missed"],
});

/** canonical ← the SUM of these ds_team_defense_week columns (the DT line). */
export const DEFENSE_STAT_MAP: Readonly<Record<Canonical, readonly string[]>> = Object.freeze({
  dst_sack: ["def_sacks"],
  dst_int: ["def_interceptions"],
  dst_fum_rec: ["fumble_recovery_opp"],
  dst_td: DST_TD_COLUMNS, // interception- AND fumble-return TDs (QA-1-017)
  dst_ret_td: ["special_teams_tds"],
  dst_safety: ["def_safeties"],
  dst_blk: ["def_fg_blocks", "def_punt_blocks"],
});

const OFFENCE: ReadonlySet<string> = new Set(["QB", "RB", "FB", "WR", "TE"]);

/** plan 08 §3.3: K → `K`; QB/RB/FB/WR/TE (or their position_group) → `O`; everything else → `D`. */
export function positionTypeOf(position: unknown, positionGroup: unknown): PositionType {
  if (position === "K" || position === "PK") return "K";
  if (
    (typeof position === "string" && OFFENCE.has(position)) ||
    (typeof positionGroup === "string" && OFFENCE.has(positionGroup))
  )
    return "O";
  return "D";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function build(
  row: SqlRow,
  map: Readonly<Record<Canonical, readonly string[]>>,
  extra: Readonly<Record<Canonical, number | null>>,
  positionType: PositionType,
): StatLine {
  const values: Record<Canonical, number> = {};
  for (const [canonical, cols] of Object.entries(map)) {
    let sum: number | null = null;
    for (const c of cols) {
      const v = num(row[c]);
      if (v !== null) sum = (sum ?? 0) + v;
    }
    if (sum !== null) values[canonical] = sum;
  }
  for (const [canonical, v] of Object.entries(extra)) if (v !== null) values[canonical] = v;
  return {
    values,
    present: Object.keys(values).sort(),
    position_type: positionType,
    provisional: false,
    source: "nflverse",
  };
}

/** A ds_player_week row → canonical StatLine (a NULL stat is absent from `present`). */
export function playerRowToStatLine(row: SqlRow): StatLine {
  return build(row, PLAYER_STAT_MAP, {}, positionTypeOf(row.position, row.position_group));
}

/**
 * A ds_team_defense_week row → the DT StatLine. `pointsAllowed` is the opponent's final score
 * (definition (a), plan 08 §3.2 U-6) or null when the game is not final / schedules is absent.
 * dst_ya = yardsAllowed(opp_passing_yards, opp_sack_yards_lost, opp_rushing_yards) — the opponent's
 * net yards, the sack loss subtracted as a magnitude whatever its stored sign ([U] Yahoo's
 * definition; QA-2-032) — present only when the opponent had rows (both yardage columns non-null).
 */
export function defenseRowToStatLine(row: SqlRow, pointsAllowed: number | null): StatLine {
  const pass = num(row.opp_passing_yards);
  const rush = num(row.opp_rushing_yards);
  const sackYds = num(row.opp_sack_yards_lost) ?? 0;
  const ya = pass !== null && rush !== null ? yardsAllowed(pass, sackYds, rush) : null;
  return build(row, DEFENSE_STAT_MAP, { dst_pa: pointsAllowed, dst_ya: ya }, "DT");
}
