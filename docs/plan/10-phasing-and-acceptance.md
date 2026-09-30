# 10 — Phasing and acceptance (MVP read-only, staged enhancements, conditional writes)

**Author:** `product-planner` · **Date:** 2026-09-29 · **Brief:** `docs/scratch/briefs/product-planner.md`
**Inputs (cited, not restated):** `docs/HANDOFF.md` (write access unavailable; two open decisions; Desktop elicitation unverified); plan 01–06 (the structural plan; plan 06 §4 build order is the substrate of Phase 0–1); plan 07 (tool priorities), plan 08 (engine gate), plan 09 (Skills priorities, eval lanes); `docs/research/05-strategy-and-analytics.md` §16 (data-needs order; the honest MVP cut #1–#5), §12 (calibration), and each section's "Evaluation"; `04-data-sources.md` §C/§D/§G; `03-yahoo-api.md` §F (unverified items that phases must close).

**Effort scale:** S ≈ days · M ≈ 1–3 weeks · L ≈ 4–8 weeks of a single senior engineer with agents. No dates (brief).

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| Ph1 | **Phase 1 is a read-only product that is useful on its own**: start/sit with distributions and `P(win)`, K/DEF streaming, weekly briefing, onboarding self-check, retrospective — on 05 §16's data #1–#5 | HANDOFF: "the product must be fully useful read-only"; 05 §16 "honest MVP cut" | ship usage-based waivers in the MVP | nothing — waivers need #6 and its crosswalk-heavy ingestion (04 §G.2) |
| Ph2 | **The calibration loop (`ff_record_recommendation`, `ff_analyze_retrospective`, `retro`) ships in Phase 1** | the brief: measurable later phases; 05 §19.3 "a first-class store, not an afterthought" | Phase 3 with the model | nothing |
| Ph3 | **Writes are a conditional phase (W) gated on Yahoo provisioning, not a numbered phase** | write access is "not available at this time" (HANDOFF); 06 U-11 | schedule it as Phase 2 | Yahoo granting `fspt-w` for the client id → W starts immediately after Phase 1 |
| Ph4 | **Phase 2 adds the external usage/market stack and every P1 engine; Phase 3 replaces the v1 projection with the opportunity model and closes the backtests** | 05 §16 #6–#8, #13 vs #10, #14: the ingestion and the modelling are different kinds of work with different verification | one big "analytics" phase | nothing |
| Ph5 | **Every acceptance criterion is a test, a CI job, a fixture assertion, or a one-line manual check Chad performs with named evidence** | the brief; SOTARA's `verify-before-handoff` rule | prose criteria | nothing |
| Ph6 | **Soft gates report a number and must not regress; hard gates block the tag** | with three fixture weeks a backtest cannot be a hard threshold without lying; a hard gate on "not worse than baseline" and a reported number is honest | hard thresholds everywhere | ≥ 2 historical seasons loaded (Phase 2) turn the soft analytics gates into hard ones (Phase 3 lists them) |

---

## 1. Phase overview

| Phase | Name | Scope in one line | Effort | Exit gate (summary) |
|---|---|---|---|---|
| 0 | Foundation | docs-only repo protections, package skeleton, CI skeleton, Yahoo access application | S | `docs.yml`/`secrets` green; ruleset on; application submitted |
| 1 | **Read-only MVP** | auth, provider, store, engine + golden, crosswalk, schedule/lines/injuries, 19 P0 tools, 6 P0 Skills, resources, prompts, rec log, retrospective v1, 5 launchd jobs | L | §3.1 acceptance A1–A16 |
| 2 | Usage, market, P1 engines | nflverse stats/snaps/pbp subset, ffopportunity, Sleeper, DynastyProcess, depth charts, news, weather, odds (opt.), 15 P1 tools, 7 P1 Skills, live/season matchup, second fixture league, plugin manifest (if D3) | L | §3.2 acceptance B1–B14 |
| 3 | Model wave | `v2-opportunity` projections, EP/TD layer, redistribution priors, source calibration table, parameter tuning loop, ≥ 2 held-out-season backtests | L | §3.3 acceptance C1–C9 |
| W | **Conditional writes** | 7 write tools, gate channels, journal reconcile, `apply` write mode, `fspt-w` | M | §3.4 acceptance W1–W9; **starts only when Yahoo grants write** |
| 4 | Later | draft tools + Skill, ESPN provider, remote/HTTP variant, marketplace release, commercial source swaps | M each | per item |

---

## 2. The measurement ledger (what each phase is measured by, and where the number lives)

| Measured quantity | First available | Producer | Where recorded |
|---|---|---|---|
| Engine golden (`|Δ| ≤ 0.01`) | Phase 1 | `tests/domain/scoring/golden.test.ts` | CI job summary |
| Start/sit regret vs baselines | Phase 1 (soft) → Phase 3 (hard) | `ff_analyze_retrospective`; `tests/backtest/lineup.test.ts` on fixtures | `docs/evals/<date>.md` (plan 05 §6 output dir) + the retro Skill's weekly report |
| `P(win)` Brier and reliability | Phase 1 (fixture weeks) → Phase 3 (held-out seasons) | same | same |
| K/DEF rank correlation vs "last week" and "lowest implied total" baselines (05 §8 eval) | Phase 1 (soft) | `tests/backtest/kdef.test.ts` | same |
| Waiver detection precision/recall vs points-only detector (05 §4 eval) | Phase 2 (soft) → Phase 3 (hard) | `tests/backtest/waivers.test.ts` over historical seasons | same |
| Projection CRPS / pinball / coverage / Spearman vs trailing-4 (05 §1 eval) | Phase 3 (hard) | `tests/backtest/projection.test.ts` | same |
| Cascade MAE vs next-man-up (05 §6 eval) | Phase 3 | `tests/backtest/cascade.test.ts` | same |
| News source calibration (Brier by source × claim type, 05 §10 eval) | Phase 3 | `ff_analyze_evidence.calibration_state` | `ff_get_status.checks[]` |
| Skill Lane 1 (structural) | Phase 1 | `check:skills` | CI |
| Skill Lane 2 (model-graded) | Phase 1, pre-release | `npm run eval:skills` | `docs/evals/` |
| Token sizes vs plan 07 §5.1 table | Phase 1 | `tests/mcp/size.test.ts` (fixture mode, every tool, both `detail` levels) | CI |

---

## 3. Phases

### 3.0 Phase 0 — Foundation (S)

**Scope.** Exactly plan 06 §4 steps 1–2: `docs.yml` (Mermaid, links, skills structure), `secrets` job + `.gitleaks.toml`, `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, the branch ruleset (Chad), `package.json` + `.npmrc` + `tsconfig` + `eslint.config.js` skeleton with the four runtime dependencies pinned (plan 04 §2), `ci.yml` skeleton (lint/typecheck/audit/no-scripts/license/pack), and the **Yahoo API access application** (HANDOFF item 4; personal, single-league, read-only; write requested in the notes with the confirmation-gate design as the justification).

**Acceptance (all hard).**
- Z1 `docs.yml` and `secrets` jobs green on `main`; a PR that introduces a string matching `\d{3}\.l\.\d{4,8}` outside the placeholder range fails `secrets` (a deliberate test commit on a branch, then deleted).
- Z2 Every Mermaid block in `docs/plan/*.md` (including 07–10) renders under the pinned `mermaid-cli`.
- Z3 `npm ci && npm run lint && npm run typecheck` pass on an empty `src/` with the boundary rules configured (a test file in `src/domain/` importing `src/store/` fails lint — plan 04 A-5).
- Z4 The access application is submitted and its date recorded in HANDOFF; the legacy-app check ("does Chad hold a still-working client id?") is answered.

**Exit gate.** Z1–Z4. **Deferred:** everything else.

### 3.1 Phase 1 — Read-only MVP (L)

**Scope.**
- *Server core:* plan 02 §2 `oob` auth + token store + lockfile; plan 01 §8 `YahooProvider` (XML, path builder, limiter, cache, error classifier); store + migrations 001 (yahoo_cache, league_settings, datasets bookkeeping, crosswalk, write_journal, recommendation_log, projection, refresh_log, roster_snapshot, transactions_seen); plan 03 lifecycle, `ff` CLI (`serve`, `auth`, `status`, `doctor`, `smoke`, `refresh`, `snapshot`, `print-config`, `install-launchd`, `uninstall`); logger with redaction.
- *Engine:* plan 08 in full for the fixture league's settings; `rounding`/`negative_floor` branches property-tested, `verified: false`.
- *Crosswalk:* 04 §D steps 1–4 with `roster_weekly` ids + deterministic matcher + overrides file; DynastyProcess and Sleeper seeds deferred to Phase 2.
- *Sources (05 §16 #3–#5):* nflverse `schedules` (lines, kickoffs, roof, byes), `injuries`, `roster_weekly`. Weather and odds deferred (the projection lists the weather driver as omitted in `assumptions[]`).
- *Tools (plan 07 P0):* A1–A5, B1–B2, C1–C2, D2–D3, E1 (`v1-trailing`), E2, E3 (`pre`), E5 (`positions ⊆ {K, DEF}`), E12–E14, G1 — 19 tools.
- *Resources:* `ff://league`, `ff://league/settings`, `ff://game/stat-categories`, `ff://status`, `ff://status/freshness`, `ff://roster/snapshot`, `ff://docs/tool-outputs`, `ff://rec/{log_id}`, `ff://rec/week/{week}`.
- *Prompts:* `ff.onboard`, `ff.weekly`, `ff.start_sit`, `ff.stream`, `ff.retro`, `ff.apply`.
- *Skills (plan 09 P0):* `onboard`, `weekly`, `start-sit`, `stream-kdef`, `retro`, `apply` (read-only mode); `_shared` references; `build-skills.ts`; `check:skills` Lane 1.
- *Jobs (plan 06):* `refresh nflverse:schedules`, `refresh nflverse:daily` (injuries, roster_weekly), `snapshot roster`, `token check`, `pre-kickoff check`; `store prune/backup`.
- *Fixtures:* Yahoo recordings for every endpoint the P0 tools touch, ≥ 3 final weeks of player stats for every rostered player of every team, scrubbed (plan 05 §3.1); nflverse excerpts; golden expected outputs.

**Acceptance.** Hard unless marked soft.
- A1 **Golden gate:** `tests/domain/scoring/golden.test.ts` — every rostered player-week in the ≥ 3 fixture weeks matches `player_points.total` within 0.01; `complete = true` on final weeks; plan 08 §7 P1–P13 green; `src/domain/scoring/**` at 100 % lines + branches.
- A2 **Live self-check:** `ff smoke` against the real league lists leagues, reads settings, scores the current roster's last final week with every player `match: true` (Chad runs it; output pasted into `docs/evals/`).
- A3 **Inspector smoke:** `tools/list` in fixture mode equals `tests/smoke/expected-tools.json` (the 19 P0 names in registry order); no `ff_prepare_*`/`ff_commit_*` listed; `resources/list` carries `ttlMs`/`cacheScope`; `prompts/list` has the six P0 prompts.
- A4 **Fault matrix:** every row of plan 05 §4.1 that applies to reads is green (999, 429/5xx, timeout, non-XML, malformed, XXE inert, `NOT_FOUND`, `token_rejected` once, `additional_authorization_required` terminal, `invalid_grant`, torn-write, two-process refresh, 25-page paging).
- A5 **Crosswalk:** on the fixture league, ≥ 95 % of rostered players resolve by id or deterministic match [A-1] and the remainder appear in `ff_get_status.crosswalk.unmatched_rostered`; a fixture rookie with no `yahoo_id` resolves by name + team + position; a name-only candidate is rejected (plan 05 §2 row); a persisted pair survives a team change.
- A6 **Envelope contract:** plan 05 §2 `mcp/envelope` assertions green for all 19 tools; `tests/mcp/size.test.ts` shows every tool's `compact` and `full` outputs on the fixture league are ≤ the plan 07 §5.1 worst-case column (analytics ≤ 10 000 chars).
- A7 **Start/sit (soft, reported):** replaying the fixture weeks with `v1-trailing` projections, `ff_analyze_lineup(objective: mean)`'s realised regret is ≤ the "start by last week's points" baseline's, and `objective: pwin` produces `mode` consistent with the sign of `μ_m − μ_o` on every matchup (hard); the regret numbers are written to `docs/evals/`.
- A8 **K/DEF (soft, reported):** `ff_analyze_waivers(positions: [K, DEF])` returns ≥ 3 candidates per position with `implied_total` populated for every fixture week (hard); rank correlation with realised points is reported against both 05 §8 baselines.
- A9 **Retrospective:** the 05 §12 "evaluation of the evaluator" unit tests pass (a perfectly calibrated synthetic forecaster scores Brier = uncertainty; CRPS of the true distribution beats a misspecified one); running the six P0 Skills' Lane 1 dry runs on fixture week `N` and `ff_analyze_retrospective(N)` on week `N+1` yields `regret`, `followed`, and `brier.p_win` for every logged call; `n < 30` → `sample_size_caveats[]` non-empty.
- A10 **Skills Lane 1:** `check:skills` green for the six P0 Skills, including the fixture dry run (plan 09 §5.1 item 7) and the pairwise trigger-collision check.
- A11 **Skills Lane 2 (manual, tokens):** the doc 06 cases ON-1..3, WK-1..3, SS-1..4, KD-1..3, RT-1..3, AP-2 and AP-4 pass the plan 09 §5.2 bar; trigger evals: all positives trigger, no negatives, on both model classes.
- A12 **Model-driven evals (plan 05 §6):** ≥ 8/10 on the 10 read-only fixture questions.
- A13 **Process/lifecycle:** plan 05 §4.2 green on ubuntu and once on macOS.
- A14 **Coverage gate** (plan 05 §7) met; `supply-chain`, `secrets`, `pack` jobs green; the tarball contains `dist`, `skills` (without `_shared`? — no: `_shared` ships; it is harmless and keeps `build-skills` reproducible), `README`, `LICENSE`, `CHANGELOG` only.
- A15 **Latency:** on a warm cache every P0 tool answers in < 500 ms and `ff_project_players` for 32 players with `n_sims = 4000` in < 3 s on Chad's Mac [A-2]; startup < 1 s without network (plan 05 §4.2).
- A16 **Usefulness check (manual, named evidence):** Chad runs `/onboard` then `/weekly` on the live league and confirms in HANDOFF that the briefing contained a lineup with intervals and `P(win)`, a K/DEF verdict with implied totals, every deadline, the attribution line, and a `log_id` per section.

**Exit gate.** A1–A6, A9–A10, A13–A15 green in CI on the tagged SHA; A2, A11, A12, A16 done by Chad with evidence in `docs/evals/`; A7–A8 reported. Tag `v0.1.0` (pre-1.0 semver, plan 04 §4.4).

**Explicitly deferred to Phase 2.** Usage (`ff_get_player_usage`), skill-position waivers, trades, cascades, schedule planning, roster audit, news, live/season matchup modes, weather/odds drivers, Sleeper/DynastyProcess seeds, the plugin manifest, `ff_get_playbook`, `ff_analyze_scoring`.

### 3.2 Phase 2 — Usage, market, and the P1 engines (L)

**Scope.**
- *Sources (05 §16 #6–#9, #13; 04 §C):* nflverse `stats_player_week`, `stats_team_week`, `snap_counts`, pbp projected subset (RZ/GL, `kick_distance`, `defteam`, `xpass`, `pass_oe`, `epa`), `depth_charts` (parquet), ffopportunity `ep_weekly`, Sleeper `players` + `trending`, DynastyProcess ids, RotoWire/ESPN RSS (CBS fallback), Open-Meteo or NWS (`FF_WEATHER_SOURCE`), The Odds API if D4; **two prior seasons** of `stats_player_week` + `schedules` + `injuries` for the soft backtests [A-3]; the plan 06 jobs for all of them; crosswalk rebuild job with the unmatched alert.
- *Tools (plan 07 P1):* C3, D1, D4–D6, E3 (`live`, `season`), E4, E5 (all positions), E6–E11, E15, G2 — 15 tools.
- *Skills (plan 09 P1):* `waivers`, `trade`, `injury-cascade`, `schedule-plan`, `roster-audit`, `news-check`, `live`; prompts for each.
- *Engine branches:* record a **second fixture league** with `uses_fractional_points = 0` and/or `uses_negative_points = 0` and/or yardage bonuses (D8) → `rounding`/`negative_floor` verified; DST points-allowed definition (plan 08 U-6) pinned.
- *Distribution:* the Claude Code plugin manifest + marketplace + plugin-scoped `.mcp.json` **if D3 = yes** (tension T3/T7 resolved in plan 04 first); `scripts/run-weekly.ts` (Agent SDK example).

**Acceptance.**
- B1 Every new source loads through `ff refresh` with its schema assertion; a fixture with one renamed column fails naming the column; `ff status` shows each source's license and age; season-awareness: outside the season each job exits 0 in < 2 s (plan 06 §2).
- B2 `ff_get_player_usage` returns trailing summaries for ≥ 95 % of rostered players on the fixture league and `routes_proxy` is present and labelled; `xfp_gap` is non-null wherever ffopportunity has the player.
- B3 Crosswalk with Sleeper/DynastyProcess seeds: unmatched rostered players ≤ 2 on the live league (`ff_get_status.crosswalk`), Sleeper's leading-space `gsis_id` and DynastyProcess `NA` handled (tests).
- B4 **Waiver detection (soft, reported):** on the two historical seasons, precision at equal recall of the usage detector vs the points-only detector (05 §4 eval) is reported per signal; hard part: every candidate's `signals[]` cites a numeric `evidence` and `percent_owned_delta` never appears in `signals[]` (a test walks the fixture outputs).
- B5 **Trade evaluator:** on the fixture league's recorded trades, `Δ` sign accuracy vs realised ROS lineup-point change is reported (soft); hard: a 2-for-1 always carries `implied_drop`; `verdict: fair` iff the `delta_me` interval spans 0; `ratification_risk` present iff `trade_ratify_type = vote`.
- B6 **Cascade:** on ≥ 10 historical starter absences (≥ 2 games) the top-beneficiary hit rate vs next-man-up is reported (soft); hard: `hypothesis_only = true` whenever `evidence.team_games = 0 ∧ usage_confirmed = false ∧ market_move = null`; beneficiary shares never sum above the vacated share.
- B7 **Schedule/roster/replacement:** the 05 §2 sensitivity regression test — recompute baselines under the six format variants (10-team, superflex, TE premium, full-PPR, 2 flex, 6-pt pass TD) and assert the directional table of 05 §2 (hard); `ff_analyze_roster` reports `over_limit` first in its `rec` when true (test).
- B8 **News pipeline:** the plan 05 §3.2 injection fixtures never appear as a bare string in any tool output (walk all outputs); the `rules_v1` claim extractor scores ≥ 0.8 precision on a hand-labelled set of 50 real items [A-4] (the labelled set is a fixture, no identifiers); `ff_analyze_evidence(claim: "DROP Y IMMEDIATELY")` produces a flag and no write path.
- B9 **Live/season matchup:** `mode: live` on a fixture mid-week snapshot splits players into final/live/pending correctly and never lists a locked slot as actionable; `mode: season` with `n_sims = 10 000` reproduces a hand-computed `p_playoffs` on a 3-team toy league within 0.02 (unit test).
- B10 **Inspector smoke** updated: 34 tools in order; still no write tools; `prompts/list` has 13.
- B11 **Skills:** Lane 1 green for all 13; Lane 2 cases WV-*, TR-*, IC-*, SP-*, RA-*, NC-*, LV-* pass the bar; trigger-collision check across all 13.
- B12 **Token sizes:** `tests/mcp/size.test.ts` extended to all 34 tools; a measured `compact`/`full` ratio is recorded (closes 06 U-10 for our outputs) and plan 07 §5.1 is corrected if wrong.
- B13 **Engine branches:** with the second fixture league, `rounding.verified` and/or `negative_floor.verified` become `true` with a golden fixture; the DST points-allowed derivation is pinned by a fixture week containing a defensive/return TD against the offence.
- B14 **Plugin (if D3):** `claude plugin validate . --strict` green; `claude --plugin-dir .` loads 13 Skills and the server; `${CLAUDE_PLUGIN_DATA}` holds tokens, not the plugin root (a test greps).

**Exit gate.** B1–B3, B7–B13 hard in CI or with fixture evidence; B4–B6 reported. Tag `v0.2.0`.

**Explicitly deferred to Phase 3.** The `v2-opportunity` projection, the redistribution prior table, the calibrated source table, parameter tuning, held-out-season hard gates.

### 3.3 Phase 3 — Model wave (L)

**Scope.** 05 §1 in full (`v2-opportunity`: market anchor, EWM shares with change points, shrinkage per rate, location-based TDs via ffopportunity/pbp, regressed matchup, weather where evidenced, `P(active)` mixture, simulated distributions); 05 §6.2 redistribution prior table from pbp history; 05 §10.2 per-source calibration table fed by the retrospective; 05 §11.4 season simulation tuned; 05 §12.4–12.5 attribution and the weekly re-fit of `h`, `k`, `β_pos`, `w`, weather multipliers; ≥ 3 historical seasons loaded [A-3]; `ff_project_players.model_version = "v2-opportunity"` with `v1-trailing` kept as a baseline.

**Acceptance (hard unless marked).**
- C1 **Projection backtest (05 §1 evaluation):** on ≥ 2 held-out seasons, `v2` beats trailing-4 on CRPS and within-position Spearman, the gain is not concentrated in weeks 1–3, and 80 % interval coverage is within ±5 points of nominal.
- C2 **Start/sit:** regret below the consensus-free baselines (last-week points, `v1-trailing` mean) on the held-out seasons; `P(win)` calibrated within ±5 points per decile; "did it matter" share reported.
- C3 **`P(win)` vs Yahoo:** Brier below Yahoo's `win_probability` on every replayed fixture week for which the pre-week Yahoo value was snapshotted (needs the scoreboard snapshot — tension T11).
- C4 **Waivers:** the usage detector beats the points detector on precision at equal recall in ≥ 2 seasons; `P(win | bid)` calibrated within ±10 points where the league's claim history allows (soft where `n < 30`).
- C5 **Cascade:** beneficiary-share MAE below next-man-up and top-beneficiary hit rate above it on the historical absence set.
- C6 **K/DEF:** beats "last week's score" clearly and matches "lowest implied total" (05 §8 eval); the share of DEF variance explained by `rare_c` reported.
- C7 **News calibration:** `calibration_state.table_n ≥ 200` claims [A-5]; news-augmented `P(active)` Brier ≤ designation-only.
- C8 **Retrospective attribution** populated (opportunity / efficiency / TD / matchup-weather / availability) for every projection-backed call; parameter changes are *proposed* and applied only by a human-run `ff tune --apply` (never automatically — 05 §12.5's own warning).
- C9 The 05 §18 "does not predict" list is re-checked with the product's own numbers and the results written to `docs/evals/` (a recurring pre-season job in plan 06 §1.4 from now on).

**Exit gate.** C1–C3, C5–C6, C8 hard; C4, C7 soft with numbers. Tag `v0.3.0` (candidate for `v1.0.0` once W or a season of use has passed).

### 3.4 Phase W — Conditional writes (M; starts only on provisioning)

**Trigger.** Yahoo grants read/write for the client id (HANDOFF item 4; 03 §F.18). Until then nothing in this phase is scheduled; the seam is designed (plan 02 §4) and `FF_WRITE_ENABLED` is documented as inert.

**Scope.** `fspt-w` in `ff auth`; plan 02 §4 gate (`PreparedWrite`, ticket, precondition hash, three channels, journal states); plan 07 §3.F tools; `journal reconcile` job (plan 06 §1.3); `apply` write mode (plan 09 §3.6); Desktop and Code elicitation smoke; `fixtures/yahoo/writes/` recorded from the **first real writes** (plan 05 §3.1 has no write fixtures today — they can only be recorded once writes exist).

**Acceptance.**
- W1 Plan 05 §4.3 gate tests green: accept → one write; decline → zero; cancel-within-2 s → OOB path; wrong code ×3 → voided; tampered/expired ticket rejected; replay → original receipt; precondition change → `PRECONDITION_CHANGED`, zero writes; legacy-era client path; the property "upstream writes ≤ distinct `prepared_id`s with valid evidence".
- W2 Write tools appear in `tools/list` only with `FF_WRITE_ENABLED=1` and `provisioned_read`; the first 401/403 on a write unregisters them, emits `list_changed`, journals `rejected_not_provisioned` (fault test).
- W3 `ff_prepare_*` refuses locked players, ineligible slots, IR-ineligible statuses, over-limit rosters, and bids over `faab_balance` with `VALIDATION` (fixture tests); no `prepare` tool accepts a player *name* (schema test).
- W4 Writes are never auto-retried; a timeout leaves `sent_unknown`; reconcile flips it within 24 h against the transactions feed (fault + job test).
- W5 **Live round trip (Chad, once):** one lineup change on the real league via `apply` with the OOB code channel — journal `applied`, Yahoo roster reflects it, reconcile `confirmed_applied`; then `ff confirm` for a second change; then, if Claude Code shows the form, the elicitation channel. Evidence in HANDOFF.
- W6 **Desktop elicitation smoke:** the result (works / drops / cancels) recorded in HANDOFF; channel 2 is the default on Desktop until it works.
- W7 Skills Lane 2 AP-1 and AP-3 pass; every non-`apply` Skill still has zero `ff_commit_*` calls under the injection cases (NC-1, AP-4, SS-4).
- W8 03 §F items 5, 11, 12 (read-only app's response to PUT/POST, roster PUT partial vs full, the FAAB drop-key typo) are closed with fixtures and their `todo` tests un-skipped.
- W9 `ff_get_status.capabilities.write` reflects the observed state after the first write; `ff doctor` #13 message updated.

**Exit gate.** W1–W4, W7–W9 in CI; W5–W6 with evidence. Tag a minor.

### 3.5 Phase 4 — Later (M each; unordered until pulled)

| Item | Pull trigger | Acceptance sketch |
|---|---|---|
| `ff_get_draft_results`, `ff_analyze_draft`, `draft` Skill | Chad wants it for the next August draft | 05 §13 eval: xVBD-best-available beats ADP-order on ≥ 2 replayed drafts under the league's `S`; DR-1..3 pass |
| ESPN provider | an ESPN league | plan 08 P14 round trip; ESPN golden vs `appliedTotal`; `ff_` names unchanged |
| Streamable HTTP + auth server; claude.ai install | a second user or hosted use (plan 01 §3.2/§3.3) | plan 01 §3.2 table implemented; DNS-rebinding tests |
| Marketplace release via `npm` source | D3 = yes and 06 U-6 verified | `claude plugin install` from the published package works on a clean machine |
| Commercial source swaps (Open-Meteo → NWS, Sleeper → own trending; FTN/ffverse attribution) | D1 = commercial | `ff status` lists no `non-commercial` source; attribution lines in every result |

---

## 4. Tensions with the structural plan (plan 01–06) — for the devil's-advocate round

None of these are contradictions the product plan resolved silently; each is a place where 07–10 need plan 01–06 to add or adjust a line. The core planner's files were not edited.

| # | Where | Tension | Proposed resolution |
|---|---|---|---|
| T1 | plan 01 §4.1 verb list | no verb fits the recommendation-log write; plan 07 uses `ff_record_recommendation` | add `record` to the verb list (a local-store write, not a platform write) |
| T2 | plan 01 §4.2 single JSON format vs doc 06 §A.6 compact tables | adopted plan 01; token saving recovered by `detail: compact\|full` (plan 07 C2) | none needed now; if B12's measured ratio is > 2× *and* clients forward `structuredContent` (06 U-2), plan 01's "Markdown as a second text block" clause activates |
| T3 | plan 04 §1 tree | no `.claude-plugin/plugin.json`, `marketplace.json`, or plugin-scoped `.mcp.json`; doc 06 §E recommends a plugin; plan 09 K7 makes it an additive P1 layer | if D3 = yes: add the three files to plan 04 §1 and `files` in §2; `check-skills` gains `claude plugin validate --strict` |
| T4 | plan 05 §6 evals | only the mcp-builder 10-question harness; Skills need their own lanes (plan 09 §5) | additive: plan 05 §1 table gains rows "Skills Lane 1 (CI, zero tokens)" and "Skills Lane 2 (manual, tokens)"; plan 04 §4.2 `skills` job gains the dry run |
| T5 | plan 06 §1.2 `store prune` / plan 01 §5.6 | pruning is described for cache, news, backups; the recommendation log and the `league_settings` hashes it references must never be pruned (05 §12) | one sentence in plan 06 §1.2 and plan 01 §5.1: "never pruned: `recommendation_log`, `league_settings` rows referenced by it, `write_journal`" |
| T6 | plan 02 §5 `player_keys ≤ 25` | analytics tools need > 25 players (a FA pool, all rosters); plan 07 uses `PlayerSelector`/`pool` selectors instead of key lists | no change to the bound; note in plan 02 §5 that selectors are the sanctioned way past it |
| T7 | plan 03 §4.2 "nothing lands in the public repo's `.mcp.json`" | a plugin's `.mcp.json` at the repo root is that file (with `${CLAUDE_PLUGIN_ROOT}` paths and no secrets) | if D3 = yes: reword to "no secrets or absolute user paths in the repo's `.mcp.json`"; the plugin file carries only variables |
| T8 | plan 01 §4.1 annotation families | no family for a **local-store write** (`ff_record_recommendation`: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`); `defineTool()` forces family annotations | add a sixth family "local write (journal/log)"; `ff_cancel_prepared` stays in the prepare family (`readOnlyHint: true`, journal only) |
| T9 | plan 03 §5 doctor rows | plan 08 §6/§9 add `ff_get_status.checks[]` rows `scoring_mismatch` and `settings_changed` | add rows #19–#20 to plan 03 §5 (offline; read from `league_settings`/`refresh_log`) |
| T10 | plan 05 §7 100 %-coverage modules | the retrospective's metric code (`src/domain/reclog/metrics.ts`: Brier decomposition, CRPS, pinball, coverage) is the "evaluation of the evaluator" (05 §12) — a wrong metric silently mis-tunes the model | add it to the six → seven 100 % modules |
| T11 | plan 06 §1.3 credentialed jobs | no job snapshots the **pre-week Yahoo `win_probability` / `team_projected_points`**, which C3 (05 §11 evaluation "against Yahoo's") needs | extend `snapshot roster` (already 30 min before first kickoff) to also store the scoreboard's two Yahoo numbers per matchup in `scoreboard_snapshot` |
| T12 | plan 01 §5.2 / §8.2 store tables | plan 08 §9 names `league_settings` (normalised), `projection`, `points_cache`; plan 07 needs `roster_snapshot`, `scoreboard_snapshot`, `fa_pool_snapshot` (plan 06 has the last two jobs but not the table names) | list them in plan 01 §8.2 so migration 001 carries them; `points_cache` is prunable, the rest are not (T5) |
| T13 | plan 02 §4.2 channel 1 + plan 07 §3.F | plan 02 says `commit` *returns* `inputRequired` (elicitation) while plan 07's `evidence.code` covers channel 2 and the CLI channel 3 bypasses the tool; consistent, but plan 02's `ff_commit_*(prepared_id, evidence)` signature should say `evidence` is **optional and only for channel 2** | one clause in plan 02 §4.1 step 3 |

Errors found in plan 01–06 while cross-reading: none that change a decision. Two nits for the core planner: plan 01 §4.1 lists `ff_list_free_agents` as an example name (plan 07 uses `ff_list_players` with `status`), and plan 05 §5 lists `ff_get_league` with `league_key=461.l.1000` — consistent with plan 07 A2.

---

## 5. Open product decisions for Chad

| # | Decision | Default the plan assumes | What changes if the other way |
|---|---|---|---|
| D1 | **Commercial distribution?** (HANDOFF item 6) | personal use | Phase 4 source swaps become Phase 2 work; Sleeper trending → own snapshot diffs; Open-Meteo → NWS; FTN/ffverse attribution in every result |
| D2 | **Buy a consensus projection feed as a baseline?** (HANDOFF item 7; FantasyPros ~$9/mo personal-use) | no — projections are ours | a `DataSource` for the feed lands in Phase 2 as a **retrospective comparator only** (05 §1 evaluation (c)); never shown as the recommendation |
| D3 | **Ship the Claude Code plugin manifest in v1 (Phase 2)?** | yes, additive (plan 09 K7) | no → copy-install stays the only path; T3/T7 close as "not applicable" |
| D4 | **Request a free The Odds API key?** (04 B6; ≈ 108 credits/month) | skip in Phase 1; optional in Phase 2 | yes → `ff_get_schedule.lines.secondary` populated; the multi-book consensus feeds the market anchor |
| D5 | **The validation league's starting FAAB budget and acquisition limits** (not in `settings`, 03 §E) | asked once by `onboard`, stored in the server's config dir, never in the repo | none — just needed at onboarding |
| D6 | **`apply` ships at P0 in read-only "manual clicks" mode?** | yes (plan 09 §1) | no → every P0 Skill ends without the "say apply" line; `apply` arrives with Phase W |
| D7 | **A token budget for Skills Lane 2 in CI (nightly)?** | no — manual pre-release only (plan 05 §8) | yes → Lane 2 runs nightly with `--max-cost` and the results land in `docs/evals/` automatically |
| D8 | **A second fixture league with non-fractional / negative-off / bonus settings** (Phase 2 B13) — does Chad have one, or will he join a public Yahoo league for fixtures? | join one public league on the same account (portal allows one *account*, not one league) | none available → those engine branches stay `verified: false` with the property tests as the only guard, and `ff_get_player_stats.match` stays `null` for such leagues |
| D9 | **How many historical seasons for backtests?** | 2 in Phase 2, ≥ 3 in Phase 3 (a few MB each) | fewer → C1/C4 revert to soft gates |
| D10 | **Is Sunday `live` needed in Phase 1?** | no (P1) | yes → E3 `live` mode and the `live` Skill move into Phase 1 (adds ~S effort; the scoreboard's 60 s class already exists) |

---

## 6. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | ≥ 95 % crosswalk resolution on the fixture league without Sleeper/DynastyProcess seeds (04 §D: ids cover ~68 %; the matcher covers rookies) | the Phase 1 crosswalk test; the number is a constant |
| A-2 | Latency targets (500 ms warm; 3 s for 32 × 4 000 sims) on Chad's Mac | first measurement; `node:sqlite` is synchronous — if the simulation stalls the loop, sims move to a worker thread (a seam, not a redesign) |
| A-3 | Two prior seasons suffice for the Phase 2 soft backtests; three for Phase 3 hard gates | first backtest run |
| A-4 | 50 hand-labelled news items and 0.8 precision are enough to trust `rules_v1` | first labelling pass |
| A-5 | 200 claims make the source × claim table meaningful | 05 §10 evaluation |
| U | Yahoo approval latency and whether write is ever granted (03 §F.18) | the application |
| U | Claude Desktop elicitation (HANDOFF) | Phase W W6 |
