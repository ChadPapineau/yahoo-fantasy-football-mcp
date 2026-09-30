// make-fixtures.ts — regenerates fixtures/nflverse/** from real nflverse release files downloaded
// by hand (plan 05 §3.2: real files ≤ 300 KB verbatim; larger ones as excerpts in the SAME schema).
// Not a test and never run by CI: run it once per fixture refresh, from a directory holding the
// downloaded release files, then review the diff and fixtures/nflverse/ATTRIBUTION.md.
//
//   scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fixtures.ts <download-dir>
//
// <download-dir> must hold: schedules_games.parquet, schedules_timestamp.txt,
// injuries_injuries_2026.parquet, inj_2025.parquet, injuries_timestamp.txt,
// weekly_rosters_roster_weekly_2026.parquet, weekly_rosters_timestamp.txt,
// stats_player_stats_player_week_2026.parquet, stats_player_timestamp.txt — or, with
// `--only <dataset>`, just that dataset's files (the others and their manifest entries stay as
// committed; the manifest is then prettier-formatted like the rest of the tree).
// Excerpts are re-encoded with tests/sources/nflverse/helpers/parquet-writer.ts: same column names,
// order, physical and logical types as the real file; literal-only SNAPPY pages; the nflverse
// key-value metadata (`nflverse_type`, `nflverse_timestamp`) is kept, Arrow's `r`/`ARROW:schema`
// blobs are not.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { writeParquet, type PhysicalType, type WriterColumn } from "./parquet-writer.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const OUT = join(ROOT, "fixtures/nflverse");
const REL = "https://github.com/nflverse/nflverse-data/releases/download";

const src = process.argv[2];
if (!src) throw new Error("usage: make-fixtures.ts <download-dir> [--only <dataset>]");
// `--only weekly_rosters` regenerates one dataset and keeps every other file and manifest entry as
// committed — for when only that dataset's rule changed and the other upstream files have moved on
const TAGS = ["schedules", "injuries", "weekly_rosters", "stats_player"] as const;
const only = process.argv[3] === "--only" ? (process.argv[4] ?? "") : null;
if (only !== null && !(TAGS as readonly string[]).includes(only))
  throw new Error(`--only takes one of ${TAGS.join(", ")}`);
const want = (tag: (typeof TAGS)[number]): boolean => only === null || only === tag;

const toAb = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface ManifestEntry {
  path: string;
  url: string;
  kind: "verbatim" | "excerpt";
  rows: number;
  bytes: number;
  sha256: string;
  upstream_bytes: number;
  upstream_rows: number;
  nflverse_timestamp: string | null;
  excerpt: string | null;
}
const manifest: ManifestEntry[] = [];

function kv(md: FileMetaData, key: string): string | null {
  return md.key_value_metadata?.find((k) => k.key === key)?.value ?? null;
}

function record(
  rel: string,
  url: string,
  bytes: Uint8Array,
  upstream: Buffer,
  kind: "verbatim" | "excerpt",
  excerpt: string | null,
): void {
  const md = parquetMetadata(toAb(Buffer.from(bytes)));
  const up = parquetMetadata(toAb(upstream));
  manifest.push({
    path: rel,
    url,
    kind,
    rows: Number(md.num_rows),
    bytes: bytes.length,
    sha256: sha(bytes),
    upstream_bytes: upstream.length,
    upstream_rows: Number(up.num_rows),
    nflverse_timestamp: kv(up, "nflverse_timestamp"),
    excerpt,
  });
  if (bytes.length > 300 * 1024) throw new Error(`${rel}: ${String(bytes.length)} bytes > 300 KB`);
}

function verbatim(file: string, rel: string, url: string): void {
  const b = readFileSync(join(src!, file));
  mkdirSync(join(OUT, rel, ".."), { recursive: true });
  copyFileSync(join(src!, file), join(OUT, rel));
  record(rel, url, b, b, "verbatim", null);
}

async function excerpt(
  file: string,
  rel: string,
  url: string,
  keep: (row: Record<string, unknown>) => boolean,
  rule: string,
): Promise<void> {
  const b = readFileSync(join(src!, file));
  const ab = toAb(b);
  const md = parquetMetadata(ab);
  const rows = (await parquetReadObjects({ file: ab })).filter(keep);
  const cols: WriterColumn[] = md.schema.slice(1).map((el) => {
    const logical = el.logical_type?.type;
    return {
      name: el.name,
      type: el.type as PhysicalType,
      ...(logical === "STRING" || logical === "DATE" ? { logical } : {}),
      values: rows.map((r): unknown => (r[el.name] as unknown) ?? null),
    };
  });
  const keyValue: Record<string, string> = {};
  for (const k of ["nflverse_type", "nflverse_timestamp"]) {
    const v = kv(md, k);
    if (v !== null) keyValue[k] = v;
  }
  const out = writeParquet(cols, { keyValue, createdBy: "fantasy-football-mcp make-fixtures" });
  mkdirSync(join(OUT, rel, ".."), { recursive: true });
  writeFileSync(join(OUT, rel), out);
  record(rel, url, out, b, "excerpt", rule);
}

interface RosterFile {
  players: { gsis_id: string; last_name: string; tags: string[] }[];
}
const roster = JSON.parse(
  readFileSync(join(ROOT, "fixtures/players/fixture-roster.json"), "utf8"),
) as RosterFile;
const ids = new Set(roster.players.map((p) => p.gsis_id));
// every gsis id the fixture league lists (my team + Team B's roster + Nico Collins on IR), so the
// crosswalk resolves the whole fixture league by roster_weekly id (plan 10 A5a) and E2/E3's
// opponent is a full roster
const leagueIds = new Set(
  [
    ...readFileSync(join(ROOT, "fixtures/manual/league.yaml"), "utf8").matchAll(
      /gsis_id:\s*"?(00-\d{7})/g,
    ),
  ].map((m) => m[1]),
);
const surnames = new Set(
  roster.players.filter((p) => p.tags.includes("same_surname")).map((p) => p.last_name),
);

for (const tag of TAGS) {
  if (!want(tag)) continue;
  mkdirSync(join(OUT, tag), { recursive: true });
  copyFileSync(join(src, `${tag}_timestamp.txt`), join(OUT, tag, "timestamp.txt"));
}

if (want("schedules"))
  await excerpt(
    "schedules_games.parquet",
    "schedules/games.excerpt.parquet",
    `${REL}/schedules/games.parquet`,
    (r) => r.season === 2025 || r.season === 2026,
    "seasons 2025 and 2026 only (every game of both); all 46 columns",
  );
if (want("injuries")) {
  verbatim(
    "injuries_injuries_2026.parquet",
    "injuries/injuries_2026.parquet",
    `${REL}/injuries/injuries_2026.parquet`,
  );
  verbatim(
    "inj_2025.parquet",
    "injuries/injuries_2025.parquet",
    `${REL}/injuries/injuries_2025.parquet`,
  );
}
if (want("weekly_rosters"))
  await excerpt(
    "weekly_rosters_roster_weekly_2026.parquet",
    "weekly_rosters/roster_weekly_2026.excerpt.parquet",
    `${REL}/weekly_rosters/roster_weekly_2026.parquet`,
    (r) =>
      ids.has(r.gsis_id as string) ||
      leagueIds.has(r.gsis_id as string) ||
      surnames.has(r.last_name as string) ||
      // every kicker: the served K streaming universe is roster_weekly's kickers (A8 needs ≥ 3
      // candidates; with only the fixture league's kickers fixture mode had exactly 3)
      r.position === "K" ||
      r.gsis_id === null ||
      r.yahoo_id === "",
    "every row of the fixture-roster players and of every gsis id in fixtures/manual/league.yaml (weeks 1-4), every row sharing a same_surname tag's last name (Allen, Love, Henry — matcher distractors), every kicker's row (position K: the K/DEF streaming universe, A8), and the real anomalies: rows with null gsis_id and rows with yahoo_id = ''; all 36 columns",
  );
if (want("stats_player"))
  verbatim(
    "stats_player_stats_player_week_2026.parquet",
    "stats_player/stats_player_week_2026.parquet",
    `${REL}/stats_player/stats_player_week_2026.parquet`,
  );

// with --only, the other datasets' committed entries stay, in their committed order
const files: ManifestEntry[] =
  only === null
    ? manifest
    : (
        JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) as { files: ManifestEntry[] }
      ).files.map((f) => manifest.find((m) => m.path === f.path) ?? f);
writeFileSync(
  join(OUT, "manifest.json"),
  `${JSON.stringify(
    {
      $comment:
        "nflverse fixtures (CC-BY 4.0, see ATTRIBUTION.md). Generated by tests/sources/nflverse/helpers/make-fixtures.ts; url = the release asset the fixture stands in for.",
      retrieved: "2026-09-30",
      timestamps: {
        schedules: "schedules/timestamp.txt",
        injuries: "injuries/timestamp.txt",
        weekly_rosters: "weekly_rosters/timestamp.txt",
        stats_player: "stats_player/timestamp.txt",
      },
      // what fixture-mode `ff refresh` requests by default: the seasons recorded here (stats
      // hold 2026 only, so the production default's prior season would 404)
      default_seasons: {
        "nflverse:schedules": [2025, 2026],
        "nflverse:injuries": [2026],
        "nflverse:roster_weekly": [2026],
        "nflverse:stats_player_week": [2026],
      },
      files,
    },
    null,
    2,
  )}\n`,
);
console.error(
  manifest.map((m) => `${m.path} ${String(m.bytes)} B ${String(m.rows)} rows`).join("\n"),
);
