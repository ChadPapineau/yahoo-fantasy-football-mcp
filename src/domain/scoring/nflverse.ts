// nflverse.ts — `toStatLine(nflverse)`, the Phase-1 path (plan 08 §3.2, OBJ-03): nflverse
// stats_player_week columns → canonical lines, the team-defence (DT) line from ds_team_defense_week
// (mapping per READER_QUERIES["PlayerWeekReader.defenseLines"]), and the league's own FG bins from
// `fg_made_list` kick distances (§4.1). Pure: it lives in the domain so store and sources may both
// import it (store may not import sources — grounding decision).
import { binCounts, parseBinCanonical } from "./brackets.js";
import { ScoringError } from "./errors.js";
import { coerceScalar } from "./numeric.js";
import type { Canonical, PositionType, ScoringSettings, StatLine } from "./types.js";
import { CANONICAL_NAME_RE, POSITION_TYPES } from "./types.js";

/**
 * Canonical ← nflverse `stats_player_week` columns (plan 08 §3.2; A-1 names asserted against
 * PLAYER_WEEK_STAT_COLUMNS in the tests). Several columns SUM; a canonical is present when at least
 * one of its columns is non-null. `off_fum_ret_td` has no player-week column (pbp only) and is
 * therefore never present from this path.
 */
export const NFLVERSE_PLAYER_COLUMNS: Readonly<Record<Canonical, readonly string[]>> =
  Object.freeze({
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
    // [U-1] whether a platform credits every player in a 2-pt conversion: the sum is per player
    two_pt: ["passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions"],
    // a QB's fumble lost on a sack counts (plan 08 §8)
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

/** nflverse `position` → the league position type (O, K, D); null when it scores nowhere (P, LS). */
export function positionTypeForNflPosition(
  position: string | null | undefined,
): PositionType | null {
  const p = (position ?? "").trim().toUpperCase();
  if (["QB", "RB", "WR", "TE", "FB", "HB"].includes(p)) return "O";
  if (["K", "PK"].includes(p)) return "K";
  const idp = [
    "DL",
    "DE",
    "DT",
    "NT",
    "LB",
    "ILB",
    "OLB",
    "MLB",
    "EDGE",
    "DB",
    "CB",
    "S",
    "SS",
    "FS",
    "SAF",
  ];
  if (idp.includes(p)) return "D";
  return null;
}

/** A row as a reader returns it: column → SQLite/parquet value (number, bigint, string, null). */
export type NflverseRow = Readonly<Record<string, unknown>>;

/** How a translated line is labelled. */
export interface LineOptions {
  /** Research 03 §D.2: the week is not final yet. Default false. */
  readonly provisional?: boolean;
  /** Provenance label. Default `nflverse`. */
  readonly source?: string;
}

function columnValue(row: NflverseRow, column: string): number | null {
  return Object.hasOwn(row, column) ? coerceScalar(row[column]) : null;
}

/** Σ of the non-null columns, or null when every column is null/absent. */
function sumColumns(row: NflverseRow, columns: readonly string[]): number | null {
  let total: number | null = null;
  for (const c of columns) {
    const v = columnValue(row, c);
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

/**
 * Builds a canonical StatLine (plan 08 §2): null/undefined values are NOT present; `present` is the
 * sorted key set; the line and its values are frozen. Throws `invalid_line` for a malformed name,
 * a non-finite / out-of-range value or an unknown position type.
 */
export function makeStatLine(
  values: Readonly<Record<string, number | null | undefined>>,
  positionType: PositionType,
  opts: LineOptions = {},
): StatLine {
  if (!POSITION_TYPES.includes(positionType)) {
    throw new ScoringError("invalid_line", "unknown position type");
  }
  const out: Record<Canonical, number> = {};
  for (const [k, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined) continue;
    if (!CANONICAL_NAME_RE.test(k))
      throw new ScoringError("invalid_line", "malformed canonical", [k]);
    const v = coerceScalar(raw);
    if (v === null || typeof raw !== "number") {
      throw new ScoringError("invalid_line", "stat value is not a finite in-range number", [k]);
    }
    out[k] = v;
  }
  return Object.freeze({
    values: Object.freeze(out),
    present: Object.freeze(Object.keys(out).sort()),
    position_type: positionType,
    provisional: opts.provisional === true,
    source: opts.source ?? "nflverse",
  });
}

/**
 * `toStatLine(nflverse)` for a `ds_player_week` row (plan 08 §3.2). The position type comes from
 * `positionType`, else from the row's `position`; a row that maps to none throws `invalid_line`.
 * Every mapped column set with a non-null value becomes present (a present 0 stays 0).
 */
export function statLineFromPlayerWeek(
  row: NflverseRow,
  opts: LineOptions & { readonly positionType?: PositionType } = {},
): StatLine {
  const pt = opts.positionType ?? positionTypeForNflPosition(row.position as string | null);
  if (pt === null) throw new ScoringError("invalid_line", "row has no fantasy position type");
  const values: Record<Canonical, number | null> = {};
  for (const [canonical, columns] of Object.entries(NFLVERSE_PLAYER_COLUMNS)) {
    values[canonical] = sumColumns(row, columns);
  }
  return makeStatLine(values, pt, opts);
}

/** Options for the team-defence line. */
export interface DefenseLineOptions extends LineOptions {
  /**
   * Points allowed from `ds_games` (the opponent's score; definition (a) of plan 08 U-6), or null
   * when the game has no final score yet — then `dst_pa` is absent (the family is not present).
   */
  readonly pointsAllowed: number | null;
  /** Whether blocked PATs count in `dst_blk` (the league's rule, plan 08 [U]). Default false. */
  readonly includePatBlocks?: boolean;
}

/**
 * The DT line of a `ds_team_defense_week` row (READER_QUERIES mapping): dst_sack ← def_sacks,
 * dst_int ← def_interceptions, dst_fum_rec ← fumble_recovery_opp, dst_td ← def_tds, dst_ret_td ←
 * special_teams_tds, dst_safety ← def_safeties, dst_blk ← def_fg_blocks + def_punt_blocks
 * (+ def_pat_blocks), dst_pa ← pointsAllowed, dst_ya ← opp_passing_yards − opp_sack_yards_lost +
 * opp_rushing_yards (present only when both yardage columns are; [U] the platform's definition).
 */
export function statLineFromTeamDefense(row: NflverseRow, opts: DefenseLineOptions): StatLine {
  const blocks = ["def_fg_blocks", "def_punt_blocks"];
  if (opts.includePatBlocks === true) blocks.push("def_pat_blocks");
  const pass = columnValue(row, "opp_passing_yards");
  const rush = columnValue(row, "opp_rushing_yards");
  const sackYards = columnValue(row, "opp_sack_yards_lost") ?? 0;
  const values: Record<Canonical, number | null> = {
    dst_sack: columnValue(row, "def_sacks"),
    dst_int: columnValue(row, "def_interceptions"),
    dst_fum_rec: columnValue(row, "fumble_recovery_opp"),
    dst_td: columnValue(row, "def_tds"),
    dst_ret_td: columnValue(row, "special_teams_tds"),
    dst_safety: columnValue(row, "def_safeties"),
    dst_blk: sumColumns(row, blocks),
    dst_pa: opts.pointsAllowed === null ? null : coerceScalar(opts.pointsAllowed),
    dst_ya: pass === null || rush === null ? null : pass - sackYards + rush,
  };
  return makeStatLine(values, "DT", opts);
}

/** Longest `fg_*_list` string parsed (a team kicks far fewer than 50 FGs in a game). */
const MAX_LIST_LEN = 400;

/**
 * Parses an nflverse `;`-separated kick-distance list (`"51;43"`); null/"" → no kicks. Throws
 * `invalid_line` for a token that is not an integer distance in 0..120 or an absurd length.
 */
export function parseKickList(list: string | null | undefined): readonly number[] {
  if (list === null || list === undefined || list.trim() === "") return [];
  if (list.length > MAX_LIST_LEN) throw new ScoringError("invalid_line", "kick list too long");
  return list.split(";").map((tok) => {
    const v = coerceScalar(tok);
    if (v === null || !Number.isInteger(v) || v < 0 || v > 120) {
      throw new ScoringError("invalid_line", "kick distance is not an integer yardage", [tok]);
    }
    return v;
  });
}

/**
 * Re-bins a K line's FG counts to the LEAGUE's own distance bins (plan 08 §4.1 — the primary path
 * when the league's bins differ from nflverse's): for each of `fg_distance` (from `madeList`) and
 * `fg_miss_distance` (from `missedList`) that the settings define for K and whose list is non-null,
 * every existing bin key of that family is replaced by the league members' counts. A null list
 * leaves the line's nflverse bins untouched.
 */
export function rebinKickLine(
  line: StatLine,
  settings: ScoringSettings,
  madeList: string | null,
  missedList: string | null = null,
): StatLine {
  let next: Record<Canonical, number> = { ...line.values };
  const lists: readonly [string, string | null][] = [
    ["fg_distance", madeList],
    ["fg_miss_distance", missedList],
  ];
  for (const [name, list] of lists) {
    const family = settings.brackets.find((f) => f.family === name && f.position_type === "K");
    if (family === undefined || list === null) continue;
    const kept = Object.entries(next).filter(([k]) => parseBinCanonical(k)?.family !== name);
    next = { ...Object.fromEntries(kept), ...binCounts(family, parseKickList(list)) };
  }
  return makeStatLine(next, line.position_type, {
    provisional: line.provisional,
    source: line.source,
  });
}
