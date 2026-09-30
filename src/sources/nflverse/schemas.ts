// schemas.ts — the expected upstream columns of each nflverse release file, with their expected
// kinds (plan 01 §5.5: "the expected columns live in one file per source … so an off-season rename
// is a one-line fix with a failing test"; D7 schema assertion). Derived from the dataset contract
// (src/store/datasets/tables.ts `requiredUpstreamColumns` + each column's type) so the loader and
// the tables can never disagree; kinds were checked against the real 2026 parquet files.
import type { DatasetSourceId } from "../../config/freshness.js";
import {
  DATASET_TABLES,
  TEAM_DEFENSE_SUM_COLUMNS,
  requiredUpstreamColumns,
} from "../../store/datasets/tables.js";

/** The four nflverse sources of Phase 1a. */
export const NFLVERSE_SOURCE_IDS = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
] as const satisfies readonly DatasetSourceId[];
/** One of them. */
export type NflverseSourceId = (typeof NFLVERSE_SOURCE_IDS)[number];

/**
 * What a column must decode to: `string` = BYTE_ARRAY (STRING/UTF8 or unannotated); `int` = INT32
 * or INT64 without a date/time annotation; `double` = DOUBLE or FLOAT (an integer column is
 * accepted — widening loses nothing); `date` = INT32 DATE (or a `YYYY-MM-DD` string).
 */
export type ColumnKind = "string" | "int" | "double" | "date";

/** Upstream inputs that are not stored verbatim, so their kind is not a stored column's type. */
const DERIVED_INPUT_KINDS: Readonly<Record<string, ColumnKind>> = Object.freeze({
  roof: "string",
  birth_date: "date",
  def_sacks: "double",
  ...Object.fromEntries(
    TEAM_DEFENSE_SUM_COLUMNS.filter((c) => c !== "def_sacks").map((c) => [c, "int" as const]),
  ),
});

function kindsFor(source: NflverseSourceId): Readonly<Record<string, ColumnKind>> {
  const verbatim = new Map<string, ColumnKind>();
  for (const t of DATASET_TABLES[source]) {
    for (const c of t.columns) {
      if (c.derivation !== null || c.from.length !== 1 || c.from[0] !== c.name) continue;
      verbatim.set(c.name, c.type === "TEXT" ? "string" : c.type === "INTEGER" ? "int" : "double");
    }
  }
  const out: Record<string, ColumnKind> = {};
  for (const name of requiredUpstreamColumns(source)) {
    const kind = DERIVED_INPUT_KINDS[name] ?? verbatim.get(name);
    if (kind === undefined)
      throw new Error(`nflverse schemas: no kind for ${source} column ${name}`);
    out[name] = kind;
  }
  return Object.freeze(out);
}

/** Every required upstream column of each source → its expected kind. Extra columns are tolerated. */
export const EXPECTED_COLUMNS: Readonly<
  Record<NflverseSourceId, Readonly<Record<string, ColumnKind>>>
> = Object.freeze({
  "nflverse:schedules": kindsFor("nflverse:schedules"),
  "nflverse:injuries": kindsFor("nflverse:injuries"),
  "nflverse:roster_weekly": kindsFor("nflverse:roster_weekly"),
  "nflverse:stats_player_week": kindsFor("nflverse:stats_player_week"),
});
