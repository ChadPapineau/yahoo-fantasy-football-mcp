## Step 0 — orient (once per conversation)

1. Call `fantasy-football-mcp-server:ff_get_status`. Note `server.tool_contract`, `capabilities.write` (all false in this version), `league.current_week`, `league.edit_key`, and every `sources[]` row whose `freshness` is `stale` or whose `last_error` is set.
   - **Version check.** If `server.tool_contract` differs from this Skill's `metadata.tool_contract`, stop and say: "These Skills expect tool contract N but the server reports M — install the Skills and the server from the same release, then ask again." Do not continue with mismatched tools.
2. Read the league settings **once**: the `ff://league/settings` resource if the client offers it, otherwise `fantasy-football-mcp-server:ff_get_league`. Note `current_week`, `edit_key`, `weekly_deadline`, `rules.uses_faab`, `rules.faab_budget`, `rules.playoffs.start_week`, the roster slots, and `scoring.settings_hash`.
3. **No league yet.** A `NOT_FOUND` error whose hint starts "No league configured" means the user has no league file: say so and offer to set one up (the `onboard` Skill — "set up my league"). An `INTERNAL` error whose hint names `league.yaml` means the file exists but is unsafe or invalid: ask the user to run `ff doctor` in a terminal and fix exactly what it names. Never ask them to paste the file into the chat to debug it.

### Never re-fetch within a conversation (plan 07 §5.3)

| Data | Rule |
|---|---|
| `ff_get_status` | once per conversation; again only after an error that mentions auth or provisioning |
| `ff_get_league` / `ff://league/settings` | once per conversation (24 h; an unchanged `settings_hash` means nothing changed) |
| `ff_get_roster` | once per hour per team; again after a `PRECONDITION_CHANGED`, or in `start-sit`'s game-day branch (at most once with `force_refresh: true`) |
| `ff_get_scoreboard` | once per hour before games; on every call in `start-sit`'s game-day branch (the server's 60 s cache absorbs repeats) |
| `ff_project_players` | once per (player set, horizon, week) — results are deterministic for a `seed` and a `settings_hash` |
| `ff_get_schedule`, `ff_get_injuries` | once per conversation unless the result's `meta.freshness` was `stale` |
| `ff_analyze_*` | re-run only when an input changed (a new roster, a new injury) — `data.inputs[]` says which inputs were used and how old they were |
| any tool | a result already in the conversation with `meta.age_s` under its class TTL is reused verbatim |

### What this version reads (the manual league)

- League settings and the user's roster come from the user's own private file `<config>/league.yaml`, which they keep up to date by hand. It is as current as their last edit: when the roster in it looks out of date, ask before recommending.
- NFL data — schedules, betting lines (implied totals), injuries, weekly rosters, player stat lines — comes from nflverse; game weather from Open-Meteo or the National Weather Service.
- Not available, and never implied: a live free-agent pool (kicker/defense rankings are availability-blind, `availability: "unknown"`), other teams' rosters unless the user entered this week's opponent, standings, matchups and transactions (empty results with a warning), game-day inactive lists, and the platform's own fantasy points (`match: null`).
