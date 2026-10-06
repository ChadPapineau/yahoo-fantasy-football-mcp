# 07 — Tool catalog (tools, resources, prompts, token economy)

**Part of:** the product plan (07–10) · **Date:** 2026-09-29
**Inputs (cited, not restated):** `docs/HANDOFF.md`; plan 01 (naming D9/§4.1, envelope §4.2, errors §4.3, data classes §5.2, seam §8), plan 02 (gate §4, bounds §5, injection §6), plan 03 (doctor §5), plan 05 (fixtures §3), plan 06 (jobs); `docs/research/05-strategy-and-analytics.md` (05 — methods by §), `04-data-sources.md` (04 — sources by need #), `03-yahoo-api.md` (03 — capability rows, §B.5 stat ids), `06-skills-and-mcp-design.md` (06 — split criteria §B, candidate names §B.2, token facts §A.6), `02-prior-art-lessons.md` §1/§5; the mcp-builder `mcp_best_practices.md` and `evaluation.md`.
**Yahoo-dependency:** `read` — A1–A5, B1–B2, C1–C2 over Yahoo (served from a hand-filled YAML by `ManualLeagueProvider` in Phase 1a), D2's game-day path, E3's `yahoo_cross_check`. `write` — §3.F (conditional). **`none`** — D1, D3–D6, E1–E2, E4–E14, G1, G3 and every resource over datasets: the analytics layer. *(tag added round 1, D.2 item 1: what survives a Yahoo denial is visible at a glance.)*

**Legend.** Priority: **P0** = read-only MVP · **P1** = first enhancement wave · **P2** = model wave · **later** = after v1. `UT` = manager- or editor-authored text emitted only inside the `untrusted_text` wrapper (team/league names, manager nicknames, notes, news — plan 01 §4.2 item 1). `UN` = a **Yahoo-authored player name**, emitted as a bare capped string and labelled by JSON path in `meta.untrusted_fields[]` with `source: "yahoo.player.name"` (plan 01 §4.2 item 2) *(round 1, OBJ-07 — every `name` on a player row below was `UT` before)*. Recommendation-log free text read back by E13/E14/`ff://rec/*` is likewise path-listed with `source: "store.recommendation_log"` (OBJ-15). `Dist` = `{ mean, p10, p25, p50, p75, p90, p_zero, basis: "position_cv" | "player_sim" }` — `basis` says where the spread came from: `position_cv` = a position-level CV table around a trailing mean (v1: the same relative width for every RB), `player_sim` = simulated stat lines for *this* player (v2); every output template prints it *(round 1, OBJ-04)*. `Rec` = the 05 §0 contract rendered as `{ action, point_estimate, distribution: Dist, delta_vs_next: { value, p10, p90 }, decision_metric, drivers[]: { name, contribution }, assumptions[]: { text, revisit_trigger }, confidence: { role_games, inputs[]: { source, as_of, age_s, freshness } }, as_of, latest_execution_time, no_move: boolean, log_id: null }` — `log_id` is filled only by `ff_record_recommendation`. `PlayerSelector` = exactly one of `{ player_keys: string[1..25] } | { gsis_ids: string[1..25] } | { team_key } | { nfl_team: abbr }` (plan 02 §5 bound; larger sets go through a selector, never a key list). Every tool: inputs are zod v4 `.strict()` with the bounds of plan 02 §5; outputs are the plan 01 §4.2 envelope (`data` shown here is `data` only); annotations follow the plan 01 §4.1 family table unless stated. Every tool description carries a ≤ 45-char pointer to the untrusted-text rule — `Untrusted fields: see server instructions.` — which is served **once**, in the server's `instructions` field (plan 02 §6.3; C13, *round 2 OBJ-28*).

Every tool below carries **decision · why · alternative · what would change it** in its last line (`D/W/A/C`).

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| C1 | **Plan 01 naming and output contract are adopted verbatim**; doc 06's `yahoo_*`/`nfl_*`/`proj_*` names, compact-table `content`, and opaque `page_cursor` are not (§1 maps them). One JSON serialisation per result; the list tools (C10) omit `structuredContent` until plan 10 A17 answers whether clients forward both copies *(revised round 1, OBJ-06)* | plan 01 is the convention; one output format halves the test surface (plan 01 §4.2); whether Claude Code/Desktop forward `structuredContent` in addition to `content` is research 06's U-2 — if both, every §5.1 row doubles, so the plan stops doubling until it is measured | doc 06 §A.6's compact table (est. 2× cheaper, unmeasured [06 U-10]); the earlier "Markdown as a second text block" escape hatch — **deleted** (a third copy) | A17 showing one copy forwarded → list tools regain `structuredContent`; a measured `compact` ratio > 2× (B12) → the compact-table format is revisited as a *replacement*, never an addition |
| C2 | **`detail: "compact" \| "full"` on every list/card/analytics tool, default `compact`** — a *field-selection* parameter inside the JSON contract | recovers most of doc 06's token saving without a second format; the Anthropic guidance cited in 06 §A.6 (−65 % with a format enum) | no selector; always full | nothing — `compact` is the contract Skills rely on (§5) |
| C3 | **31 read tools in v1 (19 P0 + 11 P1 + 1 P2), 7 conditional write tools, 4 `later` (A6, E15, E16, G2) — registered by `FF_TOOLSET=core\|full`: `core` (the default) registers the 19 P0 tools; `full` adds the P1/P2 analytics** *(revised round 1, OBJ-08/OBJ-21; the earlier "34 = 19 + 15" was a miscount — the P1 list was 14)* | the per-turn fixed cost is definitions, not results: in Claude Desktop (no Tool Search) `tools/list` is sent every turn, so 30+ tools × (`inputSchema` + `outputSchema` + a ~400-char description) is tens of thousands of chars before any result (06 §A.1, §A.6); Claude Code's deferral (Tool Search) does not apply there. Toolset gating keeps the Desktop default at the P0 surface; the analytics engines are still all designed and ship under `full` | collapse §3.E into a single `ff_analyze(kind, …)` dispatcher — **rejected**: it hides tools from annotations and the client's per-tool permission prompts; toolset gating achieves the budget without that cost | the plan 10 §2 fixed-cost ledger row exceeding its ceiling even under `core` → cut `outputSchema` further (C10) or split `core` again |
| C4 | **The recommendation log is written by a tool (`ff_record_recommendation`), not implicitly by every analytics tool** | 05 §19.3: the log must hold *the recommendation the model made and the alternatives it offered*, which only the caller knows; implicit logging would record tool outputs the model never presented | log inside each analytics tool | never — but each analytics result carries `rec` so the record call is a copy, not a re-derivation |
| C5 | **K/DEF streaming is a mode of `ff_analyze_waivers` (`positions: ["K","DEF"]`, `look_ahead`), not a separate tool** — and it is the P0 slice of that tool | 05 §8 is 05 §2's stream baseline applied to two positions; one ranking contract, one drop/claim path; the P0 data (lines, schedule, FA pool, engine) suffices for K/DEF before usage data exists | `ff_analyze_streamers` | none |
| C6 | **`ff_get_player_stats` recomputes engine points and returns `match` in the same call** | the golden check (05 §15) is the product's integrity signal; onboarding needs it in one call; the reference implementation is "one call away" (03 §B.5) | a separate `score_stat_line` tool (06 §B.2) | none; the what-if scorer is a different tool (`ff_analyze_scoring`, `later` since round 1 OBJ-21) |
| C7 | **Resources are read-side twins of tool data with `ttlMs` from plan 01 §5.4; prompts are generated from `SKILL.md`** | 06 §A.3 (resources are application-driven; prompts hold no logic); plan 01 §4.1 fixes `ff://` and `ff.<workflow>` | tools only | a client that auto-loads resources → the settings digest moves out of Step 0 entirely |
| C8 | **Analytics results are capped at 10 000 chars by construction (arrays halved with a warning); list results use the 20 000-char budget of plan 01 §4.2** | a recommendation that needs paging is a recommendation the model cannot hold in one place | one budget for all | nothing |
| C9 | **Clean negatives are surfaced by the tools themselves** (`routes_proxy`, `faab_budget: null`, `hypothesis_only: true`, `evidence_note`) rather than by Skill text alone | Skill text is advisory; a field is a contract a test can assert | Skill text only | none |
| C11 | **v1 start/sit defaults to `objective: mean`; `pwin` is opt-in until plan 10 A7 shows it wins; every `Dist` carries `basis`; in `position_cv` mode `delta_pwin` is a sign + coarse band and `coin_flip` widens** *(added round 1, OBJ-04)* | with v1 inputs the p10/p90 are `gamma(mean, CV_position)`, so σ and every ΔP(win) are functions of roster composition and a five-row table, not of the players — a two-decimal `delta_pwin` would be a dressed-up point estimate; protect/chase (the sign of `μ_m − μ_o`) is real and stays | drop the `pwin` machinery from v1 — rejected: Phase 3 needs it and it is the same solver; only the default and the reporting change | A7's `pwin`-vs-`mean` regret favouring `pwin` on the fixture weeks → default flips; `basis: player_sim` (v2) → `delta_pwin` returns to a number |
| C12 | **E13 is reframed around the metrics that reach n ≥ 30 within weeks for one league** — per-player projection CRPS/pinball/coverage, swap regret, `P(active)` Brier — and names `p_win`, `p_win_given_bid`, `p_role_holds` as "n too small" until they do; `parameter_changes_proposed[]` leaves the v1 schema for Phase 3 *(added round 1, OBJ-05)* | one 12-team H2H league yields 14 `p_win` outcomes a season and a handful of bids; under 05 §12.6's own `n < 30` rule the Brier suite is empty in-season, while player-weeks accrue by the dozen every week (plan 10 §2.1 says which metric reaches n when) | the full metric suite as framed | held-out seasons (Phase 3) — then the outcome metrics have n and the parameter loop returns |
| C13 | **The plan 02 §6.3 untrusted-text sentence is served once, in the server-level `instructions` field (2026-07-28 `DiscoverResult.instructions`; the legacy `initialize` result via the SDK's dual-era serving); every tool description carries a ≤ 45-char pointer; the `ff://docs/tool-outputs` resource and every Skill's guardrail also carry the sentence** *(added round 2, OBJ-28)* | ~260 chars × 19–31 tools was 5–8k chars of identical text in every `tools/list`; the spec has a server-level place for it — "Optional natural-language guidance for LLMs on how to use this server effectively" [V-spec server/discover, fetched 2026-09-30 during the review — log §D.0]. But a client is **not required** to call `server/discover`, and whether it forwards `instructions` to the model is [U] per client (plan 02 A-12) — so **the pointer is the guarantee and the `instructions` field is the economy**, with the resource and the Skills as the [U]-proof carriers | the sentence verbatim in every description (round 1) | a client verified (A17-style) to forward `instructions` → the pointer may shrink further; one verified *not* to → the resource and Skill copies are the only carriers there, as designed |
| C10 | **`outputSchema` is omitted on the large list tools** — `ff_list_players`, `ff_list_transactions`, `ff_list_recommendations`, `ff_get_player_usage`, `ff_get_news` — whose `data` shape is documented in `ff://docs/tool-outputs` instead; every other tool keeps its `outputSchema` *(added round 1, OBJ-08)* | a zod-derived `outputSchema` for a 25-row list is the single largest item in `tools/list`, sent every turn in Desktop (06 §A.6's rule); the model gains nothing from it that the cheat-sheet does not give | `outputSchema` everywhere (plan 01 §4.2's original rule) | the measured fixed cost (plan 10 §2) coming in far under its ceiling → restore them |

---

## 1. Name map — doc 06 proposals → this catalog (plan 01 §4.1 verbs)

| doc 06 §B.2/§B.3 name | Catalog name | Note |
|---|---|---|
| `server_status` | `ff_get_status` | plan 01 §7 |
| `yahoo_list_leagues` | `ff_list_leagues` | |
| `yahoo_get_league` / `yahoo-ff://league/{key}/settings` | `ff_get_league` / `ff://league/settings` | |
| `yahoo_get_standings` | `ff_get_standings` | |
| `yahoo_get_scoreboard` | `ff_get_scoreboard` | |
| `yahoo_get_transactions` | `ff_list_transactions` | list verb |
| `yahoo_get_players` | `ff_list_players` **+** `ff_search_players` | split per plan 02 §6.4 |
| `yahoo_get_draft_results` | `ff_get_draft_results` | later |
| `yahoo_get_roster` | `ff_get_roster` | |
| `yahoo_get_player_stats` (+ `score_stat_line`) | `ff_get_player_stats` (engine check folded in) | C6 |
| `nfl_get_usage` | `ff_get_player_usage` | |
| `nfl_get_injuries` | `ff_get_injuries` | |
| `nfl_get_schedule` | `ff_get_schedule` | lines + weather folded in |
| `nfl_get_depth_chart` | `ff_get_depth_chart` | |
| `nfl_get_defense_profile` | `ff_get_defense_profile` | |
| `nfl_get_trending` | `ff_list_trending_players` | |
| `nfl_get_news` | `ff_get_news` | |
| `nfl_resolve_player` | (folded into `ff_search_players.crosswalk`) | no separate tool |
| `proj_get_projections` | `ff_project_players` | plan 01 verb `project` |
| `replacement_baselines` | `ff_analyze_replacement` | |
| `lineup_optimize` | `ff_analyze_lineup` | |
| `matchup_win_probability` | `ff_analyze_matchup` | pre / live / season |
| `waiver_rank` (+ K/DEF `stream_rank`) | `ff_analyze_waivers` | C5 |
| `trade_evaluate` | `ff_analyze_trade` | |
| `injury_cascade` | `ff_analyze_injury_cascade` | |
| `schedule_plan` | `ff_analyze_schedule` | |
| `roster_construction` | `ff_analyze_roster` | |
| `evidence_conflict_check` | `ff_analyze_evidence` | |
| `rec_log` | `ff_record_recommendation` | verb `record` — T1, applied round 1 (plan 01 §4.1 verb list) |
| `rec_retrospective` | `ff_analyze_retrospective` | |
| `yahoo-ff://rec/{id}` | `ff://rec/{log_id}` + `ff_list_recommendations` | |
| `draft_advise` | `ff_analyze_draft` | later |
| `yahoo_ff_playbook` | `ff_get_playbook` | later (round 1, OBJ-21) |
| (none) | `ff_analyze_league_activity` | the "league activity digest" — earns a tool (§3.E11) |
| (none) | `ff_analyze_scoring` | what-if scoring across settings variants — later (round 1, OBJ-21) |
| `prepare_lineup_change` / `commit_lineup_change` | `ff_prepare_lineup` / `ff_commit_lineup` | plan 02 §4 semantics |
| `prepare_transaction` / `commit_transaction` | `ff_prepare_transaction` / `ff_commit_transaction` | |
| `prepare_claim_update`, `prepare_cancel` | folded into `ff_prepare_transaction(kind: claim_edit \| claim_cancel)` | one prepare per Yahoo write family |
| `prepare_trade` / `commit_trade` | `ff_prepare_trade` / `ff_commit_trade` | |
| (none) | `ff_cancel_prepared` | plan 01 verb `cancel` |

---

## 2. Conventions shared by every tool (stated once)

- **Common inputs.** `league_key?` (defaults to the operator-configured league in `ff://league`; validated against the allow-list, plan 02 §5); `force_refresh?: boolean` (platform-fact tools only; once per 60 s per key, plan 01 §5.3); `allow_stale?: boolean` (plan 01 §5.4); `detail?: "compact" | "full"` (C2). `week` is `1..22`; omitted = the league's `current_week`.
- **Toolset (C3; round 1).** `FF_TOOLSET=core` (default) registers the 19 P0 tools; `FF_TOOLSET=full` adds the P1/P2 analytics (C3, D1, D4–D6, E4, E6–E11). Write tools are gated separately by plan 02 S5. The registry order is fixed either way (plan 01 §3.1); `tests/smoke/expected-tools.json` holds both lists.
- **Common outputs.** The plan 01 §4.2 envelope. Analytics tools additionally carry `data.inputs[]` (each contributing dataset with `source, as_of, age_s, freshness`) and `data.rec: Rec`; `meta.estimate: true` on every number that is ours (04 §G.1). Missing drivers are named in `data.rec.assumptions[]`, never silently omitted (plan 01 §5.7).
- **Errors.** Plan 01 §4.3 codes only. A write-path validation failure (locked player, ineligible slot, IR-ineligible status, over-limit) is `VALIDATION` at `prepare` time, never a `commit` failure (06 §B.2 row 22).
- **Annotations.** By family (plan 01 §4.1): platform facts `R+open`; our analytics `R, idempotent:false, open:false`; external text `R+open`; **local write** (`ff_record_recommendation`, `ff_prepare_*`, `ff_cancel_prepared`): `readOnlyHint:false, destructiveHint:false, openWorldHint:false`, `idempotentHint:true` for `record` (dedup on `client_ref`) and `false` for prepare/cancel *(round 1, T8 + OBJ-19 — `prepare_*` was `readOnlyHint:true` before)*; commit `destructive, idempotent`; ops `R, open:false`. No per-tool exceptions remain.
- **Provenance.** `meta.source[]` names every contributing dataset; `meta.attribution` carries Yahoo's wording whenever `yahoo` is in `source` (HANDOFF terms); Sleeper and Open-Meteo results carry `license: "non-commercial"` so the 04 §G.3 trigger is visible in the payload; `meta.untrusted_fields[]` lists every `UT` and `UN` path (and every recommendation-log text path, `source: "store.recommendation_log"`) as `{ path, source }` — plan 01 §4.2 (round 1).
- **Token-cost note format.** `typical / worst` serialised characters at `detail: compact`; worst is the halving point.

---

## 3. The catalog

### 3.A League & discovery

**A1 `ff_list_leagues`** — P0 — leagues and my team per league for the logged-in user.
- Inputs: `{ season?: int 2001..2100 (default: current game), include_finished?: boolean = false }`.
- Output `data`: `{ leagues[]: { league_key, name: UT, season, num_teams, scoring_type, current_week, draft_status, is_finished, my_team: { team_key, name: UT }, in_allow_list: boolean } }`.
- Method: 05 §16 #1. Data: 03 §B.1 `users;use_login=1/games;game_keys=nfl/leagues` + `/teams`.
- Token: 400 / 4 000 (10 leagues).
- D/W/A/C: one tool for leagues *and* my team key · every other call needs `team_key`, and both come from the same user resource · separate `ff_list_teams` · a multi-team-per-league game (not NFL).

**A2 `ff_get_league`** — P0 — the normalised settings digest (`S`, `R`, `N`, rules, weeks, stat map).
- Inputs: `{ league_key?, include?: ("league"|"scoring"|"roster"|"rules"|"weeks"|"stat_map")[] (default: all) }`.
- Output `data`: `{ league: { league_key, name: UT, season, num_teams, scoring_type, current_week, start_week, end_week, edit_key, weekly_deadline, league_update_timestamp, is_finished }, scoring: { uses_fractional_points, uses_negative_points, uses_median_score: boolean|null, rules[]: { stat_id, name: UT, canonical: string|null, position_type: "O"|"K"|"DT"|"D", modifier: number|null, display_only: boolean, bonuses[]: { target, points } }, bracket_families[]: { family: "dst_points_allowed"|"dst_yards_allowed"|"fg_distance", members[]: { stat_id, lower, upper } }, unmapped_stat_ids[], settings_hash }, roster: { slots[]: { name, class: "starter"|"flex"|"bench"|"ir"|"other", count, eligible[] }, starters, bench, ir, total }, rules: { waiver_type, waiver_rule, waiver_time_days, uses_faab, faab_budget: int|null, trade_end_date, trade_ratify_type, trade_reject_time_days, can_trade_draft_picks: boolean|null, max_adds: int|null, max_weekly_adds: int|null, playoffs: { uses_playoff, start_week, num_teams, reseeding, multiweek_championship, consolation_teams }, player_pool, cant_cut_list, allow_add_to_dl_extra_pos, unverified_fields[] }, weeks[]: { week, start, end, is_current, provisional } }`.
- Method: 05 §0 (`S`/`R`/`N`), §15 inputs. Data: 03 §B.2 settings + metadata, §B.1 `game_weeks`, §B.5 stat ids; plan 01 §8.1 normaliser.
- Token: 2 500 / 6 000.
- Clean negatives carried as fields: `faab_budget: null` (03 §E — derive from pre-season `faab_balance` max or ask), `max_adds`/`max_weekly_adds: null` (03 §F.10), enumerations in `unverified_fields[]` (03 §F.9).
- D/W/A/C: one digest, normalised · every Skill's Step 0 reads it once; `settings_hash` is the engine's memo key (plan 01 §8.1) · raw settings passthrough · nothing.

**A3 `ff_get_standings`** — P0 — standings plus the per-team scalars rivals' decisions depend on.
- Inputs: `{ league_key? }`.
- Output `data`: `{ teams[]: { team_key, name: UT, manager: UT, rank, playoff_seed, wins, losses, ties, pct, streak: { type, value }, points_for, points_against, waiver_priority, faab_balance: int|null, number_of_moves, number_of_trades, roster_adds_week: int|null, clinched_playoffs, is_mine }, playoff_line: { num_playoff_teams, start_week } }`.
- Method: 05 §4.3 (rival budgets), §11.4 (season sim input), §14.5. Data: 03 §B.2 standings + §B.3 team fields.
- Token: 3 000 / 5 000.
- D/W/A/C: team scalars folded in · no separate team tool is needed (06 §B.2 row 3) · `ff_get_team` · none.

**A4 `ff_get_scoreboard`** — P0 — matchups for a week, with Yahoo's own projection and win probability as cross-checks.
- Inputs: `{ league_key?, week?, team_key? (only that matchup) }`.
- Output `data`: `{ week, matchups[]: { status: "preevent"|"midevent"|"postevent"|string, is_playoffs, is_consolation, is_tied, winner_team_key: string|null, teams[2]: { team_key, name: UT, points, projected_points_yahoo, win_probability_yahoo, is_mine } } }` + `meta.provisional` (03 §D.2).
- Method: 05 §11 (cross-check, not an input), §12 (realised results). Data: 03 §B.2 scoreboard.
- Token: 2 000 / 4 000.
- D/W/A/C: Yahoo's numbers are labelled `_yahoo` · 05 §11 pitfalls: "using Yahoo's `win_probability` as ground truth" · merging them into ours · none.

**A5 `ff_list_transactions`** — P0 — league transactions, Yahoo's most-recent-N merged with the server's persisted history.
- Inputs: `{ league_key?, types?: ("add"|"drop"|"add/drop"|"trade"|"commish"|"waiver"|"pending_trade")[], team_key? (required for waiver/pending_trade, 03 §B.2), count?: 1..200 = 25, since?: ISO }`.
- Output `data`: `{ transactions[]: { transaction_key, type, status, timestamp, faab_bid: int|null, waiver_priority: int|null, players[]: { player_key, name: UN, position, team_abbr, action: "add"|"drop"|"trade", source_type, source_team_key, destination_type, destination_team_key }, trader_team_key, tradee_team_key, note: UT }, history_coverage: { oldest_seen, gap_suspected: boolean } }`; `page.has_more` is always `false` (plan 01 §4.2; 03 §B.2 no `start`).
- Method: 05 §4.3 (FAAB price history), §5 evaluation (trade replay), §12 (followed?). Data: 03 §B.2; `transactions_seen` (plan 01 §5.2, plan 06 §1.3).
- Token: 5 000 / 20 000 (halving at count ≈ 90).
- D/W/A/C: merge with persisted history · "most recent N" cannot page (03 §E) · Yahoo only · Yahoo documenting `start`.

**A6 `ff_get_draft_results`** — later — picks/rounds/costs; ships with `ff_analyze_draft` (05 §13 low priority). Data: 03 §B.2 `draftresults`.

### 3.B Roster & lineup

**B1 `ff_get_roster`** — P0 — a roster with slots, eligibility, statuses, byes, and the **lock schedule computed once**.
- Inputs: `{ league_key?, team_key? (default: mine), week?, detail? }`.
- Output `data`: `{ team_key, week, is_editable, roster_adds_week: int|null, players[]: { player_key, gsis_id: string|null, name: UN, position, eligible[], team_abbr, slot, slot_class, is_flex, is_editable, status: string|null, status_full: UT, injury_note: UT, bye_week, opponent: string|null, kickoff: ISO|null, lock_at: ISO|null, percent_owned, percent_owned_delta, week_points: number|null }, lock_schedule[]: { lock_at, player_keys[] }, empty_starting_slots[], ir_ineligible_in_ir[], over_limit: boolean, latest_execution_time: ISO|null }` + `meta.provisional` on `week_points`.
- Method: 05 §3 (assignment input), §3.4 (lock order), §14.1, §14.2. Data: 03 §B.3 roster with `out=stats,ownership,percent_owned`; 04 #11 schedule for kickoffs; 04 §D crosswalk for `gsis_id`.
- Token: 2 500 / 6 000 (16 players full).
- D/W/A/C: locks joined here · every recommendation must carry `latest_execution_time` (05 §14.2) and every write validates locks (plan 02 §4.4) — one join, one place · a separate locks tool · none.

**B2 `ff_get_player_stats`** — P0 — league-context stat lines with the engine's recomputation and the golden `match` flag (C6).
- Inputs: `{ league_key?, player_keys: string[1..25], type: "week"|"season", week? (required when `type = week`) }`.
- Output `data`: `{ players[]: { player_key, name: UN, position, stats[]: { stat_id, canonical: string|null, value }, yahoo_points: number|null, engine_points, engine_complete: boolean, match: boolean|null, unmapped_stat_ids[] }, settings_hash }` + `meta.provisional`.
- Method: 05 §15 golden test; 05 §12 realised points. Data: 03 §B.4 (`league/{k}/players;player_keys=…/stats;type=week`), 03 §B.5.
- Token: 4 000 / 10 000.
- D/W/A/C: C6.

### 3.C Players & market

**C1 `ff_search_players`** — P0 — resolve a name to a `player_key` (the only path from a name to an id on any write, plan 02 §6.4) with crosswalk status.
- Inputs: `{ league_key?, query: string 1..64, position?, limit?: 1..25 = 10 }`.
- Output `data`: `{ players[]: { player_key, gsis_id: string|null, name: UN, position, eligible[], team_abbr, uniform_number, status: string|null, ownership: { type: "team"|"waivers"|"freeagents", owner_team_key: string|null, owner_name: UT, waiver_date: string|null }, percent_owned, percent_owned_delta, bye_week, crosswalk: { method: "id"|"match"|"override"|"none", confidence: 0..1 }, has_recent_notes, notes_last_ts } }`.
- Method: plan 02 §6.4; 04 §D. Data: 03 §B.2 `search` + `ownership`, `percent_owned`; crosswalk store.
- Token: 3 000 / 7 500.
- D/W/A/C: split from `ff_list_players` · identity resolution has a different contract (crosswalk status, ownership) and is the name→id gate the security plan names · a `search` filter on the list tool · none.

**C2 `ff_list_players`** — P0 — browse a pool (free agents, waivers, taken, all) with ownership and optional stats.
- Inputs: `{ league_key?, status?: "A"|"FA"|"W"|"T"|"K" = "A", position?: string (validated against `roster.slots[].eligible` ∪ slot names), sort?: "OR"|"AR"|"PTS"|"NAME"|stat_id = "OR", sort_type?: "season"|"week", sort_week?, with_stats?: { type: "week"|"season", week? }, limit?: 1..100 = 25, offset?: 0..10000 = 0, detail? }`.
- Output `data`: `{ players[]: { player_key, gsis_id: string|null, name: UN, position, eligible[], team_abbr, status: string|null, status_full: UT, injury_note: UT, bye_week, ownership: {…as C1}, percent_owned, percent_owned_delta, competition_signal: true, waiver_date: string|null, season_points: number|null, week_points: number|null, next_opponent: string|null, next_kickoff: ISO|null } }` + `page`.
- Method: 05 §2 (stream baseline pool), §4.1/§4.3 (`percent_owned.delta` is the *competition* signal — the field is literally named so), §8 (K/DEF pool). Data: 03 §B.2 players collection (25/page → ⌈limit/25⌉ requests, plan 01 §4.2); 04 #11 for next opponent/kickoff.
- Token: 5 000 / 20 000.
- D/W/A/C: one pool tool · same Yahoo collection, `status` is a filter · `ff_list_free_agents` + `ff_list_waivers` · none.

**C3 `ff_list_trending_players`** — P1 — Sleeper trending adds/drops mapped into this league's availability.
- Inputs: `{ league_key?, kind: "add"|"drop", lookback_hours?: 24|48|72 = 24, limit?: 1..50 = 25 }`.
- Output `data`: `{ players[]: { gsis_id: string|null, sleeper_id, player_key: string|null, name: UN, position, team_abbr, count, league_status: "FA"|"W"|"T"|"unknown", owner_team_key: string|null } }` + `meta.attribution[]` with `license: "non-commercial"`.
- Method: 05 §4.1 (competition/attention, not detection), §4.3. Data: 04 #13 Sleeper trending (primary), Yahoo ownership for `league_status`.
- Token: 2 500 / 5 000.
- D/W/A/C: Sleeper as the attention signal · keyless, CDN-cached, 04 #13 primary · Yahoo `percent_owned.delta` alone · commercial distribution (HANDOFF item 6) → replace with the server's own `fa_pool_snapshot` diffs (plan 06 §1.3).

### 3.D Stats & usage (external sources)

**D1 `ff_get_player_usage`** — P1 — per-game opportunity and efficiency inputs, trailing-window summaries, change points, and the `xFP − actual` gap.
- Inputs: `{ league_key?, players: PlayerSelector, window?: 1..17 = 4, include_prior_season?: boolean = false, detail? }`.
- Output `data`: `{ players[]: { player_key: string|null, gsis_id, name: UN, position, nfl_team, games[] (full only): { week, opponent, snaps, snap_pct, routes_proxy: number|null, targets, target_share, air_yards, air_yards_share, adot, wopr, racr, carries, carry_share, rz_targets, rz_carries, gl_carries, xfp_ep: number|null, points_league, xfp_gap: number|null }, trailing: { window_games, snap_pct, target_share, carry_share, rz_share, wopr, tprr_proxy, xfp_gap_sum, change_point: { week, metric, delta } | null }, role_confidence_games, data_gaps[] }, notes: ["routes are a snap-share proxy (04 #3)"] }`.
- Method: 05 §1 steps 2–3, §4.1 signals 2–5, §10.3. Data: 04 #1 `stats_player_week`, #2 `snap_counts` (via `pfr_id`), #4 (direct columns), #5 pbp-derived RZ/GL, B2 ffopportunity EP; 04 §D crosswalk.
- Token: 300 per player compact (16 → 5 000) / 20 000 full (halving).
- Clean negative: **routes run has no free in-season source** (04 #3); `routes_proxy` = `snap_pct × team dropbacks` and is named so.
- D/W/A/C: one usage tool with a trailing summary computed server-side · the model must not average per-game rows itself (05 §17.1); the EWM/half-life is a tuned parameter (05 §1 step 2) · raw rows only · none.

**D2 `ff_get_injuries`** — P0 — official designations, practice trend, secondary sources, and a first-cut `p_active`.
- Inputs: `{ league_key?, players?: PlayerSelector (default: my roster), only_flagged?: boolean = false }`.
- Output `data`: `{ players[]: { gsis_id: string|null, player_key: string|null, name: UN, position, nfl_team, official: { report_status: string|null, practice[]: { day, status }, primary_injury: UT, secondary_injury: UT, report_week, as_of }, yahoo: { status: string|null, status_full: UT, injury_note: UT, as_of }, sleeper: { injury_status: string|null, notes: UT, news_updated: ISO|null, as_of }, p_active: number|null, p_active_basis: "designation_base_rate"|"trend_model"|"yahoo_gameday_status"|"none", trend: "improving"|"flat"|"worsening"|null, ir_eligible: boolean, sources_agree: boolean|null, game_day: boolean }, base_rates_note: "Q → played 71 % 2017–2023 (05 §3.5)" }`.
- **Game day (round 1, OBJ-16).** Inactives are published ~90 minutes before kickoff and exist in **none** of the non-Yahoo sources: nflverse `injuries` is the Wed–Sat official report with no inactives at all (04 A #6), and Sleeper `players` is loaded once a day at 05:00 because it is a 5 MB dump "to be used once per day at most" (04 B4; plan 06 §1.2). So **within 3 h of a player's kickoff, availability comes from Yahoo `status`/`status_full` only**: `game_day: true`, `p_active_basis: "yahoo_gameday_status"` (`O`/`IR`/`NA`/`SUSP` → 0; active → 1; `Q`/`D` → the base rate until Yahoo's status changes), `sources_agree` is **suppressed** (`null`) rather than computed against a Friday designation, and `official`/`sleeper` are still shown with their `as_of` so their staleness is visible. No game-day Sleeper refreshes are added — Sleeper's etiquette stays honoured; Yahoo's status is the live source the product already has. `start-sit`'s game-day branch reads exactly this (plan 09 §3.3).
- Method: 05 §1 step 8, §3.5, §10.3 (availability conflicts), §14.1 (IR eligibility list from 03 §C.1). Data: 04 #6 nflverse `injuries` primary Wed–Sat, Sleeper secondary; Yahoo status fields (03 §B.4) — the *only* live source on game day.
- **When a report clears a player (QA-2-034 / QA-1-021, 2026-10-06).** nflverse lists a team's week rows from its first practice report; the game-status designations follow about two days later. A team's week report is final when it carries a designation, when a team playing on the same or a later Eastern date has one, or from 24 h before its kickoff, and only a final report clears a player. Until then the newest designation from a final report is carried, for at most `INJURY_REPORT.carryWeeks` = 2 weeks past that report; after that availability is unknown (`p_active` null, named). A carried Questionable is refined by the newest practice level, and an undesignated player on a practice-only report is named as designation pending — unless he did not practise on it for an injury (a rest day is not one): a new injury is not cleared, so he gets the practice trend's Questionable-and-did-not-practise rate until his designation is out (`dnp_pending`, named). D2 reads the report as E1 does (each team's report state per week, the newest earlier final report, the newest practice row); D2 names the carried, expired and pending-DNP teams in `warnings[]`, and E1 names the carried, pending and expired states in its assumptions (QA round 2 register, QA-2-034).
- Token: 3 000 / 8 000.
- D/W/A/C: three sources side by side with `sources_agree` **during the week**, Yahoo alone **on game day** · 05 §10.3: "official beats unofficial for availability" needs both visible — except when only one is live · one merged field; game-day Sleeper refreshes at 11:00/14:30/18:30 ET (rejected: 3 × 2.6 MB on 17 Sundays against a stated once-a-day etiquette, for data Yahoo already gives) · a logistic `p_active` model (P2) replaces the base-rate table without changing the shape.

**D3 `ff_get_schedule`** — P0 — kickoffs, byes, lines → implied totals, roof, weather; the market anchor.
- Inputs: `{ weeks?: int[1..6] (default: [current]), nfl_team?, include_weather?: boolean = true, include_lines?: boolean = true }`.
- Output `data`: `{ games[]: { game_id, week, kickoff_et, kickoff_local, away, home, roof, surface, divisional, rest_days: { away, home }, lines: { spread_line, total_line, implied: { away, home }, moneyline: { away, home }, as_of, source: "nflverse:schedules", secondary: { books, spread, total, as_of } | null } | null, weather: { temp_f, wind_mph, gust_mph, precip_prob, as_of, source } | null, is_final, score: { away, home } | null }, byes: { [week]: nfl_team[] } }`.
- Method: 05 §1 step 1 (implied totals; sign convention 04 B1: positive `spread_line` = home favoured; `implied_home = (total + spread)/2`), §1 step 7 (weather only where evidenced), §3.4 (kickoff order), §7, §8. Data: 04 #8 primary `schedules`, secondary The Odds API (optional key); #9 Open-Meteo/NWS; #11.
- Token: 6 000 per week / 20 000 (3 weeks full).
- D/W/A/C: lines and weather ride on the schedule row · one game, one row; the model must never re-derive an implied total · separate `ff_get_lines`, `ff_get_weather` · none.

**D4 `ff_get_depth_chart`** — P1 — a team's depth chart with the snap cross-check.
- Inputs: `{ league_key?, nfl_team?, player?: PlayerSelector (single), positions?: string[] }` (one of `nfl_team`/`player`).
- Output `data`: `{ teams[]: { nfl_team, as_of, groups[]: { pos_grp, slots[]: { pos_abb, rank, gsis_id, player_key: string|null, name: UN, snap_pct_last3: number|null } } }, sleeper_cross_check: "agree"|"disagree"|"unavailable" }`.
- Method: 05 §6.1 (never trust the listed chart over snaps — hence `snap_pct_last3`), §9.2. Data: 04 #7 nflverse `depth_charts` (parquet), Sleeper secondary.
- Token: 2 000 / 6 000.
- D/W/A/C: snaps beside the chart · 05 §6 pitfalls · chart alone · none.

**D5 `ff_get_defense_profile`** — P1 — regressed opponent adjustments and pace/pressure profiles.
- Inputs: `{ nfl_team?: abbr | "all" = "all", position?: "QB"|"RB"|"WR"|"TE"|"K"|"DEF", window_weeks?: 4..17 = 10 }`.
- Output `data`: `{ defenses[]: { nfl_team, window_games, afpa: { [position]: { allowed_per_game, league_mean, adjusted, shrink_w, multiplier } }, pace_plays_per_game, pass_rate, proe: number|null, pressure_rate: number|null, sack_rate, takeaway_rate, epa_allowed: { pass, rush } | null }, evidence_note: "YoY r QB .27 RB .22 WR .15 TE .16 (05 §18); multiplier is shrunk and ramps with weeks" }`.
- Method: 05 §1 step 6 (aFPA, `β_pos`, `w(weeks)`), §8.2, §18. Data: 04 #10 (`stats_team_week` at P1; pbp-derived at P2), FTN charting (share-alike) for pressure.
- Token: 400 per defense (32 → 13 000 full) → compact returns only the requested position (≈ 4 000).
- D/W/A/C: the shrinkage is applied in the tool and shown · a raw DvP table is the 05 §17.2 pitfall by construction · raw points allowed · none.

**D6 `ff_get_news`** — P1 — RSS items matched to players, with a deterministic claim extract; all text `UT`.
- Inputs: `{ league_key?, players?: PlayerSelector, nfl_team?, since_hours?: 1..168 = 72, limit?: 1..50 = 20, sources?: ("rotowire"|"espn"|"cbs")[] }`.
- Output `data`: `{ items[]: { id, source, published_at, players_matched[]: { gsis_id, player_key: string|null, name: UN, match_confidence }, title: UT, blurb: UT (≤ 400), url: string (text; never rendered as a link), claim: { type: "availability"|"role"|"health"|"coaching_intent"|"transaction"|"other", direction: "up"|"down"|"neutral", extractor: "rules_v1" } | null, reliability_prior: number|null } }` + `meta.untrusted_fields[]`.
- Method: 05 §10.1 (structure), §10.2 (source × claim prior; P2 calibration). Data: 04 B10 RotoWire + ESPN RSS (CBS fallback with promo filter), `ds_news` (plan 01 §5.2).
- Token: 200 per item compact / 12 000 full.
- Clean negative: **no free beat-writer aggregation** exists (04 B10, B13); these are editorial feeds and the tool says so in its description.
- D/W/A/C: claim extraction by deterministic rules, never by the model · plan 02 §6.4: news feeds analytics only as extracted structured features · pass text through · none.

### 3.E Analytics (the decision engines)

**E1 `ff_project_players`** — P0 (`model_version: "v1-trailing"`) → P2 (`"v2-opportunity"`) — floor/median/ceiling per player-week by simulation, stored format-agnostically, scored per league.
- Inputs: `{ league_key?, players: PlayerSelector | { pool: { status: "A"|"FA", position, top: 1..50 } }, horizon: "week"|"ros"|"season", week?, n_sims?: 1000..20000 = 4000, seed?: int, include_stat_line?: boolean = false, detail? }`.
- Output `data`: `{ model_version, projections[]: { player_key: string|null, gsis_id: string|null, name: UN, position, weeks[]: { week, points: Dist, p_active, opponent, implied_total } | one entry for `week`, ros_total: Dist|null, stat_line_expectation: { [canonical]: number } | null, opportunity: { targets, carries, rz_targets, gl_carries, window_games } | null, shrinkage[]: { rate, n, k }, multipliers: { matchup: number|null, weather: number|null }, drivers[]: { name, contribution }, role_confidence_games, assumptions[] }, inputs[] }` + `meta.estimate: true`.
- Method: 05 §1 (all nine steps; v1 implements steps 1, 8, 9 with **trailing nflverse `stats_player_week` lines** scored by the engine as the opportunity/efficiency stand-in — keyless, every player, every season, so v1 needs no Yahoo access and backtests are possible *(revised round 1, OBJ-03)* — and the position CVs of step 9 as the gamma fallback), §19.1. Data: v1 = 05 §16 #1–#5 (stat lines from nflverse `stats_player_week` via `toStatLine(nflverse)`, plan 08 §3.2; lines via D3; injuries via D2). **Yahoo stat lines (B2) are used for the golden check and `match` only, never as the projection input.** v2 adds #6, #7, #10 (04 #1, #4, #5, B2).
- Token: 180 per player compact (32 → 6 000) / 20 000 full.
- Clean negative: **projections are ours** (04 #12, HANDOFF item 7); `meta.estimate: true` and `model_version` are the label. If Chad buys a consensus feed (open decision D2) it enters as a *baseline in the retrospective* (05 §1 evaluation (c)), never as the product.
- **Basis (round 1, OBJ-04).** Every `Dist` here carries `basis: "position_cv"` under `v1-trailing` (the position CVs of 05 §1 step 9 around the trailing mean — honest about being a five-row table, not a per-player simulation) and `basis: "player_sim"` under `v2-opportunity`; the Skills print it next to every interval.
- D/W/A/C: distributions by simulation, stat-line store, per-league scoring · 05 §19.1 · point estimates scaled from a consensus · nothing.

**E2 `ff_analyze_lineup`** — P0 — start/sit as assignment under the H2H objective; variance up when behind, down when ahead.
- Inputs: `{ league_key?, team_key?, week?, objective?: "mean"|"pwin"|"blend" = "mean" (v1 default — round 1, OBJ-04/C11; `pwin` opt-in until plan 10 A7 shows it wins), blend_weight?: 0..1, only_unlocked?: boolean = false, exclude?: player_keys[], force_start?: player_keys[], compare?: { out: player_key, in: player_key }[] (≤ 5) }`.
- Output `data`: `{ objective_used, dist_basis: "position_cv"|"player_sim", current_lineup[]: { slot, player_key, name: UN, points: Dist, lock_at }, recommended_lineup[]: same, mode: "protect"|"chase"|"neutral", mode_basis: { mu_m, mu_o, sigma_m, sigma_o, rho_lineup }, p_win_before, p_win_after, p_win_interval: [lo, hi], swaps[]: { out: player_key | null (null when the swap fills an empty starting seat — QA-1-020/040), in, slot, delta_e, delta_pwin: number | { sign: "+"|"-"|"0", band: "small"|"medium"|"large" } (the coarse form whenever `dist_basis = position_cv` — round 1, OBJ-04), interval: [lo, hi], coin_flip: boolean (widened in `position_cv` mode: `|ΔP(win)| < 0.04` or an interval spanning 0), option_value: { kind: "thursday"|"monday"|"late_game", value, verdict } | null }, comparisons[]?: the `swaps[]` row shape (the caller's `compare` pairs that are not recommended swaps, ≤ 5, present only when `compare` is given — QA-1-010; a recommended swap is never listed here), conditionals[]: { if: { player_key, event: "inactive", decided_by: ISO }, then: { slot, in: player_key } }, stack_flags[]: { players[], effect: "ceiling+"|"floor-" }, lock_schedule[], latest_execution_time, no_move: boolean, rec: Rec }`.
- Method: 05 §3.1 (enumeration/assignment), §3.2 (sign of `μ_m − μ_o`; `|ΔP(win)| < 0.02` with an interval spanning 0 → `coin_flip`), §3.3 (correlation table), §3.4 (Thursday/Monday option value), §3.5 (conditionals), §11.1, §14.2, §14.4, §14.5 (`blend`). Data: B1, A4, E1, D2, D3.
- **Implementation rules (QA round 2, 2026-10-06).** An `exclude`d player scores 0 for the week, the same as `status: O`, so a swap's Δ is measured against the lineup the user actually has; a change that gains nothing (an inactive starter for a bench player on bye) is not made, and a forced start always is (QA-2-038). The no-move rule is applied change by change: the changes are made together when their combined Δ interval excludes 0; otherwise only the changes whose own interval excludes 0 are made and the coin flips are held, `rec.action` names both counts ("make 1 lineup change and hold 1 coin flip"), and `no_move` is true only when the current seats are kept (QA-1-020/040). A starting seat held by a player the crosswalk cannot match is kept as it is: never filled, left out of the totals, `P(win)` withheld, and an assumption names the seat (QA-2-039). A `force_start` the lineup cannot honour is `VALIDATION` with a reason: `on_ir`, `locked` (a reserve whose game has started) or `cannot_seat_together` (QA-1-010). A league whose `scoring_type` is not head-to-head (only the `head*` types are) gets `objective: "mean"` whatever was asked, `mode: "neutral"`, no `P(win)`, and an assumption that says why (QA-2-043).
- Token: 6 000 / 10 000.
- D/W/A/C: opponent-aware in one tool; `mean` default in v1 with the `pwin` solver kept in the code path (C11) · the objective needs the opponent's distribution; splitting would double-fetch and lose the sign rule; with `position_cv` inputs the `pwin` machinery adds nothing measurable yet, and A7 measures exactly that · doc 06's two tools; `pwin` as the default (the earlier draft) · points leagues force `objective: "mean"` (05 §3 format sensitivity) — no shape change; A7 favouring `pwin` → default flips.

**E3 `ff_analyze_matchup`** — P0 (`pre`) / P1 (`live`, `season`) — H2H win probability, live updates, and the season simulation behind `P(playoffs)`.
- Inputs: `{ league_key?, team_key?, week?, mode?: "pre"|"live"|"season" = "pre", method?: "normal"|"mc" = "mc", n_sims?: 1000..20000 }`.
- Output `data`: `{ p_win, interval: [lo, hi], mu_m, sigma_m, mu_o, sigma_o, cov, method, live: { players_final[], players_live[]: { player_key, points_so_far, fraction_remaining }, players_pending[], points_so_far: { me, opp } } | null, yahoo_cross_check: { win_probability, team_projected_points: { me, opp } }, actionable_slots[]: { slot, lock_at }, season: { p_playoffs, p_bye: number|null, p_alive_by_week[]: { week, p }, seed_distribution[], tiebreak_note } | null, rec: Rec }` + `meta.provisional`.
- Method: 05 §11.1–11.4 (normal vs MC, live conditioning, season sim ≥ 10 000 paths), §14.5. Data: A4, B1 (both), E1, A3 + D3 (season).
- **Points-only leagues (QA-2-043, 2026-10-06).** A league whose `scoring_type` is not head-to-head has no opponent to beat: E3 answers `NOT_FOUND` with a hint that says so.
- Token: 3 000 / 6 000.
- D/W/A/C: one tool, three modes · the three share the same simulator and correlation table · three tools · median-score leagues (`uses_median_score`) add a second "opponent" — a field, not a new tool.

**E4 `ff_analyze_replacement`** — P1 — replacement level by allocation, VOR/xVBD, drop-off curves, tiers, streamability.
- Inputs: `{ league_key?, positions?: string[], horizon?: "week"|"ros" = "ros", week?, baseline?: "starter"|"stream"|"both" = "both" }`.
- Output `data`: `{ positions[]: { position, starter_baseline_weekly[]: { week, points }, starter_baseline_ros, stream_baseline_weekly[], curve[]: { rank, vor }, tiers[]: { tier, player_keys[] }, streamability, effective_starters, flex_allocation_trace[]: { slot, position_filled } }, players[]: { player_key, name: UN, position, vor_weekly: number|null, vor_ros: Dist, xvbd, tier } }`.
- Method: 05 §2 (both baselines; allocation with flex; bench effect; Gaussian-mixture tiers; streamability). Data: E1 (ROS), C2 (the actual FA pool), all rosters (B1), A2 (`R`, `N`), D3 (byes), A5 (bench-effect history).
- Token: 6 000 / 12 000.
- D/W/A/C: computed baselines · 05 §2 pitfalls (static baselines) · consensus tiers · none.

**E5 `ff_analyze_waivers`** — P0 for `positions ⊆ {K, DEF}` / P1 for all — opportunity detection before points, weeks-of-value on *my* roster, FAAB bid curve or claim/wait, the drop and its re-add risk.
- Inputs: `{ league_key?, team_key?, positions?: string[] (P0: only K/DEF accepted; `VALIDATION` otherwise with hint), candidates?: player_keys[1..25], horizon_weeks?: 1..17, look_ahead?: 0..2 = 1 (K/DEF default 2), adds_remaining?: int|null, faab_budget?: int|null, reserve?: "none"|"playoff_reserve" = "none", include_drop?: boolean = true, detail? }`.
- Output `data`: `{ candidates[]: { player_key, name: UN, position, availability: "FA"|"W"|"T"|"unknown" (round 2), signals[]: { kind: "injury_cascade"|"snap_jump"|"target_share_jump"|"xfp_gap"|"rz_shift"|"depth_chart"|"implied_total"|"stream", value, evidence: UT|number }, weeks_of_value, p_role_holds[]: { week, p }, marginal_value: Dist, xfp_gap: number|null, competition: { rivals_upgraded[]: team_key, expected_bids: Dist|null, percent_owned_delta, competition_signal: true }, bid: { b_star, p_win_curve[]: { bid, p_win }, lambda, dollars_per_point: { value, n } } | null, claim_or_wait: { verdict: "claim"|"wait", option_value } | null, drop: { player_key, name: UN, value_ros: Dist, re_add_risk: { percent_owned, rivals_claiming } } | null, invalidators[], kdef: { implied_total, opp_implied_total, brackets_e, sacks_e, takeaways_e, rare_c, next_week: { opponent, implied_total, e } } | null }, hold_vs_stream: { position, streamability, current_starter_delta } | null (one position: the requested position whose best option gains most over its starter; `position` names it, and with K and DEF in one call it can differ from `rec`'s — QA-2-004), waiver_clearing_time: ISO|null, rec: Rec }`.
- Method: 05 §4.1 (signals ranked by lead time; `percent_owned.delta` is *competition*, never detection), §4.2 (roster fit via the E2 assignment with/without), §4.3 (first-price shading, price-of-a-point from A5, `λ`), §4.4 (priority leagues), §4.5 (drop exclusions), §8.1–8.3 (K/DEF), §14.3, §14.4. Data: C2, D1, C3, A5, A3, E4, D3, D4, D5, E1.
- **Missing betting lines (QA-2-044, 2026-10-06).** A decision-week game with no line (not published yet, or omitted as stale under QA-1-004) is named in `rec.assumptions[]`: when no game is priced, "no betting lines for week W … trailing points only" replaces the "dominated by this week's implied totals" assumption; when some are, the unpriced games' teams are named. A candidate without its line is never picked over a starter who plays; an empty slot, or a starter projecting 0 (bye, ruled out), is still filled.
- Token: 8 000 / 12 000 (10 candidates compact).
- **P0 vs P1 shape (decided 2026-10-06, a deferred QA round-1 hand-off).** At P0 the result carries one `hold_vs_stream` (labelled by `position`) and one `rec`, so consumers rank one position per call; a candidate's own range is not returned (`ff_project_players` gives it on request). With E5 for all positions (P1, plan 10 §3.2) the schema gains a compact `projection` and a `vs_starter` interval per candidate and one `hold_vs_stream` entry per requested position with a `locked` verdict; `rec` stays single. Design: HANDOFF § Deferred designs.
- **Under `ManualLeagueProvider` (X1; round 2, OBJ-29).** There is no platform FA pool, so for `positions ⊆ {K, DEF}` the tool ranks the **full nflverse K/DEF universe** (every team's kicker and defence from `roster_weekly`/`schedules`) and says so plainly: every candidate carries `availability: "unknown"`, `competition`, `bid` and `drop` are `null`, and `warnings[]` carries "availability unknown — no platform FA pool under the manual league; check the Yahoo waiver wire before claiming". This is a **ranking** by implied total, brackets and sacks/takeaways — not streaming.
- D/W/A/C: C5; usage-first detection · 05 §4 evaluation: the usage detector must beat the points detector · sort FAs by last week's points · none.

**E6 `ff_analyze_trade`** — P1 — roster-contextual Δ for both sides with intervals; partner search.
- Inputs: `{ league_key?, team_key?, offer?: { partner_team_key, give: player_keys[1..6], get: player_keys[1..6] }, find_partners?: { need_position, max_partners: 1..4 = 3 }, horizon?: "ros"|"playoffs" = "ros", risk?: "auto"|"variance"|"floor" = "auto" }` (exactly one of `offer`/`find_partners`).
- Output `data`: `{ delta_me: Dist, delta_partner: Dist, weekly_impact[]: { week, me, partner }, playoff_weeks_impact: { me, partner }, implied_drop: { side, player_key, name: UN, value } | null, health_adjustment: { me, partner }, bye_conflicts[]: { week, player_keys[] }, why_they_accept[]: string, ratification_risk: { type, level: "low"|"medium"|"high", note }, counters[]: { give[], get[], delta_me: Dist, delta_partner: Dist }, verdict: "accept"|"counter"|"decline"|"fair", deadline: trade_end_date, rec: Rec }` or `{ partners[]: { team_key, name: UT, weakest_slot, proposal: { give[], get[] }, delta_me: Dist, delta_partner: Dist } }`.
- Method: 05 §5.1–5.7, §14.6 (ratification as risk, not value), §14.4 (`fair` when the Δ interval includes 0). Data: B1 (both), A3, E1 (ROS), E4, D3, D2, A2 trade rules, A5 trade history.
- Token: 5 000 / 10 000.
- D/W/A/C: computed 2-for-1 haircut from the actual drop · 05 §5.2 · public charts (05 §5.6) · none.

**E7 `ff_analyze_injury_cascade`** — P1 — beneficiaries by role affinity, timing, and an honest evidence grade.
- Inputs: `{ league_key?, player: PlayerSelector (single), assume_weeks_out?: int|null }`.
- Output `data`: `{ injured: { gsis_id, player_key: string|null, name: UN, nfl_team, position, official_status }, expected_weeks: { p25, p50, p75, basis: "report"|"prior" }, beneficiaries[]: { gsis_id, player_key: string|null, name: UN, delta_opportunity: { targets, carries, rz }, delta_proj_by_week[]: { week, delta }, p_role_holds, evidence: { team_games, usage_confirmed, market_move: number|null }, availability: { status: "FA"|"W"|"T", owner_team_key: string|null } }, team_volume_change: { implied_total_delta: number|null }, returning_ramp: { weeks, factor }, hypothesis_only: boolean, rec: Rec }`.
- Method: 05 §6.1–6.4 (role-similarity redistribution; team evidence ≥ 2 games else the prior table — the table itself is a P2 build from pbp, 05 §6.2; `hypothesis_only` when no team evidence, no usage confirmation, no market move). Data: D2, D4, D1 (incl. prior-season absences), D3 (line move), C2.
- Token: 3 000 / 6 000.
- D/W/A/C: `hypothesis_only` as a field · 05 §6.4 · omit · none.

**E8 `ff_analyze_schedule`** — P1 — week-by-week roster stress test, bye-cluster costs, fixes, and the (weak) playoff-matchup term.
- Inputs: `{ league_key?, team_key?, weeks?: int[] (default: remaining), include_playoffs?: boolean = true }`.
- Output `data`: `{ weeks[]: { week, lineup_pts: Dist, holes[]: { slot, replacement_player_key: string|null, cost }, bye_cluster_cost, weight: { p_alive, importance } }, worst_weeks[], fixes[]: { action, cost, delta, deadline }, playoff_weeks: { weeks[], matchup_multipliers[]: { player_key, multiplier, shrink_w }, evidence_note: "preseason/early SOS ≈ noise (05 §18 row 1)" }, rec: Rec }`.
- Method: 05 §7.1–7.3, §18. Data: B1, D3, E1 (ROS), E4, E3 (`season`).
- Token: 5 000 / 10 000.
- D/W/A/C: cost, not count, of byes · 05 §7 pitfalls · a bye calendar · none.

**E9 `ff_analyze_roster`** — P1 — rest-of-season construction: bench roles, handcuffs, stashes, consolidation, IR/limit compliance.
- Inputs: `{ league_key?, team_key?, competing?: "auto"|"yes"|"eliminated" = "auto" }`.
- Output `data`: `{ phase: "early"|"mid"|"late", competing, bench_plan[]: { slot, role: "bye_cover"|"injury_cover"|"upside"|"handcuff"|"stash", player_key, marginal_value }, handcuff_values[]: { handcuff, starter, value: Dist, verdict }, stash_values[], consolidation_candidates[]: { give[], target_profile }, droppable[]: { player_key, value_ros: Dist, re_add_risk }, ir: { eligible_now[], ineligible_in_ir[], forced_drops[], blocked_until: string|null }, over_limit: boolean, adds_remaining: int|null, rec: Rec }`.
- Method: 05 §9.1–9.5 (handcuffs computed per case, never a rule — 05 §18), §14.1, §14.3. Data: B1, D2, E1 (ROS), E4, C2 (pool depth), A3.
- Token: 5 000 / 10 000.
- D/W/A/C: folded ROS construction + IR/limit audit · same inputs; a separate tool would double-trigger (06 §B.3 row 9) · two tools · none.

**E10 `ff_analyze_evidence`** — **P2** *(revised round 1, OBJ-21: was P1)* — news-vs-stats disagreement flags. At P1 the `news-check` Skill reconciles D6 + D2 + D1 + D3 itself and says "priors are hand-set"; this tool arrives with the calibrated source × claim table (05 §10.2, fed by E13) and, until `calibration_state.table_n ≥ 200`, every result carries `calibration_state.note: "priors are hand-set"` and the Skill avoids "posterior" wording.
- Inputs: `{ league_key?, player: PlayerSelector (single), claim?: { text: string ≤ 400, source?: string ≤ 64, time?: ISO, type?: enum } }`.
- Output `data`: `{ flag: "unconfirmed_narrative"|"quiet_role_change"|"availability_conflict"|"consistent"|"no_claim", prior: { p_active: number|null, role_shares: {…}|null }, evidence[]: { source, claim: UT, type, direction, reliability, time, official: boolean }, posterior: { p_active: number|null, role_shares: {…}|null }, what_would_confirm[], consequence: { affects: ("lineup"|"waivers"|"trade")[], re_run: string[] }, calibration_state: { table_n, note }, rec: Rec }`.
- Method: 05 §10.1–10.4 (structure, source × claim reliability, both-direction flags, Bayesian merge shown as prior/evidence/posterior). Data: D6, D2, D1, D3; the per-source calibration table (P2, fed by E13).
- Token: 3 000 / 6 000.
- `claim.text` is echoed only as `UT`; the tool never acts on it (plan 02 §6.4).
- D/W/A/C: the reliability model is a tool · 05 §10 is "almost all judgment", but the *prior table and the xFP gap* must be consistent and testable (06 §B.3 row 10) · Skill-only · none.

**E11 `ff_analyze_league_activity`** — P1 — the league activity digest: what rivals did, what it cost, who needs what.
- Inputs: `{ league_key?, since_days?: 1..30 = 7, include_rival_needs?: boolean = true }`.
- Output `data`: `{ window: { from, to }, transactions: { adds, drops, claims, trades, faab_spent_total, by_team[]: { team_key, name: UT, adds, drops, faab_spent, notable[]: { player_key, name: UN, action, faab_bid } } }, standings_movement[]: { team_key, rank_before, rank_after, streak }, pending_trades_visible[], top_added[]: { player_key, name: UN, count }, top_dropped[], rival_needs[]: { team_key, weakest_slots[], likely_targets[]: player_key }, faab_price_model: { dollars_per_point, n, spread }, rec: Rec|null }`.
- Method: 05 §4.3 (price of a point from history; competition), §5.7 (partner weakest slot), §12 (followed?). Data: A5 + `transactions_seen`, A3, B1 (rivals), `fa_pool_snapshot` diffs (plan 06 §1.3).
- Token: 4 000 / 8 000.
- D/W/A/C: **a workflow tool that earns its place over composition** · Yahoo's feed is most-recent-N (03 §E) and the price model needs the server's persisted history; composing this in the model re-reads ~100 rows every week · compose from A5 + A3 · none.

**E12 `ff_record_recommendation`** — P0 — the recommendation log write (05 §12's enabling condition).
- Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: true` (dedup on `client_ref`), `openWorldHint: false`.
- Inputs: `{ league_key?, kind: "lineup"|"waiver"|"stream"|"trade"|"cascade"|"schedule"|"roster"|"evidence"|"matchup"|"onboarding"|"retro"|"executed"|"weekly", week, rec: Rec, alternatives[]: { action, point_estimate, distribution: Dist, decision_metric_value }, source_calls[]: { tool, request_id }, followed_hint?: "unknown"|"user_said_yes"|"user_said_no", client_ref?: string ≤ 64, note?: string ≤ 200 }` (input capped at 20 000 chars).
- Output `data`: `{ log_id, recorded_at, week, kind, deduplicated: boolean }`.
- Method: 05 §12 "what to log", §19.3. Store: `recommendation_log` (plan 01 §8.2).
- Token: 200 out.
- **Stored-injection note (round 1, OBJ-15).** `rec.action`, `rec.assumptions[].text`, `rec.drivers[].name`, `alternatives[].action` and `note` are model-authored free text, written under whatever influence the model was under when it read the week's news; every tool or resource that reads them back (E13 `calls[].recommended`/`best_alternative`, E14 `action_summary`, `ff://rec/*`) lists their paths in `meta.untrusted_fields[]` with `source: "store.recommendation_log"`, and the Skills quote them, never follow them (plan 09 §2 item 2). `note` is capped at 200 chars (plan 02 §6.2).
- D/W/A/C: C4.

**E13 `ff_analyze_retrospective`** — P0 — score last week's calls by regret and proper scoring rules, **leading with the metrics that reach n for one league** *(reframed round 1, OBJ-05 / C12)*; parameter proposals arrive in Phase 3.
- Inputs: `{ league_key?, week? (default: last final week), kinds?: enum[], min_n?: int = 30 }`.
- Output `data`: `{ week, final: boolean, calls[]: { log_id, kind, followed: boolean|null, regret: number|null, decisive: boolean|null, recommended (path-listed, `source: "store.recommendation_log"` — OBJ-15), best_alternative (same), realised }, metrics: { per_player: { crps, pinball: { p10, p50, p90 }, coverage_80, spearman_by_position: {…}, n_player_weeks }, swap_regret: { total, per_call_mean, n_swaps }, brier: { p_active: { value, n } | "n too small (k of 30)", p_win: same, p_win_given_bid: same, p_role_holds: same }, accuracy_gap }, n_by_metric[]: { metric, n, min_n, reached: boolean }, attribution: { opportunity, efficiency, td, matchup_weather, availability } (populated in Phase 3 — plan 10 C8), sample_size_caveats[] (one line per metric under `min_n`, naming it), rec: Rec }` + `meta.provisional`. **`parameter_changes_proposed[]` is not in the v1 schema** — it arrives in Phase 3 with held-out seasons (plan 10 C8), where a proposal can be tested before a human applies it.
- Method: 05 §12.1–12.6 (Brier with decomposition, CRPS, pinball, coverage, Spearman, regret, "did it matter", attribution, `n < 30` refusal). What reaches n in weeks for one 12-team league: per-player projection error (dozens of player-weeks per week), swap regret, `P(active)` Brier; what does not: `p_win` (14 outcomes a season), `p_win_given_bid`, `p_role_holds` — plan 10 §2.1 tabulates it. Data: `recommendation_log`, B2 (final stats), A4, A5 (followed?).
- **Past weeks under `ManualLeagueProvider`, and like-for-like regret (QA-2-040/041/042, 2026-10-06).** The league file holds only the current roster, so it is evidence of a past week's lineup only while no league file the call reads changed after that week's last lock (the last kickoff, or the first under a weekly lock). Otherwise the team totals are null (so `decisive` is too) and a warning says so; `followed` is a final outcome's value as recorded, else an earlier review's non-null value, else the logged `followed_hint`, so E13 and E14 agree on a `log_id`. Regret compares like with like: each logged alternative is turned into a move of the recommendation's shape, only the players the two moves do not share are netted, and an alternative that cannot be compared is skipped and counted in a warning. `per_player` scores the stored pre-lock projections of every roster the call reads, mine and the opponent's. Pooling player-weeks across logged weeks, which plan 10 §2.1's "reaches n by" column assumes, is an open decision (QA-2-047).
- Token: 4 000 / 8 000.
- D/W/A/C: P0 so every later phase is measurable; the honest weekly output is per-player error, swap regret and `P(active)` Brier, with the outcome metrics named as under n · 05 §19.3; 05 §12.6's own rule · the full suite as framed (decorative under n) · held-out seasons (Phase 3) give the outcome metrics their n and bring `parameter_changes_proposed[]` in.

**E14 `ff_list_recommendations`** — P0 — browse the log (tool twin of `ff://rec/…`).
- Inputs: `{ league_key?, week?, kind?, limit?: 1..100 = 25, offset? }`. Output `data`: `{ items[]: { log_id, kind, week, recorded_at, action_summary (path-listed, `source: "store.recommendation_log"` — OBJ-15), followed: boolean|null } }` + `page`. Token: 2 000 / 8 000. A C10 list tool: no `outputSchema`, no `structuredContent` until A17.

**E15 `ff_analyze_scoring`** — **later** *(revised round 1, OBJ-21: was P1)* — what-if scoring of arbitrary stat lines under this league's settings and named variants. Deferred because a one-league manager does not use a cross-format what-if, the seam it demonstrated has no second platform yet, and "how many points is a 45-yard FG here?" is `A2.scoring.rules` (the plan 05 §6 eval question is answered there). Pull trigger: a second platform in use (X2/Phase 4).
- Inputs: `{ league_key?, lines[1..25]: { label, stats: { [canonical | stat_id]: number } }, variants?[0..5]: { label, overrides: { [stat_id]: modifier }, uses_negative_points?, uses_fractional_points? } }`.
- Output `data`: `{ settings_hash, results[]: { label, points_league, complete, unmapped[], by_variant: { [label]: points } } }`.
- Method: 05 §15 (core rule, families). Data: A2. Token: 1 500 / 6 000.
- D/W/A/C: a pure what-if scorer · answers "how many points is a 45-yard FG here?" and "what would this be in full-PPR?" without a projection run (plan 05 §6 eval question) · fold into B2 · none.

**E16 `ff_analyze_draft`** — later — best available by xVBD, tiers, ADP gaps, `P(available)`, run alerts (05 §13). Reason deferred: off-season feature, low priority per 05 §13, read-only draft room (03 row 25); ships with A6 in the `later` phase (plan 10).

### 3.F Writes (conditional — registered only under plan 02 S5; plan 02 §4 semantics)

All `ff_prepare_*` return `{ prepared_id, kind, diff: { human: string, structured[] }, precondition: { hash, observed_at }, expires_at, ticket, how_to_confirm: { channels: ("elicitation"|"code"|"cli")[], cli: "ff confirm <prepared_id>" }, consequences: { ir: string|null, roster_limit: string|null, faab_balance_after: int|null, lock_warnings[] }, latest_execution_time }`. Locked/ineligible/over-limit moves are `VALIDATION` here. All `ff_commit_*` take `{ prepared_id, evidence?: { kind: "code", code: string(6) } }` — elicitation and CLI evidence arrive out of band (plan 02 §4.2) — and return `{ applied: true|false|"unknown", receipt: { yahoo_status, journal_id, applied_at, transaction_key: string|null, claim_key: string|null, status: string|null }, diff, reconcile: "pending"|"confirmed" }`. Idempotent: a repeat with the same `prepared_id` returns the original receipt.

| # | Tool | Priority | Inputs (strict; plan 02 §5 bounds) | Yahoo write (03 §C) |
|---|---|---|---|---|
| F1 | `ff_prepare_lineup` | conditional | `{ league_key?, team_key?, week, moves[1..20]: { player_key, to_slot } }` | — |
| F2 | `ff_commit_lineup` | conditional | `{ prepared_id, evidence? }` | `PUT team/{k}/roster` (03 §C.1) |
| F3 | `ff_prepare_transaction` | conditional | `{ league_key?, team_key?, kind: "add"\|"drop"\|"add_drop"\|"claim"\|"claim_edit"\|"claim_cancel", add_player_key?, drop_player_key?, faab_bid?: 0..1000 (≤ `faab_balance`), waiver_priority?, claim_key? }` | — |
| F4 | `ff_commit_transaction` | conditional | `{ prepared_id, evidence? }` | `POST league/{k}/transactions`; `PUT`/`DELETE transaction/{claim}` (03 §C.2) |
| F5 | `ff_prepare_trade` | conditional | `{ league_key?, team_key?, kind: "propose"\|"accept"\|"reject"\|"cancel", partner_team_key?, give?: player_keys[1..6], get?: player_keys[1..6], trade_note?: string ≤ 200, pending_trade_key? }` | — |
| F6 | `ff_commit_trade` | conditional | `{ prepared_id, evidence? }` | `POST`/`PUT`/`DELETE` (03 §C.3); `allow`/`disallow`/`vote_against` out of scope (06 §B.2 row 19) |
| F7 | `ff_cancel_prepared` | conditional | `{ prepared_id }` → `{ voided: boolean }`; local-write annotations (`readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false` — round 1, OBJ-19/T8) | — |

- D/W/A/C (family): one prepare/commit pair per Yahoo write family, `kind` inside · plan 02 §4 requires "every write is two tools"; three families map to Yahoo's three write surfaces (roster PUT, transactions POST/PUT/DELETE, trade POST/PUT/DELETE) so a family's precondition hash has one definition · one pair per Yahoo verb (nine tools) · Yahoo granting write to a personal app at all (03 §F.18; 06 U-11) — until then this section registers nothing.

### 3.G Ops

**G1 `ff_get_status`** — P0 — the plan 01 §7 snapshot plus capabilities and the offline doctor rows.
- Inputs: `{ include_checks?: boolean = false }`.
- Output `data`: `{ server: { version, sdk_version, protocol_eras[], node, tool_contract }, auth: { state: "NoTokens"|"Valid"|"Expired"|"NotProvisioned", provisioning: "unknown"|"provisioned_read"|"provisioned_write"|"not_provisioned", access_expires_at, last_refresh_at }, capabilities: { read, write: { lineup, add_drop, waiver, trade } }, league: { league_key, current_week, edit_key }, limiter: { bucket_level, last_999_at }, sources[]: { id, license, last_success_at, age_s, freshness: "fresh"|"stale"|"expired"|"never_loaded"|"unreadable", rows, last_error: string|null, consecutive_failures }, crosswalk: { matched, unmatched_rostered, unmatched_top_owned }, store: { path, size_bytes, schema_version }, journal: { prepared, sent_unknown, oldest_pending_age_s }, jobs[]: { label, last_run_at, exit }, checks[] (plan 03 §5 offline rows) | null }`.
- Method: 06 §B.2 row 0 (every Skill's "is write even possible"). Data: plan 01 §7; plan 03 §5.
- **`unreadable` (QA-1-038, 2026-10-06).** A source whose current file (the refresh log's version) the server cannot attach — missing, damaged, or another source's, version's or layout's — reads `unreadable`, never its age's state: the data tools answer `STALE_ONLY` ("missing or unreadable") for it, the `datasets_loaded` check fails, and `ff refresh <source>` repairs it. The CLI's `ff status` reads a deleted current file, or one that is not a regular file, as `unreadable` too, with the same repair.
- Token: 2 000 / 5 000.
- D/W/A/C: one ops tool · `doctor --fix` is a human CLI action; the tool is read-only, so "doctor" and "cache status" are rows, not tools · `ff_doctor` + `ff_get_cache_status` · none.

**G3 `ff_debug_echo`** — Phase 1a, week 1; **fixture mode only** (registered only when `FF_FIXTURE_DIR` is set; never in `tests/smoke/expected-tools.json`'s production lists) *(added round 1, OBJ-06)* — the structured-content spike.
- Inputs: `{}`. Output: a fresh 12-char nonce **only** in `structuredContent` (the `text` block says "nonce omitted from text"); `outputSchema` present.
- Purpose: Chad asks Claude Code and Claude Desktop to repeat the nonce; a client that can is forwarding `structuredContent` to the model. The answer per client goes to HANDOFF "Build facts" (plan 10 A17; `scripts/dev/a17-check.mjs` prints the Claude Code line, amended 2026-10-06); §5.1 is re-based on it and the C10 list tools regain `structuredContent` only where one copy is forwarded.
- D/W/A/C: a throwaway tool · the cheapest experiment that settles research 06 U-2, which every §5.1 row silently assumed · guessing · nothing (it is deleted once A17 is recorded).
- Sibling, same rules (fixture mode only): **`ff_debug_elicit`** — issues one form-mode elicitation (`decision: APPROVE|REJECT`) and returns what came back, so Claude Code's form-mode support (plan 02 §4.2, tagged [U]) is verified from the Inspector and from a Claude Code session without a write tool (plan 10 A19, round 1 OBJ-23 b).

**G2 `ff_get_playbook`** — **later** *(revised round 1, OBJ-21: was P1)* — a Skill's procedure text for clients without Skills or prompts (the `how_to_answer` pattern, 06 §C.1). Deferred: the prompts (§4.2) already carry every Skill body for non-Claude clients, so this was a third delivery of the same text and one more per-turn definition (OBJ-08). Pull trigger: a non-Claude client without prompt support actually configured.
- Inputs: `{ skill: enum of shipped Skill names (plan 09) }`. Output `data`: `{ name, version, tool_contract, body: string, references[]: { name, body } }` — repo-authored text, `meta.source: ["repo:skills"]`, not `UT`.
- Token: ≤ 6 000 (the Skill body is capped at 500 lines, 06 §A.4).
- D/W/A/C: serve `SKILL.md` from the package · one source, three delivery paths (plugin, prompt, playbook — 06 §D.15) · duplicate text · Skills-over-MCP shipping in Claude clients (06 U-5) makes this and the prompts redundant.

---

## 4. Resources and prompts

### 4.1 Resources (`ff://`, application-driven; each has a tool twin; envelope identical; `cacheScope: "private"`)

| URI | Content | `ttlMs` (plan 01 §5.4) | Tool twin | Why a resource (06 §B.1 #4) |
|---|---|---|---|---|
| `ff://league` | the operator-configured league identity `{ league_key, team_key, season }` — set by the operator, never by the model (plan 01 §4.1; 02 §3.7) | 86 400 000 | `ff_list_leagues` | one fact every tool defaults to |
| `ff://league/settings` | the A2 digest | 86 400 000 | `ff_get_league` | read once per session; ~2.5k chars |
| `ff://game/stat-categories` | the season's full stat universe `{ stat_id, name: UT, canonical, position_type, group }` from `game/nfl/stat_categories` (03 §B.1) | 604 800 000 | (A2 `scoring.rules` covers the league subset) | static per season; the engine's truth table |
| `ff://status` | G1 without checks | 60 000 | `ff_get_status` | `ff status` for the client |
| `ff://status/freshness` | the **freshness report**: `sources[]` of G1 plus the plan 01 §5.4 class table with each class's current age and state | 60 000 | `ff_get_status` | a Skill can cite it before a recommendation |
| `ff://roster/snapshot` | the latest `roster_snapshot` row for my team and its diff vs the previous (plan 06 §1.3) | 60 000 | `ff_get_roster` | "what changed since last night" without a Yahoo call |
| `ff://docs/tool-outputs` | the tool-output cheat-sheet (plan 09 §4; the same file stamped into every Skill) — also the documented `data` shape of the C10 list tools that carry no `outputSchema`, and a verbatim carrier of the plan 02 §6.3 untrusted-text sentence (C13 — the [U]-proof copy for a client that does not surface `instructions`) | 86 400 000 | (none — `ff_get_playbook` is `later`, OBJ-21) | the biggest token saver (06 §D.15 #1) |
| `ff://rec/{log_id}` (template) | one recommendation-log entry — its free-text fields path-listed in `meta.untrusted_fields[]` with `source: "store.recommendation_log"` (round 1, OBJ-15) | 86 400 000 | `ff_list_recommendations` | "what did you tell me last week" |
| `ff://rec/week/{week}` (template) | that week's entries, summary form (same labelling) | 3 600 000 | same | the retrospective's input |

Templates use RFC 6570 with argument completion over known `log_id`s and weeks. Resource lists carry `ttlMs`/`cacheScope` (plan 01 §3.1).

### 4.2 Prompts (`ff.<workflow>`, user-invoked; string arguments; bodies generated from `SKILL.md`)

One per user-invocable Skill in plan 09 — **12** *(revised round 1: `live` is a branch of `start-sit`, OBJ-18)*: `ff.onboard`, `ff.weekly [week]`, `ff.start_sit [week]`, `ff.stream <K|DEF>`, `ff.retro [week]`, `ff.apply <what>` (P0); `ff.waivers`, `ff.trade <offer>`, `ff.injury <player>`, `ff.schedule`, `ff.roster_audit`, `ff.check <claim>` (P1). Each `prompts/get` returns: the Skill body as the user message, the embedded `ff://league/settings` resource, and the plan 02 §6.3 untrusted-text sentence (plan 01 §4.1 requires prompts to state it). Prompts hold no logic and never call tools (06 §A.3). D/W/A/C: generated, not authored · one source cannot drift · hand-written prompt bodies · Skills-over-MCP (06 U-5).

---

## 5. Token economy

### 5.1 Worst-case sizes (serialised chars at `compact`; the halving point is the budget)

Measured on the fixture league — 12 teams, the plan 05 §3.1 recordings (or the fixture YAML in 1a) with the ≤ 300 KB nflverse excerpts of plan 05 §3.2 attached — by `tests/mcp/size.test.ts` (plan 05 T10's data-size rule, round 2).

| Tool | typical | worst (budget) | paginated? | summarised server-side |
|---|---|---|---|---|
| `ff_list_players`, `ff_list_transactions`, `ff_list_recommendations` | 5 000 | 20 000 | yes (`limit`/`offset`; transactions `count`) | ownership/next-game joined; transactions merged with history |
| `ff_get_roster`, `ff_get_league`, `ff_get_standings`, `ff_get_scoreboard`, `ff_get_schedule` (1 week) | 2 000–6 000 | 20 000 | no (bounded by league size / week) | lock schedule; digest normalisation; implied totals |
| `ff_get_player_stats` (25 keys) | 4 000 | 10 000 | by key batch | engine recomputation |
| `ff_get_player_usage` (16 players) | 5 000 | 20 000 (full) | no — `compact` returns trailing only | EWM windows, change points, xFP gap |
| `ff_get_defense_profile` | 4 000 (one position) | 13 000 (all, full) | no | shrunk multipliers |
| `ff_get_news` (20 items) | 4 000 | 12 000 (full) | `limit` | player matching, claim extraction |
| every `ff_analyze_*`, `ff_project_players` | 3 000–8 000 | **10 000** (C8) | no — arrays halved with a warning | everything: the model receives decisions, not rows |
| `ff_record_recommendation` | 200 out | — | — | — |
| `ff_get_status` | 2 000 | 5 000 | no | — |

Claude Code warns at 10 000 tokens and truncates at 25 000 by default (06 §A.1); 20 000 chars ≈ 5–7k tokens at 3–4 chars/token, so no *single copy* of a result approaches either limit (whether clients forward two copies is the OBJ-06 spike, plan 10 A17 — this table is re-based on measured tokens per client once it is answered).

**Per-turn fixed cost — definitions, not results** *(added round 1, OBJ-08)*. The table above counts what a call returns; a client without deferred tool loading (Claude Desktop; Claude Code only when Tool Search is off) also pays `tools/list` **every turn**: for each registered tool its description (~150 chars with the C13 pointer; ~400 when it carried the §6.3 sentence, before round 2), its zod-derived `inputSchema`, and — where present — its `outputSchema`; plus the Skills listing (12 × ≤ 350 chars, plan 09 §2) and the prompts list. Controls: `FF_TOOLSET=core` as the default (C3), no `outputSchema` on the list tools (C10), the §6.3 sentence served once in `instructions` with a ≤ 45-char pointer per description (C13), static descriptions (§5.4). Measurement: `tests/mcp/size.test.ts` records `tools/list` bytes **and tokens (one model's tokenizer)** under `core` and `full`, plus the Skills listing chars, in fixture mode, against **token-derived, downward-only ceilings — `core` ≤ 20 000 chars (≈ 5k tokens; research 06 §A.1's own rule of thumb for ~30 rich tools), `full` ≤ 35 000 chars, Skills listing ≤ 4 500 chars [A-4]** *(revised round 2, OBJ-28: round 1's 40 000/70 000 sat above the design's size and constrained nothing)* — and the numbers go into plan 10 §2's ledger row. The ceilings are calibrated on the first measurement and may only ever move **down**; **a new tool that would breach a ceiling shrinks a schema or moves to `full`** — the number is never raised. The rule "definitions are budgeted like results" is not a constant.

**Measured — Phase 1a, fixture mode, 2026-09-30** (`tests/mcp/size.test.ts`; CI writes the same table to the `test` job summary on every run — plan 10 §2 ledger). Token counts are the 4-chars/token rule of thumb and a 3-chars/token upper bound (no tokenizer is a dependency); the per-client token re-base waits on A17's manual half.

| Quantity | Measured | Ceiling | Headroom |
|---|---|---|---|
| `tools/list` under `FF_TOOLSET=core` (19 P0 tools) | 19,483 chars ≈ 4.9k tokens (≤ 6.5k) | 20,000 | 517 chars (2.6 %) |
| `tools/list` under `full` (Phase 1a registers only the `core` tools) | 19,483 chars | 35,000 | 44 % |
| prompts list | 440 chars | — | — |
| Skills listing (4 shipped Skills) | 1,159 chars | 4,500 | 74 % |
| OBJ-07 `ff_list_players` (32 names): bare + path-listed → wrapped | 18,559 → 21,373 chars (+15.2 %) | 20,000 | wrapping would breach the worst case |
| OBJ-07 `ff_get_roster` (16 names): bare + path-listed → wrapped | 6,942 → 8,349 chars (+20.3 %) | 20,000 | — |
| Largest single results (compact / full) | `ff_list_players` 18,559 / 19,775; `ff_get_league` 13,716; `ff_search_players` 13,279; analytics max `ff_analyze_waivers` 9,725 / 7,883 | 20,000; analytics 10,000 | every tool within its column |

`core` sits at 97.4 % of its ceiling: by the downward-only rule, the next tool added to `core` shrinks a schema or goes to `full`.

### 5.2 What `detail: "compact"` drops (and why the Skills can rely on it)

`compact` keeps every identifier, every number a decision needs, and every `Dist`; it drops per-game rows (usage), per-week arrays beyond three weeks (projections `ros`), `stat_line_expectation`, `shrinkage[]`, `flex_allocation_trace`, `weekly_impact` beyond the next four weeks, and `evidence` strings inside signals. `full` is for the retrospective and for debugging. The cheat-sheet (`ff://docs/tool-outputs`) lists the exact field set per tool per level so a Skill never asks for `full` to find a field that `compact` already has.

### 5.3 "Never re-fetch within a conversation" rules (the contract Skills depend on; plan 09 §4 carries the wording)

| Data | Rule | Basis |
|---|---|---|
| `ff_get_status` | once per session; again only after an error mentions auth/provisioning | plan 01 §7 |
| `ff_get_league` / `ff://league/settings` | once per session (TTL 24 h; `settings_hash` unchanged ⇒ nothing changed) | plan 01 §5.2 |
| `ff_get_roster` | once per hour per team; again after any `ff_commit_*`, after a `PRECONDITION_CHANGED`, or in `start-sit`'s game-day branch (60 s class; plan 09 §3.3) | plan 01 §5.2 rosters 60 s TTL is the *server's* cache; the model's rule is coarser |
| `ff_get_scoreboard` | once per hour pre-week; every call in `start-sit`'s game-day branch (the server's 60 s cache absorbs stampedes) | plan 01 §5.3 coalescing |
| `ff_project_players` | once per (player set, horizon, week) per session; results are deterministic for a `seed` and a `settings_hash` | 05 §19.1 |
| `ff_get_schedule`, `ff_get_injuries` | once per session unless `meta.freshness` was `stale` | plan 01 §5.4 |
| `ff_analyze_*` | re-run only when an input changed (a new roster, a new injury) — the result's `data.inputs[]` says which inputs it used and how old they were | plan 01 §5.4 stale-data rule |
| any tool | results already in the conversation with `meta.age_s` under the class TTL are reused verbatim; the cheat-sheet's per-tool TTL column is authoritative | 06 §A.6 |

The server enforces the *upstream* side of these rules regardless (cache-first, `force_refresh` once per 60 s); the conversation-side rules exist to save the model's tokens, not Yahoo's budget.

### 5.4 Prompt-cache hygiene

Tool definitions are static within a release (no dynamic text in descriptions; the current week lives in results and resources); `tools/list` order is fixed by `src/mcp/registry.ts` (plan 01 §3.1); write tools appear only on a provisioning change (a re-auth event) — 06 §A.6's cache-invalidation rule holds by construction.

---

## 6. Clean negatives (requested capabilities that cannot be delivered honestly, and the fallback)

| Capability asked for | Why not | Honest fallback in this catalog |
|---|---|---|
| Route participation / routes run in-season | no free current source (04 #3; `participation` is post-season only) | `routes_proxy = snap_pct × team dropbacks`, named so in D1; the Skill says "snap-based" |
| Vendor projections as the baseline | none free, legal and current (04 #12) | E1 with `model_version` and `meta.estimate`; a paid feed, if Chad opts in (plan 10 decision D2), enters only as a retrospective comparator |
| Beat-reporter news | no free aggregation; X API paid; Reddit 403/non-commercial (04 B10–B13) | editorial RSS (RotoWire, ESPN) in D6 with claim extraction; the user's own pasted claim through E10 as `UT` |
| Player props as usage priors | no permissible free source (05 §16 #15; 04 B6 free tier has no props by default) | omitted; `assumptions[]` says "no props" |
| The league's starting FAAB budget and acquisition limits | not in `settings` (03 §E, §F.10) | `faab_budget: null`, `max_adds: null`; `ff_analyze_waivers` accepts them as inputs; `onboard` asks once |
| Yahoo's `win_probability` as an input | method unknown (05 §11 pitfalls) | `yahoo_cross_check` fields only |
| Live per-play scoring | Yahoo polls at `refresh_rate=60` (03 §D.2); no push | `live` mode conditions on Yahoo's 60 s totals; labelled provisional |
| Commissioner actions, draft-room picks, chat | absent from the API (03 row 25) | none; `ff_analyze_draft` advises, the user clicks |
| Historical transaction paging | `count` only (03 §B.2) | `transactions_seen` persistence from the day the server is installed; `history_coverage.gap_suspected` says when history is incomplete |
| A universal player id across platforms | none exists (plan 01 §8) | `gsis_id` via the crosswalk with `method`/`confidence` on every player row |

---

## 7. What this document does not decide, and assumptions by name

Engine internals (plan 08); Skill text, triggers, evals and install (plan 09); phasing, acceptance, tensions, open decisions (plan 10). Assumptions: **[A-1]** the 10 000-char analytics cap is enough for 10 waiver candidates at `compact` (measure on the fixture league; the cap is a constant in `src/mcp/bounds.ts`); **[A-2]** `PlayerSelector` with `team_key`/`nfl_team`/`pool` covers every case where more than 25 players are needed (if not, a second selector is added, never a larger key list); **[A-3]** the P0 `v1-trailing` projection is good enough to make start/sit and K/DEF streaming *useful*, not merely present — plan 10's Phase 1a acceptance test A7 states the bar (beats "start by last week's points" on regret over the fixture weeks); **[A-4]** *(round 1; revised round 2, OBJ-28)* the per-turn fixed-cost ceilings in §5.1 (`core` ≤ 20 000 chars ≈ 5k tokens, `full` ≤ 35 000, Skills listing ≤ 4 500) are reachable by the 19-/30-tool designs once `outputSchema` is off the list tools and the §6.3 sentence is served once — calibrated on the first fixture-mode measurement, then downward-only; constants in `tests/mcp/size.test.ts`.
