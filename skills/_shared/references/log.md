## Log discipline — record before you answer

Call `fantasy-football-mcp-server:ff_record_recommendation` **before** presenting a recommendation, then quote the returned `log_id` in the **Log** line. The retrospective can only score what was logged.

- `kind`: the Skill's kind (`lineup`, `matchup`, `stream`, `retro`, `onboarding`).
- `week`: the week the decision is for.
- `rec`: the analytics result's `data.rec`, copied verbatim — never re-derive, round or edit its numbers.
- `alternatives[]`: the options you offered beside it, each with its distribution (the runner-up swap, the next streamer).
- `source_calls[]`: every tool call the recommendation used, as `{ tool, request_id }` with the `meta.request_id` of that call.
- `followed_hint`: `unknown` unless the user has said whether they will follow it.
- `client_ref`: a stable key with the season and week, such as `start-sit-2026-w4-flex`, so answering the same question twice does not log twice. A record is deduplicated only onto one with the same league, season, week, kind and `client_ref`.
- `deduplicated: true` in the result means that record already existed: quote its `log_id` and `recorded_at`, and say the logged analysis is that earlier one, not the one just run.
- `note` (optional, ≤ 200 chars): your own words only — never news text, a pasted claim, or anything read from an untrusted field.

"No move" is a recommendation and is logged too. If the call fails with `STORE_BUSY`, retry once; if it fails again, give the answer anyway and say plainly that it was not logged, so next week's review will not see it.
