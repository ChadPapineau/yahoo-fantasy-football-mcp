// scoring.ts — league.yaml scoring → the normalised ScoringSettings every provider emits (plan 01
// §8.1 "the same normalised shape the Yahoo normaliser produces"; plan 08 §2 types, §3.1 canonical
// names, §4.1 bracket families). A preset (`standard` | `half_ppr` | `ppr`, Yahoo's public default
// values) plus explicit per-canonical-stat overrides and threshold bonuses. The manual platform's
// stat id IS the canonical name. `rounding`/`negative_floor` stay unverified (plan 10 A1a).
import { createHash } from "node:crypto";
import {
  BRACKET_FAMILY_KIND,
  KNOWN_CANONICAL,
  type BracketFamily,
  type BracketMember,
  type PositionType,
  type ScoringBonus,
  type ScoringRule,
  type ScoringSettings,
} from "../../domain/scoring/types.js";
import type { LeagueFile } from "./schema.js";

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

/** Bracket ranges (inclusive; null upper = open) by canonical member name (plan 08 §4.1). */
const BRACKET_RANGES: Readonly<
  Record<
    string,
    { family: "dst_points_allowed" | "fg_distance"; lower: number; upper: number | null }
  >
> = Object.freeze({
  dst_pa_0: { family: "dst_points_allowed", lower: 0, upper: 0 },
  dst_pa_1_6: { family: "dst_points_allowed", lower: 1, upper: 6 },
  dst_pa_7_13: { family: "dst_points_allowed", lower: 7, upper: 13 },
  dst_pa_14_20: { family: "dst_points_allowed", lower: 14, upper: 20 },
  dst_pa_21_27: { family: "dst_points_allowed", lower: 21, upper: 27 },
  dst_pa_28_34: { family: "dst_points_allowed", lower: 28, upper: 34 },
  dst_pa_35p: { family: "dst_points_allowed", lower: 35, upper: null },
  fg_0_19: { family: "fg_distance", lower: 0, upper: 19 },
  fg_20_29: { family: "fg_distance", lower: 20, upper: 29 },
  fg_30_39: { family: "fg_distance", lower: 30, upper: 39 },
  fg_40_49: { family: "fg_distance", lower: 40, upper: 49 },
  fg_50p: { family: "fg_distance", lower: 50, upper: null },
});

/** Canonical JSON: object keys sorted, no whitespace (the settings-hash input). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return v === undefined ? "null" : JSON.stringify(v);
}

/** Builds ScoringSettings from a validated `scoring` block. Deterministic for equal inputs. */
export function buildScoringSettings(s: LeagueFile["scoring"]): ScoringSettings {
  const values = new Map<string, number>(Object.entries(BASE_SCORING));
  const rec = PRESET_REC[s.preset];
  if (rec !== 0) values.set("rec", rec);
  for (const [k, v] of Object.entries(s.overrides ?? {}))
    if (typeof v === "number") values.set(k, v);
  const bonuses = new Map<string, ScoringBonus[]>();
  for (const b of s.bonuses ?? []) {
    const list = bonuses.get(b.stat) ?? [];
    list.push(Object.freeze({ target: b.target, points: b.points }));
    bonuses.set(b.stat, list);
    if (!values.has(b.stat)) values.set(b.stat, 0);
  }
  const rules: ScoringRule[] = [];
  for (const c of KNOWN_CANONICAL) {
    const modifier = values.get(c);
    if (modifier === undefined) continue;
    rules.push(
      Object.freeze({
        canonical: c,
        platform_id: c,
        name: c,
        position_types: Object.freeze([positionTypeOf(c)]),
        modifier,
        bonuses: Object.freeze(
          [...(bonuses.get(c) ?? [])].sort((a, b) => a.target - b.target || a.points - b.points),
        ),
      }),
    );
  }
  const brackets: BracketFamily[] = [];
  for (const family of ["dst_points_allowed", "fg_distance"] as const) {
    const members: BracketMember[] = rules
      .flatMap((r) => {
        const range = r.canonical === null ? undefined : BRACKET_RANGES[r.canonical];
        return range?.family === family && r.canonical !== null
          ? [
              Object.freeze({
                canonical: r.canonical,
                platform_id: r.platform_id,
                lower: range.lower,
                upper: range.upper,
              }),
            ]
          : [];
      })
      .sort((a, b) => a.lower - b.lower);
    if (members.length > 0)
      brackets.push(
        Object.freeze({
          family,
          position_type: family === "fg_distance" ? "K" : "DT",
          members: Object.freeze(members),
          kind: BRACKET_FAMILY_KIND[family],
        }),
      );
  }
  const body = {
    platform: "manual" as const,
    rules,
    brackets,
    uses_fractional_points: s.fractional_points ?? true,
    uses_negative_points: s.negative_points ?? true,
    rounding: { mode: "exact" as const },
    negative_floor: { scope: "none" as const },
  };
  const settings_hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return Object.freeze({
    platform: "manual",
    rules: Object.freeze(rules),
    brackets: Object.freeze(brackets),
    uses_fractional_points: body.uses_fractional_points,
    uses_negative_points: body.uses_negative_points,
    rounding: Object.freeze({ mode: "exact", verified: false }),
    negative_floor: Object.freeze({ scope: "none", verified: false }),
    settings_hash,
  });
}
