// venues.ts — the checked-in stadium reference the schedules source writes into `ds_venues`
// (plan 01 §5.2 weather row; research 04 §B7 "stadium lat/lon must come from our own table", §H.7
// resolved here: nflverse `stadium_id` carries no coordinates). Covers every stadium_id in the
// nflverse schedules for 2023–2026 (read from games.parquet on 2026-09-30) plus two venues nflverse
// never coded (Dublin, Berlin — 2025 games filed under the home team's stadium).
//
// Coordinates: the stadium coordinates published in each venue's English Wikipedia article
// (GeoHack), rounded to 4 decimal places (~10 m) — forecast grids are ≥ 1 km, so this precision is
// ample. Zones are IANA names. `roof_default` is the venue's physical roof: `outdoors` (open-air,
// incl. canopies), `dome` (fixed roof), `closed` (retractable — assumed closed when unknown, since a
// retractable roof is closed exactly in the weather that would matter). Where nflverse's own `roof`
// disagrees (it says `dome` for the open-air MCG, Stade de France and Allianz Arena), the physical
// roof wins for open-air and fixed-roof venues (the store reader's gameRoof and the weather sources'
// needsWeather); only a retractable venue's game row carries its own state.
import type { VenueInfo } from "../domain/analytics/types.js";
import type { DatasetRow } from "../store/types.js";

/** A venue plus what the loader needs to resolve it. */
export interface VenueReference extends VenueInfo {
  /** Display name (current). */
  readonly name: string;
  /** Every stadium name nflverse has used for this id (2023–2026), for name-based resolution. */
  readonly names: readonly string[];
  /** ISO 3166-1 alpha-2 country. */
  readonly country: string;
  readonly retractable: boolean;
  /** `nflverse` = an id nflverse uses; `local` = ours, for a venue nflverse never coded. */
  readonly origin: "nflverse" | "local";
}

type Roof = "outdoors" | "dome" | "closed" | "open";

const v = (
  stadium_id: string,
  name: string,
  names: readonly string[],
  tz: string,
  lat: number,
  lon: number,
  roof_default: Roof,
  country: string,
  retractable = false,
  origin: "nflverse" | "local" = "nflverse",
): VenueReference =>
  Object.freeze({
    stadium_id,
    name,
    names: Object.freeze([...names]),
    tz,
    lat,
    lon,
    roof_default,
    country,
    retractable,
    origin,
  });

const NY = "America/New_York";
const CHI = "America/Chicago";
const LA = "America/Los_Angeles";

/** Every venue, sorted by stadium_id. */
// prettier-ignore
export const VENUES: readonly VenueReference[] = Object.freeze([
  v("ATL97", "Mercedes-Benz Stadium", ["Mercedes-Benz Stadium"], NY, 33.7554, -84.4008, "closed", "US", true),
  v("BAL00", "M&T Bank Stadium", ["M&T Bank Stadium"], NY, 39.278, -76.6227, "outdoors", "US"),
  v("BER00", "Olympiastadion Berlin", ["Olympiastadion", "Olympiastadion Berlin"], "Europe/Berlin", 52.5147, 13.2395, "outdoors", "DE", false, "local"),
  v("BOS00", "Gillette Stadium", ["Gillette Stadium"], NY, 42.0909, -71.2643, "outdoors", "US"),
  // The Bills' new Highmark Stadium (2026) sits across the road from the old one, < 0.5 km away.
  v("BUF00", "Highmark Stadium", ["New Era Field", "Highmark Stadium"], NY, 42.7738, -78.787, "outdoors", "US"),
  v("CAR00", "Bank of America Stadium", ["Bank of America Stadium"], NY, 35.2258, -80.8528, "outdoors", "US"),
  v("CHI98", "Soldier Field", ["Soldier Field"], CHI, 41.8623, -87.6167, "outdoors", "US"),
  v("CIN00", "Paycor Stadium", ["Paycor Stadium"], NY, 39.0955, -84.5161, "outdoors", "US"),
  v("CLE00", "Huntington Bank Field", ["FirstEnergy Stadium", "Huntington Bank Field"], NY, 41.5061, -81.6995, "outdoors", "US"),
  v("DAL00", "AT&T Stadium", ["AT&T Stadium"], CHI, 32.7473, -97.0945, "closed", "US", true),
  v("DEN00", "Empower Field at Mile High", ["Empower Field at Mile High"], "America/Denver", 39.7439, -105.0201, "outdoors", "US"),
  v("DET00", "Ford Field", ["Ford Field"], "America/Detroit", 42.34, -83.0456, "dome", "US"),
  v("DUB00", "Croke Park", ["Croke Park"], "Europe/Dublin", 53.3607, -6.2512, "outdoors", "IE", false, "local"),
  v("FRA00", "Deutsche Bank Park", ["Deutsche Bank Park"], "Europe/Berlin", 50.0686, 8.6455, "outdoors", "DE"),
  // GER00 (2024) and MUN01 (2026) are the same building under two nflverse ids.
  v("GER00", "Allianz Arena", ["Allianz Arena"], "Europe/Berlin", 48.2188, 11.6247, "outdoors", "DE"),
  v("GNB00", "Lambeau Field", ["Lambeau Field"], CHI, 44.5013, -88.0622, "outdoors", "US"),
  v("HOU00", "NRG Stadium", ["NRG Stadium", "Reliant Stadium"], CHI, 29.6847, -95.4107, "closed", "US", true),
  v("IND00", "Lucas Oil Stadium", ["Lucas Oil Stadium"], "America/Indiana/Indianapolis", 39.7601, -86.1639, "closed", "US", true),
  // "Tottenham Hotspur Stadium" is deliberately NOT a JAX00 name (nflverse mis-codes one 2026 game).
  v("JAX00", "EverBank Stadium", ["TIAA Bank Stadium", "EverBank Stadium"], NY, 30.3239, -81.6373, "outdoors", "US"),
  v("KAN00", "GEHA Field at Arrowhead Stadium", ["GEHA Field at Arrowhead Stadium", "Arrowhead Stadium"], CHI, 39.0489, -94.4839, "outdoors", "US"),
  v("LAX01", "SoFi Stadium", ["SoFi Stadium"], LA, 33.9535, -118.3392, "dome", "US"),
  v("LON00", "Wembley Stadium", ["Wembley Stadium"], "Europe/London", 51.556, -0.2796, "outdoors", "GB"),
  v("LON02", "Tottenham Hotspur Stadium", ["Tottenham Stadium", "Tottenham Hotspur Stadium"], "Europe/London", 51.6043, -0.0664, "outdoors", "GB"),
  v("MAD01", "Santiago Bernabéu", ["Bernabeu", "Santiago Bernabeu", "Estadio Santiago Bernabeu"], "Europe/Madrid", 40.4531, -3.6883, "closed", "ES", true),
  v("MEL00", "Melbourne Cricket Ground", ["Melbourne Cricket Ground"], "Australia/Melbourne", -37.82, 144.9834, "outdoors", "AU"),
  v("MEX00", "Estadio Banorte", ["Estadio Banorte", "Estadio Azteca"], "America/Mexico_City", 19.3029, -99.1505, "outdoors", "MX"),
  v("MIA00", "Hard Rock Stadium", ["Hard Rock Stadium"], NY, 25.958, -80.2389, "outdoors", "US"),
  v("MIN01", "U.S. Bank Stadium", ["U.S. Bank Stadium"], CHI, 44.9737, -93.2575, "dome", "US"),
  v("MUN01", "FC Bayern Munich Stadium", ["FC Bayern Munich Stadium"], "Europe/Berlin", 48.2188, 11.6247, "outdoors", "DE"),
  v("NAS00", "Nissan Stadium", ["Nissan Stadium"], CHI, 36.1665, -86.7713, "outdoors", "US"),
  v("NOR00", "Caesars Superdome", ["Mercedes-Benz Superdome", "Caesars Superdome"], CHI, 29.9511, -90.0812, "dome", "US"),
  v("NYC01", "MetLife Stadium", ["MetLife Stadium"], NY, 40.8135, -74.0745, "outdoors", "US"),
  v("PAR00", "Stade de France", ["Stade de France"], "Europe/Paris", 48.9245, 2.3602, "outdoors", "FR"),
  v("PHI00", "Lincoln Financial Field", ["Lincoln Financial Field"], NY, 39.9008, -75.1675, "outdoors", "US"),
  v("PHO00", "State Farm Stadium", ["State Farm Stadium"], "America/Phoenix", 33.5276, -112.2626, "closed", "US", true),
  v("PIT00", "Acrisure Stadium", ["Acrisure Stadium"], NY, 40.4468, -80.0158, "outdoors", "US"),
  v("RIO00", "Maracanã Stadium", ["Maracana Stadium", "Maracana"], "America/Sao_Paulo", -22.9122, -43.2302, "outdoors", "BR"),
  v("SAO00", "Arena Corinthians", ["Arena Corinthians", "Neo Quimica Arena"], "America/Sao_Paulo", -23.5453, -46.4742, "outdoors", "BR"),
  v("SEA00", "Lumen Field", ["Lumen Field"], LA, 47.5952, -122.3316, "outdoors", "US"),
  v("SFO01", "Levi's Stadium", ["Levi's Stadium"], LA, 37.403, -121.97, "outdoors", "US"),
  v("TAM00", "Raymond James Stadium", ["Raymond James Stadium"], NY, 27.9759, -82.5033, "outdoors", "US"),
  v("VEG00", "Allegiant Stadium", ["Allegiant Stadium"], LA, 36.0909, -115.1833, "dome", "US"),
  v("WAS00", "Northwest Stadium", ["FedExField", "Northwest Stadium"], NY, 38.9076, -76.8645, "outdoors", "US"),
]);

/**
 * Games whose nflverse stadium fields name the wrong venue and whose name cannot reveal it (2025's
 * international games are filed under the home team's own stadium id AND name). Source: the NFL's
 * 2025 International Series as publicly reported (São Paulo wk 1; Dublin wk 4; London wk 5–7; Berlin
 * wk 10; Madrid wk 11). game_id → stadium_id. tests/sources/nflverse/sources.test.ts holds the
 * property (no non-Super-Bowl neutral-site game resolves to its home team's own stadium) that finds
 * the next one.
 */
export const GAME_VENUE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  "2025_01_KC_LAC": "SAO00",
  "2025_04_MIN_PIT": "DUB00",
  "2025_05_MIN_CLE": "LON02",
  "2025_06_DEN_NYJ": "LON02",
  "2025_07_LA_JAX": "LON00",
  "2025_10_ATL_IND": "BER00",
  "2025_11_WAS_MIA": "MAD01",
});

/**
 * Name normalisation for matching: NFKC, strip combining marks (Maracanã → maracana), lower-case,
 * `'`/`’` removed, other punctuation → space, whitespace collapsed.
 */
export function normalizeVenueName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .trim();
}

const BY_ID: ReadonlyMap<string, VenueReference> = new Map(VENUES.map((x) => [x.stadium_id, x]));

const BY_NAME: ReadonlyMap<string, VenueReference> = (() => {
  const m = new Map<string, VenueReference>();
  for (const x of VENUES) {
    for (const n of x.names) {
      const k = normalizeVenueName(n);
      const prior = m.get(k);
      if (prior && prior !== x) throw new Error(`venues: name ${n} maps to two venues`);
      m.set(k, x);
    }
  }
  return m;
})();

/** Longest input the resolver looks at (nflverse's longest stadium name is 35 chars). */
const MAX_INPUT = 200;

/** The venue for an nflverse (or local) stadium id, or null. Unknown / hostile input → null. */
export function venueById(stadiumId: unknown): VenueReference | null {
  if (typeof stadiumId !== "string" || stadiumId.length > MAX_INPUT) return null;
  return BY_ID.get(stadiumId.trim()) ?? null;
}

/** The venue whose known names include `name` (normalised), or null. */
export function venueByName(name: unknown): VenueReference | null {
  if (typeof name !== "string" || name.length > MAX_INPUT) return null;
  const k = normalizeVenueName(name);
  return k === "" ? null : (BY_NAME.get(k) ?? null);
}

/**
 * `ds_games.venue_id`: the real venue of a game. Precedence: a per-game override
 * (GAME_VENUE_OVERRIDES) → the venue whose known names include the game's `stadium` (so
 * `2026_05_PHI_JAX` — stadium_id JAX00, stadium "Tottenham Hotspur Stadium" — resolves to LON02) →
 * the venue of `stadium_id` → null.
 */
export function resolveVenueId(
  gameId: unknown,
  stadiumId: unknown,
  stadiumName: unknown,
): string | null {
  if (typeof gameId === "string" && Object.hasOwn(GAME_VENUE_OVERRIDES, gameId)) {
    return GAME_VENUE_OVERRIDES[gameId] ?? null;
  }
  return venueByName(stadiumName)?.stadium_id ?? venueById(stadiumId)?.stadium_id ?? null;
}

/** The `ds_venues` rows (tables.ts DS_VENUES column order), for the schedules source to insert. */
export function venueRows(): readonly DatasetRow[] {
  return VENUES.map((x) =>
    Object.freeze({
      stadium_id: x.stadium_id,
      name: x.name,
      tz: x.tz,
      lat: x.lat,
      lon: x.lon,
      roof_default: x.roof_default,
      retractable: x.retractable ? 1 : 0,
      country: x.country,
    }),
  );
}
