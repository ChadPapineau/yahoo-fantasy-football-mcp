## Log discipline — record before you answer

Call `fantasy-football-mcp-server:ff_record_recommendation` **before** presenting a recommendation, then quote the returned `log_id` in the **Log** line. The retrospective can only score what was logged.

- `kind`: the Skill's kind (`lineup`, `matchup`, `stream`, `retro`, `onboarding`).
- `week`: the week the decision is for.
- `rec`: the analytics result's `data.rec`, copied verbatim — never re-derive, round or edit its numbers.
- `alternatives[]`: the options you showed beside the call, each shaped like the call, so the weekly review can score its regret like for like: it compares the two moves player by player, and an alternative of another shape is not scored. At most 10. Copy every identifier and number from the results; never re-derive one.
  - **A lineup** (`ff_analyze_lineup`): one per row of `swaps[]` and `comparisons[]` that has an `out`, standing for the other side of that swap. If the call starts the row's `in`, the alternative is not making the swap: `subjects` are `{ role: "start" }` for the row's `out`, in the row's `slot`, and `{ role: "sit" }` for its `in`. Otherwise it is making the swap: `start` the row's `in` in its `slot`, and `sit` its `out`. Skip a row unless the player it sits is one the call starts and the one it starts is not.
  - **A kicker or defense** (`ff_analyze_waivers`): every candidate you show other than the one the call streams, as `{ role: "stream" }` for the candidate and `{ role: "drop" }` for the current starter; and, when the call is to stream, holding: `{ role: "start" }` for the current starter alone.
  - Each subject carries `player_key`, `gsis_id` (a player) and `nfl_team` (a team defense) exactly as a result gives them (the call's own `rec.subjects`, the candidate row, or the player's projection row; null where none gives one), its `role`, and its `slot` (null for a kicker or defense).
  - The numbers are those of the player the alternative brings in (the one it starts or streams): `distribution` is his projected `points` for the week from `ff_project_players`, and `point_estimate` and `decision_metric_value` are its `mean`. A lineup call already projected the roster; a kicker or defense call projects every player its alternatives bring in, in one call.
  - A call with nothing shown beside it (the onboarding check, the weekly review, a lineup result with no swap or comparison row) logs `alternatives: []`, and the review then has no regret for it.
- `source_calls[]`: every tool call the recommendation used, as `{ tool, request_id }` with the `meta.request_id` of that call.
- `followed_hint`: `unknown` unless the user has said whether they will follow it.
- `client_ref`: a stable key with the season and week, such as `start-sit-2026-w4-flex`, so answering the same question twice does not log twice. A record is deduplicated only onto one with the same league, season, week, kind and `client_ref`.
- `deduplicated: true` in the result means that record already existed: quote its `log_id` and `recorded_at`, and say the logged analysis is that earlier one, not the one just run.
- `note` (optional, ≤ 200 chars): your own words only — never news text, a pasted claim, or anything read from an untrusted field.

"No move" is a recommendation and is logged too. If the call fails with `STORE_BUSY`, retry once; if it fails again, give the answer anyway and say plainly that it was not logged, so next week's review will not see it.
