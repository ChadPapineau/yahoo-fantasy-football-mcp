## Retrospective metrics — what each one means, and when it has enough data

For one 12-team head-to-head league, a season produces dozens of player-weeks every week but only about 14 matchup outcomes. So the review leads with the player-level measures and names the outcome-level ones as "n too small (k of 30)" until they reach 30.

| Metric | Measures | Good is | Has n ≥ 30 after |
|---|---|---|---|
| CRPS (per player-week) | how close the whole projected distribution was to the realised points | lower | about one week |
| Pinball loss at p10 / p50 / p90 | whether each quantile sat where it should | lower | about one week |
| 80 % coverage | share of realised points inside p10–p90 | close to 80 % | about one week |
| Spearman by position | whether the projections ranked players in the right order | higher | a few weeks per position |
| Swap regret | points lost against the best alternative the analysis offered | lower (0 = optimal) | a few weeks |
| Brier of `P(active)` | calibration of the chance a Questionable or Doubtful player plays | lower | a few weeks |
| Brier of `P(win)` | calibration of matchup win chances | lower | more than two seasons (≈ 14 a season) |
| Brier of `P(win given bid)`, `P(role holds)` | waiver and role calls | lower | not within a season in one league |

**Regret** of a call = realised points of the best alternative that was offered − realised points of the choice. A call is **decisive** when the matchup margin was smaller than the Δ between the options, so the call changed the result.

**Reading a Brier score:** 0 is perfect; always guessing the base rate scores the base rate's variance. Below 30 outcomes a Brier score says nothing — which is why the review prints the phrase instead of the number.
