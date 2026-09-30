// helpers.ts — weather test plumbing: the authored fixtures, a publisher whose DatasetWriter is a
// real in-memory node:sqlite database built with tables.ts `ddlFor` (so every published row is
// checked against the STRICT table's types and NOT NULLs), and a fixture-routing fake fetch.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { NflGame } from "../../../src/domain/analytics/types.js";
import { ddlFor } from "../../../src/store/datasets/tables.js";
import type {
  DatasetPublisher,
  DatasetRow,
  DatasetWriter,
  PublishOutcome,
  PublishStats,
} from "../../../src/store/types.js";
import { game } from "../runner/helpers.js";

const FIX = new URL("../../../fixtures/weather/", import.meta.url);

/** A fixture's text. */
export function fixtureText(name: string): string {
  return readFileSync(new URL(name, FIX), "utf8");
}

/** A fixture parsed (a fresh copy each call, safe to mutate). */
export function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>;
}

/** A 200 JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A writer over an in-memory sqlite db. */
export function sqliteWriter(db: DatabaseSync): DatasetWriter {
  return {
    path: ":memory:",
    createTable(spec) {
      for (const sql of ddlFor(spec)) db.exec(sql);
    },
    insert(table, rows: readonly DatasetRow[]) {
      let n = 0;
      db.exec("BEGIN");
      for (const r of rows) {
        const cols = Object.keys(r);
        const sql = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
        db.prepare(sql).run(...cols.map((c) => r[c] ?? null));
        n++;
      }
      db.exec("COMMIT");
      return n;
    },
  };
}

/** A publisher whose file is an in-memory sqlite db the test can query. */
export function sqlitePublisher(): DatasetPublisher & { db: DatabaseSync | null; calls: number } {
  const p = {
    db: null as DatabaseSync | null,
    calls: 0,
    async publish(
      source: string,
      version: string,
      _released: string | null,
      fill: (w: DatasetWriter) => Promise<PublishStats>,
    ): Promise<PublishOutcome> {
      p.calls++;
      const db = new DatabaseSync(":memory:");
      const stats = await fill(sqliteWriter(db));
      p.db = db;
      return { ok: true, file: `/cache/ds/${source}.sqlite`, file_version: version, stats };
    },
    recordUnchanged() {
      return Promise.resolve();
    },
    close() {
      /* nothing */
    },
  };
  return p;
}

/** All rows of a table, ordered by game_id. */
export function rowsOf(db: DatabaseSync | null, table: string): Record<string, unknown>[] {
  if (db === null) throw new Error("nothing was published");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY game_id`).all();
}

/** "Now" for every weather test: Thursday 2026-10-01 12:00 UTC (week 5 is the coming week). */
export const WEATHER_NOW = "2026-10-01T12:00:00.000Z";

/**
 * Week-5 games (synthetic ids) exercising every selection rule. Open-air: CLE (outdoors), IND
 * (retractable, nflverse roof "open"), MUN01 (nflverse says "dome" — the venue table wins), GNB
 * (no stadium_id; resolved by name). Skipped: DET (dome), HOU (retractable, roof unknown), LAX
 * (fixed dome though nflverse says outdoors), the far-future, past, null-kickoff and unknown-venue
 * games; the duplicate CLE row is deduplicated.
 */
export function weekFiveGames(): NflGame[] {
  return [
    game("2026_05_DAL_CLE", "2026-10-04T17:00:00.000Z"),
    game("2026_05_DAL_CLE", "2026-10-04T17:00:00.000Z"),
    game("2026_05_MIN_DET", "2026-10-04T17:00:00.000Z", {
      stadium_id: "DET00",
      stadium: "Ford Field",
      roof: "dome",
    }),
    game("2026_05_ARI_HOU", "2026-10-04T17:00:00.000Z", {
      stadium_id: "HOU00",
      stadium: "NRG Stadium",
      roof: "closed",
    }),
    game("2026_05_JAX_IND", "2026-10-05T00:20:00.000Z", {
      stadium_id: "IND00",
      stadium: "Lucas Oil Stadium",
      roof: "open",
    }),
    game("2026_05_NO_MUN", "2026-10-04T13:30:00.000Z", {
      stadium_id: "MUN01",
      stadium: "FC Bayern Munich Stadium",
      roof: "dome",
    }),
    game("2026_05_LV_LA", "2026-10-04T20:05:00.000Z", {
      stadium_id: "LAX01",
      stadium: "SoFi Stadium",
      roof: "outdoors",
    }),
    game("2026_05_CHI_GB", "2026-10-04T17:00:00.000Z", {
      stadium_id: null,
      stadium: "Lambeau Field",
      roof: "outdoors",
    }),
    game("2026_05_X_ZZZ", "2026-10-04T17:00:00.000Z", {
      stadium_id: "ZZZ00",
      stadium: "Nowhere Park",
    }),
    game("2026_05_NULL_KO", null),
    game("2026_05_PAST_KO", "2026-10-01T10:00:00.000Z"),
    game("2026_06_DAL_CLE", "2026-10-11T17:00:00.000Z", { week: 6 }),
  ];
}
