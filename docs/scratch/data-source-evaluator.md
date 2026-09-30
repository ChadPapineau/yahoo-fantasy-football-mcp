# Scratch: data-source-evaluator

Brief: `docs/scratch/briefs/data-source-evaluator.md`. Deliverable:
`docs/research/04-data-sources.md`. Started 2026-09-29 (2026 NFL season, ~week 4).

## RESUME HERE

**Status:** STARTED — scratch doc created; no needs evaluated yet.

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

## Source log (append as observed)

_(none yet)_

## Findings for the orchestrator

_(none yet)_
