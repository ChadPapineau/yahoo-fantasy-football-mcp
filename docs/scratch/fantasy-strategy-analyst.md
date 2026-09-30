# Scratch: fantasy-strategy-analyst

Brief: `docs/scratch/briefs/fantasy-strategy-analyst.md`. Deliverable:
`docs/research/05-strategy-and-analytics.md`. Started 2026-09-29 (2026 NFL
season, ~week 4).

Owned paths: `docs/research/05-strategy-and-analytics.md`, this file,
`docs/scratch/fantasy-strategy-analyst.wip.patch` (temporary). Everything else
is off-limits; `data-source-evaluator` is writing `docs/research/04-*` in the
same tree in parallel.

## RESUME HERE

**Status:** STARTED — scratch doc created; no decision types specified yet.

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

_(none yet)_

## Findings for the orchestrator

_(none yet)_
