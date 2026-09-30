// open-meteo.ts — the Open-Meteo hourly forecast provider (research 04 §B7: keyless, CC-BY 4.0
// data, free API for NON-COMMERCIAL use only, 10 000 calls/day; plan 01 §6 ≤ 1 call per venue per
// hour — the hourly job). One GET per venue:
//   /v1/forecast?latitude=…&longitude=…&hourly=temperature_2m,precipitation_probability,
//   wind_speed_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT
// Response (documented shape): { utc_offset_seconds, hourly_units: {…}, hourly: { time: [
// "YYYY-MM-DDTHH:MM", …], temperature_2m: […], … } }. Open-Meteo states no issue time, so `as_of`
// is the fetch instant from the injected Clock.
import { DS_WEATHER_OPEN_METEO } from "../../store/datasets/tables.js";
import type { DataSource, SourceContext } from "../source.js";
import type { VenueReference } from "../venues.js";
import {
  createWeatherSource,
  decodeJson,
  num,
  own,
  percentToFraction,
  toFahrenheit,
  toMph,
  type KickoffForecast,
  type WeatherProvider,
  type WeatherSourceOptions,
} from "./common.js";

/** The forecast endpoint (host on the src/http allow-list). */
export const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
/** Hourly variables requested, in the order the URL lists them. */
export const OPEN_METEO_VARIABLES = [
  "temperature_2m",
  "precipitation_probability",
  "wind_speed_10m",
  "wind_gusts_10m",
] as const;
/** Days of hourly forecast requested (the job only needs the coming week). */
export const OPEN_METEO_FORECAST_DAYS = 8;
/** Largest response accepted (8 days × 24 h × 5 series is ~20 KB). */
export const OPEN_METEO_MAX_BYTES = 2 * 1024 * 1024;

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const HOUR_MS = 3_600_000;

/** The request URL for one venue. */
export function openMeteoUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: OPEN_METEO_VARIABLES.join(","),
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "GMT",
    forecast_days: String(OPEN_METEO_FORECAST_DAYS),
  });
  return `${OPEN_METEO_ENDPOINT}?${q.toString()}`;
}

function series(body: unknown, name: string): readonly unknown[] | null {
  const v = own(own(body, "hourly"), name);
  return Array.isArray(v) ? v : null;
}

function unit(body: unknown, name: string): string | null {
  const u = own(own(body, "hourly_units"), name);
  return typeof u === "string" ? u : null;
}

/** Epoch ms of an Open-Meteo local `YYYY-MM-DDTHH:MM` given the response's UTC offset, or null. */
function timeMs(t: unknown, offsetS: number): number | null {
  if (typeof t !== "string" || !TIME_RE.test(t)) return null;
  const ms = Date.parse(`${t}:00Z`);
  return Number.isFinite(ms) ? ms - offsetS * 1000 : null;
}

/** The Open-Meteo provider. */
export const OPEN_METEO_PROVIDER: WeatherProvider = Object.freeze({
  id: "weather:open_meteo",
  key: "open_meteo",
  table: DS_WEATHER_OPEN_METEO,
  license: "non-commercial",
  limiter: Object.freeze({ minIntervalMs: 200, maxPerDay: 1000 }),
  usOnly: false,
  horizonHours: 7 * 24,
  requiredFields: Object.freeze([
    "time",
    "temperature_2m",
    "wind_speed_10m",
    "precipitation_probability",
  ]),

  async fetchVenue(venue: VenueReference, ctx: SourceContext): Promise<unknown> {
    const res = await ctx.http(openMeteoUrl(venue.lat, venue.lon), {
      signal: ctx.signal,
      maxBytes: OPEN_METEO_MAX_BYTES,
      accept: "application/json",
    });
    return decodeJson(res.body);
  },

  fieldsPresent(body: unknown): ReadonlySet<string> {
    const out = new Set<string>();
    if (series(body, "time") !== null) out.add("time");
    for (const v of OPEN_METEO_VARIABLES) if (series(body, v) !== null) out.add(v);
    return out;
  },

  forecastAt(body: unknown, kickoffMs: number): KickoffForecast | null {
    const times = series(body, "time");
    if (times === null) return null;
    const offset = num(own(body, "utc_offset_seconds")) ?? 0;
    const hourStart = Math.floor(kickoffMs / HOUR_MS) * HOUR_MS;
    const i = times.findIndex((t) => timeMs(t, offset) === hourStart);
    if (i < 0) return null;
    const at = (name: string): number | null => num(series(body, name)?.[i]);
    return {
      hourStartMs: hourStart,
      temp_f: toFahrenheit(at("temperature_2m"), unit(body, "temperature_2m")),
      wind_mph: toMph(at("wind_speed_10m"), unit(body, "wind_speed_10m")),
      gust_mph: toMph(at("wind_gusts_10m"), unit(body, "wind_gusts_10m")),
      precip_prob: percentToFraction(at("precipitation_probability")),
    };
  },

  issueTime(): null {
    return null;
  },
});

/** The `weather:open_meteo` DataSource. */
export function createOpenMeteoSource(opts: WeatherSourceOptions = {}): DataSource {
  return createWeatherSource(OPEN_METEO_PROVIDER, opts);
}
