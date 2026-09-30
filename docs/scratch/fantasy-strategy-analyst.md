# Scratch: fantasy-strategy-analyst

Brief: `docs/scratch/briefs/fantasy-strategy-analyst.md`. Deliverable:
`docs/research/05-strategy-and-analytics.md`. Started 2026-09-29 (2026 NFL
season, ~week 4).

Owned paths: `docs/research/05-strategy-and-analytics.md`, this file,
`docs/scratch/fantasy-strategy-analyst.wip.patch` (temporary). Everything else
is off-limits; `data-source-evaluator` is writing `docs/research/04-*` in the
same tree in parallel.

## RESUME HERE

**Status:** WRITING 2026-09-29 — `05-strategy-and-analytics.md` has preamble + §1–§6 landed and pushed (Groups 1–2). Remaining: Group 3 (§7 bye/playoff, §8 K/DEF, §9 ROS), Group 4 (§10 news-vs-stats, §11 H2H WP, §12 calibration, §13 draft), Group 5 (§14 added decisions, §15 scoring engine, §16 data-needs order, §17 what goes wrong, §18 negatives).

**Constraints inherited from the orchestrator (do not re-derive):**
1. `docs/research/03-yahoo-api.md` §B.5: Yahoo exposes `stat_categories` +
   `stat_modifiers` + `roster_positions` in one `settings` call, so the scoring
   engine is data-driven from Yahoo's stat-id table. Yahoo provides **no
   player-level projections** — only team-week `team_projected_points` and
   `win_probability`. Projection construction must be buildable from usage /
   efficiency data + external sources.
2. Refer to data by *kind* (snap share, route participation, implied totals…);
   `data-source-evaluator` maps kinds to sources in `04-*`. Do not wait for it.

**Plan (push after each group):**
- Group 1 — §1 projections, §2 replacement level / VOR, §3 start/sit
- Group 2 — §4 waivers/FAAB, §5 trades, §6 injury cascade
- Group 3 — §7 bye/playoff planning, §8 K/DEF streaming, §9 ROS construction
- Group 4 — §10 news-vs-stats, §11 H2H win probability, §12 retrospective /
  calibration, §13 draft
- Group 5 — scoring-engine spec, data-needs ordering, "what usually goes
  wrong", the "does not predict" negatives; retire the wip patch

**Rules recap:** cite published research / documented community methods; say
when something is folk wisdom; no code copied; formulas in plain math or
pseudocode; every method parameterised by scoring + roster slots; explicit-path
staging only; `git pull --rebase origin main` before every push; never
force-push; confirm `HEAD == origin/main` after each push; stop taking scope
at ~20% context.

## Source log (append as read — URL, date, what it established)

All fetched 2026-09-29. V = the page was fetched and says this; S = only a search-summary said it (not used for numbers).

- V https://github.com/ffverse/ffopportunity — expected fantasy points = xgboost on nflverse pbp (2006–2020), "how many points the average player would score given the situation and opportunity".
- V https://sumersports.com/the-zone/sticky-football-stats-predictive-nfl-metrics/ — since 2021, players w/ 100 key snaps in consecutive seasons: target share r≈0.70 (stickiest), YPRR r>0.60, QB EPA/att r≈0.60, RB EPA/rush "virtually negligible", RB TFL% ≈0.40.
- V https://www.sharpfootballanalysis.com/fantasy/wide-receiver-stats-that-matter-fantasy-football-2024/ — 10 seasons, WR YoY R²: PPR pts/g 0.57, targets/g 0.54, rec yds/g 0.49, team target share 0.40, TPRR 0.39, air yds/target 0.38, YPRR 0.28, YAC/rec 0.14, catch% 0.11, yds/target 0.03, TD/target 0.008.
- V https://www.4for4.com/2026/preseason/do-defenses-repeat-fantasy-football-performances — Eakins, 2015–2025, YoY correlation of fantasy points allowed: QB 0.27, RB 0.22, WR ≈0.15, TE 0.16; top-5 repeat 20–30%; "SOS shows weak predictive power across most positions"; use aFPA not raw.
- V https://www.4for4.com/2014/preseason/learning-love-schedule-adjusted-fantasy-points-allowed-afpa and support FAQ — aFPA = fantasy points allowed adjusted for the opponents faced, rolling 10 weeks.
- V https://www.pff.com/news/fantasy-football-quantifying-weathers-impact-on-fantasy-performance — Spratt 2018: wind 10+ mph QB comp% −1.8, YPA −0.30; <30°F comp% −3.1, RB YPC +0.26; light rain comp% −2.3, catch rate −2.3%; "apply as multipliers".
- V https://www.4for4.com/2018/preseason/weather-effects-and-fantasy-football-part-1 — wind >13 mph: deep passes (>15 air yds) −6.2%, air yards −2.0 to −5.3% across weather; snow pass attempts −8.3%; RB targets +7.7% in bad weather; actual totals fell short of Vegas totals in rain/wind/snow.
- V https://establishtherun.com/pass-rate-over-expectation/ — PROE = called pass rate − xpass; "a bit more stable" than game script; NO numbers given (claim is folk-level).
- V https://underdognetwork.com/football/best-ball-research/weekly-variance-by-position-a-key-to-best-ball — half-PPR 2015–2021, weekly CV: QB 0.36–0.39, RB 0.54–0.63, WR 0.58–0.67, TE 0.63–0.70; SD ≈ 6.4–7.6 for top players.
- V https://fantasyfootballanalytics.net/2014/07/weekly-variability-simulation.html — per-category weekly SDs (pass yds 82, pass TD 0.8, rush yds 11.3, rec yds 15.9, rec TD 0.4); normal-per-category simulation; commenters flag averaging across talent levels as a weakness.
- V https://www.footballguys.com/article/bryant_vbd — Bryant VBD (1995): value = points above a baseline ("worst starter"); X-number sort.
- V https://www.footballguys.com/article/stuart_expected_vbd_by_adp — Expected VBD truncates sub-baseline outcomes at 0; ADP 2000–2012 log-curve fits; RB steepest dropoff (−32.5), WR −24.8, DEF −2.5; top K <5 VBD.
- V https://arxiv.org/abs/1604.01455 — Hunter, Vielma, Zaman 2016: lineups as jointly Gaussian; maximise mean s.t. variance lower bound and correlation cap; top-heavy payoffs want variance.
- S https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3393127 — Haugh & Singal, "How to Play Fantasy Sports Strategically (and Win)" (403 on fetch; cite title only for the double-up-vs-top-heavy framing).
- V https://www.rotowire.com/football/article/does-stacking-work-in-fantasy-football-what-four-years-of-data-say-about-drafting-correlated-players-2026-131409 — 2022–2025 full-PPR: QB–WR1 +0.31, QB–TE +0.27, QB–RB +0.07, same-team WR–WR −0.02; QB–WR stack ≈ +1.8 ceiling / −1.6 floor per week; season total unchanged.
- V https://www.footballguys.com/article/2024-injury-index-chance-to-play-questionable-vs-doubtful — 2017–2023, >2,000 injuries: 71% of final-report Questionable played; team-specific usage differs.
- V https://fantasyindex.com/2022/10/11/viva-murillo/the-limited-value-of-questionable — no numbers; "limited" is undefined (10–90% reps); rely on beat reports + contingency.
- V https://www.4for4.com/2023/preseason/debunking-randomness-kickers-fantasy-football — 10+ pt kicker games more than doubled when implied total ≥27 vs ≤26; stream in redraft.
- V https://subvertadown.com/article/components-contributing-to-kicker-predictability — FG volume + long FGs predictive; XPs highly predictable; missed kicks and "bad in the red zone" have little/no forward value.
- S kicker dome 8.7 vs wind 7.7 ppg and "FG attempts negative out-of-sample R²" — search summary only; NOT used.
- S https://www.scienceoffantasyfootball.com/... and RotoWire DST streaming — DST projection = points-allowed bracket from opponent implied total + 1/sack + 2/takeaway + ~0.6 league-average allowance for TDs/safeties/blocks; "points allowed most predictable, fumble recoveries least".
- V https://www.fantasypros.com/2026/09/fantasy-football-trade-value-chart-week-2-2026/ (via search) — charts assume 1-for-1; 2-for-1 needs a 5–20% haircut on the multi-player side (sources disagree on size).
- S https://www.thefantasyfootballers.com/analysis/fantasy-football-101-faab-strategies/ ; https://en.wikipedia.org/wiki/First-price_sealed-bid_auction — FAAB is a first-price sealed-bid auction → bid shading is rational.
- S ESPN vacated-targets piece (DeVonta Smith TPRR 20%→30% without A.J. Brown) — example only; no published redistribution study found.
- S handcuff strategy — no rigorous study found in this pass; treat as contested/folk.
- V http://www.borischen.co/ — tiers = Gaussian mixture model over FantasyPros ECR.
- V https://www.rotoviz.com/2013/11/zero-rb-antifragility-and-the-myth-of-value-based-drafting/ — Siegele 2013 Zero RB.
- S JJ Zachariason late-round QB; PFF "Roster Maximization: the case for QB streaming" — QB replacement level is high in 1-QB leagues.
- V https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf — strictly proper scoring rules; Brier; CRPS = integral of Brier over thresholds; decomposition into uncertainty/reliability/resolution.
- V https://www.fantasypros.com/about/faq/football-inseason-accuracy-methodology/ — FantasyPros scores experts by |rank-slot expected points − actual|.
- V https://www.actionnetwork.com/education/weighted-opportunity-rating-definition-... — WOPR = 1.5×target share + 0.7×air-yards share (Hermsmeyer).
- Yahoo facts: `docs/research/03-yahoo-api.md` §B.2 (settings), §B.4 (no player projections; team_projected_points, win_probability), §B.5 (stat ids/modifiers, bonuses), §E (gaps).

## Findings for the orchestrator

_(none yet)_
