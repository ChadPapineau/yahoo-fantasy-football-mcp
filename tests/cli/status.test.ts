// status.test.ts — `ff status` (plan 01 §7 snapshot; plan 06 J2/§3): per-source state judged by the
// class's basis, never loaded / expired shown red, the store never created or migrated by a read.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../../src/cli/exit.js";
import { labelOf, launchAgentsDir } from "../../src/cli/launchd.js";
import { main } from "../../src/cli/main.js";
import { formatAge, renderStatus, type StatusReport } from "../../src/cli/status.js";
import { datasetFilePath, storePath } from "../../src/config/paths.js";
import { fixedClock } from "../../src/domain/clock.js";
import { copyCache, fixtureEnv, makeIo, sandbox, type Sandbox } from "./helpers.js";

const REFRESHED_AT = "2026-09-30T18:00:00.000Z";
let template: Sandbox | undefined;
beforeAll(async () => {
  template = sandbox();
  const io = makeIo(template, { env: fixtureEnv(), clock: fixedClock(REFRESHED_AT) });
  expect(await main(["refresh", "nflverse", "--seasons", "2026"], io)).toBe(EXIT.OK);
}, 60_000);
afterAll(() => {
  template?.cleanup();
});

let sb: Sandbox | undefined;
afterEach(() => {
  sb?.cleanup();
  sb = undefined;
});

function refreshed(): Sandbox {
  const s = sandbox();
  sb = s;
  copyCache(template?.cacheDir ?? "", s.cacheDir);
  return s;
}

async function report(
  s: Sandbox,
  at = REFRESHED_AT,
  over: Parameters<typeof makeIo>[1] = {},
): Promise<{ code: number; r: StatusReport; text: string }> {
  const io = makeIo(s, { env: fixtureEnv(), clock: fixedClock(at), ...over });
  const code = await main(["status", "--json"], io);
  const r = JSON.parse(io.out.text) as StatusReport;
  const io2 = makeIo(s, { env: fixtureEnv(), clock: fixedClock(at), ...over });
  await main(["status"], io2);
  return { code, r, text: io2.out.text };
}

describe("ff status", () => {
  it("on a fresh install: exit 0, store missing, every source never loaded, nothing created", async () => {
    const s = sandbox();
    sb = s;
    const { code, r, text } = await report(s);
    expect(code).toBe(EXIT.OK);
    expect(r.store.state).toBe("missing");
    expect(r.sources.map((x) => x.state)).toEqual(Array(5).fill("never_loaded"));
    expect(r.journal).toBeNull();
    expect(existsSync(s.cacheDir)).toBe(false);
    expect(text).toContain("store   MISSING");
    expect(text).toContain("run `ff refresh all` (5 source(s)");
  });

  it("after a refresh: nflverse fresh with versions and rows; weather never loaded; journal empty", async () => {
    const s = refreshed();
    const { code, r, text } = await report(s, "2026-09-30T18:05:00.000Z");
    expect(code).toBe(EXIT.OK);
    expect(r.store).toMatchObject({ state: "ok", schema_version: 1, binary_schema_version: 1 });
    const by = Object.fromEntries(r.sources.map((x) => [x.source, x]));
    expect(by["nflverse:injuries"]).toMatchObject({
      state: "fresh",
      rows: 744,
      file_present: true,
      consecutive_failures: 0,
      last_error: null,
      seasons: [2026],
    });
    expect(by["nflverse:injuries"]?.age_s).toBe(300);
    expect(by["weather:open_meteo"]?.state).toBe("never_loaded");
    expect(r.journal).toEqual({ counts: {}, oldest_pending_age_s: null });
    expect(r.config.fixture_mode).toBe(true);
    expect(text).toMatch(/nflverse:injuries\s+fresh\s+5m\s+20260930T133626Z_2026 \/ 744/);
    expect(text).toMatch(/weather:open_meteo\s+NEVER LOADED/);
  });

  it("ten days later: injuries (36 h) and stats (3 d) are EXPIRED; one day later injuries is STALE", async () => {
    const s = refreshed();
    const later = await report(s, "2026-10-10T18:00:00.000Z");
    const by = Object.fromEntries(later.r.sources.map((x) => [x.source, x.state]));
    expect(by["nflverse:injuries"]).toBe("expired");
    expect(by["nflverse:stats_player_week"]).toBe("expired");
    expect(later.text).toMatch(/EXPIRED/);
    const dayLater = await report(s, "2026-10-01T18:00:01.000Z");
    expect(
      Object.fromEntries(dayLater.r.sources.map((x) => [x.source, x.state]))["nflverse:injuries"],
    ).toBe("stale");
  });

  it("a dataset file deleted behind the store's back reads as never loaded", async () => {
    const s = refreshed();
    rmSync(datasetFilePath(s.cacheDir, "nflverse:injuries"));
    const { r } = await report(s);
    expect(r.sources.find((x) => x.source === "nflverse:injuries")).toMatchObject({
      state: "never_loaded",
      file_present: false,
    });
  });

  it("a store from a newer version is reported, never migrated or rewritten", async () => {
    const s = refreshed();
    const db = new DatabaseSync(storePath(s.cacheDir));
    db.exec(
      "INSERT INTO schema_version (version, applied_at) VALUES (99, '2030-01-01T00:00:00.000Z')",
    );
    db.close();
    const { code, r, text } = await report(s);
    expect(code).toBe(EXIT.OK);
    expect(r.store).toMatchObject({ state: "newer", schema_version: 99 });
    expect(text).toContain("newer version (v99)");
    const db2 = new DatabaseSync(storePath(s.cacheDir));
    expect(db2.prepare("SELECT MAX(version) AS v FROM schema_version").get()).toEqual({ v: 99 });
    db2.close();
  });

  it("an unreadable store file is exit 1", async () => {
    const s = sandbox();
    sb = s;
    mkdirSync(s.cacheDir, { mode: 0o700 });
    writeFileSync(storePath(s.cacheDir), "this is not a database, just text padding ".repeat(200), {
      mode: 0o600,
    });
    const { code, r } = await report(s);
    expect(code).toBe(EXIT.ERROR);
    expect(r.store.state).toBe("error");
  });

  it("launchd block: installed/missing jobs on macOS; unsupported elsewhere", async () => {
    const s = sandbox();
    sb = s;
    mkdirSync(launchAgentsDir(s.home), { recursive: true });
    writeFileSync(path.join(launchAgentsDir(s.home), `${labelOf("weather")}.plist`), "x");
    const mac = await report(s, REFRESHED_AT, { platform: "darwin" });
    expect(mac.r.launchd.installed).toEqual(["weather"]);
    expect(mac.r.launchd.missing).toHaveLength(5);
    expect(mac.text).toContain("launchd: 1/6 jobs installed");
    const lin = await report(s, REFRESHED_AT, { platform: "linux" });
    expect(lin.r.launchd.supported).toBe(false);
    expect(lin.text).toContain("not available on this platform");
    rmSync(launchAgentsDir(s.home), { recursive: true });
    const none = await report(s, REFRESHED_AT, { platform: "darwin" });
    expect(none.text).toContain("no jobs installed");
  });

  it("weather off drops the weather row; nws names the nws source", async () => {
    const s = sandbox();
    sb = s;
    const off = await report(s, REFRESHED_AT, {
      env: { ...fixtureEnv(), FF_WEATHER_SOURCE: "off" },
    });
    expect(off.r.sources.map((x) => x.source)).not.toContain("weather:open_meteo");
    const nws = await report(s, REFRESHED_AT, {
      env: { ...fixtureEnv(), FF_WEATHER_SOURCE: "nws" },
    });
    expect(nws.r.sources.map((x) => x.source)).toContain("weather:nws");
  });
});

describe("rendering helpers", () => {
  it("formatAge boundaries", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(89)).toBe("89s");
    expect(formatAge(90)).toBe("2m");
    expect(formatAge(5399)).toBe("90m");
    expect(formatAge(5400)).toBe("2h");
    expect(formatAge(36 * 3600)).toBe("2d");
  });

  it("renderStatus prints warnings and pending journal counts", () => {
    const r: StatusReport = {
      version: "0.0.0",
      node: "24.21.0",
      generated_at: REFRESHED_AT,
      config: {
        config_dir: "/c",
        cache_dir: "/k",
        league_file: "/c/league.yaml",
        weather_source: "off",
        toolset: "core",
        fixture_mode: false,
        warnings: ["w1"],
      },
      store: {
        state: "pending",
        path: "/k/store.sqlite",
        size_bytes: null,
        schema_version: 0,
        binary_schema_version: 1,
        cache_misses_busy: null,
        message: "pending",
      },
      sources: [],
      journal: { counts: { prepared: 1, sent_unknown: 2 }, oldest_pending_age_s: 5 },
      launchd: { supported: true, installed: ["weather"], missing: [] },
    };
    const text = renderStatus(r).join("\n");
    expect(text).toContain("warning: w1");
    expect(text).toContain("journal pending writes: 3");
    expect(text).toContain("store   PENDING: pending");
    expect(text).toContain("launchd: 1/1 jobs installed —");
  });
});
