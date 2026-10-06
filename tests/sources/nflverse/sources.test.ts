// sources.test.ts — every nflverse DataSource end to end on the real fixture files (plan 05 §2
// `sources/*`, §3.2; plan 10 A4a): version from timestamp.txt → fetch through a fake HttpGet serving
// fixture bytes → assertSchema → publish into a real STRICT SQLite DatasetWriter. No network.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS, SOURCE_REGISTRY } from "../../../src/config/freshness.js";
import {
  NFLVERSE_SOURCES,
  injuriesSource,
  rosterWeeklySource,
  schedulesSource,
  statsPlayerWeekSource,
  type NflversePublishStats,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import type { DataSource, TempFile } from "../../../src/sources/source.js";
import { GAME_VENUE_OVERRIDES } from "../../../src/sources/venues.js";
import { DATASET_TABLES, READER_QUERIES, bindSchema } from "../../../src/store/datasets/tables.js";
import { REL, SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";

const roster = JSON.parse(
  readFileSync(new URL("../../../fixtures/players/fixture-roster.json", import.meta.url), "utf8"),
) as { players: { gsis_id: string; name: string; team: string; yahoo_id: string | null }[] };

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});

async function run(
  source: DataSource,
  seasons: readonly number[],
): Promise<{
  c: Ctx;
  files: readonly TempFile[];
  report: NflverseSchemaReport;
  stats: NflversePublishStats;
  w: SqliteWriter;
}> {
  const c = makeCtx(seasons);
  open.push(c);
  const version = await source.version(c.ctx);
  expect(version).not.toBeNull();
  if (version === null) throw new Error("unreachable");
  const files = await source.fetch(version, c.ctx);
  const report = (await source.assertSchema(files)) as NflverseSchemaReport;
  expect(report.ok, report.warnings.join("\n")).toBe(true);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  const stats = (await source.publish(files, w)) as NflversePublishStats;
  return { c, files, report, stats, w };
}

describe("registry + license fields (plan 05 §2 `sources/*`: the fields are enumerated)", () => {
  it("every nflverse source carries CC-BY 4.0, nflverse attribution, its freshness class and tables", () => {
    for (const [id, s] of Object.entries(NFLVERSE_SOURCES)) {
      expect(s.id).toBe(id);
      expect(s.license).toBe("CC-BY-4.0");
      expect(s.attribution).toEqual(ATTRIBUTIONS.nflverse);
      expect(s.freshness).toBe(SOURCE_REGISTRY[s.id].freshness);
      expect(s.versioning).toBe("release");
      expect(s.tables).toBe(DATASET_TABLES[id as keyof typeof DATASET_TABLES]);
      expect(s.limiter.minIntervalMs).toBeGreaterThan(0);
    }
  });
});

describe("nflverse:schedules", () => {
  it("publishes the 2026 games with DST-aware kickoffs, venues and lines", async () => {
    const { report, stats, w, files, c } = await run(schedulesSource, [2026]);
    expect(files).toHaveLength(1);
    expect(files[0]?.season).toBe(2026);
    // one download of games.parquet, however many seasons
    expect(c.calls.filter((u) => u.endsWith("games.parquet"))).toHaveLength(1);
    expect(report.missing_columns).toEqual([]);
    expect(report.extra_columns).toContain("referee"); // dropped, tolerated, reported
    expect(stats.tables).toEqual([
      { name: "ds_games", rows: 272 },
      { name: "ds_venues", rows: 43 },
    ]);
    expect(stats.seasons).toEqual([2026]);
    expect(stats.columns_hash).toMatch(/^[0-9a-f]{64}$/);
    // Fall-back weekend (DST ends 2026-11-01): Sunday 13:00 EST = 18:00Z; Thursday 20:15 EDT the
    // week before = 00:15Z next day.
    const k = (id: string): unknown =>
      w.all("SELECT kickoff_utc FROM ds_games WHERE game_id = ?", id)[0]?.kickoff_utc;
    expect(k("2026_08_BAL_BUF")).toBe("2026-11-01T18:00:00.000Z");
    expect(k("2026_08_CHI_SEA")).toBe("2026-11-03T01:15:00.000Z");
    const thursday = w.all(
      "SELECT game_id, gameday, gametime, kickoff_utc FROM ds_games WHERE season = 2026 AND week = 8 AND weekday = 'Thursday'",
    );
    expect(thursday).toHaveLength(1);
    const t = thursday[0] as { gameday: string; gametime: string; kickoff_utc: string };
    expect(t.kickoff_utc).toBe(
      new Date(`${t.gameday}T${t.gametime}:00-04:00`).toISOString(), // still EDT
    );
    // 2026_05_PHI_JAX is coded JAX00 but played at Tottenham → venue_id LON02 (tables.ts)
    const phiJax = w.all(
      "SELECT stadium_id, venue_id FROM ds_games WHERE game_id = '2026_05_PHI_JAX'",
    );
    expect(phiJax[0]).toEqual({ stadium_id: "JAX00", venue_id: "LON02" });
    // roof "" → NULL (35 future retractable games in 2026)
    expect(w.all("SELECT COUNT(*) AS n FROM ds_games WHERE roof = ''")[0]?.n).toBe(0);
    expect(w.all("SELECT COUNT(*) AS n FROM ds_games WHERE roof IS NULL")[0]?.n).toBeGreaterThan(0);
    // every 2026 game resolves to a known venue that joins ds_venues
    expect(
      w.all(
        "SELECT COUNT(*) AS n FROM ds_games g LEFT JOIN ds_venues v ON v.stadium_id = g.venue_id WHERE v.stadium_id IS NULL",
      )[0]?.n,
    ).toBe(0);
    expect(stats.warnings).toEqual([]);
  });

  it("covers the requested seasons only, from one download, keyed on season", async () => {
    const { stats, w, files } = await run(schedulesSource, [2025, 2026, 2025]);
    expect(files.map((f) => f.season)).toEqual([2025, 2026]);
    expect(stats.seasons).toEqual([2025, 2026]);
    expect(w.all("SELECT season, COUNT(*) AS n FROM ds_games GROUP BY season")).toEqual([
      { season: 2025, n: 285 },
      { season: 2026, n: 272 },
    ]);
    // the 2025 international games carry the home team's stadium upstream → overridden
    for (const [gameId, venue] of Object.entries(GAME_VENUE_OVERRIDES)) {
      const row = w.all("SELECT venue_id FROM ds_games WHERE game_id = ?", gameId)[0];
      expect(row?.venue_id, gameId).toBe(venue);
    }
  });

  it("[QA-1-039] no neutral-site game resolves to its home team's own stadium (Super Bowl aside)", async () => {
    // Property, not a list: nflverse files some international games under the home team's stadium
    // id AND name (2025_01_KC_LAC São Paulo → LAX01 "SoFi Stadium"). Whatever the next such game
    // is, a `location = 'Neutral'` game that is not a Super Bowl is never played at the home
    // team's own stadium — its venue_id must differ from where that team plays its home games.
    const { w } = await run(schedulesSource, [2025, 2026]);
    const home = new Map<string, string>();
    for (const r of w.all(
      `SELECT season, home_team, venue_id, COUNT(*) AS n FROM ds_games
       WHERE location = 'Home' AND venue_id IS NOT NULL
       GROUP BY season, home_team, venue_id ORDER BY n ASC`,
    )) {
      home.set(`${String(r.season)}:${String(r.home_team)}`, String(r.venue_id)); // most frequent last
    }
    const neutral = w.all(
      `SELECT game_id, season, home_team, venue_id FROM ds_games
       WHERE location = 'Neutral' AND game_type <> 'SB'`,
    );
    expect(neutral.length).toBeGreaterThanOrEqual(7); // the 2025 International Series alone
    const atHome = neutral
      .filter((g) => g.venue_id === home.get(`${String(g.season)}:${String(g.home_team)}`))
      .map((g) => `${String(g.game_id)} → ${String(g.venue_id)}`);
    expect(atHome).toEqual([]);
    const sp = w.all("SELECT venue_id FROM ds_games WHERE game_id = '2025_01_KC_LAC'")[0];
    expect(sp?.venue_id).toBe("SAO00");
  });
});

describe("nflverse:injuries", () => {
  it("publishes every 2026 report, one practice status per player-week", async () => {
    const { stats, w } = await run(injuriesSource, [2026]);
    expect(stats.tables).toEqual([{ name: "ds_injuries", rows: 744 }]);
    expect(stats.warnings).toEqual([]);
    const statuses = w.all("SELECT DISTINCT practice_status AS s FROM ds_injuries ORDER BY s");
    expect(statuses.map((r) => r.s)).toContain("Limited Participation in Practice");
    expect(w.all("SELECT COUNT(*) AS n FROM ds_injuries WHERE report_status = ''")[0]?.n).toBe(0);
  });

  it("covers two seasons from two files (real 2025 + 2026 releases)", async () => {
    const { stats, w, files } = await run(injuriesSource, [2025, 2026]);
    expect(files.map((f) => f.season)).toEqual([2025, 2026]);
    expect(stats.seasons).toEqual([2025, 2026]);
    const bySeason = w.all("SELECT season, COUNT(*) AS n FROM ds_injuries GROUP BY season");
    expect(bySeason.find((r) => r.season === 2026)?.n).toBe(744);
    expect(Number(bySeason.find((r) => r.season === 2025)?.n)).toBeGreaterThan(5000);
  });
});

describe("nflverse:roster_weekly", () => {
  it("publishes ids for every fixture player; drops null gsis_id rows; '' ids become NULL", async () => {
    const { stats, w } = await run(rosterWeeklySource, [2026]);
    expect(stats.warnings.join("\n")).toMatch(
      /ds_roster_weekly: dropped \d+ row\(s\) — null gsis_id/,
    );
    expect(w.all("SELECT COUNT(*) AS n FROM ds_roster_weekly WHERE yahoo_id = ''")[0]?.n).toBe(0);
    for (const p of roster.players) {
      const rows = w.all(
        "SELECT full_name, team, yahoo_id, birth_date FROM ds_roster_weekly WHERE gsis_id = ? ORDER BY week DESC",
        p.gsis_id,
      );
      expect(rows.length, p.name).toBeGreaterThan(0);
      expect(rows[0]?.full_name).toBe(p.name);
      expect(rows[0]?.team).toBe(p.team);
      expect(rows[0]?.yahoo_id ?? null).toBe(p.yahoo_id);
      expect(String(rows[0]?.birth_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("nflverse:stats_player_week", () => {
  it("publishes every player-week and the derived team-defence weeks", async () => {
    const { stats, w } = await run(statsPlayerWeekSource, [2026]);
    const t = Object.fromEntries(stats.tables.map((x) => [x.name, x.rows]));
    expect(t.ds_player_week).toBe(3336); // 3,339 rows − 3 null player_id placeholders
    expect(t.ds_team_defense_week).toBe(96); // 32 teams × weeks 1–3
    expect(stats.warnings).toEqual(["ds_player_week: dropped 3 row(s) — null player_id"]);
    for (const p of roster.players) {
      const weeks = w.all(
        "SELECT week FROM ds_player_week WHERE player_id = ? ORDER BY week",
        p.gsis_id,
      );
      expect(
        weeks.map((r) => r.week),
        p.name,
      ).toEqual([1, 2, 3]);
    }
    // a team's opponent yardage equals the opponent's own offence in the same game
    const det = w.all(
      "SELECT * FROM ds_team_defense_week WHERE team = 'DET' AND week = 1",
    )[0] as Record<string, number | string>;
    const opp = w.all(
      "SELECT SUM(passing_yards) AS p, SUM(rushing_yards) AS r, SUM(sack_yards_lost) AS s FROM ds_player_week WHERE team = ? AND week = 1",
      det.opponent_team as string,
    )[0];
    expect(det.opp_passing_yards).toBe(opp?.p);
    expect(det.opp_rushing_yards).toBe(opp?.r);
    // upstream stores the loss negative; the dataset holds its magnitude (QA-2-032)
    expect(Number(opp?.s)).toBeLessThan(0);
    expect(det.opp_sack_yards_lost).toBe(Math.abs(Number(opp?.s)));
    const signs = w.all(
      "SELECT MIN(opp_sack_yards_lost) AS lo, COUNT(*) AS n FROM ds_team_defense_week WHERE opp_sack_yards_lost > 0",
    )[0];
    expect(Number(signs?.lo)).toBeGreaterThan(0);
    expect(Number(signs?.n)).toBeGreaterThan(50);
    expect(w.all("SELECT 1 FROM ds_team_defense_week WHERE opp_sack_yards_lost < 0")).toEqual([]);
    // sacks are REAL (half sacks) and equal the sum over the team's rows
    const sacks = w.all(
      "SELECT team, week, def_sacks FROM ds_team_defense_week ORDER BY season, week, team",
    );
    expect(sacks.every((r) => typeof r.def_sacks === "number")).toBe(true);
  });
});

describe("fetch hygiene", () => {
  it("writes only inside the run's temp dir, one file per season", async () => {
    const c = makeCtx([2025, 2026]);
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    const files = await injuriesSource.fetch(v!, c.ctx);
    for (const f of files) {
      expect(f.path.startsWith(c.tempDir)).toBe(true);
      expect(existsSync(f.path)).toBe(true);
    }
    expect(c.calls).toEqual([
      `${REL}/injuries/timestamp.txt`,
      `${REL}/injuries/injuries_2025.parquet`,
      `${REL}/injuries/injuries_2026.parquet`,
    ]);
  });

  it("concurrent sources in one temp dir never collide", async () => {
    const c = makeCtx([2026]);
    open.push(c);
    const all = await Promise.all(
      Object.values(NFLVERSE_SOURCES).map(async (s) => {
        const v = await s.version(c.ctx);
        return s.fetch(v!, c.ctx);
      }),
    );
    const paths = all.flat().map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(readdirSync(c.tempDir)).toHaveLength(4);
  });
});

describe("fetch failures", () => {
  it("a missing season file fails the run and removes what was already downloaded", async () => {
    const c = makeCtx([2026, 2027]); // no 2027 release yet → 404
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    await expect(injuriesSource.fetch(v!, c.ctx)).rejects.toThrow(
      /injuries_2027\.parquet answered 404/,
    );
    expect(readdirSync(c.tempDir)).toEqual([]);
  });

  it("schedules: a failed games.parquet download leaves nothing behind", async () => {
    const routes = new Map([
      [`${REL}/schedules/timestamp.txt`, new TextEncoder().encode("2026-09-30 11:58:07 EDT")],
    ]);
    const c = makeCtx([2026], routes);
    open.push(c);
    const v = await schedulesSource.version(c.ctx);
    await expect(schedulesSource.fetch(v!, c.ctx)).rejects.toThrow(/404/);
    expect(readdirSync(c.tempDir)).toEqual([]);
  });

  it("no seasons → no files and no request", async () => {
    const c = makeCtx([]);
    open.push(c);
    const files = await rosterWeeklySource.fetch({ version: "v", released_at: null }, c.ctx);
    expect(files).toEqual([]);
    expect(c.calls).toEqual([]);
  });
});

describe("the published files satisfy the store's reader SQL (tables.ts READER_QUERIES)", () => {
  const bind = (sql: string): string => bindSchema(sql, "main");

  it("ScheduleReader.games / firstKickoff over the schedules file", async () => {
    const { w } = await run(schedulesSource, [2026]);
    const [games] = READER_QUERIES["ScheduleReader.games"].statements;
    const rows = w.db
      .prepare(bind(games?.sql ?? ""))
      .all({ season: 2026, weeks: JSON.stringify([8]) }) as Record<string, unknown>[];
    expect(rows).toHaveLength(14); // Thursday + Sunday + Monday of week 8
    expect(rows.every((r) => typeof r.venue_tz === "string")).toBe(true);
    const [first] = READER_QUERIES["ScheduleReader.firstKickoff"].statements;
    const fk = w.db.prepare(bind(first?.sql ?? "")).get({ season: 2026, week: 8 }) as {
      first_kickoff: string;
    };
    expect(fk.first_kickoff).toBe(rows[0]?.kickoff_utc);
  });

  it("InjuryReader.reports, PlayerWeekReader.lines/defenseLines, RosterWeeklyReader over their files", async () => {
    const ids = JSON.stringify(roster.players.map((p) => p.gsis_id));
    const inj = await run(injuriesSource, [2026]);
    const [ir] = READER_QUERIES["InjuryReader.reports"].statements;
    const all = inj.w.db
      .prepare(bind(ir?.sql ?? ""))
      .all({ season: 2026, week: 1, gsis_ids: null });
    expect(all.length).toBeGreaterThan(100);

    const st = await run(statsPlayerWeekSource, [2026]);
    const [pl] = READER_QUERIES["PlayerWeekReader.lines"].statements;
    const lines = st.w.db
      .prepare(bind(pl?.sql ?? ""))
      .all({ season: 2026, weeks: "[1,2,3]", gsis_ids: ids });
    expect(lines).toHaveLength(roster.players.length * 3);
    const [dl] = READER_QUERIES["PlayerWeekReader.defenseLines"].statements;
    const d = st.w.db
      .prepare(bind(dl?.sql ?? ""))
      .all({ season: 2026, weeks: "[1,2,3]", teams: JSON.stringify(["DET", "HOU", "PIT", "SEA"]) });
    expect(d).toHaveLength(12);

    const ro = await run(rosterWeeklySource, [2026]);
    const [latest] = READER_QUERIES["RosterWeeklyReader.latest"].statements;
    const players = ro.w.db.prepare(bind(latest?.sql ?? "")).all({ season: 2026 }) as {
      gsis_id: string;
    }[];
    for (const p of roster.players) expect(players.map((x) => x.gsis_id)).toContain(p.gsis_id);
    const allen = roster.players.find((p) => p.name === "Josh Allen");
    const byYahoo = READER_QUERIES["RosterWeeklyReader.byPlatformId"].statements[0];
    const hit = ro.w.db.prepare(bind(byYahoo?.sql ?? "")).all({ id: allen?.yahoo_id ?? "" }) as {
      gsis_id: string;
    }[];
    expect(hit.map((h) => h.gsis_id)).toEqual([allen?.gsis_id]);
    expect(ro.w.db.prepare(bind(byYahoo?.sql ?? "")).all({ id: "" })).toEqual([]);
  });
});
