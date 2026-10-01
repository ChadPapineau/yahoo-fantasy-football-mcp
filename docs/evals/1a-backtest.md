# Phase 1a backtest — start/sit (A7) and K/DEF (A8)

**Date:** 2026-09-30 · **Model:** `v1-trailing` (plan 07 E1) · **Seed:** 20260930 · **Implements:** plan 10
§3.1a A7 (a)–(e) and A8 (the reported half); A15's analytics share is measured alongside.

The tables between the `generated` markers are produced by the backtests themselves:
`tests/backtest/lineup.test.ts` and `tests/backtest/kdef.test.ts` replay the fixtures and **fail when
these numbers differ from a fresh replay**. To regenerate after a model change, run
`UPDATE_EVALS=1 scripts/dev/with-node.sh npx vitest run tests/backtest` and commit the diff with the
change that caused it.

## What was replayed (fixture sizes)

| input | file | size |
|---|---|---|
| league | `fixtures/manual/league.yaml` ("Example League", half-PPR preset + overrides; 9 starters: QB, WR×2, RB×2, TE, W/R/T, K, DEF) | Team A (16 players, one on IR) vs Team B (15 players), weeks 1–3 |
| stat lines | `fixtures/nflverse/stats_player/stats_player_week_2026.parquet` | 3,339 rows, weeks 1–3 (262,007 bytes) |
| schedule + lines | `fixtures/nflverse/schedules/games.excerpt.parquet` | 557 games, seasons 2025–2026 (186,071 bytes) |
| injuries | `fixtures/nflverse/injuries/injuries_2026.parquet` | 744 rows, weeks 1–4 (28,842 bytes) |
| K/DEF universe | all 32 team defences + the 32 kickers who recorded a 2026 line | 64 subjects per week |

Each week W is replayed with the clock one day before W's first kickoff, reading only lines of weeks
< W (the engine refuses to read the as-of week even when a reader over-serves — a unit test pins it),
the week-W betting lines and the week-W injury report. Realised points are the league's own scoring of
the week-W nflverse lines (DEF points allowed from the final score).

**Week 1 caveat.** The fixtures hold no 2025 player stats, so a week-1 projection is the positional
prior scaled by the implied team total, and the "last week's points" baseline does not exist; A7 (a)'s
hard comparison is therefore over weeks 2–3, and week 1 is reported for completeness.

## A7 — start/sit

- **Regret** = realised points of the hindsight-best legal lineup − realised points of the recommended
  lineup (the retrospective's definition, research 05 §3 Evaluation).
- **Baseline** "start by last week's points": the same exact assignment with each player's week W−1
  league points as his value.
- `pwin` searches the mean-variance hull (λ grid, both signs) and scores each candidate by the
  normal-approximation P(win) with the same-team correlation table; the opponent is assumed to start
  his highest-projected legal lineup.

<!-- generated:lineup:begin -->
| team | week | best (hindsight) | `mean` realised | `mean` regret | `pwin` realised | `pwin` regret | last-week baseline regret | mode | mode = sign(μ_m − μ_o) |
|---|---|---|---|---|---|---|---|---|---|
| Team A | 1 | 219.1 | 183.2 | 35.9 | 183.2 | 35.9 | n/a | neutral | yes |
| Team B | 1 | 118.1 | 111.5 | 6.6 | 111.5 | 6.6 | n/a | neutral | yes |
| Team A | 2 | 190.7 | 183.9 | 6.8 | 183.9 | 6.8 | 6.8 | protect | yes |
| Team B | 2 | 138.7 | 110 | 28.7 | 110 | 28.7 | 29.5 | chase | yes |
| Team A | 3 | 181.7 | 170.8 | 10.9 | 170.8 | 10.9 | 12 | protect | yes |
| Team B | 3 | 187.5 | 161.9 | 25.6 | 161.9 | 25.6 | 32.4 | chase | yes |

Totals, weeks 2–3 (both teams): `mean` regret **72**, `pwin` regret **72**, last-week baseline regret **80.7**.
Totals, weeks 1–3: `mean` regret **114.5**, `pwin` regret **114.5**.
<!-- generated:lineup:end -->

**Findings.**

- **(a) hard — met:** over weeks 2–3 the `mean` lineup's regret (72.0) is below the last-week
  baseline's (80.7). It never did worse in any team-week; it tied once (Team A, week 2).
- **(b) reported:** `pwin` chose the same starters as `mean` in all six team-weeks, so its regret is
  identical. With `position_cv` widths (one CV per position) the variance lever only moves a lineup
  when two options are nearly tied in mean — which did not happen on these rosters. `mean` stays the
  v1 default (plan 07 C11): nothing here says `pwin` wins.
- **(c) hard — met:** `pwin`'s mode matches the sign of μ_m − μ_o in every matchup (week 1 read
  `neutral`: the two projected totals were within 0.1 σ of each other).
- **(d) / (e) schema — met:** every `Dist` in every E1/E2 result carries `basis: "position_cv"`, and
  every `delta_pwin` is the `{ sign, band }` form (the type makes a two-decimal number impossible
  under `position_cv`; the backtest walks every result to check). The Skills' output template printing
  `basis` is the Skills owner's Lane 1 test.

## A8 — K/DEF streaming

`ff_analyze_waivers(positions: [K, DEF])` over the 64-subject universe, availability `unknown` (manual
league: no platform FA pool — every candidate says so and the Rec names it). Rank correlations are
Spearman ρ between a ranking and realised league points, over the subjects that played that week
(n = 32 per position), for the model (E[pts] from the E5 model), research 05 §8 baseline (a) last
week's points, and baseline (b) the implied total (DEF: facing the lowest opponent implied total;
K: the highest own implied total).

**Universe: backtest vs the served tool.** The served `ff_analyze_waivers` ranks the 32 defences plus
every team's kicker — each kicker whose newest nflverse `roster_weekly` row is on an active roster
(`status` ACT; cut and practice-squad kickers are excluded) — in `kdefUniverse`
(`src/mcp/tools/analytics.ts`): 32 + 32 = 64 subjects, the same population as this backtest's "32
kickers who recorded a 2026 line" up to mid-season signings. The committed `roster_weekly` excerpt
holds **every kicker's row** (40 kickers, 32 active), so fixture mode serves the full universe
too. The served result carries an even, rank-interleaved share of plan 07 E5's "10 candidates
compact": **5 K + 5 DEF** at `compact`, **3 + 3** at `detail: "full"`, both inside C8's 10,000
characters without truncation (Stage B fixer round 3; before it the excerpt held only the fixture
league's 3 kickers, and on the real upstream file the ranking — 32 defences + 40 kickers, cut and
practice-squad ones included, + my own K/DEF — exceeded E1's 64-target bound: every call was
`VALIDATION`. The ranking pass now takes E5's own 96-candidate bound).

<!-- generated:kdef:begin -->
| position | week | n (played) | candidates | implied_total populated | ρ model | ρ last week's points | ρ implied total |
|---|---|---|---|---|---|---|---|
| K | 1 | 32 | 10 | yes | 0.022 | n/a | 0.022 |
| DEF | 1 | 32 | 10 | yes | 0.322 | n/a | 0.322 |
| K | 2 | 32 | 10 | yes | -0.093 | -0.28 | -0.095 |
| DEF | 2 | 32 | 10 | yes | 0.24 | 0.025 | 0.213 |
| K | 3 | 32 | 10 | yes | -0.091 | -0.008 | -0.218 |
| DEF | 3 | 32 | 10 | yes | 0.17 | -0.036 | 0.046 |
<!-- generated:kdef:end -->

**Findings.**

- **Hard — met:** ≥ 3 candidates per position every week (10 each), `implied_total` populated for
  every candidate.
- **Reported:** for **DEF** the model's ρ is positive every week (0.17–0.32) and beats "last week's
  points" in weeks 2–3 (0.24 vs 0.03; 0.17 vs −0.04); against the implied-total baseline it ties in
  week 1 (0.32 vs 0.32 — with no trailing games the model's ranking *is* the implied-total ranking)
  and is higher in weeks 2–3 (0.24 vs 0.21; 0.17 vs 0.05) — research 05 §8's bar "beat (a) clearly
  and at least match (b)" is met on these three weeks. Since QA-1-024 the ranking reads each
  candidate's expected points (a deterministic quadrature over the model's own width), not a
  400-sample mean, so these rows no longer move with the seed.
  For **K** no ranking — model or either baseline — has a meaningful correlation on one week of 32
  kickers (|ρ| ≤ 0.28, signs flip week to week): the evidence that kicker scoring is close to noise
  week to week (research 05 §8.1, §18) shows up plainly, and three weeks cannot separate the methods.
- n = 32 per position-week is small: a single week's ρ has a standard error near 0.18, so these rows
  are a sanity check, not a verdict. The retrospective (E13) accumulates the real sample.

## Latency (A15, analytics share)

Measured by `tests/domain/analytics/perf.test.ts` on the fixture data (warm, this Mac, 2026-09-30):

| call | size | measured | budget |
|---|---|---|---|
| `projectPlayers` (E1) | 32 subjects (28 players + 4 DEF) × 1 week × `n_sims` 4000 = 128,000 scored lines | ≈ 0.5 s (≈ 1.1 s before the Stage B round 2 fix) | < 3 s (asserted) |
| `analyzeKdef` (E5) | 64 subjects, look-ahead 2: pass 1 at 150 samples, pass 2 (12 per position + mine) at 400 + 2 × 150 | ≈ 0.14 s | < 0.5 s (A15 P0) |

Over real stdio on the built server (`tests/process/latency.test.ts`, this Mac, 2026-09-30),
`ff_project_players` for Team A's whole roster (16 players) at `n_sims` 4000 answers in a ≈ 0.29 s
median — inside A15's literal "every P0 tool < 500 ms" (it took ≈ 0.73–0.83 s before: 43 % of the
call was storing 4,000 JSON sample lines per player-week; see HANDOFF "Log").

The scoring engine costs about 7.5 µs per sampled line, which is what sets both numbers.
