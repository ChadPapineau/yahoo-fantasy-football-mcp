// nws.ts — the National Weather Service provider (research 04 §B8: US government data, public
// domain, US venues only; a User-Agent is REQUIRED — src/http sends DEFAULT_USER_AGENT; plan 01 §6
// ≤ 1 call per venue per hour). Two steps per venue:
//   1. GET /points/{lat},{lon} → properties.forecastHourly (validated: https://api.weather.gov/
//      gridpoints/{WFO}/{x},{y}/forecast/hourly — anything else is refused, never followed);
//   2. GET that URL → properties.periods[] { startTime, endTime, temperature, temperatureUnit,
//      windSpeed ("10 mph" | "5 to 10 mph"), windGust?, probabilityOfPrecipitation{value} } and
//      properties.updateTime (the issue time, stored as `as_of`). forecastHourly carries no gust in
//      its usual shape, so `gust_mph` is null unless a period states one.
import { DS_WEATHER_NWS } from "../../store/datasets/tables.js";
import type { DataSource, SourceContext } from "../source.js";
import type { VenueReference } from "../venues.js";
import {
  createWeatherSource,
  decodeJson,
  isoOrNull,
  num,
  own,
  percentToFraction,
  toFahrenheit,
  toMph,
  type KickoffForecast,
  type WeatherProvider,
  type WeatherSourceOptions,
} from "./common.js";

/** The API root (host on the src/http allow-list). */
export const NWS_ENDPOINT = "https://api.weather.gov";
/** The only forecastHourly URL shape followed. */
export const NWS_FORECAST_HOURLY_RE =
  /^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/\d{1,4},\d{1,4}\/forecast\/hourly$/;
export const NWS_POINTS_MAX_BYTES = 1024 * 1024;
export const NWS_HOURLY_MAX_BYTES = 4 * 1024 * 1024;
const ACCEPT = "application/geo+json";
/**
 * Longest quantity string parsed ("5 to 10 mph" is 11 characters). Upstream text is untrusted (plan
 * 02 §1 T3) and an hourly body may be 4 MiB: anything longer is refused BEFORE any regex runs.
 */
export const NWS_QUANTITY_TEXT_MAX = 32;
// Matched against the trimmed text with whitespace runs collapsed to one space, so no two
// quantifiers compete for the same characters (a `\s*…\s*` pair backtracks in O(n²) — QA-1-082).
const WIND_RE = /^(\d{1,3}(?:\.\d{1,3})?)(?: ?to ?(\d{1,3}(?:\.\d{1,3})?))? ?(mph|km\/h)?$/i;

/** A coordinate as NWS wants it: ≤ 4 decimals, no trailing zeros (avoids its 301 normalisation). */
export function nwsCoord(x: number): string {
  return String(Number(x.toFixed(4)));
}

/** The points URL for one venue. */
export function nwsPointsUrl(lat: number, lon: number): string {
  return `${NWS_ENDPOINT}/points/${nwsCoord(lat)},${nwsCoord(lon)}`;
}

/** A value that is a number, a numeric string with a unit, or a WMO QuantitativeValue. */
function quantity(
  v: unknown,
  fallbackUnit: string | null,
): { value: number | null; unit: string | null } {
  if (typeof v === "number") return { value: num(v), unit: fallbackUnit };
  if (typeof v === "string") {
    if (v.length > NWS_QUANTITY_TEXT_MAX) return { value: null, unit: null };
    const m = WIND_RE.exec(v.trim().replace(/\s+/g, " "));
    if (m === null) return { value: null, unit: null };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    return { value: Math.max(a, b), unit: m[3] === undefined ? "mph" : m[3].toLowerCase() };
  }
  const value = num(own(v, "value"));
  const code = own(v, "unitCode");
  return { value, unit: typeof code === "string" ? code : fallbackUnit };
}

function periods(body: unknown): readonly unknown[] | null {
  const p = own(own(body, "properties"), "periods");
  return Array.isArray(p) ? p : null;
}

/** The NWS provider. */
export const NWS_PROVIDER: WeatherProvider = Object.freeze({
  id: "weather:nws",
  key: "nws",
  table: DS_WEATHER_NWS,
  license: "public-domain",
  limiter: Object.freeze({ minIntervalMs: 500, maxPerDay: 2000 }),
  usOnly: true,
  horizonHours: 156,
  requiredFields: Object.freeze(["periods", "temperature", "windSpeed"]),

  async fetchVenue(venue: VenueReference, ctx: SourceContext): Promise<unknown> {
    const points = await ctx.http(nwsPointsUrl(venue.lat, venue.lon), {
      signal: ctx.signal,
      maxBytes: NWS_POINTS_MAX_BYTES,
      accept: ACCEPT,
    });
    const hourly = own(own(decodeJson(points.body), "properties"), "forecastHourly");
    if (typeof hourly !== "string" || !NWS_FORECAST_HOURLY_RE.test(hourly))
      throw new Error("nws: points response has no valid forecastHourly URL");
    const res = await ctx.http(hourly, {
      signal: ctx.signal,
      maxBytes: NWS_HOURLY_MAX_BYTES,
      accept: ACCEPT,
    });
    return decodeJson(res.body);
  },

  fieldsPresent(body: unknown): ReadonlySet<string> {
    const out = new Set<string>();
    const ps = periods(body);
    if (ps === null) return out;
    out.add("periods");
    for (const f of ["temperature", "windSpeed", "probabilityOfPrecipitation", "windGust"]) {
      if (ps.some((p) => own(p, f) !== undefined)) out.add(f);
    }
    return out;
  },

  forecastAt(body: unknown, kickoffMs: number): KickoffForecast | null {
    const ps = periods(body);
    if (ps === null) return null;
    for (const p of ps) {
      const start = isoOrNull(own(p, "startTime"));
      const end = isoOrNull(own(p, "endTime"));
      if (start === null || end === null) continue;
      const s = Date.parse(start);
      const e = Date.parse(end);
      if (!(s <= kickoffMs && kickoffMs < e)) continue;
      const tu = own(p, "temperatureUnit");
      const t = quantity(own(p, "temperature"), typeof tu === "string" ? tu : "F");
      const w = quantity(own(p, "windSpeed"), "mph");
      const g = quantity(own(p, "windGust"), "mph");
      const pop = quantity(own(p, "probabilityOfPrecipitation"), "percent");
      return {
        hourStartMs: s,
        temp_f: toFahrenheit(t.value, t.unit),
        wind_mph: toMph(w.value, w.unit),
        gust_mph: toMph(g.value, g.unit),
        precip_prob: percentToFraction(pop.value),
      };
    }
    return null;
  },

  issueTime(body: unknown): string | null {
    const props = own(body, "properties");
    return isoOrNull(own(props, "updateTime")) ?? isoOrNull(own(props, "updated"));
  },
});

/** The `weather:nws` DataSource. */
export function createNwsSource(opts: WeatherSourceOptions = {}): DataSource {
  return createWeatherSource(NWS_PROVIDER, opts);
}
