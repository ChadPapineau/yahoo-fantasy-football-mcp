// common.test.ts — the shared weather machinery: roof decision, game selection, unit conversion,
// the per-run temp file and its schema assertion, and the FF_WEATHER_SOURCE switch (plan 01 §5.2;
// plan 06 §1.2). Adversarial: hostile JSON, truncated/oversized/foreign temp files, aborts.
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import type { SourceContext } from "../../../src/sources/source.js";
import { venueById, type VenueReference } from "../../../src/sources/venues.js";
import {
  columnsHash,
  createWeatherSource,
  decodeJson,
  hourBucket,
  inRange,
  isoOrNull,
  MAX_WEATHER_FILE_BYTES,
  needsWeather,
  num,
  own,
  percentToFraction,
  readWeatherFile,
  safeId,
  selectGames,
  toFahrenheit,
  toMph,
  venueOf,
  WEATHER_FILE_FORMAT,
  type WeatherProvider,
} from "../../../src/sources/weather/common.js";
import { weatherSourceFor } from "../../../src/sources/weather/index.js";
import { OPEN_METEO_PROVIDER } from "../../../src/sources/weather/open-meteo.js";
import { DS_WEATHER_NWS, DS_WEATHER_OPEN_METEO } from "../../../src/store/datasets/tables.js";
import { fakeSchedules, game, recordingWriter } from "../runner/helpers.js";
import { WEATHER_NOW, weekFiveGames } from "./helpers.js";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ff-wx-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(over: Partial<SourceContext> = {}): SourceContext {
  return {
    http: () => Promise.reject(new Error("no network")),
    signal: new AbortController().signal,
    clock: fixedClock(WEATHER_NOW),
    seasons: [2026],
    week: 5,
    datasets: { schedules: fakeSchedules(weekFiveGames()) },
    tempDir: dir,
    ...over,
  };
}

const venue = (id: string): VenueReference => {
  const v = venueById(id);
  if (v === null) throw new Error(id);
  return v;
};

describe("roof decision (grounding open issue: the physical roof wins)", () => {
  it.each([
    ["CLE00", "outdoors", true],
    ["CLE00", null, true],
    ["CLE00", "dome", true], // an open-air venue nflverse mislabels
    ["MEL00", "dome", true],
    ["PAR00", "dome", true],
    ["MUN01", "dome", true],
    ["DET00", "outdoors", false], // a fixed dome is never open
    ["LAX01", "outdoors", false],
    ["HOU00", null, false], // retractable, unknown → assumed closed
    ["HOU00", "closed", false],
    ["HOU00", "dome", false],
    ["HOU00", "open", true],
    ["IND00", " Outdoors ", true],
  ])("%s with game roof %j → %s", (id, roof, expected) => {
    expect(needsWeather({ roof }, venue(id))).toBe(expected);
  });

  it("venueOf: resolved id first, then the stadium name, else null", () => {
    expect(venueOf({ stadium_id: "CLE00", stadium: "Lambeau Field" })?.stadium_id).toBe("CLE00");
    expect(venueOf({ stadium_id: null, stadium: "Lambeau Field" })?.stadium_id).toBe("GNB00");
    expect(venueOf({ stadium_id: "nope", stadium: "nope" })).toBeNull();
  });
});

describe("selectGames", () => {
  const P = { usOnly: false, horizonHours: 168 };
  it("the target week's games inside [now − 1 h, now + horizon], deduplicated", () => {
    const sch = fakeSchedules(weekFiveGames());
    const s = selectGames(ctx({ datasets: { schedules: sch } }), P, {});
    expect(s.games.map((g) => g.game_id).sort()).toEqual([
      "2026_05_CHI_GB",
      "2026_05_DAL_CLE",
      "2026_05_JAX_IND",
      "2026_05_NO_MUN",
    ]);
    expect([...s.venues.keys()].sort()).toEqual(["CLE00", "GNB00", "IND00", "MUN01"]);
    expect(sch.queries).toEqual([{ season: 2026, weeks: [5] }]);
    expect(s.warnings).toEqual(["no venue coordinates for game 2026_05_X_ZZZ"]);
  });
  it("US only drops Munich; the newest season is used; no seasons → nothing", () => {
    const s = selectGames(ctx({ seasons: [2025, 2026] }), { usOnly: true, horizonHours: 156 }, {});
    expect(s.games.map((g) => g.venue_id)).not.toContain("MUN01");
    expect(selectGames(ctx({ seasons: [] }), P, {}).games).toEqual([]);
  });
  it("an injected game list replaces the schedules reader; hostile ids are elided in warnings", () => {
    const sch = fakeSchedules([]);
    const s = selectGames(ctx({ datasets: { schedules: sch } }), P, {
      games: () => [
        game("bad id\n<x>", "2026-10-04T17:00:00.000Z", { stadium_id: "??", stadium: "??" }),
      ],
    });
    expect(s.warnings).toEqual(["no venue coordinates for game ?"]);
    expect(sch.queries).toEqual([]);
  });
  it("a garbage kickoff string is skipped", () => {
    const s = selectGames(ctx(), P, { games: () => [game("g", "next sunday")] });
    expect(s.games).toEqual([]);
  });
});

describe("small readers and unit conversions", () => {
  it("own never walks the prototype; num only finite numbers", () => {
    expect(own({ a: 1 }, "a")).toBe(1);
    expect(own({}, "toString")).toBeUndefined();
    expect(own([1], "0")).toBeUndefined();
    expect(own(null, "a")).toBeUndefined();
    expect([num(1), num(Number.NaN), num("1"), num(Number.POSITIVE_INFINITY)]).toEqual([
      1,
      null,
      null,
      null,
    ]);
  });
  it("conversions and ranges", () => {
    expect(toFahrenheit(0, "°C")).toBe(32);
    expect(toFahrenheit(0, "wmoUnit:degC")).toBe(32);
    expect(toFahrenheit(70, null)).toBe(70);
    expect(toFahrenheit(70, "K")).toBeNull();
    expect(toFahrenheit(null, "F")).toBeNull();
    expect(toMph(10, "m/s")).toBe(22.37);
    expect(toMph(10, "kn")).toBe(11.51);
    expect(toMph(10, null)).toBe(10);
    expect(toMph(10, "__proto__")).toBeNull();
    expect(toMph(null, "mph")).toBeNull();
    expect(percentToFraction(50)).toBe(0.5);
    expect(percentToFraction(-1)).toBeNull();
    expect(percentToFraction(null)).toBeNull();
    expect(inRange(Number.NaN, 0, 1)).toBeNull();
  });
  it("isoOrNull / decodeJson / safeId / hourBucket / columnsHash", () => {
    expect(isoOrNull("2026-10-04T13:00:00-04:00")).toBe("2026-10-04T17:00:00.000Z");
    expect(isoOrNull("x".repeat(100))).toBeNull();
    expect(isoOrNull(5)).toBeNull();
    expect(decodeJson(new TextEncoder().encode('{"a":1}'))).toEqual({ a: 1 });
    expect(decodeJson(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(decodeJson(new TextEncoder().encode("[".repeat(100_000)))).toBeUndefined();
    expect(safeId("2026_05_A_B")).toBe("2026_05_A_B");
    expect(safeId(42)).toBe("?");
    expect(hourBucket(Date.parse("2026-10-01T23:59:59.999Z"))).toBe("2026-10-01T23");
    expect(columnsHash(DS_WEATHER_OPEN_METEO)).toBe(columnsHash(DS_WEATHER_NWS)); // same column set
    expect(columnsHash(DS_WEATHER_OPEN_METEO)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the temp file", () => {
  const src = createWeatherSource(OPEN_METEO_PROVIDER);
  const write = async (name: string, v: unknown): Promise<string> => {
    const p = join(dir, name);
    await writeFile(p, typeof v === "string" ? v : JSON.stringify(v));
    return p;
  };
  const valid = {
    format: WEATHER_FILE_FORMAT,
    provider: "open_meteo",
    fetched_at: WEATHER_NOW,
    games: [],
    responses: [],
    warnings: ["w", 5],
  };

  it("readWeatherFile validates format, provider and shape", async () => {
    expect((await readWeatherFile(await write("ok.json", valid), "open_meteo")).warnings).toEqual([
      "w",
    ]);
    await expect(readWeatherFile(await write("p.json", valid), "nws")).rejects.toThrow(
      /format or provider/,
    );
    await expect(
      readWeatherFile(await write("f.json", { ...valid, format: "v0" }), "open_meteo"),
    ).rejects.toThrow();
    await expect(
      readWeatherFile(await write("i.json", { ...valid, games: "nope" }), "open_meteo"),
    ).rejects.toThrow(/incomplete/);
    await expect(
      readWeatherFile(await write("t.json", '{"format":'), "open_meteo"),
    ).rejects.toThrow();
    await expect(readWeatherFile(dir, "open_meteo")).rejects.toThrow(/missing or too large/);
    const big = join(dir, "big.json");
    await writeFile(big, "{}");
    await truncate(big, MAX_WEATHER_FILE_BYTES + 1);
    await expect(readWeatherFile(big, "open_meteo")).rejects.toThrow(/too large/);
    const noWarn = await write("nw.json", { ...valid, warnings: "x" });
    expect((await readWeatherFile(noWarn, "open_meteo")).warnings).toEqual([]);
  });

  it("assertSchema: exactly one readable file; zero games is fine", async () => {
    const bad = async (files: { path: string; bytes: number; season: null }[]) =>
      src.assertSchema(files);
    expect((await bad([])).ok).toBe(false);
    const p = await write("a.json", valid);
    expect(
      (
        await bad([
          { path: p, bytes: 1, season: null },
          { path: p, bytes: 1, season: null },
        ])
      ).ok,
    ).toBe(false);
    expect((await bad([{ path: join(dir, "missing"), bytes: 1, season: null }])).warnings).toEqual([
      "the weather file is unreadable",
    ]);
    expect(await bad([{ path: p, bytes: 1, season: null }])).toMatchObject({ ok: true, rows: 0 });
  });

  it("publish: no file → throws; an empty game list → an empty table", async () => {
    const w = recordingWriter();
    await expect(src.publish([], w)).rejects.toThrow(/nothing to publish/);
    const p = await write("e.json", valid);
    const stats = await src.publish([{ path: p, bytes: 1, season: null }], w);
    expect(stats).toMatchObject({
      rows: 0,
      seasons: [],
      tables: [{ name: "ds_weather_open_meteo", rows: 0 }],
    });
    expect(w.tables.map((t) => t.name)).toEqual(["ds_weather_open_meteo"]);
  });

  it("fetch without a runner temp dir refuses; the file is written 0600 and exclusive", async () => {
    const { tempDir: _t, ...noTemp } = ctx();
    await expect(src.fetch({ version: "v", released_at: null }, noTemp)).rejects.toThrow(/tempDir/);
    const files = await src.fetch(
      { version: "v", released_at: null },
      ctx({ datasets: { schedules: fakeSchedules([]) } }),
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.season).toBeNull();
    await expect(
      src.fetch(
        { version: "v", released_at: null },
        ctx({ datasets: { schedules: fakeSchedules([]) } }),
      ),
    ).rejects.toThrow(/EEXIST/);
  });
});

describe("fetch loop edge cases", () => {
  const provider = (fetchVenue: WeatherProvider["fetchVenue"]): WeatherProvider => ({
    ...OPEN_METEO_PROVIDER,
    fetchVenue,
  });
  it("an abort between venues stops the run", async () => {
    const ac = new AbortController();
    const s = createWeatherSource(
      provider(() => {
        ac.abort();
        return Promise.resolve({ hourly: { time: [] } });
      }),
    );
    await expect(
      s.fetch({ version: "v", released_at: null }, ctx({ signal: ac.signal })),
    ).rejects.toMatchObject({
      kind: "aborted",
    });
  });
  it("an aborted HttpError from a venue is rethrown even after successes", async () => {
    let n = 0;
    const s = createWeatherSource(
      provider(() => {
        n++;
        return n === 1 ? Promise.resolve({}) : Promise.reject(new HttpError({ kind: "aborted" }));
      }),
    );
    await expect(s.fetch({ version: "v", released_at: null }, ctx())).rejects.toBeInstanceOf(
      HttpError,
    );
  });
  it("a transient failure AFTER a success only warns; a non-HttpError failure warns 'invalid response'", async () => {
    let n = 0;
    const s = createWeatherSource(
      provider(() => {
        n++;
        if (n === 1) return Promise.resolve({ hourly: { time: [] } });
        if (n === 2) return Promise.reject(new HttpError({ kind: "reset" }));
        return Promise.reject(new Error("bad shape"));
      }),
    );
    const files = await s.fetch({ version: "v", released_at: null }, ctx());
    const report = await s.assertSchema(files);
    expect(report.warnings.filter((w) => w.startsWith("venue "))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(": reset"),
        expect.stringContaining(": invalid response"),
      ]),
    );
  });
});

describe("weatherSourceFor (FF_WEATHER_SOURCE)", () => {
  it("open-meteo | nws | off", () => {
    expect(weatherSourceFor("open-meteo")?.id).toBe("weather:open_meteo");
    expect(weatherSourceFor("nws")?.id).toBe("weather:nws");
    expect(weatherSourceFor("off")).toBeNull();
  });
});
