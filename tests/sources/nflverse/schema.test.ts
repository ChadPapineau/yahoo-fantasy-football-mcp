// schema.test.ts — the schema + codec assertion (plan 01 §5.5 and D7; plan 05 §2 `sources/*`): a
// renamed column fails naming it, an extra column passes with a warning, a zstd/gzip column chunk
// fails naming column and codec, wrong types fail, and non-parquet or empty input never passes.
import type { FileMetaData, SchemaElement } from "hyparquet";
import { afterEach, describe, expect, it } from "vitest";
import {
  injuriesSource,
  rosterWeeklySource,
  schedulesSource,
  statsPlayerWeekSource,
  type NflverseSchemaReport,
} from "../../../src/sources/nflverse/index.js";
import { checkParquet, kindMatches } from "../../../src/sources/nflverse/parquet.js";
import { EXPECTED_COLUMNS } from "../../../src/sources/nflverse/schemas.js";
import { requiredUpstreamColumns } from "../../../src/store/datasets/tables.js";
import { SqliteWriter, makeCtx, type Ctx } from "./helpers/harness.js";
import { writeParquet } from "./helpers/parquet-writer.js";
import { rewrite, tempFile } from "./helpers/rewrite.js";

const INJ = "injuries/injuries_2026.parquet";
const STATS = "stats_player/stats_player_week_2026.parquet";
const GAMES = "schedules/games.excerpt.parquet";

const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
function dir(): string {
  const c = makeCtx([2026]);
  open.push(c);
  return c.tempDir;
}
const assert = async (
  s: typeof injuriesSource,
  bytes: Uint8Array,
  season: number | null = 2026,
): Promise<NflverseSchemaReport> =>
  (await s.assertSchema([tempFile(dir(), "f.parquet", bytes, season)])) as NflverseSchemaReport;

describe("expected columns", () => {
  it("cover exactly the contract's required upstream columns, for every source", () => {
    for (const [id, cols] of Object.entries(EXPECTED_COLUMNS)) {
      expect(Object.keys(cols).sort()).toEqual([
        ...requiredUpstreamColumns(id as keyof typeof EXPECTED_COLUMNS),
      ]);
    }
    expect(EXPECTED_COLUMNS["nflverse:roster_weekly"].birth_date).toBe("date");
    expect(EXPECTED_COLUMNS["nflverse:stats_player_week"].def_sacks).toBe("double");
    expect(EXPECTED_COLUMNS["nflverse:schedules"].spread_line).toBe("double");
  });

  it("every real fixture passes as-is (types and codecs match nflverse's own files)", async () => {
    const cases = [
      [injuriesSource, INJ],
      [statsPlayerWeekSource, STATS],
      [schedulesSource, GAMES],
      [rosterWeeklySource, "weekly_rosters/roster_weekly_2026.excerpt.parquet"],
    ] as const;
    for (const [s, rel] of cases) {
      const r = await assert(s, await rewrite(rel));
      expect(r.ok, `${s.id}: ${r.warnings.join("; ")}`).toBe(true);
    }
  });
});

describe("renamed, missing and extra columns", () => {
  it("a renamed column fails, naming the column", async () => {
    const r = await assert(
      injuriesSource,
      await rewrite(INJ, { rename: { report_status: "status_report" } }),
    );
    expect(r.ok).toBe(false);
    expect(r.missing_columns).toEqual(["report_status"]);
    expect(r.extra_columns).toContain("status_report");
    expect(r.warnings.join("\n")).toMatch(/missing or renamed column\(s\): report_status/);
  });

  it("a dropped stat column fails the stats source, naming it", async () => {
    const r = await assert(
      statsPlayerWeekSource,
      await rewrite(STATS, { drop: ["passing_yards", "def_sacks"] }),
    );
    expect(r.ok).toBe(false);
    expect(r.missing_columns).toEqual(["def_sacks", "passing_yards"]);
  });

  it("an extra column passes with a warning", async () => {
    const r = await assert(
      injuriesSource,
      await rewrite(INJ, {
        extra: [{ name: "date_modified", type: "BYTE_ARRAY", logical: "STRING" }],
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.extra_columns).toContain("date_modified");
    expect(r.warnings.join("\n")).toMatch(/extra column\(s\) tolerated: .*date_modified/);
  });

  it("publish refuses a file that fails the assertion (never writes a partial table)", async () => {
    const f = tempFile(dir(), "bad.parquet", await rewrite(INJ, { drop: ["gsis_id"] }), 2026);
    const w = new SqliteWriter(dir());
    await expect(injuriesSource.publish([f], w)).rejects.toMatchObject({ code: "schema" });
    w.close();
  });
});

describe("codec assertion (plan 01 D7, OBJ-20)", () => {
  it.each(["ZSTD", "GZIP", "BROTLI", "LZ4"] as const)(
    "a %s column chunk fails naming column + codec",
    async (codec) => {
      const r = await assert(injuriesSource, await rewrite(INJ, { codec: { full_name: codec } }));
      expect(r.ok).toBe(false);
      expect(r.bad_codecs).toEqual([{ column: "full_name", codec }]);
      expect(r.warnings.join("\n")).toContain(`column full_name uses codec ${codec}`);
    },
  );

  it("a foreign codec on a column we do not read still fails (every chunk is asserted)", async () => {
    const r = await assert(injuriesSource, await rewrite(INJ, { codec: { first_name: "ZSTD" } }));
    expect(r.ok).toBe(false);
    expect(r.bad_codecs).toEqual([{ column: "first_name", codec: "ZSTD" }]);
  });

  it("SNAPPY and UNCOMPRESSED both pass", async () => {
    for (const codec of ["SNAPPY", "UNCOMPRESSED"] as const) {
      const r = await assert(injuriesSource, await rewrite(INJ, { codec: { full_name: codec } }));
      expect(r.ok).toBe(true);
    }
  });
});

describe("types", () => {
  it("a numeric column turned into text fails, naming column, expected and found", async () => {
    const r = await assert(
      injuriesSource,
      await rewrite(INJ, { retype: { week: { type: "BYTE_ARRAY", logical: "STRING" } } }),
    );
    expect(r.ok).toBe(false);
    expect(r.type_mismatches).toEqual([
      { column: "week", expected: "int", found: "BYTE_ARRAY/STRING" },
    ]);
    expect(r.warnings.join("\n")).toContain("column week expected int, found BYTE_ARRAY/STRING");
  });

  it("an int column widened to INT64 passes; a double where an int is expected fails", async () => {
    expect(
      (await assert(injuriesSource, await rewrite(INJ, { retype: { week: { type: "INT64" } } })))
        .ok,
    ).toBe(true);
    const r = await assert(
      injuriesSource,
      await rewrite(INJ, { retype: { week: { type: "DOUBLE" } } }),
    );
    expect(r.type_mismatches.map((m) => m.column)).toEqual(["week"]);
  });

  it("a double column that arrives as integers passes (widening), as text fails", async () => {
    expect(
      (
        await assert(
          schedulesSource,
          await rewrite(GAMES, { retype: { spread_line: { type: "INT64" } } }),
        )
      ).ok,
    ).toBe(true);
    const r = await assert(
      schedulesSource,
      await rewrite(GAMES, { retype: { total_line: { type: "BYTE_ARRAY", logical: "STRING" } } }),
    );
    expect(r.ok).toBe(false);
  });

  it("kindMatches: the whole table", () => {
    const el = (type: SchemaElement["type"], logical?: string): SchemaElement =>
      ({
        name: "c",
        type,
        ...(logical ? { logical_type: { type: logical } } : {}),
      }) as SchemaElement;
    const rows: [SchemaElement, Record<string, boolean>][] = [
      [el("BYTE_ARRAY", "STRING"), { string: true, int: false, double: false, date: true }],
      [el("BYTE_ARRAY"), { string: true, int: false, double: false, date: true }],
      [el("BYTE_ARRAY", "JSON"), { string: false, int: false, double: false, date: false }],
      [el("INT32"), { string: false, int: true, double: true, date: false }],
      [el("INT64", "INTEGER"), { string: false, int: true, double: true, date: false }],
      [el("INT32", "DATE"), { string: false, int: false, double: false, date: true }],
      [el("INT64", "TIMESTAMP"), { string: false, int: false, double: false, date: false }],
      [el("DOUBLE"), { string: false, int: false, double: true, date: false }],
      [el("FLOAT"), { string: false, int: false, double: true, date: false }],
      [el("BOOLEAN"), { string: false, int: false, double: false, date: false }],
      [{ name: "c", type: "INT32", converted_type: "INT_16" }, { int: true }],
      [{ name: "c", type: "BYTE_ARRAY", converted_type: "UTF8" }, { string: true }],
    ];
    for (const [e, expect_] of rows) {
      for (const [kind, want] of Object.entries(expect_)) {
        expect(kindMatches(e, kind as "string"), `${JSON.stringify(e)} ${kind}`).toBe(want);
      }
    }
  });

  it("a nested (group) column counts as extra, or as a mismatch when its name is expected", () => {
    const md = {
      version: 2,
      num_rows: 1n,
      row_groups: [],
      metadata_length: 0,
      schema: [
        { name: "schema", num_children: 3 },
        { name: "season", type: "INT32" },
        { name: "nested", num_children: 2 },
        { name: "a", type: "INT32" },
        { name: "inner", num_children: 1 },
        { name: "b", type: "INT32" },
        { name: "week", num_children: 1 },
        { name: "x", type: "INT32" },
      ],
    } as unknown as FileMetaData;
    const r = checkParquet(md, { season: "int", week: "int", team: "string" });
    expect(r.missing).toEqual(["team"]);
    expect(r.extra).toEqual(["nested"]);
    expect(r.mismatches).toEqual([{ column: "week", expected: "int", found: "GROUP" }]);
    expect(r.nflverseTimestamp).toBeNull();
  });

  it("chunks without metadata are skipped; one warning per column + codec", () => {
    const chunk = (codec: string, path: string) => ({
      file_offset: 0n,
      meta_data: { codec, path_in_schema: [path] },
    });
    const md = {
      version: 2,
      num_rows: 2n,
      metadata_length: 0,
      schema: [{ name: "schema", num_children: 0 }],
      row_groups: [
        { num_rows: 1n, total_byte_size: 0n, columns: [chunk("ZSTD", "a"), { file_offset: 0n }] },
        { num_rows: 1n, total_byte_size: 0n, columns: [chunk("ZSTD", "a"), chunk("GZIP", "a")] },
      ],
    } as unknown as FileMetaData;
    expect(checkParquet(md, {}).badCodecs).toEqual([
      { column: "a", codec: "ZSTD" },
      { column: "a", codec: "GZIP" },
    ]);
  });
});

describe("files that are not usable parquet", () => {
  it.each([
    ["an empty file", new Uint8Array(0)],
    ["a truncated file", new TextEncoder().encode("PAR1")],
    ["HTML from a captive portal", new TextEncoder().encode("<html><body>Sign in</body></html>")],
    [
      "magic but no footer",
      new TextEncoder().encode("PAR1\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000PAR1"),
    ],
    [
      "a footer length past the file",
      Uint8Array.from([
        0x50, 0x41, 0x52, 0x31, 1, 2, 3, 4, 0xff, 0xff, 0xff, 0x7f, 0x50, 0x41, 0x52, 0x31,
      ]),
    ],
  ])("%s fails without throwing", async (_label, bytes) => {
    const r = await assert(injuriesSource, bytes);
    expect(r.ok).toBe(false);
    expect(r.warnings.join("\n")).toMatch(/not parquet|unreadable parquet footer/);
  });

  it("a valid file with zero rows fails (never replaces good data with nothing)", async () => {
    const r = await assert(injuriesSource, await rewrite(INJ, { rows: () => [] }));
    expect(r.ok).toBe(false);
    expect(r.rows).toBe(0);
    expect(r.warnings.join("\n")).toMatch(/no rows in any file/);
  });

  it("one empty season among populated ones passes with a warning", async () => {
    const d = dir();
    const r = (await injuriesSource.assertSchema([
      tempFile(d, "a.parquet", await rewrite(INJ, { rows: () => [] }), 2025),
      tempFile(d, "b.parquet", await rewrite(INJ), 2026),
    ])) as NflverseSchemaReport;
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(744);
    expect(r.warnings).toContain("nflverse:injuries season 2025: file has no rows");
    expect(r.files.map((f) => f.season)).toEqual([2025, 2026]);
  });

  it("no files at all fails", async () => {
    const r = await injuriesSource.assertSchema([]);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual(["nflverse:injuries: no files to check"]);
  });

  it("a missing temp file fails without throwing", async () => {
    const r = await injuriesSource.assertSchema([
      { path: "/nonexistent/x.parquet", bytes: 0, season: null },
    ]);
    expect(r.ok).toBe(false);
    expect(r.warnings).toEqual(["nflverse:injuries file: unreadable file"]);
  });

  it("reports nflverse's own timestamp from the parquet metadata", async () => {
    const c = makeCtx([2026]);
    open.push(c);
    const v = await injuriesSource.version(c.ctx);
    const files = await injuriesSource.fetch(v!, c.ctx);
    const r = (await injuriesSource.assertSchema(files)) as NflverseSchemaReport;
    expect(r.files).toEqual([
      { season: 2026, rows: 744, nflverse_timestamp: "2026-09-30 09:36:25 EDT" },
    ]);
  });

  it("a parquet file with none of the expected columns fails naming all of them", async () => {
    const r = await assert(
      injuriesSource,
      writeParquet([{ name: "x", type: "INT32", values: [1] }]),
    );
    expect(r.ok).toBe(false);
    expect(r.missing_columns).toEqual(Object.keys(EXPECTED_COLUMNS["nflverse:injuries"]).sort());
  });
});
