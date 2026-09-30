# 04 — NFL data sources: evaluation, grades, crosswalk, freshness

**Observed on 2026-09-29 (evening US) / 2026-09-30 UTC — 2026 NFL season, week 3 complete, week 4 kicks off Thu 2026-10-01.**
Author: `data-source-evaluator` (brief: `docs/scratch/briefs/data-source-evaluator.md`). Working notes with the raw probe log: `docs/scratch/data-source-evaluator.md`.

## How to read this document

- **[V-observed]** — I fetched the real URL today (`curl -I`/GET, ≤ 5 MB samples, GitHub releases API) and report what came back: HTTP status, sizes, `updated_at`, row counts, week coverage, field names.
- **[V-docs]** — stated on the provider's own page, quoted.
- **[V-community]** — reported by third parties (search results, wrappers); not confirmed against the provider.
- **[U]** — unverified; listed by name in §H.
- Nothing was installed and no third-party code was executed. Parquet files were **not** opened (no reader available without installing one); every schema below comes from the CSV/CSV.gz twin of the same release, which nflverse publishes in lockstep (same `updated_at` to the second).
- Yahoo itself provides none of what is graded here — see `docs/research/03-yahoo-api.md` §E. Yahoo's `player_id` is the join target for everything.

**Grades:** *Primary* = use it; *Secondary* = use it to cross-check or fill gaps; *Fallback* = use only if the above fail; *Do not use* = ToS-prohibited, dead, or not worth its cost yet. A paid or ToS-restricted source is never graded Primary without saying so in the same cell.

---

## A. Evaluation matrix (need → grade per source)

| # | Need | Primary | Secondary | Fallback | Do not use |
|---|---|---|---|---|---|
| 1 | Play-by-play, weekly player stats, EPA/efficiency | **nflverse `pbp` + `stats_player`** (CC-BY 4.0, 2026 wk 1–3 live, updated today) | nflverse `stats_team` (team-level volume/EPA) | — | old `player_stats` tag (frozen 2025-05-07); PFR direct scrape |
| 2 | Snap counts | **nflverse `snap_counts`** (PFR-derived, 4×/day, 2026 wk 1–3) | — | Sleeper `depth_chart_order` as a role proxy | PFR direct (20 req/min jail; data-use policy) |
| 3 | Routes run / route participation | **NONE free & current.** nflverse `pbp_participation` "does not update during the season" (2025 file, dated 2026-02-10; no 2026 file) | proxy: `snap_counts.offense_pct` × team dropbacks (`pbp`) | PFF Premium Stats (paid, no API) | `participation` for 2026 in-season (does not exist) |
| 4 | Target share, air yards, WOPR, RACR, aDOT | **nflverse `stats_player_week`** — has `targets, receiving_air_yards, target_share, air_yards_share, wopr, racr` directly; aDOT = `receiving_air_yards / targets` | **ffopportunity `ep_weekly_2026`** (expected FP, CC-BY-SA; updated today) | NGS `ngs_receiving` (`avg_intended_air_yards`, `percent_share_of_intended_air_yards`) | — |
| 5 | Red-zone / goal-line usage | **derive from nflverse `pbp`**: `yardline_100 <= 20` (RZ), `<= 10`, `goal_to_go = 1` (GL) grouped by `rusher_player_id` / `receiver_player_id` / `posteam` (no pre-built `red_zone` column exists — verified absent) | ffopportunity `rec_touchdown_exp`, `rush_touchdown_exp` | — | — |
| 6 | Injuries + practice participation | **nflverse `injuries`** (official NFL reports: `report_status`, `practice_status`, primary/secondary injury; daily 07:00 UTC; 2026 wk 1–3) | Sleeper `players` `injury_status` / `injury_body_part` / `injury_notes` (177 active set; no key) | ESPN fantasy `injuryStatus` (unofficial, ToS) | Sleeper `practice_participation` (0 of 861 populated — dead field); ESPN core `/injuries` (404) |
| 7 | Depth charts | **nflverse `depth_charts`** (ESPN-sourced, daily, new 2025+ schema: timestamped rows, `pos_rank`, `pos_slot`) | Sleeper `depth_chart_position` / `depth_chart_order` (617 of 861 set) | — | ESPN site scrape (ToS) |
| 8 | Betting lines, spreads, totals, implied totals | **nflverse `schedules` (`games.csv`)**: `spread_line, total_line, away/home_moneyline, *_spread_odds, over/under_odds`; all 16 wk-4 games lined; updates every 5 min in season; free, no key | **The Odds API** free tier (500 credits/mo, key by email; storing permitted; commercial display OK) | ESPN core `…/competitions/{id}/odds` (DraftKings; unofficial, ToS) | DraftKings/FanDuel/Action Network endpoints (no public ToS-clean API) |
| 9 | Weather | **Open-Meteo** (no key; 7-day hourly; **non-commercial only**, 10k/day) | **NWS `api.weather.gov`** (free, US-only, needs `User-Agent`; public-domain) | nflverse `schedules.temp/wind` (**post-game actuals only**, outdoor games; not a forecast) | ESPN core `weather` (AccuWeather via ESPN; unofficial, ToS) |
| 10 | Defensive matchup (DvP, pace, pass/run rate) | **derive from nflverse `pbp`** (`defteam`, `xpass`, `pass_oe`, `epa`, `success`, `play_type`, `game_seconds_remaining`) joined to position via `roster_weekly` | nflverse `stats_team_week` (volume allowed by `opponent_team`); FTN `ftn_charting` (`n_defense_box`, `n_pass_rushers`, blitz) | — | FTN/FO DVOA (paid, no API); PFF (paid) |
| 11 | Schedule / bye weeks / playoff weeks | **nflverse `schedules`** (kickoff ET, `away_rest/home_rest`, `roof`, `surface`, `div_game`, QB names, cross-ids) + **Yahoo `league/settings`** for playoff weeks | Sleeper `state/nfl` (current `week`, `season_type`, `display_week`) | Yahoo player `bye_weeks` | — |
| 12 | Projections & consensus rankings | **NONE free, legal and current.** Build our own from #1/#4/#5/#8 usage + ffopportunity expected points | FantasyPros API — **paid** ($8.99/mo HOF "personal-use"; free tier "non-production"; commercial = custom) | Sleeper `api.sleeper.com/projections` (**undocumented**, RotoWire-sourced, non-commercial ToS); ESPN `kona_player_info` (**undocumented**, Disney ToU bars automated access) | numberFire (dead → fanduel.com/research); FFAnalytics-style scraping |
| 13 | Trending adds/drops | **Sleeper `players/nfl/trending/add|drop`** (no key; `[{count, player_id}]`; CDN-cached 600 s) | Yahoo `percent_owned.delta` (own API) | — | — |
| 14 | News / beat reporters | **RotoWire RSS** `rotowire.com/rss/news.php?sport=NFL` (5 items, ~200-char blurbs) + **ESPN RSS** (28 items, headline+link only) | Sleeper `players.news_updated` (timestamp only — a "something changed" signal, latest 2026-09-30T02:40Z) | CBS RSS (36 items, ~140 chars, includes sportsbook promos) | Rotoworld/NBC (RSS 301→HTML; Atom feed exists but is **empty**), NFL.com feeds-rs (404), FantasyPros player-news RSS (200 but 0 bytes), Reddit JSON (403; OAuth + non-commercial), X/Twitter API (paid), Fox partner RSS (403) |
| 15 | Player-ID crosswalk | **nflverse `roster_weekly_2026`** (`gsis_id ↔ yahoo_id, sleeper_id, espn_id, pfr_id, sportradar_id, rotowire_id, pff_id, fantasy_data_id`) — but `yahoo_id` covers only **362/532** active skill players (all 2025 + 2026 rookies missing) | **DynastyProcess `db_playerids.csv`** (identical yahoo coverage: 362, 0 conflicts) | Sleeper `players.yahoo_id` (**227/861** active skill; 0/154 for 2026 rookies) | nflverse `players.csv` (2025+ release has **no** `yahoo_id`/`sleeper_id`) |
| 16 | Historical data for backtests | **nflverse** `pbp` + `stats_player` 1999–2026; `snap_counts` 2012–; `injuries` 2009–; `depth_charts` 2001–; `roster_weekly` 2002–; `schedules` 1999–; `pfr_advstats` 2018–; `ngs` 2016–; `ftn` 2022–; `participation` 2016–2025 | ffopportunity `ep_weekly` (2024–2026 assets observed; earlier seasons in the same release) | Yahoo historical league data (own API, `games;seasons=`) | — |

---

## B. Per-source evidence

### B1. nflverse-data (GitHub releases) — the backbone

- **What:** automated data releases for nflverse; 25 release tags, 4,365 assets [V-observed via `api.github.com/repos/nflverse/nflverse-data/releases`]. Each tag ships `.csv`, `.csv.gz`, `.parquet`, `.rds` (+ stale `.qs`) and a `timestamp.txt`.
- **Access:** unauthenticated HTTPS download from `https://github.com/nflverse/nflverse-data/releases/download/{tag}/{file}` (302 → `objects.githubusercontent.com`). No key.
- **License:** repo `LICENSE.md` = **Creative Commons Attribution 4.0** [V-observed raw file]. Sub-releases carry their own terms: FTN-derived data (`ftn_charting`, `participation` 2023+) is **CC-BY-SA 4.0** with mandatory attribution "to FTN Data via nflverse" [V-docs nflreadr reference]. Snap counts / pfr_advstats are scraped from Pro-Football-Reference by nflverse; nflreadr states only "Issues with this data should be filed here: nflverse-pfr" — no separate licence statement [V-docs]. (PFR's own data-use policy is in B12; we consume nflverse's release, we do not scrape PFR.)
- **Reliability:** maintained org (nflreadr commit 2026-09-17, nflreadpy 2026-09-09 per `docs/research/01`), GitHub Actions automation with a public status table. Breaking-change history I observed: (a) `player_stats` tag **frozen** at 2025-05-07 and replaced by `stats_player` with new file names (`stats_player_week_YYYY`) and columns; (b) `depth_charts` schema changed after the 2024 season ("From 2025 onward, updates include ISO8601 timestamps instead of week assignments" [V-docs]); (c) `players` release rebuilt in 2025 with **fewer external ids** (no `yahoo_id`/`sleeper_id`/`sportradar_id`; those now live only in `rosters`/`weekly_rosters`); (d) NGS moved from per-season files (last touched 2024) to single all-season files `ngs_{passing,receiving,rushing}`; (e) `pbp_participation` source "died during the 2023 season" [V-docs]. Expect one such change per off-season; pin file names and assert columns at load.
- **Rate limits:** none documented for release downloads; GitHub API is 60 req/h unauthenticated (only needed for `updated_at` polling — prefer `timestamp.txt`, 24 bytes).
- **Free-text exposure:** low — player names, injury descriptors ("Hip", "Not injury related - resting player"), depth-chart position names, `desc` play descriptions in pbp (machine-generated).
- **Documented cadence** [V-docs, `nflreadr` "nflverse Data Update Schedule"]: pbp/stats "Nightly after game days + specific game day points", raw pbp "usually available within 15 minutes after a game has ended", Thursday updates "the cleanest data we have"; rosters/injuries/depth_charts daily 07:00 UTC; snap_counts/pfr_advstats/ftn_charting at 0, 6, 12, 18 UTC ("actual availability of new data depends on the update schedule of PFR/FTN"); nextgen_stats nightly 3–5 AM ET; schedules **every 5 minutes** during the season; participation post-season only.

Per release, as observed 2026-09-29 [V-observed]:

| Release / 2026 file | `updated_at` (UTC) | Sample | Key fields (for our needs) |
|---|---|---|---|
| `pbp/play_by_play_2026.csv.gz` (3.26 MB gz; parquet 3.65 MB) | 2026-09-29T15:44 | 8,311 plays, **372 cols**, weeks 1–3 | `game_id, play_id, week, posteam, defteam, yardline_100, goal_to_go, down, ydstogo, play_type, pass, rush, qb_dropback, pass_attempt, air_yards, yards_after_catch, complete_pass, epa, qb_epa, wpa, xpass, pass_oe, cpoe, success, receiver_player_id/name, rusher_player_id, passer_player_id, td_player_id, pass_location, pass_length, run_location, run_gap, shotgun, no_huddle, qb_scramble, game_seconds_remaining, score_differential, vegas_wp, spread_line, total_line, roof, surface, temp, wind, xyac_*`. **Absent:** `red_zone`, personnel/formation/route/pressure columns (those only exist in `participation`). |
| `stats_player/stats_player_week_2026.csv` (1.49 MB) | 15:46 | 3,339 rows, 150 cols, weeks 1–3 | `player_id` (= gsis), `team, opponent_team, targets, receptions, receiving_yards, receiving_air_yards, receiving_yards_after_catch, target_share, air_yards_share, wopr, racr, pacr, carries, rushing_*, passing_*, *_epa, passing_cpoe, receiving_first_downs, fantasy_points, fantasy_points_ppr` + full K/P/DEF/IDP stats |
| `stats_team/stats_team_week_2026.csv` | 15:46 | 96 rows (32 × 3), 138 cols | same stat families at team level; `opponent_team` → "allowed" tables by inversion |
| `snap_counts/snap_counts_2026.csv` (403 KB) | 11:01 | 4,488 rows, weeks 1–3 | `pfr_player_id, player, position, team, opponent, offense_snaps, offense_pct, defense_*, st_*` — **no gsis_id**; join via `pfr_id` in `roster_weekly` |
| `ftn_charting/ftn_charting_2026.csv` (1.38 MB) | 17:01 | 8,065 plays, 29 cols, weeks 1–3 | `nflverse_game_id, nflverse_play_id, starting_hash, qb_location, n_offense_backfield, n_defense_box, is_no_huddle, is_motion, is_play_action, is_screen_pass, is_rpo, is_trick_play, is_qb_out_of_pocket, is_interception_worthy, is_throw_away, read_thrown, is_catchable_ball, is_contested_ball, is_created_reception, is_drop, is_qb_sneak, n_blitzers, n_pass_rushers, is_qb_fault_sack`. Play-level; **no per-receiver route data.** "charted within 48 hours following each game" [V-docs] |
| `pbp_participation` | **2025 file 2026-02-10; no 2026 file** | 2025: 4.74 MB parquet | offense/defense personnel, formation, `n_offense/n_defense`, players on field, `route`, `was_pressure`, `time_to_throw`, `ngs_air_yards`, coverage type — **post-season only from 2023 on** [V-docs] |
| `injuries/injuries_2026.csv` (83 KB) | 13:59 | 734 rows, weeks 1–3 | `gsis_id, team, week, position, full_name, report_primary_injury, report_secondary_injury, report_status, practice_primary_injury, practice_secondary_injury, practice_status` (e.g. "Full Participation in Practice"). No timestamp column in the 2026 file. |
| `depth_charts/depth_charts_2026.csv` (55 MB; parquet 2.66 MB) | 13:59 | range-sample 3,134 rows | **new schema:** `dt` (ISO8601 e.g. `2026-09-29T13:59:18Z`), `team, player_name, espn_id, gsis_id, pos_grp_id, pos_grp, pos_id, pos_name, pos_abb, pos_slot, pos_rank` — no `week`; one snapshot per day, so the CSV is large; **use the parquet** |
| `weekly_rosters/roster_weekly_2026.csv.gz` (445 KB) | 14:03 | 10,562 rows, **weeks 1–4** | `season, team, position, depth_chart_position, jersey_number, status (ACT/DEV/RES/RET/EXE/CUT), full_name, gsis_id, espn_id, sportradar_id, yahoo_id, rotowire_id, pff_id, pfr_id, fantasy_data_id, sleeper_id, week, esb_id, smart_id, entry_year, rookie_year, draft_club, draft_number` |
| `players/players.csv.gz` (2.5 MB) | 14:32 | 24,834 rows, 39 cols | `gsis_id, display_name, esb_id, nfl_id, pfr_id, pff_id, otc_id, espn_id, smart_id, position, latest_team, status, rookie_season, last_season, draft_*`. **No `yahoo_id`, `sleeper_id`, `sportradar_id`.** 2,545 rows with `last_season = 2026`. |
| `nextgen_stats/ngs_receiving.csv.gz` (1.0 MB, all seasons) | 13:33 | 15,077 rows 2016–2026; 2026: 346 rows, weeks 0 (season-to-date), 1–3 | `player_gsis_id, avg_cushion, avg_separation, avg_intended_air_yards, percent_share_of_intended_air_yards, catch_percentage, avg_yac, avg_expected_yac, avg_yac_above_expectation` (also `ngs_passing`, `ngs_rushing`). NGS publishes only qualifying players. |
| `pfr_advstats/advstats_week_{pass,rush,rec,def}_2026` | 2026-09-27T11:01 (timestamp.txt 23:02) | rec: 525 rows, weeks 1–3 | `pfr_player_id, receiving_drop, receiving_drop_pct, receiving_broken_tackles, receiving_int, receiving_rat, passing_drops, rushing_broken_tackles` |
| `schedules/games.csv` (2.18 MB, all seasons) | **2026-09-30T02:36** | 1999–2026; 272 games in 2026 | `game_id, gameday, weekday, gametime (ET), away_team, home_team, away_score, home_score, result, total, gsis, nfl_detail_id, pfr, pff, espn, ftn, away_rest, home_rest, away_moneyline, home_moneyline, spread_line, away_spread_odds, home_spread_odds, total_line, under_odds, over_odds, div_game, roof, surface, temp, wind, away_qb_id/name, home_qb_id/name, away_coach, home_coach, referee, stadium_id, stadium`. 2026 fill: lines on 79/272 (48 played + all 16 wk-4 + 15 later); `temp`/`wind` on 33/272 = **played outdoor games only**. Dictionary: `spread_line` "A positive number means the home team was favored by that many points"; `temp`/`wind` "(for outdoors and open only)" [V-observed `nflreadr/data-raw/dictionary_schedules.csv`]. Sportsbook of origin is **not stated** [U]. Sample: `2026_04_PIT_CLE 2026-10-01 20:15 spread -2.5 total 38.5 ML -148/+124 roof outdoors espn 401872964 pfr 202610010cle`. |
| `espn_data/qbr_week_level` | 15:13 | — | ESPN QBR by week (unofficial-origin but redistributed by nflverse) |

**Grades:** Primary for needs 1, 2, 4, 5, 6, 7, 8, 10, 11, 16; Primary-but-partial for 15; **Do not use** for need 3 in-season (`participation`).

### B2. ffopportunity (ffverse) — expected fantasy points

- **What:** "Expected Fantasy Points" from nflverse pbp via released models; `ep_weekly_2026.csv` **921 KB, updated 2026-09-29T11:35Z**, 1,028 rows, 159 cols, weeks 1–3 [V-observed, release `latest-data`]. Fields: `player_id` (gsis), `full_name, position, posteam, week, game_id, pass_attempt, rec_attempt, rush_attempt, rec_air_yards, receptions, receptions_exp, rec_yards_gained(_exp), rush_yards_gained(_exp), rec_touchdown(_exp), rush_touchdown(_exp), pass/rec/rush_fantasy_points_exp, total_fantasy_points, total_fantasy_points_exp, total_fantasy_points_diff, rec_attempt_team, …`. Also `ep_pbp_pass_2026`, `ep_pbp_rush_2026` (play-level). Seasons 2024–2026 observed in assets (release holds 191 assets; earlier seasons present).
- **Access:** GitHub release download, no key. **License:** models and data **CC-BY-SA 4.0**; code GPL-3 [V-observed README "Terms of Use"].
- **Reliability:** ffverse (same maintainers as nflverse/DynastyProcess); automated via GitHub Actions; 2025 files refreshed 2026-09-08 (model rerun). Not audited for code — we consume the CSV/parquet only.
- **Grade:** Secondary for need 4 and 5; the best free base for our own projection (need 12).

### B3. DynastyProcess `db_playerids.csv` — id crosswalk

- **What:** `https://github.com/dynastyprocess/data/raw/master/files/db_playerids.csv` → 302 → raw.githubusercontent, **2.63 MB**, 12,508 rows, 35 cols [V-observed]: `mfl_id, sportradar_id, fantasypros_id, gsis_id, pff_id, sleeper_id, nfl_id, espn_id, yahoo_id, fleaflicker_id, cbs_id, pfr_id, cfbref_id, rotowire_id, rotoworld_id, ktc_id, stats_id, stats_global_id, fantasy_data_id, swish_id, name, merge_name, position, team, birthdate, age, draft_year, draft_round, draft_pick, draft_ovr, twitter_username, height, weight, college, db_season`. Missing values are the literal string `NA`. Team abbreviations are MFL-style (`LVR`, `NOS`, `JAC`) — normalise.
- **Freshness:** last commit on the file 2026-09-25T05:10Z "Automated Player ID pipeline" (README: "updated via Github Actions on a weekly basis") [V-observed].
- **Coverage (skill players with a team, n = 1,549):** `yahoo_id` 750, `sleeper_id` 1,018, `espn_id` 1,146, `gsis_id` 1,128, `pfr_id` 1,154, `fantasypros_id` 898, `mfl_id` 1,549. **2026 rookies: `yahoo_id` 0/125.** Joined to the nflverse wk-4 active skill roster on `gsis_id`, DynastyProcess supplies exactly the same 362 `yahoo_id`s with 0 conflicts — it is not an independent source for Yahoo ids.
- **License:** not stated in the README [U]; repository is public and explicitly "for the purpose of supporting apps and developers".
- **Grade:** Secondary for need 15 (adds `fantasypros_id`, `mfl_id`, `ktc_id`, `merge_name`).

### B4. Sleeper API (`api.sleeper.app/v1`) — official, no key

- **Docs quotes** [V-docs docs.sleeper.com]: "stay under 1000 API calls per minute, otherwise, you risk being IP-blocked"; `players/nfl`: "use this call sparingly, as it is intended only to be used once per day at most", "average size of this query is 5MB"; "No API Token is necessary, as you cannot modify contents via this API"; **"free to use for non-commercial purposes"**, "For commercial use of the Sleeper API, please reach out to us directly to discuss licensing". No projections/news/stats endpoints are documented.
- **Observed** [V-observed]: `players/nfl` → 200, gzip **2.57 MB on the wire / 14.66 MB decompressed**, 12,229 players, CDN `cache-control: s-maxage=600`. Per-player fields include `yahoo_id, gsis_id, espn_id, sportradar_id, rotowire_id, fantasy_data_id, stats_id, swish_id, oddsjam_id, injury_status, injury_body_part, injury_notes, injury_start_date, practice_participation, practice_description, depth_chart_order, depth_chart_position, news_updated, team, status, active, years_exp, search_rank, fantasy_positions`. Defect: `gsis_id` has a **leading space in 866 of 3,893** values (`" 00-0035057"`) — trim before joining. Among 861 active skill players with a team: `injury_status` set 177, `depth_chart_order` 617, `news_updated` 846 (latest 2026-09-30T02:40Z), **`practice_participation` 0** (dead), **`yahoo_id` 227** (26 %; `years_exp = 0`: 0/154, `= 1`: 11/154).
- `state/nfl` → `{"week":4,"season":"2026","season_type":"regular","display_week":3,"season_has_scores":true}`. `players/nfl/trending/add?lookback_hours=24&limit=5` → `[{"count":5862780,"player_id":"12495"}, …]`; `trending/drop` likewise. Both CDN-cached 600 s.
- **Free-text exposure:** low (`injury_notes` e.g. "Sprain"; no article text).
- **Grades:** Primary for need 13; Secondary for 6, 7, 11; Fallback for 15. **Constraint:** non-commercial licence — flag before any paid tier of our product.

### B4b. Sleeper projections — UNDOCUMENTED (`api.sleeper.com/projections/nfl/{season}/{week}`)

`…/2026/4?season_type=regular&position[]=RB&order_by=ppr` → 200, 480 KB, 751 items, every item `company: "rotowire"`, `category: "proj"`; 104 with `stats.pts_ppr`; stat keys `pts_ppr, pts_half_ppr, pts_std, rush_att, rush_yd, rush_td, rec_tgt, rec, rec_yd, rec_td, adp_dd_ppr, …`; e.g. Bijan Robinson ATL vs NO wk 4 `pts_ppr 22.15, rush_att 18.61, rec_tgt 5.43` [V-observed]. Not in the docs, different host from the documented API, third-party (RotoWire) content, non-commercial ToS. **Grade: Fallback for need 12 — dev/backtest reference only; never a production dependency.**

### B5. ESPN — all unofficial

- **ToS** [V-docs disneytermsofuse.com §2.B.x]: users may not "access, monitor, copy or extract the Disney Products using a robot, spider, script, or other automated means, including, for the avoidance of doubt, for the purposes of creating or developing any AI Tool, data mining or web scraping".
- **Observed** [V-observed]: `site.api.espn.com/…/scoreboard` bare → 200 (week 3, `cache-control: max-age=9`), but **any query string (`?week=4`, `?dates=`) → Akamai "Access Denied" 403** from this network. `sports.core.api.espn.com/v2/…/seasons/2026/types/2/weeks/4/events` → 200 (16 events); event `401872964` PIT@CLE carries `weather` (type Forecast, AccuWeather link, `temperature 77, windSpeed 7, gust 8, precipitation 30, lastUpdated 2026-09-29T21:29Z`) and an `odds` ref → provider **DraftKings**, `details "PIT -2.5"`, `overUnder 38.5`, with `open`/`current`/`propBets`. `…/athletes/{id}/injuries` and `…/teams/{id}/injuries` → **404**. Fantasy: `lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leaguedefaults/3?view=kona_player_info` + `X-Fantasy-Filter` → 200; `players[].player.stats[]` with `statSourceId = 1` = projection (Gibbs wk 4 `appliedTotal 26.2`), plus `injuryStatus, ownership, draftRanksByRankType, rankings, lastNewsDate` and **`outlooks` / `seasonOutlook` = paragraphs of editorial free text (high injection exposure)**.
- **Grade: Do not use in production** (ToS + undocumented + WAF-blocked with parameters). Fallback only as a dev-time comparison for odds/weather/projections.

### B6. The Odds API (`api.the-odds-api.com/v4`)

- **Docs** [V-docs]: free tier "500 credits per month"; one credit per (sport, market, region) request; paid "$30 per month" (20K) … "$249 per month" (15M); key "via email"; NFL h2h, spreads, totals; props "for selected sports and bookmakers". Terms: "Storing our data and retaining it indefinitely" is permitted; "Do not resell, repackage, or redistribute our data as a standalone data product"; display "including for commercial use" allowed; "Attribution to The Odds API is not required".
- **Observed:** no-key call → `401 {"message":"API key is missing","error_code":"MISSING_KEY"}` [V-observed]. Live payload shape not verified (no key) [U].
- **Budget math:** 1 call = spreads+totals for all NFL games in one region = 2 credits; a 3×/day poll for 18 weeks ≈ 108 credits/month — fits the free tier with room for a game-day refresh.
- **Grade:** Secondary for need 8 (multi-book consensus, opening vs current); nflverse `schedules` stays Primary because it is free, keyless and 5-minute fresh.

### B7. Open-Meteo (`api.open-meteo.com/v1/forecast`)

- **Observed:** no key; Cleveland 7-day hourly (168 h) with `temperature_2m, wind_speed_10m, wind_gusts_10m, precipitation_probability, precipitation` in °F/mph; `2026-10-01T20:00 → 75.8 °F, wind 10.1 mph, gust 20.6, precip 4 %` [V-observed].
- **Terms** [V-docs open-meteo.com/en/terms]: data **CC-BY 4.0**; "You may only use the free API services for non-commercial purposes"; limits 600/min, 5,000/h, 10,000/day; commercial = "Operating websites or apps that have subscriptions or display advertisements" or "Integrating our service into commercial products".
- **Grade:** Primary for need 9 while the product is non-commercial; switch to NWS (B8) or a paid Open-Meteo plan before monetising. Stadium lat/lon must come from our own table (nflverse `stadium_id` has no coordinates [U — not checked]).

### B8. NWS (`api.weather.gov`)

- **Observed:** `points/41.5061,-81.6995` → 200 `application/geo+json`, `forecastHourly = gridpoints/CLE/83,65/forecast/hourly`; `cache-control: s-maxage=120`; requires a `User-Agent` [V-observed]. US government data — public domain; US venues only (no London/Germany/Mexico games — use Open-Meteo for those).
- **Grade:** Secondary for need 9 (and the commercial-safe Primary later).

### B9. FantasyPros

- **Site ToS** [V-docs fantasypros.com/about/legal §19]: "You agree not to sell, resell, reproduce, duplicate, copy or use for any commercial purposes any portion of this site, or use of or access to this site." No explicit anti-scraping clause was found. **API** [V-docs fantasypros.com/api-data]: key via `secure.fantasypros.com/api-keys/request`, header `x-api-key`; **Free = "Non-production"**; Premium **$8.99/mo** (bundled with HOF) **"Personal-use license"**; Commercial = custom pricing; data = ECR, ADP, weekly + ROS projections, news, injuries. Observed: public API URL without key → 403; `rss/player-news.xml` → 200 with **0 bytes** [V-observed].
- **Grade:** Secondary for need 12 **only as a paid, personal-use tier** (fine for Chad's own league; not for redistribution). Do not scrape the site.

### B10. News RSS (observed 2026-09-29)

| Feed | Status | Items | Text per item | Latest | Verdict |
|---|---|---|---|---|---|
| RotoWire `rotowire.com/rss/news.php?sport=NFL` | 200 `application/xml` | 5 | ~200 chars ("Daniels (elbow) is traveling with the Commanders to London…") | 2026-09-29 18:41 PDT | **Primary** for player news; tiny window — poll every 15 min and persist |
| ESPN `espn.com/espn/rss/nfl/news` | 200 `text/xml` | 28 | **headline + link only** (description empty) | 2026-09-29 14:50 EST | **Primary** for headlines; minimal injection surface |
| CBS `cbssports.com/rss/headlines/nfl/` | 200 | 36 | ~140 chars; first item is a sportsbook promo | 2026-09-29 21:45 UTC | Fallback; filter promos |
| NBC/Rotoworld `nbcsports.com/fantasy/football/player-news.atom` | 200 `atom+xml` | **0 entries** (feed `updated 2026-09-28`) | — | — | Do not use (empty); old `rotoworld.com/rss/feed/nfl` 301→HTML |
| FantasyPros `rss/player-news.xml` | 200, **0 bytes** | 0 | — | — | Do not use |
| NFL.com `feeds-rs/news` | 404 | — | — | — | Dead |
| Fox `api.foxsports.com/v2/content/optimized-rss` | 403 | — | — | — | Do not use (partner key) |

RSS is untrusted input: strip HTML, cap length, never pass to the model as instructions. Note that both usable feeds are news *sites'* editorial choices, not beat reporters; there is no free beat-writer aggregation (X/Twitter API is paid — B13).

### B11. Reddit

`reddit.com/r/fantasyfootball/hot.json` → **403** with a generic and with a descriptive UA [V-observed]. Reddit's Data API terms could not be fetched from here (redditinc.com unreachable, reddithelp.com 403) — community sources report OAuth mandatory, **100 QPM per OAuth client**, non-commercial free tier, commercial by agreement [V-community: DownloaderForReddit wiki, socialcrawl.dev, vorplabs.com]. User-generated full text = highest injection exposure. **Grade: Do not use** in v1.

### B12. Pro-Football-Reference (direct)

`robots.txt` → 403 for curl with both a generic and a Chrome UA [V-observed]. Bot policy [V-docs sports-reference.com/bot-traffic]: sites "more often than twenty requests in a minute" → "your session will be in jail for up to a day", "regardless of bot type and construction". Data-use policy [V-docs /data_use.html]: no "automated means … in a manner that adversely impacts site performance"; no "database, archive, or other data store that competes with or constitutes a material substitute for the services or data stores offered on the Site"; and material may not be used "for purposes of training, fine-tuning, prompting, or instructing artificial intelligence models"; custom data requests carry a "$5,000" minimum. **Grade: Do not use directly.** We consume PFR-derived snap counts/advstats only through nflverse's CC-BY release (B1); that path is nflverse's responsibility, not a scrape of ours.

### B13. Paid tiers (recorded for cost; none adopted now)

| Vendor | What | Price observed | Verdict |
|---|---|---|---|
| Fantasy Nerds (`api.fantasynerds.com`) | "draft + weekly rankings, projections, DFS, injuries, depth charts, news"; NBA/MLB bundled | **$499/yr** Standard (personal or businesses < 1,000 paying customers **or** < $500K revenue); $2,999/yr Extended; no free tier stated [V-docs pricing page] | Hold — cheapest legal projections+news bundle if we later decide not to build projections; rate limits [U] |
| SportsDataIO | projections, injuries, depth charts, odds, props, weather, news | "contact sales"; free trial exists (limits not stated on page) [V-docs] | Hold — enterprise pricing |
| RotoWire API (`rotowire.com/api/`) | news, projections, lineups | page **403** to both fetch methods [V-observed]; pricing [U] | Hold; RSS (B10) is the free slice |
| PFF Premium Stats | routes run, grades | subscription, no API | Do not use (no API; ToS) |
| FTN Fantasy / FTN DVOA | DVOA, charting | subscription; the charting slice is already free via nflverse CC-BY-SA | Do not use now |
| X/Twitter API | beat reporters | paid Basic tier [V-community] | Do not use now |
| Open-Meteo commercial | weather at commercial scale | tiers "Standard/Professional/Enterprise", prices not on the terms page | Trigger: monetisation |

### B14. numberFire

`numberfire.com` and its projections path → **301 → `fanduel.com/research`** [V-observed]. Dead as a standalone source. **Do not use.**

---

## C. Recommended primary + secondary per need

| Need | Primary | Secondary | Note |
|---|---|---|---|
| Play-by-play / weekly stats / EPA | nflverse `pbp`, `stats_player_week` | nflverse `stats_team_week` | poll `timestamp.txt`, load parquet |
| Snap counts | nflverse `snap_counts` | — | join on `pfr_id` |
| Routes run | **none** (constraint) | proxy `offense_pct × team dropbacks` | say "snap-based" in the UI |
| Target share / air yards / WOPR / RACR / aDOT | nflverse `stats_player_week` (direct columns) | ffopportunity `ep_weekly` | aDOT derived |
| Red-zone / goal-line | derived from `pbp` (`yardline_100`, `goal_to_go`) | ffopportunity `*_touchdown_exp` | — |
| Injuries / practice | nflverse `injuries` | Sleeper `players` injury fields | Sleeper `news_updated` as a change signal |
| Depth charts | nflverse `depth_charts` (parquet) | Sleeper `depth_chart_order` | daily |
| Betting lines / implied totals | nflverse `schedules` | The Odds API (free key) | implied home = (total + spread)/2 with nflverse sign convention |
| Weather | Open-Meteo (non-commercial) | NWS | nflverse `temp/wind` = actuals after the game |
| Defensive matchup / pace / rates | derived from `pbp` + `roster_weekly` positions | `stats_team_week`, FTN charting | — |
| Schedule / byes / playoffs | nflverse `schedules` + Yahoo settings | Sleeper `state/nfl` | — |
| Projections / rankings | **none free** — build from usage + ffopportunity | FantasyPros API (paid, personal-use) | Sleeper/ESPN unofficial = dev reference only |
| Trending adds/drops | Sleeper `trending/add|drop` | Yahoo `percent_owned.delta` | — |
| News | RotoWire RSS + ESPN RSS | Sleeper `news_updated` | CBS fallback; all text untrusted |
| ID crosswalk | nflverse `roster_weekly` ids + **name/team/number matching seeded from Yahoo** | DynastyProcess ids | see §D |
| Backtests | nflverse multi-season releases | ffopportunity, Yahoo `seasons=` | — |

---

## D. ID-crosswalk plan (the linchpin)

**The fact that shapes it:** no free source carries Yahoo ids for the 2025 and 2026 draft classes. On the nflverse week-4 active QB/RB/WR/TE/K roster (532 players), `yahoo_id` is present for 362; the 170 missing are 80 rookies of 2026, 79 of 2025, 9 of 2024, 2 of 2023. DynastyProcess supplies the identical 362 (0 conflicts, 0 additions). Sleeper's `yahoo_id` covers 227/861 active skill players and 0/154 of 2026 rookies, and fills **none** of the 170. So an id-table join alone will miss every second-year breakout and every rookie — exactly the players a waiver tool exists for.

**Canonical key:** `gsis_id` (NFL's id; present on 100 % of nflverse rows, on ffopportunity, NGS, injuries, depth charts; on Sleeper after trimming; on DynastyProcess). Every non-Yahoo dataset joins to `gsis_id` directly or through `roster_weekly` (`pfr_id` for snap counts/advstats, `espn_id`, `sleeper_id`).

**Yahoo → gsis, in order of precedence:**
1. **Exact id:** `roster_weekly.yahoo_id` (≡ DynastyProcess `yahoo_id`) = Yahoo's numeric `player_id` (Aaron Rodgers `7200` ↔ `nfl.p.7200`) [V-observed values; equivalence to Yahoo `player_id` is [U] until one live call confirms it]. Covers ~68 % of active skill players today, ~100 % of pre-2025 entrants.
2. **Deterministic match on Yahoo's own player record** (`name.full`, `editorial_team_abbr`, `display_position`/`primary_position`, `uniform_number`) against `roster_weekly` (`full_name`, `team`, `position`, `jersey_number`), normalising names DynastyProcess-style (`merge_name`: lowercase, strip punctuation and suffixes Jr/Sr/II/III/IV, ASCII-fold) and team abbreviations through one mapping table (Yahoo `Jax`/`LV`/`LAR` vs nflverse `JAX`/`LV`/`LA` vs DP `JAC`/`LVR`/`LA`; the exact Yahoo set is [U] — read it from the live player list). Accept on name + team + position; use jersey number only to break ties; never accept name-only.
3. **Manual overrides file** for the residue (expected: a handful of practice-squad and same-name cases), checked into the repo.
4. **Persist every learned pair** (`yahoo_player_id → gsis_id`, source, confidence, first_seen) in our store so the match is done once per player, not per request, and survives trades (team changes must not break an established pair).

**Refresh:** `roster_weekly` daily (07:00 UTC → observed 14:03 UTC today), DynastyProcess weekly (Friday ~05:00 UTC), Sleeper players once per day. Re-run step 2 only for Yahoo players with no persisted pair. Alert when the unmatched count for rostered/top-owned players exceeds a threshold.

**Known defects to code around:** Sleeper `gsis_id` leading space; DynastyProcess `NA` strings; nflverse `depth_charts` keyed by `gsis_id` + `espn_id` but no `week`; snap counts keyed only by `pfr_player_id` + name.

---

## E. Freshness map (what changes when)

| Cadence | What | Source / evidence |
|---|---|---|
| **Every ~5 min (in season)** | scores, lines, kickoff changes | nflverse `schedules` (vignette: "every 5 minutes"; observed 02:36 UTC update while games are days away) |
| **Within ~15 min after a game; game-day update points** | raw pbp → pbp → `stats_player/team` | nflverse (vignette); observed all three at 15:44–15:46 UTC Tuesday |
| **Every 10 min (CDN)** | Sleeper trending adds/drops, `state/nfl`, players | `cache-control: s-maxage=600` |
| **Hourly** | weather forecast rows | Open-Meteo / NWS (`s-maxage=120`) — poll at most hourly per venue |
| **4× daily (0/6/12/18 UTC)** | snap counts, PFR advstats, FTN charting | vignette; observed 11:01 / 23:02 / 17:01 UTC |
| **Daily 07:00 UTC (observed ~14:00 UTC)** | injuries, depth charts, rosters/weekly rosters, players | vignette + `updated_at` |
| **Nightly 3–5 AM ET** | NGS | vignette; observed 13:33 UTC |
| **Daily ~07:30 ET** | ffopportunity EP | observed 11:35 UTC |
| **Weekly (Fri ~05:00 UTC)** | DynastyProcess ids | commit history |
| **Wed–Sat** | practice reports (Wed/Thu/Fri) and game status (Fri/Sat) inside `injuries` | NFL reporting rhythm; file itself refreshes daily |
| **Once per season** | `participation` (post-season), draft ids, Yahoo league settings, stadium table | — |
| **Never (frozen)** | old `player_stats` tag (2025-05-07); per-season NGS files (2024); numberFire | — |

Week boundary: pbp/stats had weeks 1–3 on Tuesday evening; `roster_weekly` already had week 4; Sleeper `state/nfl` says `week 4, display_week 3`.

---

## F. Do-not-use list

| Source | Reason |
|---|---|
| nflverse `player_stats` tag | Frozen 2025-05-07; superseded by `stats_player` |
| nflverse `pbp_participation` for the current season | Post-season only since 2023 ("does not update during the season"); no 2026 file |
| nflverse `players.csv` as a Yahoo/Sleeper crosswalk | 2025+ release dropped those ids |
| Pro-Football-Reference direct | 403 to non-browser clients; "jail for up to a day" over 20 req/min; data-use policy bars competing data stores and AI prompting |
| ESPN site/core/fantasy endpoints in production | Undocumented; Disney ToU bars automated access; site API WAF-blocked with parameters |
| Sleeper `api.sleeper.com/projections` in production | Undocumented; third-party (RotoWire) content; non-commercial licence |
| Sleeper `practice_participation` | 0 of 861 populated |
| Reddit JSON | 403 unauthenticated; OAuth + non-commercial; highest injection exposure |
| NBC/Rotoworld feeds | RSS gone (301 → HTML); Atom feed empty |
| FantasyPros site scraping / player-news RSS | §19 no commercial copying; RSS serves 0 bytes; use the keyed API if ever |
| NFL.com `feeds-rs`, Fox partner RSS | 404 / 403 |
| numberFire | Redirects to FanDuel Research |
| PFF, FTN DVOA, SportsDataIO, RotoWire API, X API | Paid and/or no API; not worth it before the free stack is exhausted |
| DraftKings / FanDuel / Action Network endpoints | No public, ToS-clean API; The Odds API already carries their lines |

---

## G. The three constraints that most shape the architecture

1. **There is no free, legal, current projection source — and no free route data.** Every "start/sit" and "waiver target" number must be *ours*, computed from nflverse usage (`stats_player_week` shares, `pbp` red-zone/EPA, `snap_counts`), ffopportunity expected points, lines (`schedules`) and injuries, then explained as such. Routes run cannot be shown in-season; snap share is the honest proxy. FantasyPros is the only priced alternative and its cheap tier is personal-use only.
2. **The Yahoo id join is incomplete by construction:** 32 % of active skill players (every 2025/2026 rookie) have no Yahoo id in any free table. The crosswalk must be a *matcher* (name + team + position, seeded from Yahoo's player list, persisted, with overrides), not a lookup — and it is the first thing to build and test, because every other dataset hangs off it via `gsis_id`.
3. **The free stack is non-commercial in two places (Sleeper, Open-Meteo) and share-alike in two (FTN charting, ffopportunity).** Monetising the product later means swapping Open-Meteo → NWS (US venues) and Sleeper → own trending signal or a licence, and attributing FTN/ffverse. Everything else in the primary set is CC-BY 4.0 (nflverse) or public domain (NWS), keyless, and file-based — so the ingestion layer is "download-if-`timestamp.txt`-changed, load parquet, assert schema", not a web of API clients.

---

## H. Unverified — by name

1. **Which sportsbook** feeds nflverse `schedules` lines and whether they are opening or current; the dictionary does not say.
2. **Yahoo `player_id` ≡ nflverse/DynastyProcess `yahoo_id`** (the values look like Yahoo ids — Rodgers 7200 — but no live Yahoo call was possible here).
3. **Yahoo team-abbreviation set** vs nflverse/DP (needed for the matcher's mapping table).
4. **The Odds API live payload** (no key): bookmaker list, timestamps, and whether the 500 free credits reset monthly as stated.
5. **Fantasy Nerds rate limits**; **RotoWire API pricing** (page 403); **SportsDataIO trial limits**.
6. **DynastyProcess data licence** (README silent).
7. **nflverse `stadium_id` → coordinates** (not checked; a stadium lat/lon table is probably ours to maintain).
8. **Parquet schemas** — every schema above was read from the CSV twin; column order/types in parquet assumed identical.
9. **Reddit Data API terms** — quoted from community sources only (both Reddit hosts refused fetches).
10. **ESPN `Access Denied`** — whether the 403 on parameterised scoreboard calls is IP/UA/geo-specific (moot: not to be used).
11. **ffopportunity earlier-season coverage** — release holds 191 assets; only 2024–2026 file names were listed in my filter.
12. **Sleeper players `yahoo_id` for veterans** — 26 % fill suggests a stale field, not verified against Yahoo.
13. **How nflverse populates `yahoo_id`** (and why it stops at the 2024 class) — an upstream question worth an issue on `nflverse/nflverse-rosters`.
