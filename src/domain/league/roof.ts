// roof.ts — whether a game is played under a roof (season-fresh spec §4.6, SF-10): ONE rule for the
// games reader (src/store/readers.ts gameRoof) and the weather sources (src/sources/weather/common.ts
// needsWeather), so analytics and the published forecasts agree on which games are outdoors. Pure.
//
// The venue table (src/sources/venues.ts) records each stadium's physical roof and is verified
// through REFERENCE_VINTAGES.venues. nflverse's own `roof` is wrong for some venues (it codes the
// open-air MCG, Stade de France and Allianz Arena as `dome`), so the table decides for a venue whose
// roof cannot change under its id — an open-air venue abroad (a neutral site, never rebuilt with a
// roof for an NFL team) or a fixed dome — in every season. A US open-air team stadium may be rebuilt
// with a roof under the same id, so past the table's vintage a known game roof wins for it (and for
// a retractable venue, whose game row carries its state, and a venue the table does not know); the
// schedules publish warns about every disagreement past the vintage, so the table gets re-verified.
import { REFERENCE_VINTAGES } from "../../config/reference-vintage.js";

/** What the rule reads of a venue table entry (ds_venues has the same columns). */
export interface VenueRoofFacts {
  /** `outdoors` | `dome` | `closed` | `open`. */
  readonly roof_default: string;
  readonly retractable: boolean;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
}

/** A roof value lower-cased and trimmed; null when empty or absent. */
export function normalizedRoof(value: string | null | undefined): string | null {
  const r = (value ?? "").trim().toLowerCase();
  return r === "" ? null : r;
}

/**
 * Whether a venue's physical roof stands in every season, the game row notwithstanding: a fixed dome,
 * or an open-air venue outside the US. Never a retractable venue.
 */
export function isRoofFixed(v: VenueRoofFacts): boolean {
  if (v.retractable) return false;
  const roof = normalizedRoof(v.roof_default);
  return roof === "dome" || (roof === "outdoors" && v.country.trim().toUpperCase() !== "US");
}

/**
 * A game's roof (normalised): a venue whose roof cannot change → its physical roof; a season past
 * the venue table's vintage → the game row's roof when known, else the table's; within the vintage
 * → the table's for an open-air or domed venue, the game row's state (else the default) for a
 * retractable one; an unknown venue → the game row's value.
 */
export function gameRoofOf(
  gameRoofValue: string | null | undefined,
  venue: VenueRoofFacts | null,
  season: number,
): string | null {
  const game = normalizedRoof(gameRoofValue);
  if (venue === null) return game;
  const table = normalizedRoof(venue.roof_default);
  if (isRoofFixed(venue)) return table;
  if (season > REFERENCE_VINTAGES.venues.verified_through_season) return game ?? table;
  if (table === "outdoors" || table === "dome") return table;
  return game ?? table;
}

/** Whether a game is played open-air (its roof, by gameRoofOf, is `open` or `outdoors`). */
export function isOpenAir(
  gameRoofValue: string | null | undefined,
  venue: VenueRoofFacts | null,
  season: number,
): boolean {
  const roof = gameRoofOf(gameRoofValue, venue, season);
  return roof === "open" || roof === "outdoors";
}
