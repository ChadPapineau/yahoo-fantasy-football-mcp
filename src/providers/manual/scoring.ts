// scoring.ts — league.yaml scoring → the normalised ScoringSettings every provider emits (plan 01
// §8.1 "the same normalised shape the Yahoo normaliser produces"; plan 08 §2 types, §3.1 canonical
// names, §4.1 bracket families). A preset (`standard` | `half_ppr` | `ppr`, Yahoo's public default
// values) plus explicit per-canonical-stat overrides and threshold bonuses; the overrides may also
// state missed-FG bins (`fg_miss_*`) and yards-allowed bins (`dst_ya_*`), which the engine scores
// as its bracket families (QA-2-045). A per-position value (a TE premium) cannot be stated: rules
// apply per position type. The manual platform's stat id IS the canonical name.
// `rounding`/`negative_floor` stay unverified (plan 10 A1a).
import { parseBinCanonical } from "../../domain/scoring/brackets.js";
import { normalizeSettings, type RuleDraft } from "../../domain/scoring/settings.js";
import {
  KNOWN_CANONICAL,
  type PositionType,
  type ScoringBonus,
  type ScoringSettings,
} from "../../domain/scoring/types.js";
import { DST_YA_BINS, FG_MISS_BINS, type LeagueFile } from "./schema.js";

/** A scoring preset name. */
export type ScoringPreset = LeagueFile["scoring"]["preset"];

/** Points per reception for each preset. */
export const PRESET_REC: Readonly<Record<ScoringPreset, number>> = Object.freeze({
  standard: 0,
  half_ppr: 0.5,
  ppr: 1,
});

/**
 * Yahoo's public default ("standard") values, shared by every preset except `rec`. Bracket members
 * are listed even at 0 points (`dst_pa_21_27`) so the family stays contiguous.
 */
export const BASE_SCORING: Readonly<Record<string, number>> = Object.freeze({
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -1,
  rush_yd: 0.1,
  rush_td: 6,
  rec_yd: 0.1,
  rec_td: 6,
  ret_td_off: 6,
  two_pt: 2,
  fum_lost: -2,
  off_fum_ret_td: 6,
  fg_0_19: 3,
  fg_20_29: 3,
  fg_30_39: 3,
  fg_40_49: 4,
  fg_50p: 5,
  pat_made: 1,
  dst_pa_0: 10,
  dst_pa_1_6: 7,
  dst_pa_7_13: 4,
  dst_pa_14_20: 1,
  dst_pa_21_27: 0,
  dst_pa_28_34: -1,
  dst_pa_35p: -4,
  dst_sack: 1,
  dst_int: 2,
  dst_fum_rec: 2,
  dst_td: 6,
  dst_safety: 2,
  dst_blk: 2,
  dst_ret_td: 6,
  dst_xpr: 2,
});

/** The position type a canonical stat scores for (kicking → K, `dst_*` → DT, else offence). */
export function positionTypeOf(canonical: string): PositionType {
  if (canonical.startsWith("dst_")) return "DT";
  if (canonical.startsWith("fg_") || canonical.startsWith("pat_")) return "K";
  return "O";
}

/**
 * Why the yards-allowed bins a file lists cannot score, or null (QA-2-045): they must run from 0 to
 * an open-ended bin with no gap or overlap — the engine scores a yardage past a closed last bin in
 * that bin, so `dst_ya_0_99` alone would pay a 450-yard defence. Value-free.
 */
export function yardsAllowedProblem(s: LeagueFile["scoring"]): string | null {
  const bins = DST_YA_BINS.filter((b) => typeof s.overrides?.[b] === "number")
    .map((b) => parseBinCanonical(b))
    .filter((b) => b !== null)
    .sort((a, b) => a.lower - b.lower);
  if (bins.length === 0) return null;
  const contiguous = bins.every((b, i) => i === 0 || (bins[i - 1]?.upper ?? -1) + 1 === b.lower);
  return bins[0]?.lower === 0 && contiguous && bins.at(-1)?.upper === null
    ? null
    : "yards-allowed brackets (dst_ya_*) must run from 0 (dst_ya_0_99) to one open-ended bin (dst_ya_500p or dst_ya_550p) with no gap or overlap; list the bins worth 0 too";
}

/** Canonical JSON (sorted keys, no whitespace) — the scoring engine's one definition. */
export { canonicalJson } from "../../domain/scoring/settings.js";

/**
 * Builds ScoringSettings from a validated `scoring` block. Deterministic for equal inputs. The last
 * step is the scoring engine's own `normalizeSettings` (plan 08 §2), so the manual league gets the
 * same bracket derivation, duplicate checks, negative-floor default (plan 08 §4.4 / P9: scope
 * `player_week_total` when `negative_points: false`) and the one settings_hash definition as every
 * other provider.
 */
export function buildScoringSettings(s: LeagueFile["scoring"]): ScoringSettings {
  const values = new Map<string, number>(Object.entries(BASE_SCORING));
  const rec = PRESET_REC[s.preset];
  if (rec !== 0) values.set("rec", rec);
  // a missed-FG penalty on some bins: the others score 0, so the family stays contiguous
  if (FG_MISS_BINS.some((b) => typeof s.overrides?.[b] === "number"))
    for (const b of FG_MISS_BINS) values.set(b, 0);
  for (const [k, v] of Object.entries(s.overrides ?? {}))
    if (typeof v === "number") values.set(k, v);
  const bonuses = new Map<string, ScoringBonus[]>();
  for (const b of s.bonuses ?? []) {
    const list = bonuses.get(b.stat) ?? [];
    list.push(Object.freeze({ target: b.target, points: b.points }));
    bonuses.set(b.stat, list);
    if (!values.has(b.stat)) values.set(b.stat, 0);
  }
  const rules: RuleDraft[] = [];
  for (const c of [...KNOWN_CANONICAL, ...FG_MISS_BINS, ...DST_YA_BINS]) {
    const modifier = values.get(c);
    if (modifier === undefined) continue;
    rules.push({
      canonical: c,
      platform_id: c,
      name: c,
      position_types: [positionTypeOf(c)],
      modifier,
      bonuses: [...(bonuses.get(c) ?? [])].sort(
        (a, b) => a.target - b.target || a.points - b.points,
      ),
    });
  }
  return normalizeSettings({
    platform: "manual",
    rules,
    uses_fractional_points: s.fractional_points ?? true,
    uses_negative_points: s.negative_points ?? true,
  });
}
