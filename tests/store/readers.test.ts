// readers.test.ts — the domain dataset ports over attached files (plan 01 §5.2/§5.5; READER_QUERIES
// in src/store/datasets/tables.ts; plan 07 §2 stamps): every method's mapping on the fixture-roster
// datasets, the "never loaded" outcome (stamp null, no throw), weather source precedence, the DT
// line (points allowed from schedules, skipped when schedules is absent), hostile and huge
// parameters staying data, and stamps carrying the release instant and check time.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SOURCE_REGISTRY } from "../../src/config/freshness.js";
import type { DatasetPublisher, Store } from "../../src/store/types.js";
import {
  GAME_BUF_MIA,
  GAME_DET_GB,
  PLAYERS,
  SEASON,
  gamesRows,
  injuryRows,
  playerWeekRows,
  publishAllFixtures,
  publishTables,
  rosterRows,
  weatherRows,
} from "./helpers/datasets.js";
import { openPublisher, openStore, tempCache, type TempCache } from "./helpers/env.js";

let t: TempCache;
let pub: DatasetPublisher;
let s: Store;
const warnings: string[] = [];
beforeEach(() => {
  t = tempCache();
  pub = openPublisher(t);
  warnings.length = 0;
});
afterEach(() => {
  s.close();
  pub.close();
  t.cleanup();
});

const open = (extra: Parameters<typeof openStore>[1] = {}): Store =>
  (s = openStore(t, { onWarning: (c) => warnings.push(c), ...extra }));

const p0 = PLAYERS[0];
const kicker = PLAYERS.find((p) => p.position === "K");
if (p0 === undefined || kicker === undefined) throw new Error("fixture roster");

describe("never loaded: every reader answers stamp null, rows [] — never throws", () => {
  it("with no dataset files at all", () => {
    open();
    expect(s.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(s.datasets.schedules.firstKickoff(SEASON, 1)).toBeNull();
    expect(s.datasets.injuries.reports(SEASON, 3, null)).toEqual({ rows: [], stamp: null });
    expect(s.datasets.playerWeeks.lines([p0.gsis_id], SEASON, [1])).toEqual({
      rows: [],
      stamp: null,
    });
    expect(s.datasets.playerWeeks.defenseLines(["DET"], SEASON, [1])).toEqual({
      rows: [],
      stamp: null,
    });
    expect(s.datasets.weather.forGames([GAME_BUF_MIA])).toEqual({ rows: [], stamp: null });
    expect(s.rosterWeekly.latest(SEASON)).toEqual({ rows: [], stamp: null });
    expect(s.rosterWeekly.byPlatformId("yahoo", "30977")).toEqual({ rows: [], stamp: null });
    expect(s.rosterWeekly.byPlatformId("yahoo", "")).toEqual({ rows: [], stamp: null });
    expect(s.attachments()).toEqual([]);
  });
});

describe("with the fixture datasets published", () => {
  beforeEach(async () => {
    await publishAllFixtures(pub);
    open();
  });

  it("attaches all six Phase-1a files at open", () => {
    expect(s.attachments().map((a) => a.source)).toEqual([
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:schedules",
      "nflverse:stats_player_week",
      "weather:nws",
      "weather:open_meteo",
    ]);
    for (const a of s.attachments()) {
      expect(a.schema).toBe(`ds_${a.source.replace(":", "__")}`);
      expect(a.inode).toBeGreaterThan(0);
      expect(a.size_bytes).toBeGreaterThan(0);
    }
  });

  it("ScheduleReader.games maps every field per the contract", () => {
    const r = s.datasets.schedules.games(SEASON, [1]);
    expect(r.stamp).toMatchObject({
      source: "nflverse:schedules",
      as_of: "2026-09-30T09:40:10.000Z",
      file_version: "2026-09-30T15:58:07Z",
      freshness_class: SOURCE_REGISTRY["nflverse:schedules"].freshness,
      fetched_at: t.clock.nowIso(),
      checked_at: t.clock.nowIso(),
    });
    expect(r.rows.map((g) => g.game_id)).toEqual([GAME_DET_GB, GAME_BUF_MIA]); // by kickoff
    const buf = r.rows.find((g) => g.game_id === GAME_BUF_MIA);
    expect(buf).toEqual({
      game_id: GAME_BUF_MIA,
      season: SEASON,
      week: 1,
      kickoff: "2026-09-13T17:00:00.000Z",
      away: "BUF",
      home: "MIA",
      stadium_id: "MIA00",
      stadium: "Hard Rock Stadium",
      venue_tz: "America/New_York",
      roof: "outdoors", // NULL roof → the venue's default
      surface: "grass",
      divisional: true,
      rest_days: { away: 7, home: 7 },
      lines: {
        spread_line: -3.5,
        total_line: 48.5,
        implied: { away: 26, home: 22.5 },
        moneyline: { away: -170, home: 145 },
        as_of: "2026-09-30T09:40:10.000Z",
      },
      is_final: true,
      score: { away: 27, home: 20 },
    });
    const det = r.rows.find((g) => g.game_id === GAME_DET_GB);
    expect(det?.lines).toBeNull();
    expect(det?.is_final).toBe(false);
    expect(det?.score).toBeNull();
    expect(det?.venue_tz).toBe("America/Chicago");
    // a row with a non-NflTeam abbreviation is skipped and warned
    expect(s.datasets.schedules.games(SEASON, [2]).rows).toEqual([]);
    expect(warnings).toContain("dataset_row_skipped_team");
    expect(s.datasets.schedules.games(SEASON, []).rows).toEqual([]);
    expect(s.datasets.schedules.games(2025, [1]).rows.map((g) => g.game_id)).toEqual([
      "2025_01_BUF_NYJ",
    ]);
  });

  it("ScheduleReader.firstKickoff", () => {
    expect(s.datasets.schedules.firstKickoff(SEASON, 1)).toBe("2026-09-11T00:20:00.000Z");
    expect(s.datasets.schedules.firstKickoff(SEASON, 2)).toBeNull(); // only a game without kickoff
    expect(s.datasets.schedules.firstKickoff(SEASON, 17)).toBeNull();
  });

  it("InjuryReader.reports: filter, practice as one 'week' day, primary falls back to practice", () => {
    const all = s.datasets.injuries.reports(SEASON, 3, null);
    expect(all.stamp?.source).toBe("nflverse:injuries");
    expect(all.rows).toHaveLength(2); // the ZZZ row is skipped
    const one = s.datasets.injuries.reports(SEASON, 3, [p0.gsis_id]);
    expect(one.rows).toEqual([
      {
        gsis_id: p0.gsis_id,
        season: SEASON,
        week: 3,
        nfl_team: p0.team,
        report_status: "Questionable",
        practice: [{ day: "week", status: "Limited Participation in Practice" }],
        primary_injury: "Ankle",
        secondary_injury: "Knee",
        as_of: "2026-09-30T09:40:10.000Z",
      },
    ]);
    const other = all.rows.find((r) => r.gsis_id !== p0.gsis_id);
    expect(other?.practice).toEqual([]);
    expect(s.datasets.injuries.reports(SEASON, 3, []).rows).toEqual([]);
    expect(s.datasets.injuries.reports(SEASON, 4, null).rows).toEqual([]);
  });

  it("PlayerWeekReader.lines translates to canonical StatLines (nulls absent, sums, K type)", () => {
    const r = s.datasets.playerWeeks.lines([p0.gsis_id, kicker.gsis_id], SEASON, [1, 2]);
    expect(r.rows).toHaveLength(4);
    expect(r.rows.map((x) => `${x.gsis_id}:${String(x.week)}`)).toEqual(
      [`${p0.gsis_id}:1`, `${p0.gsis_id}:2`, `${kicker.gsis_id}:1`, `${kicker.gsis_id}:2`].sort(),
    );
    const qb = r.rows.find((x) => x.gsis_id === p0.gsis_id && x.week === 1);
    expect(qb?.line.position_type).toBe("O");
    expect(qb?.line.values.pass_yd).toBe(250);
    expect(qb?.line.values.two_pt).toBe(1);
    expect(qb?.line.present).not.toContain("fg_50p");
    expect(qb?.opponent).toBe("MIA");
    const k = r.rows.find((x) => x.gsis_id === kicker.gsis_id && x.week === 1);
    expect(k?.line.position_type).toBe("K");
    expect(k?.line.values).toMatchObject({ fg_40_49: 2, fg_50p: 1, pat_made: 3, pat_miss: 0 });
    expect(k?.line.present).not.toContain("rush_yd");
    expect(k?.line.source).toBe("nflverse");
    expect(s.datasets.playerWeeks.lines([], SEASON, [1]).rows).toEqual([]);
  });

  it("PlayerWeekReader.defenseLines: DT line, points allowed from schedules only when final", () => {
    const r = s.datasets.playerWeeks.defenseLines(["MIA", "DET"], SEASON, [1]);
    expect(r.stamp?.source).toBe("nflverse:stats_player_week");
    const mia = r.rows.find((x) => x.nfl_team === "MIA");
    expect(mia?.opponent).toBe("BUF");
    expect(mia?.line.position_type).toBe("DT");
    expect(mia?.line.values).toEqual({
      dst_sack: 2.5,
      dst_int: 1,
      dst_fum_rec: 0,
      dst_td: 0,
      dst_ret_td: 1,
      dst_safety: 0,
      dst_blk: 1,
      dst_pa: 27,
      dst_ya: 260 - 15 + 110,
    });
    const det = r.rows.find((x) => x.nfl_team === "DET");
    expect(det?.line.present).not.toContain("dst_pa"); // game not final
    expect(det?.line.present).not.toContain("dst_ya"); // opponent had no rows
  });

  it("WeatherReader.forGames: the preferred source first, the other fills the gaps", () => {
    const r = s.datasets.weather.forGames([GAME_BUF_MIA, GAME_DET_GB, "nope"]);
    expect(r.rows.map((w) => `${w.game_id}:${w.source}:${String(w.temp_f)}`)).toEqual([
      `${GAME_BUF_MIA}:weather:open_meteo:81`,
      `${GAME_DET_GB}:weather:nws:60`,
    ]);
    expect(r.stamp?.source).toBe("weather:open_meteo");
    expect(r.rows[0]).toMatchObject({
      wind_mph: 12,
      gust_mph: 20,
      precip_prob: 0.2,
      as_of: "2026-09-12T06:00:00.000Z",
    });
    const empty = s.datasets.weather.forGames([]);
    expect(empty.rows).toEqual([]);
    expect(empty.stamp?.source).toBe("weather:open_meteo");
  });

  it("RosterWeeklyReader.latest / byPlatformId", () => {
    const latest = s.rosterWeekly.latest(SEASON);
    expect(latest.rows).toHaveLength(PLAYERS.length);
    expect(new Set(latest.rows.map((r) => r.week))).toEqual(new Set([3]));
    const allen = latest.rows.find((r) => r.gsis_id === p0.gsis_id);
    expect(allen).toEqual({
      gsis_id: p0.gsis_id,
      season: SEASON,
      week: 3,
      full_name: p0.name,
      team: p0.team,
      position: p0.position,
      jersey_number: p0.jersey,
      yahoo_id: p0.yahoo_id,
      sleeper_id: p0.sleeper_id,
      espn_id: p0.espn_id,
      pfr_id: p0.pfr_id,
      status: "ACT",
    });
    for (const [plat, id] of [
      ["yahoo", p0.yahoo_id],
      ["sleeper", p0.sleeper_id],
      ["espn", p0.espn_id],
    ] as const) {
      const r = s.rosterWeekly.byPlatformId(plat, id ?? "");
      expect(r.rows.map((x) => [x.gsis_id, x.week])).toEqual([[p0.gsis_id, 3]]);
      expect(r.stamp?.source).toBe("nflverse:roster_weekly");
    }
    for (const bad of ["", "   ", "x".repeat(65), "' OR 1=1 --", "30977\u0000"])
      expect(s.rosterWeekly.byPlatformId("yahoo", bad).rows).toEqual([]);
    expect(s.rosterWeekly.byPlatformId("yahoo", "").stamp?.source).toBe("nflverse:roster_weekly");
    expect(() => s.rosterWeekly.byPlatformId("nfl" as never, "1")).toThrow(RangeError);
    expect(s.rosterWeekly.latest(2025).rows).toEqual([]);
  });

  it("hostile and huge list parameters stay data", () => {
    const hostile = ["') OR 1=1 --", '"; DROP TABLE ds_player_week; --', "‮", "💥", "%", "_"];
    expect(s.datasets.playerWeeks.lines(hostile, SEASON, [1]).rows).toEqual([]);
    const huge = Array.from({ length: 20_000 }, (_, i) => `00-${String(i).padStart(7, "0")}`);
    huge.push(p0.gsis_id);
    expect(s.datasets.playerWeeks.lines(huge, SEASON, [1]).rows).toHaveLength(1);
    expect(s.datasets.injuries.reports(SEASON, 3, huge).rows).toHaveLength(1);
    expect(() => s.datasets.playerWeeks.lines([1 as never], SEASON, [1])).toThrow(RangeError);
    expect(() =>
      s.datasets.playerWeeks.lines(new Array<string>(100_001).fill("x"), SEASON, [1]),
    ).toThrow(RangeError);
    expect(() => s.datasets.schedules.games(SEASON, [0])).toThrow(RangeError);
    expect(() => s.datasets.schedules.games(Number.NaN, [1])).toThrow(RangeError);
    expect(() => s.datasets.schedules.firstKickoff(SEASON, 23)).toThrow(RangeError);
    expect(() => s.datasets.schedules.games(SEASON, "1" as never)).toThrow(RangeError);
    expect(() => s.datasets.playerWeeks.lines("x" as never, SEASON, [1])).toThrow(RangeError);
  });
});

describe("partial datasets", () => {
  it("defenseLines without schedules: rows without dst_pa", async () => {
    await publishTables(pub, "nflverse:stats_player_week", "v1", playerWeekRows());
    open();
    const r = s.datasets.playerWeeks.defenseLines(["MIA"], SEASON, [1]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.line.present).not.toContain("dst_pa");
  });

  it("weather: NWS preferred; only one source present; stamp is the first contributing source", async () => {
    await publishTables(pub, "weather:nws", "h1", weatherRows("nws", [GAME_DET_GB], 55), [], null);
    await publishTables(
      pub,
      "weather:open_meteo",
      "h1",
      weatherRows("open_meteo", [GAME_BUF_MIA, GAME_DET_GB], 70),
      [],
      null,
    );
    open({ weatherSource: "weather:nws" });
    const r = s.datasets.weather.forGames([GAME_BUF_MIA, GAME_DET_GB]);
    expect(r.rows.map((w) => w.source)).toEqual(["weather:open_meteo", "weather:nws"]);
    expect(r.stamp?.source).toBe("weather:nws");
    const only = s.datasets.weather.forGames([GAME_BUF_MIA]);
    expect(only.stamp?.source).toBe("weather:open_meteo");
    const none = s.datasets.weather.forGames(["zzz"]);
    expect(none.stamp?.source).toBe("weather:nws"); // attached but no rows: not "never loaded"
  });

  it("a stamp's checked_at advances with recordUnchanged; as_of falls back to the publish time", async () => {
    await publishTables(pub, "nflverse:roster_weekly", "r1", rosterRows([1]), [SEASON], null);
    open();
    expect(s.rosterWeekly.latest(SEASON).stamp).toMatchObject({
      as_of: t.clock.nowIso(),
      checked_at: t.clock.nowIso(),
    });
    t.clock.advance(3_600_000);
    await pub.recordUnchanged("nflverse:roster_weekly", "r1", t.clock.nowIso());
    const st = s.rosterWeekly.latest(SEASON).stamp;
    expect(st?.checked_at).toBe(t.clock.nowIso());
    expect(st?.fetched_at).not.toBe(st?.checked_at);
  });

  it("a garbage file in ds/ is never served (warned, treated as never loaded)", async () => {
    const { writeFileSync } = await import("node:fs");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(t.datasetDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${t.datasetDir}/nflverse__schedules.sqlite`, "this is not sqlite ".repeat(100), {
      mode: 0o600,
    });
    open();
    expect(s.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_attach_failed");
  });

  it("an empty or table-less file in ds/ is never served", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(t.datasetDir, { recursive: true, mode: 0o700 });
    writeFileSync(`${t.datasetDir}/nflverse__schedules.sqlite`, "", { mode: 0o600 });
    open();
    expect(s.datasets.schedules.games(SEASON, [1])).toEqual({ rows: [], stamp: null });
    expect(warnings).toContain("dataset_tables_missing");
  });

  it("a symlinked dataset file is refused", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    const { renameSync, symlinkSync } = await import("node:fs");
    const f = `${t.datasetDir}/nflverse__schedules.sqlite`;
    renameSync(f, `${t.root}/elsewhere.sqlite`);
    symlinkSync(`${t.root}/elsewhere.sqlite`, f);
    open();
    expect(s.datasets.schedules.games(SEASON, [1]).stamp).toBeNull();
    expect(warnings).toContain("dataset_symlink_refused");
  });

  it("a file whose dataset_meta names another source is refused", async () => {
    await publishTables(pub, "nflverse:injuries", "v1", injuryRows());
    const { renameSync } = await import("node:fs");
    renameSync(
      `${t.datasetDir}/nflverse__injuries.sqlite`,
      `${t.datasetDir}/nflverse__schedules.sqlite`,
    );
    open();
    expect(s.datasets.schedules.games(SEASON, [1]).stamp).toBeNull();
    expect(warnings).toContain("dataset_source_mismatch");
  });

  it("a throwing warning sink never breaks a read", async () => {
    await publishTables(pub, "nflverse:schedules", "v1", gamesRows());
    open({
      onWarning: () => {
        throw new Error("sink");
      },
    });
    expect(s.datasets.schedules.games(SEASON, [2]).rows).toEqual([]);
  });
});
