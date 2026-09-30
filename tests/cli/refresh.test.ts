// refresh.test.ts — `ff refresh` (plan 01 §5.5, §5.7; plan 06 §1.2 jobs, §2 season awareness, per-job
// lock, notifications): the fixture-mode run publishes real dataset files through the real http
// client/runner/publisher; unchanged releases skip; a failure is exit 1 with a notification; every
// argument is validated; nothing touches the network (fixture transport or a failing fake fetch).
import { existsSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { main } from "../../src/cli/main.js";
import {
  currentSeason,
  defaultSeasons,
  describeResult,
  jobNameFor,
  parseSeasons,
  REFRESH_TARGETS,
  resultJson,
  sourcesFor,
} from "../../src/cli/refresh.js";
import { OSASCRIPT } from "../../src/cli/notify.js";
import { UsageError } from "../../src/cli/exit.js";
import { datasetFilePath } from "../../src/config/paths.js";
import { loadConfig } from "../../src/config/schema.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { FetchLike } from "../../src/http/client.js";
import { NFLVERSE_SOURCES } from "../../src/sources/nflverse/index.js";
import type { RefreshResult } from "../../src/sources/runner.js";
import {
  fakeExec,
  fixtureEnv,
  FIXTURE_NOW,
  makeIo,
  ROOT,
  sandbox,
  type Sandbox,
} from "./helpers.js";

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

// One full fixture run shared by the assertions about ordering (schedules before weather).
let full: { sb: Sandbox; code: number; out: string; err: string } | null = null;
beforeAll(async () => {
  const s = sandbox();
  const io = makeIo(s, { env: fixtureEnv(), clock: fixedClock(FIXTURE_NOW) });
  const code = await main(["refresh", "all", "--seasons", "2026"], io);
  full = { sb: s, code, out: io.out.text, err: io.err.text };
}, 60_000);
afterAll(() => {
  full?.sb.cleanup();
});

describe("ff refresh all (fixture mode)", () => {
  it("publishes every 1a source, schedules first and weather last, and exits 0", () => {
    expect(full?.code).toBe(EXIT.OK);
    const lines = (full?.out ?? "").trim().split("\n");
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual([
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
      "weather:open_meteo",
    ]);
    for (const l of lines) expect(l).toMatch(/ published /);
    // weather saw this run's schedule (re-attached before it ran) and found open-air games
    expect(lines[4]).toMatch(/ [1-9][0-9]* rows/);
    for (const id of Object.keys(NFLVERSE_SOURCES)) {
      expect(existsSync(datasetFilePath(full?.sb.cacheDir ?? "", id))).toBe(true);
    }
    // logs are JSON lines on stderr, never human text
    for (const l of (full?.err ?? "")
      .trim()
      .split("\n")
      .filter((x) => x !== ""))
      expect(() => JSON.parse(l) as unknown).not.toThrow();
  });
});

describe("ff refresh <source>", () => {
  it("publishes, then reports unchanged, then --force re-publishes; --json has fixed fields", async () => {
    const s = sandbox();
    sb = s;
    const run = async (argv: string[]): Promise<{ code: number; out: string }> => {
      const io = makeIo(s, { env: fixtureEnv() });
      return { code: await main(argv, io), out: io.out.text };
    };
    const a = await run(["refresh", "nflverse:injuries", "--seasons", "2026"]);
    expect(a.code).toBe(EXIT.OK);
    expect(a.out).toMatch(
      /^nflverse:injuries\s+published\s+version 20260930T133626Z_2026\s+744 rows/,
    );
    const b = await run(["refresh", "nflverse:injuries", "--seasons", "2026", "--json"]);
    expect(b.code).toBe(EXIT.OK);
    expect(JSON.parse(b.out)).toEqual({
      target: "nflverse:injuries",
      results: [
        {
          source: "nflverse:injuries",
          status: "unchanged",
          version: "20260930T133626Z_2026",
          attempts: 1,
        },
      ],
    });
    const c = await run(["refresh", "nflverse:injuries", "--seasons", "2026", "--force"]);
    expect(c.out).toMatch(/published/);
  }, 30_000);

  it("FF_WEATHER_SOURCE=off skips weather with exit 0", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: { ...fixtureEnv(), FF_WEATHER_SOURCE: "off" } });
    expect(await main(["refresh", "weather"], io)).toBe(EXIT.OK);
    expect(io.out.text).toMatch(/^weather\s+skipped\s+FF_WEATHER_SOURCE=off/);
  });

  it("weather before any schedule is a season-gate skip, not a failure", async () => {
    sb = sandbox();
    const io = makeIo(sb, { env: fixtureEnv() });
    expect(await main(["refresh", "weather"], io)).toBe(EXIT.OK);
    expect(io.out.text).toMatch(/skipped\s+schedules_never_loaded/);
  });

  it("an upstream failure exits 1, records it, and notifies once on macOS with --notify", async () => {
    sb = sandbox();
    const notFound: FetchLike = () => Promise.resolve(new Response(null, { status: 404 }));
    const fx = fakeExec();
    const io = makeIo(sb, { fetch: notFound, platform: "darwin", exec: fx.exec });
    expect(await main(["refresh", "nflverse:injuries", "--notify"], io)).toBe(EXIT.ERROR);
    expect(io.out.text).toMatch(/nflverse:injuries\s+FAILED\s+network/);
    expect(fx.calls).toHaveLength(1);
    expect(fx.calls[0]?.file).toBe(OSASCRIPT);
    expect(fx.calls[0]?.args[1]).toContain("refresh-nflverse-injuries failed: network");
    // without --notify: no notification
    const fx2 = fakeExec();
    const io2 = makeIo(sb, { fetch: notFound, platform: "darwin", exec: fx2.exec });
    expect(await main(["refresh", "nflverse:injuries"], io2)).toBe(EXIT.ERROR);
    expect(fx2.calls).toEqual([]);
    // status shows the failure
    const io3 = makeIo(sb, {});
    await main(["status", "--json"], io3);
    const st = JSON.parse(io3.out.text) as {
      sources: { source: string; consecutive_failures: number; last_error: unknown }[];
    };
    const inj = st.sources.find((s) => s.source === "nflverse:injuries");
    expect(inj?.consecutive_failures).toBe(2);
    expect(inj?.last_error).toMatchObject({ error: "network" });
  }, 30_000);

  it("a store that cannot be opened is exit 1 (and a notification)", async () => {
    sb = sandbox();
    writeFileSync(sb.cacheDir, "a file, not a directory");
    const fx = fakeExec();
    const io = makeIo(sb, { env: fixtureEnv(), platform: "darwin", exec: fx.exec });
    expect(await main(["refresh", "nflverse:schedules", "--notify"], io)).toBe(EXIT.ERROR);
    expect(io.err.text).toContain("the store could not be opened");
    expect(fx.calls[0]?.args[1]).toContain("failed: store");
  });

  it("an aborted run (SIGINT) is exit 1", async () => {
    sb = sandbox();
    const ac = new AbortController();
    ac.abort();
    const io = makeIo(sb, { env: fixtureEnv() });
    expect(
      await main(["refresh", "nflverse", "--seasons", "2026"], io, { signal: ac.signal }),
    ).toBe(EXIT.ERROR);
    expect(io.out.text.trim().split("\n")).toHaveLength(1);
  });

  it("targets and seasons are validated before anything runs", async () => {
    sb = sandbox();
    for (const argv of [
      ["refresh"],
      ["refresh", "nflverse:pbp"],
      ["refresh", "toString"],
      ["refresh", "all", "--seasons", ""],
      ["refresh", "all", "--seasons", "1998"],
      ["refresh", "all", "--seasons", "20266"],
      ["refresh", "all", "--seasons", "2026;rm"],
      ["refresh", "all", "--seasons", ",,"],
      [
        "refresh",
        "all",
        "--seasons",
        Array.from({ length: 31 }, (_, i) => String(2000 + i)).join(","),
      ],
    ]) {
      const io = makeIo(sb, { env: fixtureEnv() });
      expect(await main(argv, io), argv.join(" ")).toBe(EXIT.USAGE);
      expect(existsSync(sb.cacheDir), argv.join(" ")).toBe(false);
    }
  });
});

describe("refresh helpers", () => {
  it("currentSeason: September opens a season; January–August belong to the previous one", () => {
    expect(currentSeason(Date.parse("2026-08-31T23:59:59Z"))).toBe(2025);
    expect(currentSeason(Date.parse("2026-09-01T00:00:00Z"))).toBe(2026);
    expect(currentSeason(Date.parse("2027-02-08T00:00:00Z"))).toBe(2026);
    expect(currentSeason(Date.parse("2026-12-31T23:59:59Z"))).toBe(2026);
  });

  it("parseSeasons sorts and de-duplicates", () => {
    expect(parseSeasons(" 2026, 2025,2026 ")).toEqual([2025, 2026]);
    expect(() => parseSeasons("2101")).toThrow(UsageError);
  });

  it("default seasons: stats and schedules carry the previous season", () => {
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:stats_player_week"], 2026)).toEqual([
      2025, 2026,
    ]);
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:schedules"], 2026)).toEqual([2025, 2026]);
    expect(defaultSeasons(NFLVERSE_SOURCES["nflverse:injuries"], 2026)).toEqual([2026]);
  });

  it("every target maps to sources in refresh order; weather follows FF_WEATHER_SOURCE", () => {
    sb = sandbox();
    const cfg = (ws: string) =>
      loadConfig({
        env: { FF_CONFIG_DIR: sb?.configDir, FF_CACHE_DIR: sb?.cacheDir, FF_WEATHER_SOURCE: ws },
        file: undefined,
        home: sb?.home ?? "/",
        repoRoot: ROOT,
      });
    const ids = (t: (typeof REFRESH_TARGETS)[number], ws = "open-meteo") =>
      sourcesFor(t, cfg(ws)).map((s) => s?.id ?? null);
    expect(ids("all")).toEqual([
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
      "weather:open_meteo",
    ]);
    expect(ids("all", "nws").at(-1)).toBe("weather:nws");
    expect(ids("weather", "off")).toEqual([null]);
    expect(ids("nflverse:daily")).toEqual(["nflverse:injuries", "nflverse:roster_weekly"]);
    expect(ids("nflverse:stats")).toEqual(["nflverse:stats_player_week"]);
    expect(ids("nflverse:stats_player_week")).toEqual(["nflverse:stats_player_week"]);
    expect(ids("nflverse:roster_weekly")).toEqual(["nflverse:roster_weekly"]);
    expect(ids("nflverse:schedules")).toEqual(["nflverse:schedules"]);
    expect(jobNameFor("nflverse:daily")).toBe("refresh-nflverse-daily");
    expect(jobNameFor("all")).toBe("refresh-all");
  });

  it("describeResult / resultJson cover every status with fixed fields only", () => {
    const v = { version: "v1", released_at: null };
    const rs: RefreshResult[] = [
      {
        status: "published",
        source: "nflverse:injuries",
        version: v,
        file: "/f",
        file_version: "v1",
        stats: { rows: 3, tables: [], seasons: [2026], columns_hash: "h" },
        attempts: 1,
        warnings: [],
      },
      { status: "unchanged", source: "nflverse:injuries", version: v, attempts: 1 },
      { status: "skipped", source: "weather:nws", reason: "off_season" },
      {
        status: "failed",
        source: "nflverse:injuries",
        error: "schema",
        message: "schema assertion failed: missing column(s): x",
        version: v,
        attempts: 1,
        schema: null,
      },
    ];
    expect(rs.map(describeResult).map((l) => l.split(/\s+/)[1])).toEqual([
      "published",
      "unchanged",
      "skipped",
      "FAILED",
    ]);
    expect(rs.map((r) => resultJson(r).status)).toEqual([
      "published",
      "unchanged",
      "skipped",
      "failed",
    ]);
    const first = rs[0];
    if (first !== undefined) expect(resultJson(first)).not.toHaveProperty("file");
  });
});
