// publish.test.ts — adversarial publish paths (plan 05 §2 `sources/*`, tables.ts conventions):
// duplicate rows, nulls in key columns, rows from the wrong season, hostile text stored raw,
// NaN/±Infinity/oversize numbers never stored, a 25k-row file in bounded batches, a writer failure
// surfacing to the runner, the team-defence aggregation edge cases, and the implied-totals sign.
import { afterEach, describe, expect, it } from "vitest";
import {
  gameLines,
  gameRow,
  injuriesSource,
  rosterWeeklySource,
  schedulesSource,
  statsPlayerWeekSource,
  type NflversePublishStats,
} from "../../../src/sources/nflverse/index.js";
import {
  INSERT_BATCH_ROWS,
  TableLoader,
  asInt,
  asReal,
  asText,
  buildRow,
  coerce,
} from "../../../src/sources/nflverse/rows.js";
import { TeamDefenseAggregator } from "../../../src/sources/nflverse/team-defense.js";
import type { DatasetWriter } from "../../../src/sources/source.js";
import { DS_INJURIES } from "../../../src/store/datasets/tables.js";
import { SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";
import { fixtureRows, rewrite, tempFile, type Row } from "./helpers/rewrite.js";

const INJ = "injuries/injuries_2026.parquet";
const STATS = "stats_player/stats_player_week_2026.parquet";
const GAMES = "schedules/games.excerpt.parquet";
const ROSTER = "weekly_rosters/roster_weekly_2026.excerpt.parquet";

const open: Ctx[] = [];
const writers: SqliteWriter[] = [];
afterEach(() => {
  for (const w of writers.splice(0)) w.close();
  for (const c of open.splice(0)) c.cleanup();
});
function env(): { dir: string; w: SqliteWriter } {
  const c = makeCtx([2026]);
  open.push(c);
  const w = new SqliteWriter(c.tempDir);
  writers.push(w);
  return { dir: c.tempDir, w };
}

describe("duplicates and null keys", () => {
  it("every row twice → each kept once, the duplicates counted", async () => {
    const { dir, w } = env();
    const f = tempFile(dir, "d.parquet", await rewrite(INJ, { rows: (r) => [...r, ...r] }), 2026);
    const s = (await injuriesSource.publish([f], w)) as NflversePublishStats;
    expect(s.rows).toBe(744);
    expect(s.warnings).toEqual(["ds_injuries: dropped 744 row(s) — duplicate primary key"]);
  });

  it("nulls or blanks in NOT NULL key columns drop the row and say which column", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(INJ, {
      rows: (rows) =>
        rows.map((r, i) =>
          i === 0
            ? { ...r, gsis_id: null }
            : i === 1
              ? { ...r, gsis_id: "   " }
              : i === 2
                ? { ...r, week: null }
                : r,
        ),
    });
    const s = (await injuriesSource.publish(
      [tempFile(dir, "n.parquet", bytes, 2026)],
      w,
    )) as NflversePublishStats;
    expect(s.rows).toBe(741);
    expect([...s.warnings].sort()).toEqual([
      "ds_injuries: dropped 1 row(s) — null week",
      "ds_injuries: dropped 2 row(s) — null gsis_id",
    ]);
  });

  it("rows of another season in a per-season file are dropped and counted", async () => {
    const { dir, w } = env();
    const f = tempFile(dir, "s.parquet", await rewrite(INJ), 2025); // 2026 rows in a "2025" file
    const s = (await injuriesSource.publish([f], w)) as NflversePublishStats;
    expect(s.rows).toBe(0);
    expect(s.seasons).toEqual([]);
    expect(s.warnings).toEqual([
      "ds_injuries: dropped 744 row(s) — season differs from the file's season",
    ]);
  });

  it("a stats row without player_id is neither stored nor aggregated", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(STATS, {
      rows: (rows) =>
        rows.map((r) =>
          r.team === "DET" && r.week === 1 && r.position === "QB" ? { ...r, player_id: null } : r,
        ),
    });
    await statsPlayerWeekSource.publish([tempFile(dir, "p.parquet", bytes, 2026)], w);
    const det = w.all(
      "SELECT player_rows FROM ds_team_defense_week WHERE team = 'DET' AND week = 1",
    )[0];
    const stored = w.all(
      "SELECT COUNT(*) AS n FROM ds_player_week WHERE team = 'DET' AND week = 1",
    )[0];
    expect(det?.player_rows).toBe(stored?.n);
    const opp = w.all(
      "SELECT opp_passing_yards FROM ds_team_defense_week WHERE opponent_team = 'DET' AND week = 1",
    )[0];
    expect(opp?.opp_passing_yards).toBe(0); // DET's QB row gone → no DET passing yards
  });
});

describe("hostile values", () => {
  const hostile = [
    "Robert'); DROP TABLE ds_injuries;--",
    "‮evil‬",
    "zero​width",
    "🏈 Ja'Marr",
    "<script>alert(1)</script>",
    "x".repeat(10_000),
  ];

  it("third-party text is stored raw (the tools wrap it), and SQL text stays data", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(INJ, {
      rows: (rows) =>
        rows.map((r, i) => (i < hostile.length ? { ...r, full_name: hostile[i] } : r)),
    });
    await injuriesSource.publish([tempFile(dir, "h.parquet", bytes, 2026)], w);
    const names = w.all("SELECT full_name FROM ds_injuries").map((r) => r.full_name);
    for (const h of hostile) expect(names).toContain(h);
    expect(w.all("SELECT COUNT(*) AS n FROM ds_injuries")[0]?.n).toBe(744);
  });

  it("NaN / ±Infinity doubles are stored as NULL, never as a number", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(GAMES, {
      rows: (rows) =>
        rows.map((r) =>
          r.game_id === "2026_01_NE_SEA"
            ? { ...r, spread_line: Number.NaN, total_line: Infinity }
            : r.game_id === "2026_01_SF_LA"
              ? { ...r, spread_line: -Infinity }
              : r,
        ),
    });
    const s = await schedulesSource.publish([tempFile(dir, "g.parquet", bytes, 2026)], w);
    expect(s.rows).toBeGreaterThan(272);
    const r = w.all(
      "SELECT game_id, spread_line, total_line FROM ds_games WHERE game_id IN ('2026_01_NE_SEA','2026_01_SF_LA') ORDER BY game_id",
    );
    expect(r).toEqual([
      { game_id: "2026_01_NE_SEA", spread_line: null, total_line: null },
      { game_id: "2026_01_SF_LA", spread_line: null, total_line: expect.any(Number) as number },
    ]);
  });

  it("coercion rules", () => {
    expect(asInt(3)).toBe(3);
    expect(asInt(3.5)).toBeNull();
    expect(asInt(7n)).toBe(7);
    expect(asInt(2n ** 60n)).toBeNull();
    expect(asInt(-(2n ** 60n))).toBeNull();
    expect(asInt("3")).toBeNull();
    expect(asReal(1.5)).toBe(1.5);
    expect(asReal(Number.NaN)).toBeNull();
    expect(asReal(5n)).toBe(5);
    expect(asReal("1.5")).toBeNull();
    expect(asText("  ")).toBeNull();
    expect(asText(" a ")).toBe("a");
    expect(asText(5)).toBeNull();
    expect(coerce("BLOB", new Uint8Array(1))).toBeNull();
    expect(coerce("TEXT", "x")).toBe("x");
    const row = buildRow(DS_INJURIES, { season: 2026, extra: "ignored" });
    expect(Object.keys(row)).toEqual(DS_INJURIES.columns.map((c) => c.name));
    expect(row.team).toBeNull();
  });
});

describe("volume: bounded batches", () => {
  it("a 25,000-row stats file publishes in batches of at most INSERT_BATCH_ROWS", async () => {
    const { dir, w } = env();
    const base = (await fixtureRows(STATS)).filter((r) => r.player_id !== null);
    const bytes = await rewrite(STATS, {
      rows: () => {
        const out: Row[] = [];
        for (let i = 0; out.length < 25_000; i++) {
          const r = base[i % base.length]!;
          out.push({
            ...r,
            player_id: `${String(r.player_id)}-${String(Math.floor(i / base.length))}`,
          });
        }
        return out;
      },
    });
    const t0 = performance.now();
    const s = (await statsPlayerWeekSource.publish(
      [tempFile(dir, "big.parquet", bytes, 2026)],
      w,
    )) as NflversePublishStats;
    const ms = performance.now() - t0;
    expect(s.tables.find((t) => t.name === "ds_player_week")?.rows).toBe(25_000);
    const batches = w.batches.filter((b) => b.table === "ds_player_week");
    expect(Math.max(...batches.map((b) => b.rows))).toBeLessThanOrEqual(INSERT_BATCH_ROWS);
    expect(batches).toHaveLength(Math.ceil(25_000 / INSERT_BATCH_ROWS));
    expect(ms).toBeLessThan(20_000);
  }, 30_000);
});

describe("failures surface to the runner", () => {
  it("a writer that fails mid-publish rejects the publish", async () => {
    const { dir } = env();
    let calls = 0;
    const broken: DatasetWriter = {
      path: "/dev/null",
      createTable: () => undefined,
      insert: () => {
        calls++;
        throw new Error("disk full");
      },
    };
    const f = tempFile(dir, "i.parquet", await rewrite(INJ), 2026);
    await expect(injuriesSource.publish([f], broken)).rejects.toThrow("disk full");
    expect(calls).toBe(1);
  });

  it("a writer that cannot create a table rejects before any row is read", async () => {
    const { dir } = env();
    const broken: DatasetWriter = {
      path: "/dev/null",
      createTable: () => {
        throw new Error("readonly");
      },
      insert: () => 0,
    };
    const f = tempFile(dir, "r.parquet", await rewrite(ROSTER), 2026);
    await expect(rosterWeeklySource.publish([f], broken)).rejects.toThrow("readonly");
  });
});

describe("schedules details", () => {
  it("a season-less TempFile keeps every season in the file", async () => {
    const { dir, w } = env();
    const s = await schedulesSource.publish(
      [tempFile(dir, "all.parquet", await rewrite(GAMES), null)],
      w,
    );
    expect(s.seasons).toEqual([2025, 2026]);
  });

  it("warns about games at an unknown venue or without a kickoff time", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(GAMES, {
      rows: (rows) =>
        rows.map((r) =>
          r.game_id === "2026_01_NE_SEA"
            ? { ...r, stadium_id: "MARS01", stadium: "Olympus Mons", gametime: null }
            : r,
        ),
    });
    const s = (await schedulesSource.publish(
      [tempFile(dir, "g.parquet", bytes, 2026)],
      w,
    )) as NflversePublishStats;
    expect(s.warnings).toEqual([
      "ds_games: 1 game(s) at a venue not in src/sources/venues.ts",
      "ds_games: 1 game(s) without a kickoff time",
    ]);
  });

  it("implied totals follow nflverse's sign: positive spread = home favoured", async () => {
    const games = (await fixtureRows(GAMES)).filter((r) => r.season === 2026);
    const withLines = games.filter(
      (r) => typeof r.spread_line === "number" && typeof r.total_line === "number",
    );
    expect(withLines.length).toBeGreaterThan(50);
    for (const r of withLines) {
      const l = gameLines(r);
      const spread = r.spread_line as number;
      const total = r.total_line as number;
      expect(l?.implied.home ?? 0).toBeCloseTo((total + spread) / 2, 10);
      expect((l?.implied.home ?? 0) + (l?.implied.away ?? 0)).toBeCloseTo(total, 10);
      if (spread > 0) expect(l?.implied.home ?? 0).toBeGreaterThan(l?.implied.away ?? 0);
      if (spread < 0) expect(l?.implied.away ?? 0).toBeGreaterThan(l?.implied.home ?? 0);
      // the moneyline favourite (negative) is the spread favourite
      const hml = r.home_moneyline as number | null;
      if (hml !== null && spread >= 3) expect(hml).toBeLessThan(0);
    }
    const sample = gameLines({
      spread_line: 3.5,
      total_line: 44.5,
      away_moneyline: 150,
      home_moneyline: -175,
    });
    expect(sample).toEqual({
      spread_line: 3.5,
      total_line: 44.5,
      implied: { home: 24, away: 20.5 },
      moneyline: { away: 150, home: -175 },
    });
    expect(gameLines({ spread_line: null, total_line: null })).toBeNull();
    expect(gameLines({ away_moneyline: 120 })?.implied).toEqual({ away: null, home: null });
  });

  it("gameRow derives kickoff across the spring-forward and fall-back boundaries", () => {
    const k = (gameday: string, gametime: string): unknown =>
      gameRow({ game_id: "x", season: 2026, gameday, gametime }).kickoff_utc;
    expect(k("2026-11-01", "13:00")).toBe("2026-11-01T18:00:00.000Z"); // EST, the fall-back day
    expect(k("2026-10-31", "13:00")).toBe("2026-10-31T17:00:00.000Z"); // EDT, the day before
    expect(k("2027-03-14", "13:00")).toBe("2027-03-14T17:00:00.000Z"); // EDT, spring-forward day
    expect(k("2026-11-01", "25:00")).toBeNull();
  });
});

describe("TeamDefenseAggregator edge cases", () => {
  it("no opponent rows → opponent yardage NULL; conflicting games are counted", () => {
    const a = new TeamDefenseAggregator();
    a.add({
      season: 2026,
      week: 1,
      team: "DET",
      opponent_team: "GB",
      game_id: "g1",
      season_type: "REG",
      def_sacks: 1.5,
      passing_yards: 10,
    });
    a.add({
      season: 2026,
      week: 1,
      team: "DET",
      opponent_team: "CHI",
      game_id: "g2",
      season_type: "REG",
      def_sacks: 1,
    });
    a.add({
      season: 2026,
      week: 2,
      team: "DET",
      opponent_team: "MIN",
      game_id: "g3",
      season_type: "REG",
    });
    a.add({
      season: 2026,
      week: 2,
      team: "MIN",
      opponent_team: "DET",
      game_id: "other",
      season_type: "REG",
      passing_yards: 99,
    });
    a.add({ season: null, week: 1, team: "DET" }); // unkeyed: ignored
    const rows = a.rows();
    expect(a.conflictCount).toBe(2); // opponent + game_id disagree in week 1
    const w1 = rows.find((r) => r.week === 1);
    expect(w1).toMatchObject({
      team: "DET",
      opponent_team: "GB",
      def_sacks: 2.5,
      player_rows: 2,
      opp_passing_yards: null,
    });
    const w2 = rows.find((r) => r.week === 2 && r.team === "DET");
    expect(w2?.opp_passing_yards).toBeNull(); // MIN's rows are from another game
    expect(rows.map((r) => `${String(r.week)}${String(r.team)}`)).toEqual(["1DET", "2DET", "2MIN"]);
  });

  it("a stats publish reports aggregation conflicts as a warning", async () => {
    const { dir, w } = env();
    const bytes = await rewrite(STATS, {
      rows: (rows) => rows.map((r, i) => (i === 0 ? { ...r, game_id: "2026_99_ZZZ_YYY" } : r)),
    });
    const s = (await statsPlayerWeekSource.publish(
      [tempFile(dir, "c.parquet", bytes, 2026)],
      w,
    )) as NflversePublishStats;
    expect(s.warnings.some((x) => /^ds_team_defense_week: \d+ row\(s\) disagreed/.test(x))).toBe(
      true,
    );
  });

  it("TableLoader: a table without a primary key keeps duplicates", () => {
    const { w } = env();
    const spec = {
      name: "ds_t" as const,
      columns: [{ name: "a", type: "INTEGER" as const, nullable: true }],
      primary_key: null,
      indexes: [],
    };
    const l = new TableLoader(w, spec);
    expect(l.add({ a: 1 })).toBe(true);
    expect(l.add({ a: 1 })).toBe(true);
    expect(l.finish()).toEqual({ name: "ds_t", rows: 2, seasons: [], warnings: [] });
  });
});

describe("empty and mismatched files at publish", () => {
  it("a zero-row file publishes empty tables (the assertion is what refuses it)", async () => {
    const { dir, w } = env();
    const s = await rosterWeeklySource.publish(
      [tempFile(dir, "e.parquet", await rewrite(ROSTER, { rows: () => [] }), 2026)],
      w,
    );
    expect(s.rows).toBe(0);
    expect(w.created).toEqual(["ds_roster_weekly"]);
  });

  it("roster rows of another season are dropped and counted", async () => {
    const { dir, w } = env();
    const s = (await rosterWeeklySource.publish(
      [tempFile(dir, "m.parquet", await rewrite(ROSTER), 2025)],
      w,
    )) as NflversePublishStats;
    expect(s.rows).toBe(0);
    expect(s.warnings.join("\n")).toMatch(/season differs from the file's season/);
  });
});
