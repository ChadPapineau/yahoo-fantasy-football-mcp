// columns.ts — nflverse stat column → canonical stat name (plan 08 §3.2; §3.3 position-type gating;
// §4.1 FG-distance bins are counts; §4.3 fumbles / 2-pt / return TDs) and `toStatLine(nflverse)`,
// the Phase-1 translator (plan 08 §3.2 "toStatLine(nflverse) is the Phase-1 path"). The loader's
// schema assertion (schemas.ts) is what verifies these column names exist (A-1).
// PURE: imports only domain types, no I/O, no store/sources modules — so it can move into
// src/domain verbatim if the store's readers need it (store may not import src/sources).
import { DST_TD_COLUMNS, yardsAllowed } from "../../domain/scoring/nflverse.js";
import type { Canonical, PositionType, StatLine } from "../../domain/scoring/types.js";

/** One canonical stat and the nflverse columns summed to produce it. */
export interface StatMapping {
  readonly canonical: Canonical;
  /** Summed; null components count 0; absent when every component is null. */
  readonly columns: readonly string[];
  /** The line position types it is emitted for (plan 08 §3.3; the engine gates again). */
  readonly position_types: readonly PositionType[];
  /** `count` = a non-negative integer (a negative or fractional value is flagged); `measure` (yards, half sacks) may be negative or fractional. */
  readonly kind: "count" | "measure";
  readonly note: string | null;
}

const O: readonly PositionType[] = Object.freeze(["O"]);
const K: readonly PositionType[] = Object.freeze(["K"]);

const m = (
  canonical: Canonical,
  columns: readonly string[],
  position_types: readonly PositionType[],
  kind: "count" | "measure",
  note: string | null = null,
): StatMapping =>
  Object.freeze({ canonical, columns: Object.freeze([...columns]), position_types, kind, note });

/**
 * The mapping (plan 08 §3.2 table), offence then kicker. `off_fum_ret_td` is deliberately absent:
 * plan 08 derives it from pbp only ("0 when pbp absent (present false)"), so it is never present
 * from this path (the player-level `fumble_recovery_tds` stays unmapped).
 */
export const NFLVERSE_STAT_MAP: readonly StatMapping[] = Object.freeze([
  m("pass_yd", ["passing_yards"], O, "measure", "gross passing yards (sack yards not subtracted)"),
  m("pass_td", ["passing_tds"], O, "count"),
  m("pass_int", ["passing_interceptions"], O, "count"),
  m("pass_1d", ["passing_first_downs"], O, "count"),
  m("rush_att", ["carries"], O, "count"),
  m("rush_yd", ["rushing_yards"], O, "measure"),
  m("rush_td", ["rushing_tds"], O, "count"),
  m("rush_1d", ["rushing_first_downs"], O, "count"),
  m("targets", ["targets"], O, "count"),
  m("rec", ["receptions"], O, "count"),
  m("rec_yd", ["receiving_yards"], O, "measure"),
  m("rec_td", ["receiving_tds"], O, "count"),
  m("rec_1d", ["receiving_first_downs"], O, "count"),
  m(
    "ret_td_off",
    ["special_teams_tds"],
    O,
    "count",
    "player-level kick/punt return TDs (plan 08 §3.2; pbp is the fallback)",
  ),
  m(
    "two_pt",
    ["passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions"],
    O,
    "count",
    "[U-1] whether a league counts pass + rush + rec 2-pt under one id",
  ),
  m(
    "fum_lost",
    ["sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost"],
    O,
    "count",
  ),
  m(
    "fum",
    ["sack_fumbles", "rushing_fumbles", "receiving_fumbles"],
    O,
    "count",
    "[U-2] total fumbles, for leagues that score fumbles rather than fumbles lost",
  ),
  m("fg_0_19", ["fg_made_0_19"], K, "count"),
  m("fg_20_29", ["fg_made_20_29"], K, "count"),
  m("fg_30_39", ["fg_made_30_39"], K, "count"),
  m("fg_40_49", ["fg_made_40_49"], K, "count"),
  m("fg_50p", ["fg_made_50_59", "fg_made_60_"], K, "count", "50–59 + 60+"),
  m("fg_miss_0_19", ["fg_missed_0_19"], K, "count", "[U-3] learned family"),
  m("fg_miss_20_29", ["fg_missed_20_29"], K, "count", "[U-3] learned family"),
  m("fg_miss_30_39", ["fg_missed_30_39"], K, "count", "[U-3] learned family"),
  m("fg_miss_40_49", ["fg_missed_40_49"], K, "count", "[U-3] learned family"),
  m("fg_miss_50p", ["fg_missed_50_59", "fg_missed_60_"], K, "count", "[U-3] learned family"),
  m("pat_made", ["pat_made"], K, "count"),
  m("pat_miss", ["pat_missed"], K, "count"),
]);

/** Every nflverse column some mapping reads. */
export const MAPPED_STAT_COLUMNS: readonly string[] = Object.freeze(
  [...new Set(NFLVERSE_STAT_MAP.flatMap((x) => x.columns))].sort(),
);

/** The columns of `available` no mapping reads (usage shares, attempts, fantasy points, …). */
export function unmappedStatColumns(available: readonly string[]): readonly string[] {
  const used = new Set(MAPPED_STAT_COLUMNS);
  return Object.freeze(available.filter((c) => !used.has(c)));
}

/** What a translation noticed (never fatal: the value is dropped or kept as documented). */
export interface TranslationIssue {
  readonly column: string | null;
  readonly issue: string;
}

/** A translated line plus its diagnostics. */
export interface Translation {
  readonly line: StatLine;
  readonly issues: readonly TranslationIssue[];
}

/** Options for a translation. */
export interface TranslateOptions {
  /** Research 03 §D.2: the week is not yet final (default false). */
  readonly provisional?: boolean;
  /** Overrides the position type derived from `position` / `position_group`. */
  readonly positionType?: PositionType;
}

const OFFENCE_GROUPS = new Set(["QB", "RB", "WR", "TE", "OL"]);
const DEFENCE_GROUPS = new Set(["DL", "LB", "DB"]);

/**
 * The position type of an nflverse row (plan 08 §3.3): K → `K`; QB/RB/WR/TE (and FB, OL) → `O`;
 * DL/LB/DB → `D`; anything else (P, LS, unknown) → `O` with an issue.
 */
export function positionTypeOf(
  position: unknown,
  positionGroup: unknown,
): { readonly type: PositionType; readonly issue: string | null } {
  const pos = typeof position === "string" ? position.trim().toUpperCase() : "";
  const grp = typeof positionGroup === "string" ? positionGroup.trim().toUpperCase() : "";
  if (pos === "K") return { type: "K", issue: null };
  if (OFFENCE_GROUPS.has(grp) || OFFENCE_GROUPS.has(pos) || pos === "FB") {
    return { type: "O", issue: null };
  }
  if (DEFENCE_GROUPS.has(grp)) return { type: "D", issue: null };
  return {
    type: "O",
    issue: pos === "" ? "position unknown → O" : `non-fantasy position ${pos} → O`,
  };
}

function numeric(v: unknown): { readonly value: number | null; readonly bad: string | null } {
  if (v === null || v === undefined) return { value: null, bad: null };
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isSafeInteger(n) ? { value: n, bad: null } : { value: null, bad: "out of range" };
  }
  if (typeof v !== "number") return { value: null, bad: `not a number (${typeof v})` };
  if (!Number.isFinite(v)) return { value: null, bad: "not finite" };
  return { value: v, bad: null };
}

function buildLine(
  values: Record<string, number>,
  positionType: PositionType,
  provisional: boolean,
): StatLine {
  const present = Object.keys(values).sort();
  return Object.freeze({
    values: Object.freeze(values),
    present: Object.freeze(present),
    position_type: positionType,
    provisional,
    source: "nflverse",
  });
}

function sumColumns(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
  kind: "count" | "measure",
  issues: TranslationIssue[],
): number | null {
  let total: number | null = null;
  for (const col of columns) {
    const { value, bad } = numeric(row[col]);
    if (bad !== null) issues.push({ column: col, issue: bad });
    if (value === null) continue;
    if (kind === "count" && (value < 0 || !Number.isInteger(value))) {
      issues.push({ column: col, issue: `count is ${String(value)}` });
    }
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Translates one nflverse `stats_player_week` row (or a `ds_player_week` row — same column names)
 * into a canonical StatLine (plan 08 §2/§3.2). A null column is ABSENT (not 0); a sum is present
 * when any component is. Only the mappings for the row's position type are emitted. Non-numeric or
 * non-finite values never reach the line (NaN-free by construction) and are reported as issues.
 */
export function translatePlayerWeek(
  row: Readonly<Record<string, unknown>>,
  opts: TranslateOptions = {},
): Translation {
  const issues: TranslationIssue[] = [];
  let positionType = opts.positionType;
  if (positionType === undefined) {
    const p = positionTypeOf(row.position, row.position_group);
    positionType = p.type;
    if (p.issue !== null) issues.push({ column: "position", issue: p.issue });
  }
  const values: Record<string, number> = {};
  if (positionType === "D") {
    issues.push({ column: null, issue: "IDP line: no canonical mapping (plan 08 §3.1 [U-5])" });
  }
  for (const x of NFLVERSE_STAT_MAP) {
    if (!x.position_types.includes(positionType)) continue;
    const v = sumColumns(row, x.columns, x.kind, issues);
    if (v !== null) values[x.canonical] = v;
  }
  return { line: buildLine(values, positionType, opts.provisional ?? false), issues };
}

/** `toStatLine(nflverse)` (plan 08 §3.2): the line only. */
export function toStatLine(
  row: Readonly<Record<string, unknown>>,
  opts: TranslateOptions = {},
): StatLine {
  return translatePlayerWeek(row, opts).line;
}

/** Options for a team-defence line. */
export interface DefenseOptions {
  /** The opponent's points (plan 08 §3.2 dst_pa, definition [U-6]); null/absent → no dst_pa. */
  readonly pointsAllowed?: number | null;
  /** Count blocked PATs in `dst_blk` (league rule, plan 08 [U]); default false. */
  readonly includePatBlocks?: boolean;
  readonly provisional?: boolean;
}

/**
 * The DT StatLine of one `ds_team_defense_week` row (tables.ts READER_QUERIES
 * `PlayerWeekReader.defenseLines` mapping): dst_sack, dst_int, dst_fum_rec, dst_td, dst_ret_td,
 * dst_safety, dst_blk (FG + punt blocks, + PAT blocks when asked), dst_pa (the scalar; the engine
 * bracketizes it, plan 08 §4.1), dst_ya = yardsAllowed(opponent passing, sack yards, rushing) —
 * net yards, the sack term a magnitude whatever its sign (all three needed; QA-2-032).
 */
export function toDefenseStatLine(
  row: Readonly<Record<string, unknown>>,
  opts: DefenseOptions = {},
): Translation {
  const issues: TranslationIssue[] = [];
  const values: Record<string, number> = {};
  const put = (canonical: string, cols: readonly string[], kind: "count" | "measure"): void => {
    const v = sumColumns(row, cols, kind, issues);
    if (v !== null) values[canonical] = v;
  };
  put("dst_sack", ["def_sacks"], "measure"); // half sacks are legitimate
  put("dst_int", ["def_interceptions"], "count");
  put("dst_fum_rec", ["fumble_recovery_opp"], "count");
  put("dst_td", DST_TD_COLUMNS, "count");
  put("dst_ret_td", ["special_teams_tds"], "count");
  put("dst_safety", ["def_safeties"], "count");
  put(
    "dst_blk",
    opts.includePatBlocks
      ? ["def_fg_blocks", "def_punt_blocks", "def_pat_blocks"]
      : ["def_fg_blocks", "def_punt_blocks"],
    "count",
  );
  const pa = numeric(opts.pointsAllowed);
  if (pa.value !== null) values.dst_pa = pa.value;
  const pass = numeric(row.opp_passing_yards).value;
  const sackYds = numeric(row.opp_sack_yards_lost).value;
  const rush = numeric(row.opp_rushing_yards).value;
  if (pass !== null && sackYds !== null && rush !== null)
    values.dst_ya = yardsAllowed(pass, sackYds, rush);
  return { line: buildLine(values, "DT", opts.provisional ?? false), issues };
}

/**
 * The opponent's final score for `team` in a game row (`away_team`, `home_team`, `away_score`,
 * `home_score`) — dst_pa definition (a) of plan 08 §3.2 [U-6]; null when the team did not play in
 * it or a score is missing.
 */
export function pointsAllowedFor(
  team: string,
  game: Readonly<Record<string, unknown>>,
): number | null {
  const away = numeric(game.away_score).value;
  const home = numeric(game.home_score).value;
  if (away === null || home === null) return null;
  if (game.home_team === team) return away;
  if (game.away_team === team) return home;
  return null;
}

/** Longest `fg_*_list` accepted (a kicker makes at most a handful of kicks a game). */
const MAX_KICK_LIST = 400;

/**
 * The kick distances of an nflverse `fg_made_list` / `fg_missed_list` / `fg_blocked_list`
 * (`"51;43"`) — the input for a league's own FG-distance brackets (plan 08 §4.1, `kick_distance` as
 * the scalar). Tokens that are not integers 1–99 are skipped; a non-string or oversize value → [].
 */
export function kickDistances(list: unknown): readonly number[] {
  if (typeof list !== "string" || list.length > MAX_KICK_LIST) return [];
  const out: number[] = [];
  for (const tok of list.split(";")) {
    const t = tok.trim();
    if (!/^\d{1,2}$/.test(t)) continue;
    const n = Number(t);
    if (n >= 1) out.push(n);
  }
  return out;
}
