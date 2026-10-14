// reference-vintage.ts — the single registry of reference tables that hold season-dependent facts
// typed in by hand (season-fresh spec §2.7). Each is stamped with the last season it was verified
// against; past that season (plus a grace) the table still works and `ff doctor` row 23 and G1
// `season.reference_past_vintage` say so. Season facts that the schedule data can give are never
// tabled here: they come from the loaded schedule.
import { FLEX_RULES } from "./flex-rules.js";

/** The reference tables with a vintage. */
export type ReferenceId = "venues" | "flex_rules" | "analytics_base_rates";

/** Every reference id, in registry order. */
export const REFERENCE_IDS: readonly ReferenceId[] = Object.freeze([
  "venues",
  "flex_rules",
  "analytics_base_rates",
]);

/** One table's vintage: verified through a season, warning once the season in progress passes it. */
export interface ReferenceVintage {
  readonly id: ReferenceId;
  readonly verified_through_season: number;
  /** Seasons past `verified_through_season` before a warning (0 = warn from the next season). */
  readonly grace_seasons: number;
  readonly source: string;
  readonly checked_on: string;
  /**
   * The seasons each part of the table was estimated from, `[first, last]`, when the table is a set
   * of base rates (the newest `last` is `verified_through_season`). Season years live here, never
   * in the code that uses the rates (tests/lint/season-agnostic.test.ts).
   */
  readonly basis_seasons?: Readonly<Record<string, readonly [number, number]>>;
}

/** The registry. */
export const REFERENCE_VINTAGES: Readonly<Record<ReferenceId, ReferenceVintage>> = Object.freeze({
  venues: Object.freeze({
    id: "venues",
    verified_through_season: 2026,
    grace_seasons: 0,
    source: "src/sources/venues.ts (every stadium_id of the nflverse schedules 2023–2026)",
    checked_on: "2026-09-30",
  }),
  flex_rules: Object.freeze({
    id: "flex_rules",
    verified_through_season: FLEX_RULES.verified_through_season,
    grace_seasons: 0,
    source: FLEX_RULES.source,
    checked_on: FLEX_RULES.checked_on,
  }),
  analytics_base_rates: Object.freeze({
    id: "analytics_base_rates",
    verified_through_season: 2025,
    grace_seasons: 3,
    source: "research 05 base rates through 2025 (src/domain/analytics/constants.ts)",
    checked_on: "2026-09-30",
    basis_seasons: Object.freeze({
      /** Position CVs of weekly fantasy points (half-PPR 2015–2021). */
      position_cv: Object.freeze([2015, 2021] as const),
      /** P(active) by final-report designation (2017–2023). */
      p_active: Object.freeze([2017, 2023] as const),
      /** Same-team weekly correlations (2022–2025). */
      correlation: Object.freeze([2022, 2025] as const),
    }),
  }),
});

/** A table past its vintage for the season in progress. */
export interface VintageWarning {
  readonly id: ReferenceId;
  readonly verified_through_season: number;
}

/** The tables whose vintage (plus grace) the season in progress has passed, in registry order. */
export function pastVintage(seasonInProgress: number): readonly VintageWarning[] {
  const out: VintageWarning[] = [];
  for (const id of REFERENCE_IDS) {
    const v = REFERENCE_VINTAGES[id];
    if (seasonInProgress > v.verified_through_season + v.grace_seasons)
      out.push(Object.freeze({ id, verified_through_season: v.verified_through_season }));
  }
  return Object.freeze(out);
}
