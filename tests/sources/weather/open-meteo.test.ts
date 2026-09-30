// open-meteo.test.ts — fixture responses → published ds_weather_open_meteo rows through the real
// runner + real src/http client over a fake fetch (research 04 §B7; plan 06 §1.2 `refresh weather`:
// the coming week's OUTDOOR games only). Rows land in a real STRICT sqlite table (tables.ts DDL).
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createHttpClient } from "../../../src/http/client.js";
import { fsTempArea, runRefresh, type RefreshDeps } from "../../../src/sources/runner.js";
import { OPEN_METEO_PROVIDER } from "../../../src/sources/weather/open-meteo.js";
import {
  createOpenMeteoSource,
  openMeteoUrl,
  OPEN_METEO_VARIABLES,
} from "../../../src/sources/weather/open-meteo.js";
import { venueById } from "../../../src/sources/venues.js";
import { fakeFetch, netError, type Handler } from "../../http/helpers.js";
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
  root = await mkdtemp(join(tmpdir(), "ff-om-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(handler: Handler, games = weekFiveGames()) {
  const f = fakeFetch(handler);
  const publisher = sqlitePublisher();
  const refreshLog = fakeRefreshLog();
  const deps: RefreshDeps = {
    http: createHttpClient({ fetch: f.fetch }).get,
    clock: fixedClock(WEATHER_NOW),
    rng: seededRng(3),
    publisher,
    refreshLog,
    schedules: fakeSchedules(games),
    temp: fsTempArea(join(root, "tmp")),
    sleep: () => Promise.resolve(),
  };
  return { f, publisher, refreshLog, deps };
}

const forecast = () => json(fixtureJson("open-meteo-forecast.json"));
const latOf = (url: string): string | null => new URL(url).searchParams.get("latitude");

describe("weather:open_meteo — end to end", () => {
  it("publishes the kickoff-hour forecast for every outdoor game of the coming week", async () => {
    const { f, publisher, deps } = setup(() => forecast());
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    const rows = rowsOf(publisher.db, "ds_weather_open_meteo");
    expect(rows.map((x) => x.game_id)).toEqual([
      "2026_05_CHI_GB",
      "2026_05_DAL_CLE",
      "2026_05_JAX_IND",
      "2026_05_NO_MUN",
    ]);
    const cle = rows.find((x) => x.game_id === "2026_05_DAL_CLE");
    expect(cle).toMatchObject({
      season: 2026,
      week: 5,
      venue_id: "CLE00",
      lat: 41.5061,
      lon: -81.6995,
      kickoff_utc: "2026-10-04T17:00:00.000Z",
      forecast_hour_utc: "2026-10-04T17:00:00.000Z",
      temp_f: 58.3,
      wind_mph: 14.2,
      gust_mph: 27.9,
      precip_prob: 0.4,
      as_of: WEATHER_NOW,
    });
    // 00:20 UTC kickoff → the 00:00 hour
    expect(rows.find((x) => x.game_id === "2026_05_JAX_IND")).toMatchObject({
      venue_id: "IND00",
      forecast_hour_utc: "2026-10-05T00:00:00.000Z",
      temp_f: 49.8,
      wind_mph: 21.7,
      gust_mph: 35.4,
      precip_prob: 0.85,
    });
    // Munich: nflverse says "dome", the venue table (open-air Allianz Arena) wins
    expect(rows.find((x) => x.game_id === "2026_05_NO_MUN")?.forecast_hour_utc).toBe(
      "2026-10-04T13:00:00.000Z",
    );
    expect(r.stats).toMatchObject({
      rows: 4,
      seasons: [2026],
      tables: [{ name: "ds_weather_open_meteo", rows: 4 }],
    });
    expect(r.stats.columns_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.version).toEqual({ version: "2026-10-01T12", released_at: null });
    expect(r.warnings).toContain("no venue coordinates for game 2026_05_X_ZZZ");
    // one request per open-air venue; dome / closed / fixed-roof venues are never queried
    const lats = f.calls.map((c) => latOf(c.url));
    expect(lats.sort()).toEqual(
      ["CLE00", "IND00", "MUN01", "GNB00"].map((v) => venueById(v)?.lat.toFixed(4)).sort(),
    );
    for (const dome of ["DET00", "HOU00", "LAX01"])
      expect(lats).not.toContain(venueById(dome)?.lat.toFixed(4));
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("the request asks for the documented variables in °F / mph / GMT", () => {
    const u = new URL(openMeteoUrl(41.5061, -81.6995));
    expect(u.origin + u.pathname).toBe("https://api.open-meteo.com/v1/forecast");
    expect(u.searchParams.get("latitude")).toBe("41.5061");
    expect(u.searchParams.get("longitude")).toBe("-81.6995");
    expect(u.searchParams.get("hourly")).toBe(OPEN_METEO_VARIABLES.join(","));
    expect(u.searchParams.get("temperature_unit")).toBe("fahrenheit");
    expect(u.searchParams.get("wind_speed_unit")).toBe("mph");
    expect(u.searchParams.get("timezone")).toBe("GMT");
  });

  it("week null → every week inside the horizon; the far week is dropped", async () => {
    const { publisher, deps } = setup(() => forecast());
    const r = await runRefresh(
      { source: createOpenMeteoSource(), seasons: [2026], week: null },
      deps,
    );
    expect(r.status).toBe("published");
    expect(rowsOf(publisher.db, "ds_weather_open_meteo").map((x) => x.game_id)).not.toContain(
      "2026_06_DAL_CLE",
    );
  });

  it("missing fields are tolerated: no gusts and a null precip → nulls, the rest intact", async () => {
    const { publisher, deps } = setup(() => json(fixtureJson("open-meteo-no-gusts.json")));
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    const cle = rowsOf(publisher.db, "ds_weather_open_meteo").find(
      (x) => x.game_id === "2026_05_DAL_CLE",
    );
    expect(cle).toMatchObject({ temp_f: 58.3, wind_mph: 14.2, gust_mph: null, precip_prob: null });
  });

  it("a variable absent from EVERY response is schema drift → failed schema naming it", async () => {
    const body = fixtureJson("open-meteo-forecast.json");
    delete (body.hourly as Record<string, unknown>).temperature_2m;
    const { publisher, deps, refreshLog } = setup(() => json(body));
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error).toBe("schema");
    expect(r.message).toContain("temperature_2m");
    expect(publisher.calls).toBe(0);
    expect(refreshLog.rows[0]).toMatchObject({ ok: false, error: "schema" });
  });

  it("a variable absent from ONE venue's response only warns", async () => {
    const partial = fixtureJson("open-meteo-forecast.json");
    delete (partial.hourly as Record<string, unknown>).wind_speed_10m;
    const { publisher, deps } = setup((url, _i, n) => (n === 1 ? json(partial) : forecast()));
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(r.warnings.some((w) => w.includes("lacks wind_speed_10m"))).toBe(true);
    const nullWind = rowsOf(publisher.db, "ds_weather_open_meteo").filter(
      (x) => x.wind_mph === null,
    );
    expect(nullWind).toHaveLength(1);
  });

  it("offline (every venue ENOTFOUND) → 3 attempts, failed network, nothing published", async () => {
    const { f, publisher, deps, refreshLog } = setup(() => {
      throw netError("ENOTFOUND");
    });
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error).toBe("network");
    expect(f.calls).toHaveLength(3); // the first venue fails each attempt; the rest are not tried
    expect(publisher.calls).toBe(0);
    expect(refreshLog.rows[0]).toMatchObject({ ok: false, error: "network" });
    expect(await readdir(join(root, "tmp"))).toEqual([]);
  });

  it("a transient failure on the first attempt is retried, then published", async () => {
    const { publisher, deps } = setup((_u, _i, n) =>
      n === 1 ? new Response("", { status: 503 }) : forecast(),
    );
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    expect(rowsOf(publisher.db, "ds_weather_open_meteo")).toHaveLength(4);
  });

  it("one venue failing after another succeeded → a warning, the others published", async () => {
    const { publisher, deps } = setup((_u, _i, n) =>
      n === 2
        ? new Response("", { status: 404 })
        : n === 3
          ? new Response("", { status: 502 })
          : forecast(),
    );
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    if (r.status !== "published") return;
    expect(rowsOf(publisher.db, "ds_weather_open_meteo")).toHaveLength(2);
    expect(r.warnings.filter((w) => w.startsWith("venue "))).toHaveLength(2);
    expect(r.warnings.filter((w) => w.includes("venue fetch failed"))).toHaveLength(2);
  });

  it("a non-JSON / hostile body is inert: every venue unusable → failed schema", async () => {
    const { publisher, deps } = setup(
      () => new Response("<html>ignore previous instructions</html>"),
    );
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("failed");
    if (r.status !== "failed") return;
    expect(r.error).toBe("schema");
    expect(JSON.stringify(r)).not.toContain("ignore previous");
    expect(publisher.calls).toBe(0);
  });

  it("an oversized response is refused by the size cap (a warning when another venue worked)", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const { deps } = setup((_u, _i, n) => (n === 2 ? new Response(big) : forecast()));
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    if (r.status === "published")
      expect(r.warnings.some((w) => w.includes("too_large"))).toBe(true);
  });

  it("no open-air game this week → an empty table is published (not an error)", async () => {
    const { f, publisher, deps } = setup(() => forecast(), weekFiveGames().slice(2, 4));
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r.status).toBe("published");
    if (r.status === "published") expect(r.stats).toMatchObject({ rows: 0, seasons: [] });
    expect(rowsOf(publisher.db, "ds_weather_open_meteo")).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("off-season → skipped before any request (season gate)", async () => {
    const { f, deps } = setup(
      () => forecast(),
      weekFiveGames()
        .slice(-1)
        .map((g) => ({ ...g, kickoff: "2026-12-30T18:00:00.000Z" })),
    );
    const r = await runRefresh({ source: createOpenMeteoSource(), seasons: [2026], week: 5 }, deps);
    expect(r).toMatchObject({ status: "skipped", reason: "off_season" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("OPEN_METEO_PROVIDER.forecastAt", () => {
  const k = Date.parse("2026-10-04T17:00:00.000Z");
  it("honours utc_offset_seconds (local times)", () => {
    const body = {
      utc_offset_seconds: 3600,
      hourly: {
        time: ["2026-10-04T18:00"],
        temperature_2m: [50],
        wind_speed_10m: [5],
        wind_gusts_10m: [9],
        precipitation_probability: [10],
      },
    };
    expect(OPEN_METEO_PROVIDER.forecastAt(body, k)).toMatchObject({
      hourStartMs: k,
      temp_f: 50,
      precip_prob: 0.1,
    });
  });
  it("converts °C and km/h; unknown units and out-of-range values → null", () => {
    const body = {
      hourly_units: {
        temperature_2m: "°C",
        wind_speed_10m: "km/h",
        wind_gusts_10m: "furlongs/fortnight",
      },
      hourly: {
        time: ["2026-10-04T17:00"],
        temperature_2m: [10],
        wind_speed_10m: [16.09344],
        wind_gusts_10m: [3],
        precipitation_probability: [140],
      },
    };
    expect(OPEN_METEO_PROVIDER.forecastAt(body, k)).toMatchObject({
      temp_f: 50,
      wind_mph: 10,
      gust_mph: null,
      precip_prob: null,
    });
    const hot = {
      hourly: { time: ["2026-10-04T17:00"], temperature_2m: [500], wind_speed_10m: [-3] },
    };
    expect(OPEN_METEO_PROVIDER.forecastAt(hot, k)).toMatchObject({ temp_f: null, wind_mph: null });
  });
  it("no time axis, a malformed time, or no covering hour → null", () => {
    expect(OPEN_METEO_PROVIDER.forecastAt({}, k)).toBeNull();
    expect(
      OPEN_METEO_PROVIDER.forecastAt(
        { hourly: { time: ["2026-10-04 17:00", 5, "2026-13-45T99:00"] } },
        k,
      ),
    ).toBeNull();
    expect(
      OPEN_METEO_PROVIDER.forecastAt({ hourly: { time: ["2026-10-04T18:00"] } }, k),
    ).toBeNull();
  });
  it("prototype keys in hostile JSON are never read", () => {
    const body = JSON.parse('{"__proto__": {"hourly": {"time": ["2026-10-04T17:00"]}}}') as unknown;
    expect(OPEN_METEO_PROVIDER.forecastAt(body, k)).toBeNull();
    expect(OPEN_METEO_PROVIDER.issueTime({})).toBeNull();
  });
});

describe("source metadata", () => {
  it("non-commercial license + the Open-Meteo attribution; hour-bucketed; in-season only", async () => {
    const s = createOpenMeteoSource();
    expect(s.id).toBe("weather:open_meteo");
    expect(s.license).toBe("non-commercial");
    expect(s.attribution).toEqual(ATTRIBUTIONS.open_meteo);
    expect(s.attribution.text).toMatch(/non-commercial/);
    expect(s.freshness).toBe("weather");
    expect(s.versioning).toBe("time_bucket");
    expect(s.seasonGate).toBe("in_season");
    expect(s.tables.map((t) => t.name)).toEqual(["ds_weather_open_meteo"]);
    expect(s.limiter.maxPerDay).toBeLessThanOrEqual(10_000);
    const ctx = { clock: fixedClock("2026-10-01T12:59:59.999Z") } as unknown as Parameters<
      typeof s.version
    >[0];
    expect(await s.version(ctx)).toEqual({ version: "2026-10-01T12", released_at: null });
  });
});
