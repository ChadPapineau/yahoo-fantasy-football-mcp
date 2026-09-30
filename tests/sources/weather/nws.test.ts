// nws.test.ts — NWS two-step points → forecastHourly (research 04 §B8: public domain, US only,
// User-Agent required). Fixture responses → published ds_weather_nws rows through the real runner
// and src/http client over a fake fetch; a hostile forecastHourly URL is never followed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createHttpClient, DEFAULT_USER_AGENT } from "../../../src/http/client.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import {
  createNwsSource,
  NWS_PROVIDER,
  nwsCoord,
  nwsPointsUrl,
} from "../../../src/sources/weather/nws.js";
import { fakeFetch, type Handler } from "../../http/helpers.js";
import { fakeRefreshLog, fakeSchedules } from "../runner/helpers.js";
import {
  fixtureJson,
  json,
  rowsOf,
  sqlitePublisher,
  WEATHER_NOW,
  weekFiveGames,
} from "./helpers.js";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ff-nws-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(handler: Handler) {
  const f = fakeFetch(handler);
  const publisher = sqlitePublisher();
  const deps: RefreshDeps = {
    http: createHttpClient({ fetch: f.fetch }).get,
    clock: fixedClock(WEATHER_NOW),
    rng: seededRng(5),
    publisher,
    refreshLog: fakeRefreshLog(),
    schedules: fakeSchedules(weekFiveGames()),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
  return { f, publisher, deps };
}

const standard: Handler = (url) =>
  url.includes("/points/")
    ? json(fixtureJson("nws-points.json"))
    : json(fixtureJson("nws-forecast-hourly.json"));

describe("weather:nws — end to end", () => {
  it("points → forecastHourly per US open-air venue; rows at the kickoff hour; as_of = updateTime", async () => {
    const { f, publisher, deps } = setup(standard);
    const r = await runRefresh({ source: createNwsSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    const rows = rowsOf(publisher.db, "ds_weather_nws");
    // Munich is open-air but outside the US: NWS never covers it
    expect(rows.map((x) => x.game_id)).toEqual([
      "2026_05_CHI_GB",
      "2026_05_DAL_CLE",
      "2026_05_JAX_IND",
    ]);
    expect(rows.find((x) => x.game_id === "2026_05_DAL_CLE")).toMatchObject({
      forecast_hour_utc: "2026-10-04T17:00:00.000Z",
      temp_f: 57,
      wind_mph: 15, // "10 to 15 mph" → the upper bound
      gust_mph: null, // forecastHourly states no gust
      precip_prob: 0.3,
      as_of: "2026-10-01T10:43:12.000Z",
    });
    expect(rows.find((x) => x.game_id === "2026_05_JAX_IND")).toMatchObject({
      forecast_hour_utc: "2026-10-05T00:00:00.000Z",
      temp_f: 49,
      wind_mph: 18,
      precip_prob: null,
    });
    expect(f.calls).toHaveLength(6); // 3 venues × (points + hourly)
    for (const c of f.calls) {
      expect(c.headers["user-agent"]).toBe(DEFAULT_USER_AGENT);
      expect(c.headers.accept).toBe("application/geo+json");
    }
    expect(f.calls[0]?.url).toBe("https://api.weather.gov/points/41.5061,-81.6995");
    expect(f.calls[1]?.url).toBe("https://api.weather.gov/gridpoints/CLE/83,65/forecast/hourly");
  });

  it.each([
    "https://evil.example/gridpoints/CLE/83,65/forecast/hourly",
    "https://api.weather.gov/../../etc/passwd",
    "https://api.weather.gov/gridpoints/CLE/83,65/forecast/hourly?redirect=https://evil.example",
    "http://api.weather.gov/gridpoints/CLE/83,65/forecast/hourly",
  ])("a forecastHourly of %s is refused and never requested", async (bad) => {
    const points = fixtureJson("nws-points.json");
    (points.properties as Record<string, unknown>).forecastHourly = bad;
    const { f, deps } = setup((url) =>
      url.includes("/points/") ? json(points) : json(fixtureJson("nws-forecast-hourly.json")),
    );
    const r = await runRefresh({ source: createNwsSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("failed"); // every venue unusable → schema failure, nothing published
    expect(f.calls.every((c) => c.url.includes("/points/"))).toBe(true);
  });

  it("the NWS 301 coordinate normalisation (same host) is followed", async () => {
    const { deps } = setup((url, _i, n) =>
      n === 1
        ? new Response(null, {
            status: 301,
            headers: { location: "https://api.weather.gov/points/41.5061,-81.6995" },
          })
        : standard(url, {}, n),
    );
    const r = await runRefresh({ source: createNwsSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
  });
});

describe("NWS_PROVIDER.forecastAt", () => {
  const k = Date.parse("2026-10-04T17:00:00.000Z");
  const period = (p: Record<string, unknown>) => ({
    properties: {
      periods: [
        { startTime: "garbage", endTime: "2026-10-04T14:00:00-04:00" },
        { startTime: "2026-10-04T13:00:00-04:00", endTime: "2026-10-04T14:00:00-04:00", ...p },
      ],
    },
  });
  it("reads WMO QuantitativeValue forms and °C / km/h", () => {
    expect(
      NWS_PROVIDER.forecastAt(
        period({
          temperature: { unitCode: "wmoUnit:degC", value: 20 },
          windSpeed: { unitCode: "wmoUnit:km_h-1", value: 16.09344 },
          windGust: "20 mph",
          probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: 55 },
        }),
        k,
      ),
    ).toEqual({ hourStartMs: k, temp_f: 68, wind_mph: 10, gust_mph: 20, precip_prob: 0.55 });
  });
  it("temperatureUnit C on a number; km/h in a string; unparsable wind → null", () => {
    expect(
      NWS_PROVIDER.forecastAt(
        period({ temperature: 10, temperatureUnit: "C", windSpeed: "32 km/h" }),
        k,
      ),
    ).toMatchObject({ temp_f: 50, wind_mph: 19.88 });
    expect(
      NWS_PROVIDER.forecastAt(period({ temperature: 60, windSpeed: "calm" }), k),
    ).toMatchObject({
      temp_f: 60,
      wind_mph: null,
      gust_mph: null,
      precip_prob: null,
    });
  });
  it("[QA-1-082] a hostile quantity string is refused in linear time (no regex backtracking)", () => {
    // plan 02 §1 T3 / §6.2: upstream text is untrusted and a bounded body parses in linear time.
    // A digit, a long whitespace run and a non-matching tail cost O(n²) in a regex with adjacent
    // `\s*` runs: 50 k spaces took ~2 s, a 4 MiB hourly body's worth would block for hours.
    const hostile = (n: number): string => `1${" ".repeat(n)}x`;
    for (const n of [50_000, 1_000_000]) {
      const body = period({
        temperature: hostile(n),
        windSpeed: hostile(n),
        windGust: `${"\t".repeat(n)}9`,
        probabilityOfPrecipitation: hostile(n),
      });
      const t0 = performance.now();
      const out = NWS_PROVIDER.forecastAt(body, k);
      const ms = performance.now() - t0;
      expect(ms, `${String(n)} chars took ${ms.toFixed(0)} ms`).toBeLessThan(100);
      expect(out).toMatchObject({ temp_f: null, wind_mph: null, gust_mph: null });
    }
    // the real shapes still parse (padding, ranges, units, case)
    expect(
      NWS_PROVIDER.forecastAt(
        period({ temperature: 60, windSpeed: "  5 to 12 MPH ", windGust: "20mph" }),
        k,
      ),
    ).toMatchObject({ wind_mph: 12, gust_mph: 20 });
  });
  it("no periods or no covering period → null", () => {
    expect(NWS_PROVIDER.forecastAt({}, k)).toBeNull();
    expect(NWS_PROVIDER.forecastAt(period({}), k + 3_600_000)).toBeNull();
  });
  it("issueTime: updateTime, else updated, else null", () => {
    expect(
      NWS_PROVIDER.issueTime({ properties: { updateTime: "2026-10-01T10:43:12+00:00" } }),
    ).toBe("2026-10-01T10:43:12.000Z");
    expect(NWS_PROVIDER.issueTime({ properties: { updated: "2026-10-01T09:00:00Z" } })).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    expect(NWS_PROVIDER.issueTime({ properties: { updateTime: "not a date" } })).toBeNull();
  });
  it("fieldsPresent", () => {
    expect([...NWS_PROVIDER.fieldsPresent(period({ temperature: 1 }))].sort()).toEqual([
      "periods",
      "temperature",
    ]);
    expect(NWS_PROVIDER.fieldsPresent({}).size).toBe(0);
  });
});

describe("NWS helpers and metadata", () => {
  it("coordinates: ≤ 4 decimals, no trailing zeros", () => {
    expect(nwsCoord(42.34)).toBe("42.34");
    expect(nwsCoord(-83.04561)).toBe("-83.0456");
    expect(nwsPointsUrl(42.34, -83.0456)).toBe("https://api.weather.gov/points/42.34,-83.0456");
  });
  it("public-domain license, NWS attribution, US only", () => {
    const s = createNwsSource();
    expect(s.id).toBe("weather:nws");
    expect(s.license).toBe("public-domain");
    expect(s.attribution).toEqual(ATTRIBUTIONS.nws);
    expect(s.versioning).toBe("time_bucket");
    expect(NWS_PROVIDER.usOnly).toBe(true);
    expect(s.tables.map((t) => t.name)).toEqual(["ds_weather_nws"]);
  });
});
