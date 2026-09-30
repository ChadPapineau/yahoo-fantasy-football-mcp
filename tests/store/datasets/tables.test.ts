// tables.test.ts — src/store/datasets/tables.ts (plan 01 §5.1–§5.5 dataset files; plan 08 §3.2):
// the contract is well-formed (identifiers, no duplicate columns, PK/index columns exist, season
// keys), grounded in the real 2026 parquet columns, every domain reader has a statement over a
// table of its own source, and the DDL + every reader statement actually run on node:sqlite —
// including hostile parameters that must stay data.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DATASET_SOURCE_IDS, SOURCE_REGISTRY } from "../../../src/config/freshness.js";
import type {
  InjuryReader,
  PlayerWeekReader,
  ScheduleReader,
  WeatherReader,
} from "../../../src/domain/analytics/types.js";
import type { RosterWeeklyReader } from "../../../src/domain/crosswalk/types.js";
import {
  ALL_DATASET_TABLES,
  BY_PLATFORM_STATEMENT,
  DATASET_IDENTIFIER_RE,
  DATASET_TABLES,
  DS_GAMES,
  PHASE_1A_DATASET_SOURCES,
  PLAYER_WEEK_STAT_COLUMNS,
  READER_QUERIES,
  TEAM_DEFENSE_SUM_COLUMNS,
  bindSchema,
  ddlFor,
  isPhase1aDatasetSource,
  requiredUpstreamColumns,
  tablesFor,
  type DatasetTableContract,
  type ReaderMethod,
  type ReaderStatement,
} from "../../../src/store/datasets/tables.js";
import type { DatasetTableSpec } from "../../../src/store/types.js";
import { OBSERVED_PARQUET_COLUMNS } from "./observed-columns.js";

const schemaOf = (s: string): string => `ds_${s.replace(/[^a-z0-9]+/g, "_")}`;
const readerStatements: readonly (readonly [string, ReaderStatement])[] = Object.values(
  READER_QUERIES,
).flatMap((r) => r.statements.map((s) => [r.method, s] as const));

/** A DB with every Phase-1a source attached (in memory) under its schema name and its tables created. */
function contractDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const s of PHASE_1A_DATASET_SOURCES) {
    db.exec(`ATTACH DATABASE ':memory:' AS ${schemaOf(s)}`);
    for (const t of DATASET_TABLES[s]) for (const sql of ddlFor(t, schemaOf(s))) db.exec(sql);
  }
  return db;
}

function run(
  db: DatabaseSync,
  st: ReaderStatement,
  params: Record<string, string | number | null>,
): Record<string, unknown>[] {
  return db.prepare(bindSchema(st.sql, schemaOf(st.source))).all(params);
}

function insert(
  db: DatabaseSync,
  source: string,
  table: string,
  row: Record<string, unknown>,
): void {
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${schemaOf(source)}.${table} (${cols.join(",")}) VALUES (${cols.map((c) => `:${c}`).join(",")})`;
  db.prepare(sql).run(row as Record<string, string | number | null>);
}

describe("contract shape", () => {
  it("covers exactly the Phase-1a sources of SOURCE_REGISTRY", () => {
    const phase1a = DATASET_SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].phase === "1a");
    expect([...PHASE_1A_DATASET_SOURCES].sort()).toEqual([...phase1a].sort());
    expect(Object.keys(DATASET_TABLES).sort()).toEqual([...PHASE_1A_DATASET_SOURCES].sort());
    for (const s of PHASE_1A_DATASET_SOURCES) {
      expect(DATASET_TABLES[s].length).toBeGreaterThan(0);
      for (const t of DATASET_TABLES[s]) expect(t.source).toBe(s);
    }
  });

  it("has unique ds_ table names across every dataset file", () => {
    const names = ALL_DATASET_TABLES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n).toMatch(/^ds_[a-z0-9_]+$/);
      expect(n).toMatch(DATASET_IDENTIFIER_RE);
    }
  });

  it.each(ALL_DATASET_TABLES.map((t) => [t.name, t] as const))(
    "%s: valid identifiers, no duplicate columns, PK/index columns exist",
    (_n, t: DatasetTableContract) => {
      const names = t.columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const c of t.columns) {
        expect(c.name).toMatch(DATASET_IDENTIFIER_RE);
        expect(["TEXT", "INTEGER", "REAL", "BLOB"]).toContain(c.type);
        if (c.derivation === null) expect(c.from).toEqual([c.name]);
        else expect(c.derivation.length).toBeGreaterThan(0);
      }
      expect(t.primary_key).not.toBeNull();
      for (const k of t.primary_key ?? []) {
        const c = t.columns.find((x) => x.name === k);
        expect(c, `${t.name} PK ${k}`).toBeDefined();
        expect(c?.nullable, `${t.name} PK ${k} must be NOT NULL`).toBe(false);
      }
      const seen = new Set<string>();
      for (const ix of t.indexes) {
        expect(ix.length).toBeGreaterThan(0);
        for (const k of ix) expect(names, `${t.name} index ${k}`).toContain(k);
        expect(seen.has(ix.join(","))).toBe(false);
        seen.add(ix.join(","));
        expect(ix.join(","), "an index equal to the PK is redundant").not.toBe(
          (t.primary_key ?? []).join(","),
        );
      }
      expect(t.description.length).toBeGreaterThan(0);
    },
  );

  it("keys per-season tables on a NOT NULL INTEGER season (critic C-06b)", () => {
    for (const t of ALL_DATASET_TABLES) {
      if (t.season_key === null) continue;
      expect(t.primary_key).toContain("season");
      const c = t.columns.find((x) => x.name === "season");
      expect(c).toMatchObject({ type: "INTEGER", nullable: false });
    }
    const perSeason = ALL_DATASET_TABLES.filter((t) => t.source.startsWith("nflverse:"));
    expect(perSeason.filter((t) => t.season_key === null).map((t) => t.name)).toEqual([
      "ds_venues",
    ]);
  });

  it("is a DatasetTableSpec (what DatasetWriter.createTable takes) and deeply frozen", () => {
    const spec: DatasetTableSpec = DS_GAMES;
    expect(spec.name).toBe("ds_games");
    for (const t of ALL_DATASET_TABLES) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Object.isFrozen(t.columns)).toBe(true);
      for (const c of t.columns) expect(Object.isFrozen(c)).toBe(true);
    }
  });

  it("tablesFor / isPhase1aDatasetSource", () => {
    expect(tablesFor("nflverse:schedules").map((t) => t.name)).toEqual(["ds_games", "ds_venues"]);
    expect(tablesFor("nflverse:pbp")).toEqual([]);
    expect(isPhase1aDatasetSource("weather:nws")).toBe(true);
    expect(isPhase1aDatasetSource("__proto__")).toBe(false);
    expect(isPhase1aDatasetSource("nflverse:stats_team_week")).toBe(false);
  });
});

describe("grounded in the real 2026 parquet files (research 04 §H.8)", () => {
  it.each(Object.keys(OBSERVED_PARQUET_COLUMNS))(
    "%s: every required upstream column exists in the file",
    (source) => {
      const observed = new Set(OBSERVED_PARQUET_COLUMNS[source]);
      const required = requiredUpstreamColumns(source as (typeof DATASET_SOURCE_IDS)[number]);
      expect(required.length).toBeGreaterThan(3);
      expect(required.filter((c) => !observed.has(c))).toEqual([]);
      expect([...required].sort()).toEqual(required);
    },
  );

  it("weather and non-1a sources require no parquet columns", () => {
    expect(requiredUpstreamColumns("weather:open_meteo")).toEqual([]);
    expect(requiredUpstreamColumns("nflverse:pbp")).toEqual([]);
  });

  it("stores every plan 08 §3.2 stat_player_week column verbatim", () => {
    const plan08 = [
      "passing_yards", "passing_tds", "passing_interceptions", "carries", "rushing_yards",
      "rushing_tds", "targets", "receptions", "receiving_yards", "receiving_tds",
      "passing_2pt_conversions", "rushing_2pt_conversions", "receiving_2pt_conversions",
      "sack_fumbles_lost", "rushing_fumbles_lost", "receiving_fumbles_lost", "special_teams_tds",
      "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59",
      "fg_made_60_", "fg_missed_0_19", "fg_missed_60_", "pat_made", "pat_missed",
    ]; // prettier-ignore
    const stored = PLAYER_WEEK_STAT_COLUMNS.map((c) => c.name);
    expect(plan08.filter((c) => !stored.includes(c))).toEqual([]);
    const observed = new Set(OBSERVED_PARQUET_COLUMNS["nflverse:stats_player_week"]);
    for (const c of TEAM_DEFENSE_SUM_COLUMNS) expect(observed.has(c), c).toBe(true);
  });
});

describe("reader queries (one per domain reader method)", () => {
  it("names exactly the reader methods of the domain ports", () => {
    type Expected =
      | `ScheduleReader.${Extract<keyof ScheduleReader, string>}`
      | `InjuryReader.${Extract<keyof InjuryReader, string>}`
      | `PlayerWeekReader.${Extract<keyof PlayerWeekReader, string>}`
      | `WeatherReader.${Extract<keyof WeatherReader, string>}`
      | `RosterWeeklyReader.${Extract<keyof RosterWeeklyReader, string>}`;
    expectTypeOf<ReaderMethod>().toEqualTypeOf<Expected>();
    for (const [k, r] of Object.entries(READER_QUERIES)) {
      expect(r.method).toBe(k);
      expect(r.statements.length).toBeGreaterThan(0);
      expect(r.mapping.length).toBeGreaterThan(0);
    }
  });

  it("every statement reads only its own source's tables, binds exactly its params", () => {
    for (const [m, st] of readerStatements) {
      const own = DATASET_TABLES[st.source].map((t) => t.name);
      for (const t of st.tables) expect(own, `${m} → ${t}`).toContain(t);
      const referenced = [...st.sql.matchAll(/\{schema\}\.(ds_[a-z0-9_]+)/g)].map((x) => x[1]);
      expect(new Set(referenced)).toEqual(new Set(st.tables));
      const bound = new Set([...st.sql.matchAll(/:([a-z_]+)/g)].map((x) => x[1]));
      expect(bound).toEqual(new Set(st.params));
    }
  });

  it("every table is read by some reader", () => {
    const read = new Set(readerStatements.flatMap(([, st]) => st.tables));
    expect(ALL_DATASET_TABLES.map((t) => t.name).filter((n) => !read.has(n))).toEqual([]);
  });

  it("byPlatformId has one statement per platform, keyed by BY_PLATFORM_STATEMENT", () => {
    const sts = READER_QUERIES["RosterWeeklyReader.byPlatformId"].statements;
    expect(sts[BY_PLATFORM_STATEMENT.yahoo]?.sql).toContain("yahoo_id = :id");
    expect(sts[BY_PLATFORM_STATEMENT.sleeper]?.sql).toContain("sleeper_id = :id");
    expect(sts[BY_PLATFORM_STATEMENT.espn]?.sql).toContain("espn_id = :id");
  });
});

describe("DDL + statements on node:sqlite", () => {
  it("creates every table STRICT, and every reader statement prepares and runs", () => {
    const db = contractDb();
    const sample: Record<string, string | number | null> = {
      season: 2026,
      week: 3,
      weeks: "[1,2,3]",
      gsis_ids: '["00-0034857"]',
      teams: '["BUF"]',
      game_ids: '["2026_04_PIT_CLE"]',
      id: "30977",
    };
    for (const [, st] of readerStatements) {
      const p = Object.fromEntries(st.params.map((k) => [k, sample[k] ?? null]));
      const rows = run(db, st, p);
      if (st.sql.includes("MIN(")) expect(rows).toEqual([{ first_kickoff: null }]);
      else expect(rows).toEqual([]);
    }
    expect(() => {
      insert(db, "nflverse:injuries", "ds_injuries", {
        season: "not a number",
        game_type: "REG",
        week: 1,
        team: "BUF",
        gsis_id: "00-0000001",
      });
    }).toThrow();
    db.close();
  });

  it("games join the venue table; firstKickoff; lines columns round-trip", () => {
    const db = contractDb();
    insert(db, "nflverse:schedules", "ds_venues", {
      stadium_id: "CLE00",
      name: "Huntington Bank Field",
      tz: "America/New_York",
      lat: 41.5061,
      lon: -81.6995,
      roof_default: "outdoors",
      retractable: 0,
      country: "US",
    });
    const game = (id: string, week: number, kick: string | null): Record<string, unknown> => ({
      game_id: id,
      season: 2026,
      game_type: "REG",
      week,
      gameday: "2026-10-01",
      kickoff_utc: kick,
      away_team: "PIT",
      home_team: "CLE",
      spread_line: -2.5,
      total_line: 38.5,
      venue_id: "CLE00",
    });
    insert(
      db,
      "nflverse:schedules",
      "ds_games",
      game("2026_04_PIT_CLE", 4, "2026-10-02T00:15:00.000Z"),
    );
    insert(db, "nflverse:schedules", "ds_games", game("2026_04_X_Y", 4, null));
    insert(
      db,
      "nflverse:schedules",
      "ds_games",
      game("2026_04_A_B", 4, "2026-10-04T13:30:00.000Z"),
    );
    const games = run(db, READER_QUERIES["ScheduleReader.games"].statements[0]!, {
      season: 2026,
      weeks: "[4]",
    });
    expect(games.map((g) => g.game_id)).toEqual(["2026_04_PIT_CLE", "2026_04_A_B", "2026_04_X_Y"]);
    expect(games[0]).toMatchObject({ venue_tz: "America/New_York", spread_line: -2.5 });
    const fk = run(db, READER_QUERIES["ScheduleReader.firstKickoff"].statements[0]!, {
      season: 2026,
      week: 4,
    });
    expect(fk).toEqual([{ first_kickoff: "2026-10-02T00:15:00.000Z" }]);
    const none = run(db, READER_QUERIES["ScheduleReader.firstKickoff"].statements[0]!, {
      season: 2026,
      week: 5,
    });
    expect(none).toEqual([{ first_kickoff: null }]);
    db.close();
  });

  it("roster latest() returns the newest week per player; ids match only non-null values", () => {
    const db = contractDb();
    const row = (week: number, team: string, yahoo: string | null): Record<string, unknown> => ({
      season: 2026,
      week,
      game_type: "REG",
      team,
      gsis_id: "00-0038134",
      full_name: "Kenneth Walker III",
      yahoo_id: yahoo,
    });
    insert(db, "nflverse:roster_weekly", "ds_roster_weekly", row(1, "KC", "33996"));
    insert(db, "nflverse:roster_weekly", "ds_roster_weekly", row(4, "KC", "33996"));
    insert(db, "nflverse:roster_weekly", "ds_roster_weekly", {
      ...row(4, "LV", null),
      gsis_id: "00-0040122",
      full_name: "Ashton Jeanty",
    });
    const latest = run(db, READER_QUERIES["RosterWeeklyReader.latest"].statements[0]!, {
      season: 2026,
    });
    expect(latest.map((r) => [r.gsis_id, r.week])).toEqual([
      ["00-0038134", 4],
      ["00-0040122", 4],
    ]);
    const by = READER_QUERIES["RosterWeeklyReader.byPlatformId"].statements;
    expect(run(db, by[0]!, { id: "33996" })).toHaveLength(1);
    expect(run(db, by[0]!, { id: "" })).toEqual([]);
    expect(run(db, by[1]!, { id: "33996" })).toEqual([]);
    db.close();
  });

  it("hostile list parameters stay data (no injection, huge lists, unicode)", () => {
    const db = contractDb();
    insert(db, "nflverse:injuries", "ds_injuries", {
      season: 2026,
      game_type: "REG",
      week: 2,
      team: "BUF",
      gsis_id: "00-0034857",
      report_status: "Questionable",
    });
    const st = READER_QUERIES["InjuryReader.reports"].statements[0]!;
    const hostile = JSON.stringify([
      "x') OR 1=1 --",
      "00-0034857\u0000",
      "Ｏ'Brien",
      "' ; DROP TABLE ds_injuries; --",
    ]);
    expect(run(db, st, { season: 2026, week: 2, gsis_ids: hostile })).toEqual([]);
    const many = JSON.stringify([
      ...Array.from({ length: 20_000 }, (_, i) => `00-${String(i).padStart(7, "0")}`),
      "00-0034857",
    ]);
    expect(run(db, st, { season: 2026, week: 2, gsis_ids: many })).toHaveLength(1);
    expect(run(db, st, { season: 2026, week: 2, gsis_ids: null })).toHaveLength(1);
    expect(run(db, st, { season: 2026, week: 2, gsis_ids: "[]" })).toEqual([]);
    expect(() => run(db, st, { season: 2026, week: 2, gsis_ids: "not json" })).toThrow();
    db.close();
  });
});

describe("ddlFor / bindSchema reject what they must", () => {
  const base: DatasetTableSpec = {
    name: "ds_t",
    columns: [
      { name: "a", type: "TEXT", nullable: false },
      { name: "b", type: "INTEGER", nullable: true },
    ],
    primary_key: ["a"],
    indexes: [["b"]],
  };

  it("emits CREATE TABLE ... STRICT with quoted identifiers and named indexes", () => {
    expect(ddlFor(base)).toEqual([
      'CREATE TABLE "ds_t" ("a" TEXT NOT NULL, "b" INTEGER, PRIMARY KEY ("a")) STRICT',
      'CREATE INDEX "ds_t__b" ON "ds_t" ("b")',
    ]);
    expect(ddlFor({ ...base, primary_key: null, indexes: [] }, "ds_x")).toEqual([
      'CREATE TABLE "ds_x"."ds_t" ("a" TEXT NOT NULL, "b" INTEGER) STRICT',
    ]);
  });

  it.each([
    [
      "an injected column name",
      { columns: [{ name: 'a" TEXT); DROP TABLE x; --', type: "TEXT", nullable: true }] },
    ],
    ["an upper-case column", { columns: [{ name: "A", type: "TEXT", nullable: true }] }],
    ["a unicode column", { columns: [{ name: "wéek", type: "TEXT", nullable: true }] }],
    ["an empty column", { columns: [{ name: "", type: "TEXT", nullable: true }] }],
    ["a 64-char column", { columns: [{ name: "a".repeat(64), type: "TEXT", nullable: true }] }],
    ["a duplicate column", { columns: [base.columns[0]!, base.columns[0]!] }],
    ["an unknown PK column", { primary_key: ["zz"] }],
    ["an unknown index column", { indexes: [["zz"]] }],
    ["a bad table name", { name: "ds_T" as const }],
  ] as const)("throws on %s", (_label, patch) => {
    expect(() => ddlFor({ ...base, ...patch })).toThrow(/dataset contract/);
  });

  it("rejects a hostile schema name", () => {
    expect(() => ddlFor(base, 'main"; DROP')).toThrow(/dataset contract/);
    expect(() => bindSchema("SELECT 1 FROM {schema}.ds_t", "Main")).toThrow(/dataset contract/);
    expect(bindSchema("SELECT 1 FROM {schema}.ds_t, {schema}.ds_u", "ds_a")).toBe(
      'SELECT 1 FROM "ds_a".ds_t, "ds_a".ds_u',
    );
  });
});
