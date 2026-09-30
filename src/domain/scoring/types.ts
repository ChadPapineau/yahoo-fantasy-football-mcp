// types.ts — the scoring-engine contract shared by the engine, the translators, the tools and the
// tests: plan 08 §2 (types), §3.1 (canonical registry names), §4 (brackets, bonuses, rounding/floor
// flags with `verified`), §5 (stored projections), E8 (`Dist.basis`). Deviations from §2's text:
// bracket families carry `kind: indicator | count` (FG-by-distance bins are COUNTS — a kicker can
// make two 40–49 FGs in a game; critic C-09); a stored projection is keyed by a ProjectionSubject
// (a player's gsis id OR a team defence) with `made_at` so a post-kickoff run never overwrites the
// pre-kickoff distribution the retrospective scores (critics C-13, C-03).
// `StatLine.present` is a sorted array (not a Set) so every type is plain, serialisable data;
// `ScoringSettings.platform` is any `PlatformId` (ManualLeagueProvider emits the same shape).
// This file is pure data: the engine itself lives beside it (src/domain/scoring/*).
import type { NflTeam } from "../../config/schema.js";

/** A platform id — the four implementations the FantasyPlatform seam names (plan 01 §8). */
export type PlatformId = "yahoo" | "manual" | "sleeper" | "espn";

/** A canonical stat name — the hub every platform id and every external column maps to (plan 08 E2). */
export type Canonical = string;

/** The grammar of a canonical name: lowercase snake case, ≤ 40 chars. */
export const CANONICAL_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * The canonical names named by plan 08 §3.1 (the registry seed). Families marked [U] there
 * (`fg_miss_*`, `dst_ya_*`, bonus and IDP ids) are learned by pattern and are valid `Canonical`s
 * although they are not listed here.
 */
export const KNOWN_CANONICAL = [
  "pass_yd",
  "pass_td",
  "pass_int",
  "pass_1d",
  "rush_att",
  "rush_yd",
  "rush_td",
  "rush_1d",
  "targets",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_1d",
  "ret_td_off",
  "two_pt",
  "fum_lost",
  "fum",
  "off_fum_ret_td",
  "fg_0_19",
  "fg_20_29",
  "fg_30_39",
  "fg_40_49",
  "fg_50p",
  "pat_made",
  "pat_miss",
  "dst_pa",
  "dst_pa_0",
  "dst_pa_1_6",
  "dst_pa_7_13",
  "dst_pa_14_20",
  "dst_pa_21_27",
  "dst_pa_28_34",
  "dst_pa_35p",
  "dst_ya",
  "dst_sack",
  "dst_int",
  "dst_fum_rec",
  "dst_td",
  "dst_safety",
  "dst_blk",
  "dst_ret_td",
  "dst_xpr",
] as const;
/** One of the seeded canonical names. */
export type KnownCanonical = (typeof KNOWN_CANONICAL)[number];

/** A position type: offence, kicker, team defence/special teams, individual defensive player. */
export type PositionType = "O" | "K" | "DT" | "D";

/** The position types, in plan 08 §3.3 order. */
export const POSITION_TYPES: readonly PositionType[] = ["O", "K", "DT", "D"];

/** A threshold bonus on one stat: `points` when the value is ≥ `target` (plan 08 §4.2). */
export interface ScoringBonus {
  /** Threshold (inclusive). */
  readonly target: number;
  /** Points awarded at or above the threshold. */
  readonly points: number;
}

/** One scoring rule (plan 08 §2). */
export interface ScoringRule {
  /** Canonical name; `null` = the platform id could not be mapped (unmapped, logged once). */
  readonly canonical: Canonical | null;
  /** The platform's stat id as a string (Yahoo `stat_id`; ESPN later) — opaque to the engine. */
  readonly platform_id: string;
  /** Platform display name (untrusted for output; used for family derivation). */
  readonly name: string;
  /** The position types this rule applies to. */
  readonly position_types: readonly PositionType[];
  /** Points per unit; `null` = display-only (present in categories, absent from modifiers) → 0. */
  readonly modifier: number | null;
  /** Threshold bonuses on this stat; several entries sum. */
  readonly bonuses: readonly ScoringBonus[];
}

/** The derived bracket families (plan 08 §4.1); other families pass through as sanitised slugs. */
export type BracketFamilyName = "dst_points_allowed" | "dst_yards_allowed" | "fg_distance";

/**
 * How a family's members count per game (critic C-09):
 * - `indicator`: exactly one member is 1 per game (points/yards allowed brackets) — Σ members ≤ 1;
 * - `count`: each member is a count scored linearly per bin (FGs made by distance: 2 × 40–49 and
 *   1 × 50+ in one game is legal). The translator emits per-bin counts; the engine never asserts
 *   exclusivity on a count family.
 */
export type BracketKind = "indicator" | "count";

/** The kind of each named family. */
export const BRACKET_FAMILY_KIND: Readonly<Record<BracketFamilyName, BracketKind>> = Object.freeze({
  dst_points_allowed: "indicator",
  dst_yards_allowed: "indicator",
  fg_distance: "count",
});

/**
 * Grammar of any family name (named or derived from platform display names): a lowercase slug.
 * The normaliser slugs derived names to this before they can become object keys in tool output
 * (`bracket_probability`) — the envelope's key walker rejects anything else (critic C-12).
 */
export const BRACKET_FAMILY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** One member of a bracket family: an indicator or count stat for a scalar range. */
export interface BracketMember {
  /** Canonical name of the indicator stat (e.g. `dst_pa_7_13`). */
  readonly canonical: Canonical;
  /** Platform stat id of the indicator. */
  readonly platform_id: string;
  /** Inclusive lower bound of the scalar. */
  readonly lower: number;
  /** Inclusive upper bound; `null` = open-ended (`35+`). */
  readonly upper: number | null;
}

/** A family of bracket stats derived from rule names (plan 08 §4.1). */
export interface BracketFamily {
  /** Family name: a BracketFamilyName or a derived slug matching BRACKET_FAMILY_RE. */
  readonly family: BracketFamilyName | (string & {});
  /** The position type the family scores. */
  readonly position_type: PositionType;
  /** Members sorted by `lower`, contiguous, non-overlapping (the normaliser asserts it). */
  readonly members: readonly BracketMember[];
  /** `indicator` (Σ members ≤ 1 per game) or `count` (linear per bin) — see BracketKind. */
  readonly kind: BracketKind;
}

/** Total-points rounding (plan 08 E4): only applied once `verified`. */
export type RoundingMode = "exact" | "round_half_up_total" | "floor_total" | (string & {});

/** Negative-points floor scope (plan 08 E4 / §4.4). */
export type NegativeFloorScope = "none" | "player_week_total" | (string & {});

/** Normalised league scoring settings (plan 08 §2; produced by a provider's normaliser). */
export interface ScoringSettings {
  /** The platform the settings came from. */
  readonly platform: PlatformId;
  /** Every rule, mapped or not. */
  readonly rules: readonly ScoringRule[];
  /** Derived bracket families. */
  readonly brackets: readonly BracketFamily[];
  /** Platform flag: fractional points allowed. */
  readonly uses_fractional_points: boolean;
  /** Platform flag: negative totals allowed. */
  readonly uses_negative_points: boolean;
  /** Rounding rule and whether a golden fixture has verified it. */
  readonly rounding: { readonly mode: RoundingMode; readonly verified: boolean };
  /** Negative floor rule and whether a golden fixture has verified it. */
  readonly negative_floor: { readonly scope: NegativeFloorScope; readonly verified: boolean };
  /** sha256 of the canonical JSON of everything above except the `verified` flags (memo key). */
  readonly settings_hash: string;
}

/** A canonical stat line (plan 08 §2). */
export interface StatLine {
  /** Only stats that were present (a present 0 is `0`; an absent stat has no key). */
  readonly values: Readonly<Record<Canonical, number>>;
  /** The present canonical names, sorted ascending (distinguishes 0 from "not reported"). */
  readonly present: readonly Canonical[];
  /** The player's position type in this league (O, K, DT, D). */
  readonly position_type: PositionType;
  /** Research 03 §D.2: week not yet final. */
  readonly provisional: boolean;
  /** Provenance: `yahoo`, `manual`, `nflverse`, `projection:v1-trailing`, … */
  readonly source: string;
}

/** How one rule contributed to a score. */
export interface ScoreContribution {
  /** The stat. */
  readonly canonical: Canonical;
  /** The stat's value in the line. */
  readonly value: number;
  /** Points per unit (or the bonus/bracket points). */
  readonly modifier: number;
  /** Points contributed. */
  readonly points: number;
  /** Which mechanism produced them. */
  readonly kind: "linear" | "bracket" | "bonus";
}

/** `score(line, settings)` result (plan 08 §2). */
export interface ScoreResult {
  /** After rounding/floor rules when verified; exact otherwise. */
  readonly points: number;
  /** Exact arithmetic total. */
  readonly points_exact: number;
  /** False if provisional AND any rule's stat is absent. */
  readonly complete: boolean;
  /** Platform ids in settings with `canonical = null` (reported once per settings_hash). */
  readonly unmapped: readonly string[];
  /** Stats in the line not in the settings. */
  readonly ignored: readonly Canonical[];
  /** Per-rule contributions (`explain`). */
  readonly contributions: readonly ScoreContribution[];
}

/** Where a distribution's width came from (plan 07 legend, plan 08 E8). */
export type DistBasis = "position_cv" | "player_sim";

/** A points distribution (plan 07 legend `Dist`). Born in `scoreSamples`; `basis` travels with it. */
export interface Dist {
  readonly mean: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  /** Probability of exactly zero points (inactive / did not play). */
  readonly p_zero: number;
  /** `position_cv` (v1 CV table around a trailing mean) or `player_sim` (v2 simulation). */
  readonly basis: DistBasis;
}

/** `scoreSamples(lines, settings, basis)` result (plan 08 §2). */
export interface ScoreSamplesResult {
  /** The scored distribution, `basis` copied from the argument. */
  readonly dist: Dist;
  /** Linear part + expected bonus/bracket terms; equals the sample mean within MC error. */
  readonly mean_of_exact: number;
  /** P(bonus fires) per canonical stat. */
  readonly bonus_probability: Readonly<Record<Canonical, number>>;
  /**
   * Per bracket family name (BRACKET_FAMILY_RE keys only): for an `indicator` family the
   * probability of each member; for a `count` family the expected count per member. Member order.
   */
  readonly bracket_probability: Readonly<Record<string, readonly number[]>>;
}

/** The engine's three functions (plan 08 E1). */
export interface ScoringEngine {
  /** Scores one line. */
  score(line: StatLine, settings: ScoringSettings): ScoreResult;
  /** Scores sampled lines into a distribution; `basis` is stamped on the `Dist`. */
  scoreSamples(
    lines: readonly StatLine[],
    settings: ScoringSettings,
    basis: DistBasis,
  ): ScoreSamplesResult;
  /** Same as `score` — named for the tools that render `contributions`. */
  explain(line: StatLine, settings: ScoringSettings): ScoreResult;
}

/**
 * Who a projection (or any per-subject analytics row) is about — defined ONCE (critic C-13): a player
 * by gsis id, or a team defence by its nflverse team. Team defences have no gsis id; they never enter
 * the crosswalk matcher (their identity IS the team), and under ManualLeagueProvider their player key
 * is `manual.p.def-<team lowercase>` (see `manualPlayerKeyFor` in src/domain/league/types.ts).
 */
export type ProjectionSubject =
  | { readonly kind: "player"; readonly gsis_id: string }
  | { readonly kind: "defense"; readonly nfl_team: NflTeam };

/**
 * A stored projection, format-agnostic, scored per league at read time (plan 08 §5, E7). Rows are
 * APPEND-ONLY per (subject, season, week, model_version, made_at): a re-run adds a row, it never
 * overwrites, so the retrospective can read the newest projection made before the subject's lock
 * (`ProjectionRepository.getAsOf`) and no post-kickoff run leaks the outcome into CRPS/pinball.
 */
export interface StoredProjection {
  readonly subject: ProjectionSubject;
  /** Season year. */
  readonly season: number;
  /** Week 1..22. */
  readonly week: number;
  /** Which model produced it. */
  readonly model_version: string;
  /** When it was computed (from the injected Clock). */
  readonly made_at: string;
  /** The newest `as_of` among its inputs (the data it could have seen). */
  readonly inputs_as_of: string;
  /** Expected canonical stat line. */
  readonly expectation: Readonly<Record<Canonical, number>>;
  /** `n_sims` sampled canonical lines. */
  readonly samples: readonly StatLine[];
}

/** Classification of a golden/live mismatch (plan 08 §6 step 3). */
export type MismatchKind = "unmapped_id" | "bracket_bounds" | "flag_semantics" | "translator";
