# fixtures/nflverse — attribution and provenance

The files in this directory are **nflverse data**, © the nflverse contributors, licensed under the
**Creative Commons Attribution 4.0 International licence (CC-BY 4.0)** —
<https://github.com/nflverse/nflverse-data> (licence: `LICENSE.md` in that repository;
<https://creativecommons.org/licenses/by/4.0/>). They are redistributed here as test fixtures
(plan 05 §3.2), either **verbatim** or as an **excerpt** (a selection of rows, every column kept).
No league, team or manager data of any fantasy league is included — only public NFL data.

**Retrieved:** 2026-09-30, from the GitHub release assets
`https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}`.

| Fixture | Kind | Rows | Bytes | Stands in for | nflverse_timestamp (parquet metadata) | sha256 |
|---|---|---|---|---|---|---|
| `schedules/games.excerpt.parquet` | excerpt | 557 of 7,548 | 186,071 | `schedules/games.parquet` | `2026-09-30 11:58:07 EDT` | `85f64502d5d6fc23…` |
| `injuries/injuries_2026.parquet` | verbatim | 744 of 744 | 28,842 | `injuries/injuries_2026.parquet` | `2026-09-30 09:36:25 EDT` | `8dfa86b18c4f7cd5…` |
| `injuries/injuries_2025.parquet` | verbatim | 6,068 of 6,068 | 97,472 | `injuries/injuries_2025.parquet` | `2026-09-07 08:23:38 EDT` | `c7637c2f63471944…` |
| `weekly_rosters/roster_weekly_2026.excerpt.parquet` | excerpt | 333 of 10,579 | 137,758 | `weekly_rosters/roster_weekly_2026.parquet` | `2026-09-30 09:40:10 EDT` | `bccd5a5710ccbae1…` |
| `stats_player/stats_player_week_2026.parquet` | verbatim | 3,339 of 3,339 | 262,007 | `stats_player/stats_player_week_2026.parquet` | `2026-09-30 05:05:44 EDT` | `b1e2afafb899f59c…` |
| `{schedules,injuries,weekly_rosters,stats_player}/timestamp.txt` | verbatim | — | 24 each | `{tag}/timestamp.txt` | — | — |

`manifest.json` carries the full sha256, the upstream URL and row counts of each file; the tests'
fake HttpGet serves each fixture at the URL it stands in for.

## How the excerpts were made

The real `games.parquet` (521 KB) and `roster_weekly_2026.parquet` (737 KB) exceed the plan's
300 KB fixture cap, and hyparquet cannot write parquet. `tests/sources/nflverse/helpers/make-fixtures.ts`
read the real files with hyparquet, kept the rows below, and re-wrote them with the test-only
writer `tests/sources/nflverse/helpers/parquet-writer.ts`: **same column names, order, physical
and logical types** as the real file, PLAIN values in literal-only SNAPPY pages, and nflverse's
`nflverse_type` / `nflverse_timestamp` key-value metadata (Arrow's `r` / `ARROW:schema` blobs are
not copied). Values are unchanged.

- `games.excerpt.parquet`: every game of seasons **2025 and 2026** (285 + 272), all 46 columns.
- `roster_weekly_2026.excerpt.parquet`: every row (weeks 1–4) of the players in
  `fixtures/players/fixture-roster.json` and of every `gsis_id` in `fixtures/manual/league.yaml`;
  every row sharing a `same_surname` last name (Allen, Love, Henry — matcher distractors); every
  kicker's row (position `K`, 40 kickers of whom 32 are on an active roster in week 4 — the K/DEF
  streaming universe, plan 10 A8); and the file's real anomalies — the rows with a null `gsis_id`
  and the rows with `yahoo_id = ""`. All 36 columns. Regenerated alone (`--only weekly_rosters`)
  from the same upstream file (same bytes and `nflverse_timestamp`) when the kicker rule was added;
  the unchanged rule reproduced the previous excerpt byte for byte first.

The verbatim files are byte-identical to the release assets, so the loader's parquet path
(Arrow-written SNAPPY pages, RLE_DICTIONARY encodings) is exercised on real nflverse output by the
injuries and stats_player_week tests; the excerpts exercise the same code on the other two schemas.
Production reads parquet only (plan 01 D7).

To refresh: download the release files, run
`scripts/dev/with-node.sh npx tsx tests/sources/nflverse/helpers/make-fixtures.ts <download-dir>`,
update this table from `manifest.json`, and review the diff.
