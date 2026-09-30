// registry.ts — the canonical stat registry: plan 08 §3.1 (canonical names, position types, the
// name-matching patterns, the Yahoo sample ids as a seed — never the source of truth, E3) and §4.2
// (a bonus that arrives as its own stat id, e.g. "300+ Passing Yards Bonus", folds onto the base).
import { ScoringError } from "./errors.js";
import type { Canonical, KnownCanonical, PositionType } from "./types.js";
import { POSITION_TYPES } from "./types.js";

/** One fixed registry row: a canonical name and the display-name pattern that resolves to it. */
export interface RegistryEntry {
  readonly canonical: KnownCanonical;
  /** The position types whose display names may resolve to this canonical name. */
  readonly position_types: readonly PositionType[];
  /** Matched against `normalizeStatName(name)` (lower case, single spaces, ASCII hyphens). */
  readonly pattern: RegExp;
  /** The id in Yahoo's official settings sample (research 03 §B.5); `null` = not in the sample. */
  readonly yahoo_id: string | null;
}

const O: readonly PositionType[] = ["O"];
const K: readonly PositionType[] = ["K"];
const DT: readonly PositionType[] = ["DT"];

const row = (
  canonical: KnownCanonical,
  position_types: readonly PositionType[],
  pattern: RegExp,
  yahoo_id: string | null,
): RegistryEntry => Object.freeze({ canonical, position_types, pattern, yahoo_id });

/**
 * The fixed rows (plan 08 §3.1). "Interceptions" is `pass_int` under O and `dst_int` under DT — the
 * position type disambiguates (research 05 §15). Parametric families (FG distance, points/yards
 * allowed) are resolved by `PARAMETRIC` below, not listed per bin.
 */
export const REGISTRY: readonly RegistryEntry[] = Object.freeze([
  row("pass_yd", O, /^passing yards$/, "4"),
  row("pass_td", O, /^passing touchdowns$/, "5"),
  row("pass_int", O, /^interceptions( thrown)?$/, "6"),
  row("pass_1d", O, /^passing (1st|first) downs$/, null),
  row("rush_att", O, /^rushing attempts$/, "8"),
  row("rush_yd", O, /^rushing yards$/, "9"),
  row("rush_td", O, /^rushing touchdowns$/, "10"),
  row("rush_1d", O, /^rushing (1st|first) downs$/, "81"),
  row("targets", O, /^targets$/, "78"),
  row("rec", O, /^receptions$/, "11"),
  row("rec_yd", O, /^receiving yards$/, "12"),
  row("rec_td", O, /^receiving touchdowns$/, "13"),
  row("rec_1d", O, /^receiving (1st|first) downs$/, null),
  row("ret_td_off", O, /^return touchdowns$/, "15"),
  row("two_pt", O, /^2-point conversions$/, "16"),
  row("fum_lost", O, /^fumbles lost$/, "18"),
  row("fum", O, /^fumbles$/, null),
  row("off_fum_ret_td", O, /^offensive fumble return td$/, "57"),
  row("pat_made", K, /^point after attempts? made$/, "29"),
  row("pat_miss", K, /^point after attempts? missed$/, null),
  row("dst_pa", DT, /^points allowed$/, "31"),
  row("dst_ya", DT, /^(total )?yards allowed$/, null),
  row("dst_sack", DT, /^sacks?$/, "32"),
  row("dst_int", DT, /^interceptions?$/, "33"),
  row("dst_fum_rec", DT, /^fumble recover(y|ies)$/, "34"),
  row("dst_td", DT, /^touchdowns?$/, "35"),
  row("dst_safety", DT, /^safet(y|ies)$/, "36"),
  row("dst_blk", DT, /^block(ed)? kicks?$/, "37"),
  row("dst_ret_td", DT, /^kickoff and punt return touchdowns$/, "49"),
  row("dst_xpr", DT, /^extra points? returned$/, "82"),
]);

/** A parametric row: a bounded display name → a bin canonical (`fg_40_49`, `dst_pa_35p`, …). */
interface ParametricEntry {
  readonly position_types: readonly PositionType[];
  /** Canonical prefix; the bounds are appended as `_a_b`, `_n` or `_np`. */
  readonly prefix: string;
  /** Stem of the display name, before the bounds. */
  readonly stem: string;
  /** Suffix after the bounds (`" yards"` or `""`). */
  readonly suffix: string;
  /** Whether a single-number bin (`Points Allowed 0`) is legal. */
  readonly single: boolean;
}

const PARAMETRIC: readonly ParametricEntry[] = Object.freeze([
  {
    position_types: K,
    prefix: "fg_miss",
    stem: "field goals missed",
    suffix: " yards",
    single: false,
  },
  { position_types: K, prefix: "fg", stem: "field goals", suffix: " yards", single: false },
  { position_types: DT, prefix: "dst_pa", stem: "points allowed", suffix: "", single: true },
  { position_types: DT, prefix: "dst_ya", stem: "yards allowed", suffix: "", single: true },
]);

/** Bounds text after a stem: `a-b`, `n+` or (when legal) `n`; at most 4 digits each. */
const BOUNDS_RE = /^(\d{1,4})(?:-(\d{1,4})|(\+))?$/;

/**
 * Normalises a platform display name for matching: NFKC, lower case, unicode dashes → "-",
 * whitespace runs → one space, trimmed. The ORIGINAL name is what the settings keep.
 */
export function normalizeStatName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolves a bounded name (`field goals 40-49 yards`) to its bin canonical, or null. */
function parametric(norm: string, pt: PositionType): Canonical | null {
  for (const p of PARAMETRIC) {
    if (!p.position_types.includes(pt)) continue;
    if (!norm.startsWith(`${p.stem} `) || !norm.endsWith(p.suffix)) continue;
    const bounds = norm.slice(p.stem.length + 1, norm.length - p.suffix.length);
    const m = BOUNDS_RE.exec(bounds);
    if (m === null) continue;
    const [, a, b, plus] = m;
    if (b !== undefined) return `${p.prefix}_${String(Number(a))}_${String(Number(b))}`;
    if (plus !== undefined) return `${p.prefix}_${String(Number(a))}p`;
    if (p.single) return `${p.prefix}_${String(Number(a))}`;
  }
  return null;
}

/** Resolves a display name under ONE position type, or null (unmapped). */
function resolveOne(norm: string, pt: PositionType): Canonical | null {
  for (const r of REGISTRY) {
    if (r.position_types.includes(pt) && r.pattern.test(norm)) return r.canonical;
  }
  return parametric(norm, pt);
}

/**
 * The canonical name for a platform display name under the rule's position types (plan 08 §3.1),
 * or `null` when no pattern matches (the rule is then unmapped and scores 0). Throws
 * `ambiguous_canonical` when the position types disagree (e.g. "Interceptions" under both O and DT).
 */
export function resolveCanonical(
  name: string,
  positionTypes: readonly PositionType[],
): Canonical | null {
  const norm = normalizeStatName(name);
  const found = new Set<Canonical>();
  for (const pt of POSITION_TYPES) {
    if (!positionTypes.includes(pt)) continue;
    const c = resolveOne(norm, pt);
    if (c !== null) found.add(c);
  }
  if (found.size > 1) {
    throw new ScoringError("ambiguous_canonical", "one stat name maps to several canonicals", [
      name,
      ...[...found].sort(),
    ]);
  }
  const [only] = found;
  return only ?? null;
}

/** One Yahoo stat of the official settings sample (research 03 §B.5): id → display name + type. */
export interface YahooSampleStat {
  readonly name: string;
  readonly position_type: PositionType;
}

/**
 * The 36 stat ids of Yahoo's official `league/{key}/settings` sample (research 03 §B.5) — a SEED
 * for providers that are given ids without names (plan 08 E3); names resolve through the registry.
 */
export const YAHOO_SAMPLE_STATS: Readonly<Record<string, YahooSampleStat>> = Object.freeze({
  "4": { name: "Passing Yards", position_type: "O" },
  "5": { name: "Passing Touchdowns", position_type: "O" },
  "6": { name: "Interceptions", position_type: "O" },
  "8": { name: "Rushing Attempts", position_type: "O" },
  "9": { name: "Rushing Yards", position_type: "O" },
  "10": { name: "Rushing Touchdowns", position_type: "O" },
  "78": { name: "Targets", position_type: "O" },
  "11": { name: "Receptions", position_type: "O" },
  "12": { name: "Receiving Yards", position_type: "O" },
  "13": { name: "Receiving Touchdowns", position_type: "O" },
  "15": { name: "Return Touchdowns", position_type: "O" },
  "16": { name: "2-Point Conversions", position_type: "O" },
  "18": { name: "Fumbles Lost", position_type: "O" },
  "57": { name: "Offensive Fumble Return TD", position_type: "O" },
  "19": { name: "Field Goals 0-19 Yards", position_type: "K" },
  "20": { name: "Field Goals 20-29 Yards", position_type: "K" },
  "21": { name: "Field Goals 30-39 Yards", position_type: "K" },
  "22": { name: "Field Goals 40-49 Yards", position_type: "K" },
  "23": { name: "Field Goals 50+ Yards", position_type: "K" },
  "29": { name: "Point After Attempt Made", position_type: "K" },
  "31": { name: "Points Allowed", position_type: "DT" },
  "32": { name: "Sack", position_type: "DT" },
  "33": { name: "Interception", position_type: "DT" },
  "34": { name: "Fumble Recovery", position_type: "DT" },
  "35": { name: "Touchdown", position_type: "DT" },
  "36": { name: "Safety", position_type: "DT" },
  "37": { name: "Block Kick", position_type: "DT" },
  "49": { name: "Kickoff and Punt Return Touchdowns", position_type: "DT" },
  "82": { name: "Extra Point Returned", position_type: "DT" },
  "50": { name: "Points Allowed 0", position_type: "DT" },
  "51": { name: "Points Allowed 1-6", position_type: "DT" },
  "52": { name: "Points Allowed 7-13", position_type: "DT" },
  "53": { name: "Points Allowed 14-20", position_type: "DT" },
  "54": { name: "Points Allowed 21-27", position_type: "DT" },
  "55": { name: "Points Allowed 28-34", position_type: "DT" },
  "56": { name: "Points Allowed 35+", position_type: "DT" },
});

/** Bonus-as-stat-id name forms (wire form [U], research 03 §F.8 — plan 08 §4.2). */
const BONUS_NAME_RES: readonly RegExp[] = [
  /^(?<target>\d{1,4})\+ (?<kind>passing|rushing|receiving) yards? bonus$/,
  /^(?<target>\d{1,4})\+ yard (?<kind>passing|rushing|receiving) bonus$/,
  /^(?<kind>passing|rushing|receiving) yards? bonus (?<target>\d{1,4})\+$/,
];

/**
 * When `name` is a yardage bonus that arrived as its own stat id (plan 08 §4.2), the base canonical
 * and the threshold it pays at; otherwise null.
 */
export function bonusRuleTarget(name: string): { base: Canonical; target: number } | null {
  const norm = normalizeStatName(name);
  for (const re of BONUS_NAME_RES) {
    const m = re.exec(norm);
    if (m === null) continue;
    // both named groups are mandatory in every pattern, so a match always carries them
    const { target, kind } = m.groups as { target: string; kind: string };
    const base = kind === "passing" ? "pass_yd" : kind === "rushing" ? "rush_yd" : "rec_yd";
    return { base, target: Number(target) };
  }
  return null;
}
