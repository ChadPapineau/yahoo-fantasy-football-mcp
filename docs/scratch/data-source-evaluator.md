# Scratch: data-source-evaluator

Brief: `docs/scratch/briefs/data-source-evaluator.md`. Deliverable:
`docs/research/04-data-sources.md`. Started 2026-09-29 (2026 NFL season, ~week 4).

## RESUME HERE

**Status:** IN PROGRESS — Group A (nflverse core), crosswalk sources, Sleeper, NWS, ESPN scoreboard, ffopportunity OBSERVED (see source log). Next: odds/weather/projections/news ToS + probes, then write `docs/research/04-data-sources.md`.

**Next step:** read `docs/research/03-yahoo-api.md` §E (Gaps) + capability matrix
and `docs/research/01-repo-security-audit.md` verdicts (only for code libraries),
then evaluate needs in groups of 3–4, pushing after each group:

1. Group A — nflverse core: pbp / player_stats / snap_counts / participation /
   ftn_charting / schedules (2026 data present? last-updated? cadence? license?)
2. Group B — injuries / depth charts / players crosswalk (nflverse, Sleeper, ESPN)
3. Group C — betting lines / weather / schedule
4. Group D — projections + rankings (FantasyPros, ESPN, Sleeper, numberFire, paid)
5. Group E — trending / news / RSS / Reddit
6. Group F — defensive matchup derivations; historical backtests
7. Synthesis: primary+secondary table, ID-crosswalk plan, freshness map,
   do-not-use list, unverified list. Retire the wip patch.

**Rules recap:** no installs, no third-party code execution, samples ≤ 5 MB,
`curl -I` preferred; mark verified vs unverified; quote ToS; explicit-path
staging only; pull --rebase before each push.

**Owned paths:** `docs/research/04-data-sources.md`,
`docs/scratch/data-source-evaluator.md`,
`docs/scratch/data-source-evaluator.wip.patch` (temporary).

## Source log (append as observed) — all observed 2026-09-29 (UTC evening)

nflverse-data releases (GitHub API, 4,365 assets, 25 tags). License: repo LICENSE.md = CC-BY 4.0.
- pbp `play_by_play_2026.{csv,csv.gz,parquet,rds}` updated 2026-09-29T15:44Z; sample: 8,311 plays, 372 cols, weeks 1–3. Has air_yards, yardline_100, goal_to_go, xpass, pass_oe, cpoe, epa, wpa, vegas_wp, spread_line, total_line, roof, temp, wind, receiver/rusher/passer ids, xyac_*. ABSENT: personnel/formation/route/pressure (those are participation-only).
- stats_player `stats_player_week_2026.csv` (1.49 MB) updated 15:46Z; 3,339 rows, 150 cols, weeks 1–3; has targets, target_share, air_yards_share, wopr, racr, receiving_air_yards, *_epa, fantasy_points(_ppr). OLD tag `player_stats` FROZEN — timestamp 2025-05-07 (do not use).
- snap_counts `snap_counts_2026.csv` 11:01Z; 4,488 rows, weeks 1–3; PFR-derived; keys pfr_player_id + player name (no gsis_id).
- pbp_participation: NO 2026 file; 2025 file dated 2026-02-10; vignette: "does not update during the season", FTN post-season only, CC-BY-SA 4.0.
- ftn_charting `ftn_charting_2026.csv` 17:01Z; 8,065 rows, 29 cols, weeks 1–3; is_motion, is_play_action, is_rpo, is_screen_pass, n_defense_box, n_pass_rushers, is_drop, is_catchable_ball, read_thrown …; CC-BY-SA 4.0 attribution to FTN Data via nflverse; "charted within 48 hours".
- injuries `injuries_2026.csv` 13:59Z; 734 rows, weeks 1–3; gsis_id, report_status, practice_status, report_primary_injury, practice_primary_injury. No date_modified column in 2026 file. Cadence: daily 07:00 UTC.
- depth_charts `depth_charts_2026.csv` 13:59Z (55 MB csv / 2.6 MB parquet); NEW 2025+ schema: dt (ISO8601), team, player_name, espn_id, gsis_id, pos_grp, pos_name, pos_abb, pos_slot, pos_rank — no week column; ESPN-sourced; daily.
- players `players.csv` (7.3 MB) 14:32Z; 24,834 rows; ids: gsis_id, esb_id, nfl_id, pfr_id, pff_id, otc_id, espn_id, smart_id — NO yahoo_id / sleeper_id / sportradar_id in the 2025+ players release.
- weekly_rosters `roster_weekly_2026.csv` 14:03Z; weeks 1–4; HAS yahoo_id, sleeper_id, espn_id, pfr_id, sportradar_id, rotowire_id, pff_id, fantasy_data_id. Wk4 ACT QB/RB/WR/TE/K = 532: yahoo_id 362 (68%), sleeper_id 519, espn_id 529, pfr_id 529.
- nextgen_stats `ngs_receiving.csv.gz` 13:33Z; all seasons 2016–2026 in one file; 2026 rows 346, weeks 0(=season),1–3; avg_separation, avg_cushion, avg_intended_air_yards, percent_share_of_intended_air_yards, avg_yac_above_expectation; keyed by player_gsis_id. Cadence: nightly 3–5 AM ET in season.
- pfr_advstats `advstats_week_{pass,rush,rec,def}_2026` 2026-09-27; rec: drops, drop_pct, broken tackles, receiving_int, receiving_rat; keyed pfr_player_id. 4x daily.
- stats_team `stats_team_week_2026.csv` 15:46Z; 96 rows (32 teams × 3 wks), 138 cols — team pass/rush volume, EPA allowed derivable by opponent_team.
- schedules `games.csv` (2.18 MB) 2026-09-30T02:36Z; 1999–2026; 272 games 2026; cols incl. spread_line, total_line, away/home_moneyline, spread odds, over/under odds, roof, surface, temp, wind, away/home_rest, away/home_qb_name, referee, ids espn/pfr/pff/ftn/gsis. 2026 fill: spread/total/moneyline 79/272 (all played + this week + 15 of wk5+); temp/wind 33/272 (played outdoor games only — NOT a forecast). Vignette: updates every 5 minutes in season. Wk4 sample 2026_04_PIT_CLE spread -2.5 total 38.5.
- espn_data qbr_week_level 15:13Z. contracts 13:56Z.
- SEASON DEPTH: pbp 1999–2026; stats_player 1999–2026; snap_counts 2012–; ftn 2022–; injuries 2009–; depth_charts 2001–; weekly_rosters 2002–; pfr_advstats 2018–; ngs 2016–; participation 2016–2025.
- Cadence vignette (nflreadr articles/nflverse_data_schedule): pbp/stats "nightly after game days + specific game day points", pbp raw "usually available within 15 minutes after a game has ended", Thursday "cleanest"; rosters/injuries/depth_charts daily 07:00 UTC; snap_counts/pfr_advstats/ftn 0,6,12,18 UTC; ngs nightly 3–5 AM ET; schedules every 5 min.

ffopportunity (ffverse) releases `latest-data`: ep_weekly_2026.csv (921 KB) updated 2026-09-29T11:35Z; 1,028 rows, 159 cols, weeks 1–3; player_id = gsis; total_fantasy_points_exp, rec/rush/pass *_exp, *_diff, rec_attempt_team. Data license CC-BY-SA 4.0 (README "Terms of Use"); code GPL-3. Also ep_pbp_pass/rush_2026.

DynastyProcess `files/db_playerids.csv` (2.63 MB raw.githubusercontent): 12,508 rows, 35 cols; last commit 2026-09-25 "Automated Player ID pipeline" (weekly Action). Missing = literal "NA". Skill w/ team (1,549): yahoo_id 750, sleeper 1,018, espn 1,146, gsis 1,128, pfr 1,154, fantasypros 898, mfl 1,549. 2026 rookies: yahoo_id 0/125. Missing yahoo_id includes 2025 rookies (Cam Ward, Jaxson Dart, Shedeur Sanders …).

Sleeper `api.sleeper.app/v1` (no key): players/nfl HEAD 200, cache s-maxage=600, no content-length (chunked; docs say ~5 MB, "once per day"). Range sample shows per-player: yahoo_id, gsis_id (NB leading space " 00-0035057"), espn_id, sportradar_id, rotowire_id, fantasy_data_id, stats_id, swish_id, oddsjam_id, injury_status, injury_body_part, injury_notes, injury_start_date, practice_participation, practice_description, depth_chart_order, depth_chart_position, news_updated, team, status, search_rank. state/nfl → week 4, season 2026, season_type regular, display_week 3. trending/add 24h → [{count, player_id}] (top count 5.86M). All responses cached 600 s at CDN.

NWS api.weather.gov points/41.5061,-81.6995 → 200 geo+json, forecastHourly gridpoints/CLE/83,65; requires User-Agent; cache-control s-maxage=120.

ESPN site.api.espn.com scoreboard (unofficial) → 200, cache-control max-age=9, CORS *; returns week 3 (16 events) with no odds/weather on completed games; competition keys lack `odds` here.


## Findings for the orchestrator

_(none yet)_
