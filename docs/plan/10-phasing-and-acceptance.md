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
| Ph7 | **Phase 1 splits into 1a (Yahoo-free) and 1b (Yahoo)** — 1a is built and accepted on fixtures + nflverse only and **starts now**; 1b is everything that needs a Yahoo token (§3.1) *(revised round 1, OBJ-02)* | the critical path ran through a Yahoo approval with no observed grant, no date and no fallback (adversarial log OBJ-02); the analytics layer needs no Yahoo access (HANDOFF 2026-09-30) | one Phase 1 gated on the approval | nothing — 1a is valuable under every branch of the approval |
| Ph8 | **Dated decision gate on the Yahoo application (D0):** application submitted on *<date Chad submits — recorded in HANDOFF>*; decision point = **4 weeks after submission or NFL week 9, whichever is earlier**; if no read grant by then, 1b pauses and the fallback (Ph9) ships *(revised round 1, OBJ-02)* | a plan silent on its expected value under its dominant risk cannot be approved honestly; the *rule* is fixed now, only the date is a placeholder | wait indefinitely | the grant arriving at any point — 1b resumes immediately and X1 becomes an import option |
| Ph9 | **Fallbacks named: X1 = 1a with `ManualLeagueProvider` as the league source for Chad's league; X2 = `SleeperProvider` as the *first* second platform** (ESPN stays `later`, §3.5) *(revised round 1, OBJ-02)* | X1 keeps start/sit, K/DEF and usage-based waiver candidates without Yahoo (it loses the live FA pool and other teams' rosters unless pasted); Sleeper's read API is public, keyless and non-commercial (fine for personal use, 04 §B4) and is **not** ToS-blocked, so it proves the `FantasyPlatform` seam on a platform that can actually be built and makes the product usable to anyone on Sleeper; ESPN is ToS-blocked (04 §B5), which is why it is the wrong first seam | ESPN as the second seam | a read grant → X1 is only an import path and X2 stays a Phase 4 pull item |

**D0 — the application, and the honest expected value for the 2026 season** *(added round 1, OBJ-02)*. Today is 2026-09-30, NFL week 4 of 18. Phase 1a starts now and does not wait for Yahoo. For 1b: **approved by week 6** → 1b live by about week 9–10, read-only weekly briefings for the second half of the season and the fantasy playoffs; **approved by week 10** → 1b live for the fantasy playoffs only; **denied or unanswered at the Ph8 decision point** → X1 for Chad's league (degraded but real: start/sit, K/DEF streaming, and — from Phase 2 — usage-based waiver candidates over a hand-filled league), X2 for the public, and every line of Phase 2–3 stays valuable for 2027. Under no branch does a week-4 start yield a week-4 product; the plan no longer implies it. D0 outranks D1–D10 (§5).

---

## 1. Phase overview

| Phase | Name | Scope in one line | Effort | Exit gate (summary) |
|---|---|---|---|---|
| 0 | Foundation | docs-only repo protections, package skeleton, CI skeleton, Yahoo access application (D0) | S | `docs.yml`/`secrets` green; ruleset on (**no required checks** — OBJ-13); application submitted |
| 1a | **Read-only MVP — Yahoo-free half** *(revised round 1)* | store + migrations, `ff refresh` for nflverse `schedules`/`injuries`/`roster_weekly`/**`stats_player_week`**, lines + weather, crosswalk, scoring engine over nflverse lines, projections v1, K/DEF streaming, rec log + retrospective v1, the 19 P0 tools under `FF_TOOLSET=core` (platform-fact tools served by `ManualLeagueProvider`), Skills `stream-kdef`/`retro`/`start-sit` + `onboard` (manual mode) in fixture mode, the data launchd jobs | L | §3.1a acceptance (the 1a items of A1–A17); **needs no Yahoo access; starts now** |
| 1b | **Read-only MVP — Yahoo half** *(revised round 1)* | `ff auth` + token store + lockfile, `YahooProvider`, the platform-fact tools over Yahoo, golden test vs `player_points`, Yahoo fixtures, `ff smoke`, Skills `onboard` (Yahoo mode)/`weekly`/`apply`, the credentialed launchd jobs | M | §3.1b acceptance (the 1b items of A1–A19); starts on a provisioned token; **pauses at the Ph8 decision point** if none — then X1/X2 |
| 2 | Usage, market, P1 engines | nflverse team stats/snaps/pbp subset, ffopportunity, Sleeper, DynastyProcess, depth charts, news, odds (opt.), 11 P1 tools (30 under `FF_TOOLSET=full`), 6 P1 Skills, E3 `live`/`season` modes (`live` activates `start-sit`'s game-day branch), second fixture league, plugin manifest (if D3) | L | §3.2 acceptance B1–B14 |
| 3 | Model wave | `v2-opportunity` projections, EP/TD layer, redistribution priors, source calibration table, parameter tuning loop, ≥ 2 held-out-season backtests | L | §3.3 acceptance C1–C9 |
| W | **Conditional writes** | 7 write tools, gate channels, journal reconcile, `apply` write mode, `fspt-w` | M | §3.4 acceptance W1–W9; **starts only when Yahoo grants write** |
| 4 | Later | `SleeperProvider` (X2 — pulled forward if Ph8 fires), draft tools + Skill, ESPN provider (after Sleeper; ToS-blocked today), remote/HTTP variant, marketplace release, commercial source swaps, `ff_get_playbook`, `ff_analyze_scoring` | M each | per item |

---

## 2. The measurement ledger (what each phase is measured by, and where the number lives)

| Measured quantity | First available | Producer | Where recorded |
|---|---|---|---|
| Engine properties over nflverse lines (plan 08 §7 P1–P13; 100 % coverage) | Phase 1a | `tests/property/scoring.test.ts` | CI job summary |
| Engine golden vs Yahoo (`|Δ| ≤ 0.01`) | Phase 1b | `tests/domain/scoring/golden.test.ts` | CI job summary |
| Start/sit regret vs baselines — **incl. `objective: pwin` vs `objective: mean`** (round 1, OBJ-04) | Phase 1a (soft) → Phase 3 (hard) | `ff_analyze_retrospective`; `tests/backtest/lineup.test.ts` on fixtures | `docs/evals/<date>.md` (plan 05 §6 output dir) + the retro Skill's weekly report |
| Per-player projection CRPS / pinball / coverage / Spearman (soft, reported weekly — the metrics that reach n ≥ 30 in weeks for one league, §2.1) *(added round 1, OBJ-05)* | Phase 1a | `ff_analyze_retrospective.metrics.per_player` | the retro Skill's weekly report + `docs/evals/` |
| Swap regret and `P(active)` Brier *(added round 1, OBJ-05)* | Phase 1a | `ff_analyze_retrospective.metrics.swap_regret`, `.brier.p_active` | same |
| `P(win)` Brier and reliability | reported with the "n too small" caveat in-season (14 outcomes/season, §2.1) → **Phase 3** (held-out seasons) for a number | same | same |
| K/DEF rank correlation vs "last week" and "lowest implied total" baselines (05 §8 eval) | Phase 1a (soft) | `tests/backtest/kdef.test.ts` | same |
| Waiver detection precision/recall vs points-only detector (05 §4 eval) | Phase 2 (soft) → Phase 3 (hard) | `tests/backtest/waivers.test.ts` over historical seasons | same |
| Projection CRPS / pinball / coverage / Spearman vs trailing-4 (05 §1 eval) | Phase 3 (hard) | `tests/backtest/projection.test.ts` | same |
| Cascade MAE vs next-man-up (05 §6 eval) | Phase 3 | `tests/backtest/cascade.test.ts` | same |
| News source calibration (Brier by source × claim type, 05 §10 eval) | Phase 3 | `ff_analyze_evidence.calibration_state` | `ff_get_status.checks[]` |
| Skill Lane 1 (structural) | Phase 1a | `check:skills` | CI |
| Skill Lane 2 (model-graded) | Phase 1a/1b, pre-release | `npm run eval:skills` | `docs/evals/` |
| Token sizes vs plan 07 §5.1 table | Phase 1a | `tests/mcp/size.test.ts` (fixture mode, every tool, both `detail` levels) | CI |
| **Per-turn fixed cost**: `tools/list` bytes under `FF_TOOLSET=core` and `full` + Skills listing chars + prompts list, vs the plan 07 §5.1 ceilings *(added round 1, OBJ-08)* | Phase 1a (`core`) → Phase 2 (`full`) | `tests/mcp/size.test.ts` (fixture mode) | CI job summary; the measured numbers are copied into plan 07 §5.1 |

### 2.1 When each retrospective metric reaches n ≥ 30 for one 12-team H2H league *(added round 1, OBJ-05)*

05 §12.6's rule — refuse conclusions from `n < ~30` calls of a type — decides which of E13's metrics can say anything in a season. Counts assume one user logging every P0 Skill weekly from NFL week 5; they are order-of-magnitude estimates **[A-7]** and E13's `n_by_metric[]` reports the real ones.

| Metric | What one week adds (n) | Reaches n ≥ 30 by | Where it is honest |
|---|---|---|---|
| Per-player projection CRPS / pinball / coverage (all rostered players, all rosters) | ~150–190 player-weeks | the **first** logged week | Phase 1a (soft), Phase 3 (hard) |
| Per-player CRPS / pinball / coverage (my roster only) | ~15–16 | week 2 of logging | same |
| Spearman by position (within-position rank, all rosters) | ~20–25 per position (RB/WR), ~12 (QB/TE) | week 2 (RB/WR), week 3 (QB/TE) | same |
| `P(active)` Brier (Q/D/O designations on rostered players, all rosters) | ~8–15 | week 3–4 of logging | Phase 1a |
| Swap regret (logged start/sit swaps, my team) | ~3–6 per week | week 6–10 of logging | Phase 1a (soft) → Phase 3 (hard) |
| `p_role_holds` (waiver/cascade calls) | ~1–3 | around season end, if at all | Phase 2 soft; Phase 3 |
| `P(win)` Brier / reliability (H2H outcomes) | 1 (14 a regular season) | **never in-season**; ≥ 3 held-out seasons | Phase 3 only (C2) |
| `p_win_given_bid` (FAAB claims) | 0–2 | never in-season | Phase 3 (C4, soft where `n < 30`) |
| `parameter_changes_proposed[]` | — | needs the rows above at n **and** a held-out season to test a proposal against | Phase 3 (C8) — not in the v1 schema |

Consequence for the P0 Skills: `retro` leads with the top four rows, names the rest as "n too small (k of 30)", and never proposes a parameter change in v1 (plan 09 §3.5).

---

## 3. Phases

### 3.0 Phase 0 — Foundation (S)

**Scope.** Exactly plan 06 §4 steps 1–2: `docs.yml` (Mermaid, links, skills structure), `secrets` job + `.gitleaks.toml`, `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, the branch ruleset (Chad), `package.json` + `.npmrc` + `tsconfig` + `eslint.config.js` skeleton with the four runtime dependencies pinned (plan 04 §2), `ci.yml` skeleton (lint/typecheck/audit/no-scripts/license/pack), and the **Yahoo API access application** (HANDOFF item 4; personal, single-league, read-only; write requested in the notes with the confirmation-gate design as the justification).

**Acceptance (all hard).**
- Z1 `docs.yml` and `secrets` jobs green on `main`; a PR that introduces a string matching `\d{3}\.l\.\d{4,8}` outside the placeholder range fails `secrets` (a deliberate test commit on a branch, then deleted); the branch ruleset is on — no force-push, no deletion, linear history — **with no required status checks** (round 1, OBJ-13: a required check rejects every fresh direct push, which breaks "push before teardown"); the `ci-vigilance` obligation (plan 04 §5) is the docs-phase substitute and every agent brief carries it.
- Z2 Every Mermaid block in `docs/plan/*.md` (including 07–10) renders under the pinned `mermaid-cli`.
- Z3 `npm ci && npm run lint && npm run typecheck` pass on an empty `src/` with the boundary rules configured (a test file in `src/domain/` importing `src/store/` fails lint — plan 04 A-5); **and `docs.yml`'s `mermaid` job is green on a commit where `.npmrc` (`ignore-scripts=true`) is present** — `.npmrc` lands in its own commit *before* `package.json` so the run is unambiguous (round 1, OBJ-12: the explicit Chrome install and `--ignore-scripts=false` make the job independent of the project `.npmrc`; plan 04 §4.2).
- Z4 The access application (D0) is submitted and its date recorded in HANDOFF — that date starts the Ph8 clock; the legacy-app check ("does Chad hold a still-working client id?") is answered (**resolved 2026-09-30: no existing app**, HANDOFF item 4).

**Exit gate.** Z1–Z4. **Deferred:** everything else.

### 3.1 Phase 1 — Read-only MVP, split into 1a (Yahoo-free) and 1b (Yahoo) *(revised round 1, OBJ-02 / OBJ-03)*

Phase 1 is one product — `v0.1.0` is tagged when **both** halves are green — built as two halves with separate scope, acceptance and exit gates so that work proceeds and is testable while the Yahoo application (D0) is pending. **1a needs no Yahoo access and starts now.** 1b needs a provisioned token and starts when one exists; if the Ph8 decision point passes without a read grant, 1b pauses and X1/X2 ship (§0). The original A1–A16 keep their numbers (other plans cite them); items that had a Yahoo half and a Yahoo-free half are split into `a`/`b`.

#### 3.1a Phase 1a — the Yahoo-free half (L)

**Scope.**
- *Store and lifecycle:* store + migrations 001 (yahoo_cache, league_settings, datasets bookkeeping, crosswalk, write_journal, recommendation_log, projection, refresh_log, roster_snapshot, transactions_seen); plan 03 lifecycle; the `ff` CLI without its Yahoo subcommands (`serve`, `status`, `doctor`, `refresh`, `snapshot`, `print-config`, `install-launchd`, `uninstall`); logger with redaction.
- *Sources (05 §16 #1's stat lines and #3–#5):* nflverse `schedules` (lines, kickoffs, roof, byes), `injuries`, `roster_weekly`, and **`stats_player_week`** (moved from Phase 2 — OBJ-03: the same stat lines as Yahoo's, keyless, everyone, every season); weather via `FF_WEATHER_SOURCE` (D.1 OBJ-02 lists weather/lines in 1a; moved from Phase 2). Odds stay deferred (D4).
- *Engine:* plan 08 in full **over nflverse lines** — `toStatLine(nflverse)` is the Phase-1 path (OBJ-03); `rounding`/`negative_floor` branches property-tested, `verified: false`.
- *Crosswalk:* 04 §D steps 1–4 with `roster_weekly` ids + deterministic matcher + overrides file; DynastyProcess and Sleeper seeds deferred to Phase 2.
- *Platform seam:* **`ManualLeagueProvider`** behind `FantasyPlatform` (plan 01 §8): league settings and my roster from a hand-filled YAML the `onboard` Skill helps write; other teams' rosters, transactions and the FA pool are optional (empty, or pasted). It is what X1 ships for Chad's league under denial.
- *Tools (plan 07 P0, registered under `FF_TOOLSET=core`):* A1–A5, B1–B2, C1–C2, D2–D3, E1 (`v1-trailing` from nflverse lines), E2, E3 (`pre`), E5 (`positions ⊆ {K, DEF}`), E12–E14, G1 — 19 tools. In 1a the platform-fact tools (A1–A5, B1–B2, C1–C2) serve what the YAML holds and `ff_get_player_stats.match` is `null` (no Yahoo points to match against); the Yahoo-free tools (D2, D3, E1–E3, E5, E12–E14, G1) are complete.
- *Resources:* `ff://league`, `ff://league/settings`, `ff://status`, `ff://status/freshness`, `ff://docs/tool-outputs`, `ff://rec/{log_id}`, `ff://rec/week/{week}` (`ff://game/stat-categories` and `ff://roster/snapshot` need Yahoo → 1b).
- *Prompts:* `ff.start_sit`, `ff.stream`, `ff.retro` (the rest → 1b).
- *Skills (plan 09 P0):* `stream-kdef`, `retro`, `start-sit`, and `onboard`'s manual-league mode, in fixture mode; `_shared` references; `build-skills.ts`; `check:skills` Lane 1.
- *Jobs (plan 06 §1.2):* `refresh nflverse:schedules`, `refresh nflverse:daily` (injuries, roster_weekly), `refresh nflverse:stats` (`stats_player_week` only in Phase 1), `refresh weather`; `store prune/backup`.
- *Fixtures:* nflverse excerpts (plan 05 §3.2) including ≥ 3 final weeks of `stats_player_week` for the fixture league's players; a fixture manual league (`fixtures/manual/league.yaml`, placeholder names only); golden expected outputs for the engine over nflverse lines.

**Acceptance (1a; hard unless marked soft).**
- A1a **Engine over nflverse lines:** plan 08 §7 P1–P13 green; `src/domain/scoring/**` at 100 % lines + branches; `toStatLine(nflverse)` over the fixture excerpt scores every player-week without `NaN` and with `complete = true` on final weeks; the frozen `fixtures/golden/` outputs match (plan 08 §6 step 1). The golden gate against Yahoo `player_points.total` is **A1b** (1b).
- A3a **Inspector smoke (fixture mode, `FF_TOOLSET=core`):** `tools/list` equals `tests/smoke/expected-tools.json` (the 19 P0 names in registry order); no `ff_prepare_*`/`ff_commit_*` listed; `resources/list` carries `ttlMs`/`cacheScope`; `prompts/list` has the three 1a prompts.
- A4a **Fault matrix — store and sources:** the plan 05 §4.1 rows that need no Yahoo (torn-write, two-process refresh, the 3-s writer-lock row, the network-error-on-refresh row) and the `sources/*`/`store` rows of plan 05 §2 — schema assertion, attached-staging load with a < 50 ms swap, migrations from every historical version, **the consistent pre-migration backup restored with exact journal/log row counts** (OBJ-10), and **the contention test: p95 tool latency < 300 ms and zero errors under a 3-s writer lock, cache writes counted as misses, `ff_record_recommendation` → `STORE_BUSY` within ≤ 1 s** (OBJ-11).
- A5a **Crosswalk matcher:** every player in the fixture YAML resolves by `roster_weekly` id or deterministic name + team + position match, or is listed in `ff_get_status.crosswalk.unmatched_rostered`; a fixture rookie with no platform id resolves by name + team + position; a name-only candidate is rejected (plan 05 §2 row); a persisted pair survives a team change. The ≥ 95 % figure on the Yahoo fixture league is **A5b** (1b).
- A6 **Envelope contract:** plan 05 §2 `mcp/envelope` assertions green for all 19 tools (every third-party string wrapped or path-listed; recommendation-log text carries `source: "store.recommendation_log"` — OBJ-07/OBJ-15); `tests/mcp/size.test.ts` shows every tool's `compact` and `full` outputs on the fixture league are ≤ the plan 07 §5.1 worst-case column (analytics ≤ 10 000 chars), **records the `ff_list_players`/`ff_get_roster` payloads with player names wrapped vs bare** (the OBJ-07 before/after, copied into plan 07 §5.1), and records the per-turn fixed cost against its ceiling (§2 ledger; OBJ-08).
- A17 **Structured-content spike (round 1, OBJ-06; week 1 of 1a):** `ff_debug_echo` (fixture mode only) returns a nonce only in `structuredContent`; Chad asks Claude Code and Claude Desktop to repeat it; the answer per client is recorded in HANDOFF "Stack facts"; plan 07 §5.1 is re-based on measured tokens per client; the C10 list tools omit `structuredContent` until this is answered and regain it only if a client forwards one copy.
- A7 **Start/sit (soft, reported; revised round 1, OBJ-04):** replaying the fixture weeks with `v1-trailing` projections (nflverse lines, the fixture YAML roster): (a) `ff_analyze_lineup(objective: mean)`'s realised regret is ≤ the "start by last week's points" baseline's (hard); (b) **`objective: pwin` vs `objective: mean` realised regret is reported on the same weeks** — `mean` stays the v1 default unless `pwin` wins (plan 07 C11); (c) `objective: pwin` produces `mode` consistent with the sign of `μ_m − μ_o` on every matchup (hard); (d) every `Dist` in every 1a tool carries `basis: "position_cv"` and the Skills' output template prints it (Lane 1 test); (e) in `position_cv` mode `delta_pwin` is the `{ sign, band }` form and never a two-decimal number (schema test). The regret numbers are written to `docs/evals/`.
- A8 **K/DEF (soft, reported):** `ff_analyze_waivers(positions: [K, DEF])` returns ≥ 3 candidates per position with `implied_total` populated for every fixture week (hard); rank correlation with realised points is reported against both 05 §8 baselines.
- A9 **Retrospective (revised round 1, OBJ-05):** the 05 §12 "evaluation of the evaluator" unit tests pass (a perfectly calibrated synthetic forecaster scores Brier = uncertainty; CRPS of the true distribution beats a misspecified one); `src/domain/reclog/metrics.ts` is at 100 % lines + branches (T10); running the 1a Skills' Lane 1 dry runs on fixture week `N` and `ff_analyze_retrospective(N)` on week `N+1` yields `regret`, `followed`, `metrics.per_player` (CRPS/pinball/coverage), `swap_regret` and `brier.p_active` for the logged calls; `brier.p_win`, `p_win_given_bid` and `p_role_holds` read `"n too small (k of 30)"` and `sample_size_caveats[]` names each; `n_by_metric[]` matches the §2.1 table's shape; `parameter_changes_proposed` is **absent** from the v1 output schema (schema test).
- A10 **Skills Lane 1:** `check:skills` green for the 1a Skills, including the fixture dry run (plan 09 §5.1 item 7) and the pairwise trigger-collision check.
- A11a **Skills Lane 2 (manual, tokens):** SS-1..4, KD-1..3, RT-1..3 pass the plan 09 §5.2 bar on the fixture YAML league; trigger evals: all positives trigger, no negatives, on both model classes.
- A13 **Process/lifecycle:** plan 05 §4.2 green on ubuntu and once on macOS.
- A14 **Coverage gate** (plan 05 §7) met; `supply-chain`, `secrets`, `pack` jobs green; the tarball contains `dist`, `skills` (`_shared` ships; it is harmless and keeps `build-skills` reproducible), `README`, `LICENSE`, `CHANGELOG` only.
- A15 **Latency:** on a warm cache every P0 tool answers in < 500 ms and `ff_project_players` for 32 players with `n_sims = 4000` in < 3 s on Chad's Mac [A-2]; startup < 1 s without network (plan 05 §4.2).

**Exit gate (1a).** A1a, A3a, A4a, A5a, A6, A9, A10, A13–A15 green in CI on the SHA; A11a done by Chad with evidence in `docs/evals/`; A7–A8 reported. No tag of its own: `v0.1.0` is tagged when 1b's gate is also green. If the Ph8 decision point fires first, **X1 ships from 1a's green SHA** as `v0.1.0` with `ManualLeagueProvider` as the league source (the README says so), and X2 is pulled from §3.5.

#### 3.1b Phase 1b — the Yahoo half (M; starts on a provisioned token)

**Scope.**
- *Auth and provider:* plan 02 §2 `oob` auth + token store + lockfile; plan 01 §8 `YahooProvider` (XML, path builder, limiter, cache, error classifier); `ff auth`, `ff smoke`; `ff doctor`'s online rows.
- *Tools:* the platform-fact tools (A1–A5, B1–B2, C1–C2) over Yahoo; B2's golden `match`; D2's Yahoo `status`/`status_full` fields; E3 `pre`'s `yahoo_cross_check`.
- *Resources:* `ff://game/stat-categories`, `ff://roster/snapshot`.
- *Prompts:* `ff.onboard`, `ff.weekly`, `ff.apply`.
- *Skills (plan 09 P0):* `onboard` (Yahoo mode), `weekly`, `apply` (read-only mode).
- *Jobs (plan 06 §1.3):* `snapshot roster`, `snapshot fa-pool`, `transactions append`, `token check`, `pre-kickoff check`.
- *Fixtures:* Yahoo recordings for every endpoint the P0 tools touch, ≥ 3 final weeks of player stats for every rostered player of every team, scrubbed (plan 05 §3.1); golden expected outputs vs `player_points.total`.

**Acceptance (1b; hard unless marked soft).**
- A1b **Golden gate:** `tests/domain/scoring/golden.test.ts` — every rostered player-week in the ≥ 3 Yahoo fixture weeks matches `player_points.total` within 0.01; `complete = true` on final weeks (plan 08 §6 step 1).
- A2 **Live self-check:** `ff smoke` against the real league lists leagues, reads settings, scores the current roster's last final week with every player `match: true` (Chad runs it; output pasted into `docs/evals/`).
- A3b **Inspector smoke (Yahoo fixture league):** `tools/list` unchanged from A3a; `prompts/list` has the six P0 prompts; a `tools/call` of `ff_get_player_stats` on a fixture week returns `match: true` for every player.
- A4b **Fault matrix — Yahoo rows:** every row of plan 05 §4.1 that applies to reads (999, 429/5xx, timeout, non-XML, malformed, XXE inert, `NOT_FOUND`, `token_rejected` once, `additional_authorization_required` terminal, `invalid_grant`, 25-page paging).
- A5b **Crosswalk on the Yahoo fixture league:** ≥ 95 % of rostered players resolve by id or deterministic match [A-1] and the remainder appear in `ff_get_status.crosswalk.unmatched_rostered`.
- A11b **Skills Lane 2 (manual, tokens):** ON-1..3, WK-1..3, AP-2, AP-4 and the two-session AP-5 pass the plan 09 §5.2 bar; AP-4/AP-5 are run with the manager-authored wrappers on and off and both results are recorded in `docs/evals/` (OBJ-07); trigger evals as in A11a.
- A12 **Model-driven evals (plan 05 §6):** ≥ 8/10 on the 10 read-only fixture questions.
- A16 **Usefulness check (manual, named evidence):** Chad runs `/onboard` then `/weekly` on the live league and confirms in HANDOFF that the briefing contained a lineup with intervals and `P(win)`, a K/DEF verdict with implied totals, every deadline, the attribution line, and a `log_id` per section.
- A19 **Elicitation verified (round 1, OBJ-23 b):** `ff_debug_elicit` (fixture mode only, plan 07 G3) is exercised from the Inspector and from a Claude Code session against the fixture-mode server; the result per client (form shown and answered / dropped / `cancelled`) is recorded in HANDOFF "Confirmation-gate facts", and plan 02 §4.2's availability column is re-tagged from [U] to a run-verified tag with the date. (Claude Desktop is Phase W's W6.)
- A18 **XML safety (round 1, OBJ-14):** `xml.ts` sets `processEntities: false` and `htmlEntities: false`; the internal-`DOCTYPE` entity fixture is not expanded and the billion-laughs fixture is inert in < 1 s; the mutation check (plan 05 §2 `providers/yahoo/xml`) shows the fixture test red with `processEntities: true`; the `supply-chain` job's full-tree diff (`npm ls --omit=dev --all`) matches plan 04 §2's count for the chosen `fast-xml-parser` pin.

**Exit gate (1b).** A1b, A3b, A4b, A5b, A18 green in CI on the tagged SHA; A19 with evidence in HANDOFF; A2, A11b, A12, A16 done by Chad with evidence in `docs/evals/`. Tag `v0.1.0` (pre-1.0 semver, plan 04 §4.4) once **both** 1a and 1b gates are green.

**Explicitly deferred to Phase 2.** Usage (`ff_get_player_usage`), skill-position waivers, trades, cascades, schedule planning, roster audit, news, live/season matchup modes, the odds driver, Sleeper/DynastyProcess seeds, the plugin manifest. **Deferred to `later`** (round 1, OBJ-21): `ff_get_playbook`, `ff_analyze_scoring`. (No longer deferred: `stats_player_week` and weather are in 1a.)

### 3.2 Phase 2 — Usage, market, and the P1 engines (L)

**Scope.**
- *Sources (05 §16 #6–#9, #13; 04 §C):* nflverse `stats_team_week`, `snap_counts`, pbp projected subset (RZ/GL, `kick_distance`, `defteam`, `xpass`, `pass_oe`, `epa`), `depth_charts` (parquet), ffopportunity `ep_weekly`, Sleeper `players` + `trending`, DynastyProcess ids, RotoWire/ESPN RSS (CBS fallback), The Odds API if D4 (`stats_player_week` and weather moved to Phase 1a — round 1); **two prior seasons** of `stats_player_week` + `schedules` + `injuries` for the soft backtests [A-3]; the plan 06 jobs for all of them; crosswalk rebuild job with the unmatched alert.
- *Tools (plan 07 P1):* C3, D1, D4–D6, E4, E6–E9, E11 — 11 new tools (30 under `FF_TOOLSET=full`; `core` stays at 19), plus E3's `live`/`season` modes and E5 for all positions. E10 → Phase 3 (P2); E15 and G2 → later *(round 1, OBJ-21)*.
- *Skills (plan 09 P1):* `waivers`, `trade`, `injury-cascade`, `schedule-plan`, `roster-audit`, `news-check` — six; prompts for each. `start-sit`'s game-day branch gains its live `P(win)` split when E3 `live` ships here (`live` is no longer a Skill — round 1, OBJ-18).
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
- B8 **News pipeline:** the plan 05 §3.2 injection fixtures never appear outside an `untrusted_text` wrapper or a `meta.untrusted_fields[]`-listed path in any tool output (walk all outputs — plan 02 §6.2, round 1); the `rules_v1` claim extractor scores ≥ 0.8 precision on a hand-labelled set of 50 real items [A-4] (the labelled set is a fixture, no identifiers); `news-check` on the pasted "DROP Y IMMEDIATELY" (NC-1) produces a flag word, "priors are hand-set", and no write path — at the Skill level, since E10 arrives in Phase 3 (OBJ-21).
- B9 **Live/season matchup:** `mode: live` on a fixture mid-week snapshot splits players into final/live/pending correctly and never lists a locked slot as actionable; `start-sit`'s game-day branch on the same fixture (Lane 1 dry run) sets `only_unlocked: true` and reads Yahoo game-day status only (`p_active_basis: "yahoo_gameday_status"`, OBJ-16); `mode: season` with `n_sims = 10 000` reproduces a hand-computed `p_playoffs` on a 3-team toy league within 0.02 (unit test).
- B10 **Inspector smoke** updated: 30 tools in order under `FF_TOOLSET=full` (19 under `core`, the default — OBJ-08); still no write tools; `prompts/list` has 12.
- B11 **Skills:** Lane 1 green for all 12; Lane 2 cases WV-*, TR-*, IC-*, SP-*, RA-*, NC-* (incl. the two-session NC-4, run with wrappers on and off — OBJ-07/OBJ-15) and SS-5..7 pass the bar; trigger-collision check across all 12 with the time-blind Sunday prompts (plan 09 §5.1 item 5).
- B12 **Token sizes:** `tests/mcp/size.test.ts` extended to all 30 tools; a measured `compact`/`full` ratio is recorded (closes 06 U-10 for our outputs) and plan 07 §5.1 is corrected if wrong.
- B13 **Engine branches:** with the second fixture league, `rounding.verified` and/or `negative_floor.verified` become `true` with a golden fixture; the DST points-allowed derivation is pinned by a fixture week containing a defensive/return TD against the offence.
- B14 **Plugin (if D3):** `claude plugin validate . --strict` green; `claude --plugin-dir .` loads 12 Skills and the server; `${CLAUDE_PLUGIN_DATA}` holds tokens, not the plugin root (a test greps).

**Exit gate.** B1–B3, B7–B13 hard in CI or with fixture evidence; B4–B6 reported. Tag `v0.2.0`.

**Explicitly deferred to Phase 3.** The `v2-opportunity` projection, the redistribution prior table, the calibrated source table and **E10 `ff_analyze_evidence`** (OBJ-21), parameter tuning, held-out-season hard gates.

### 3.3 Phase 3 — Model wave (L)

**Scope.** 05 §1 in full (`v2-opportunity`: market anchor, EWM shares with change points, shrinkage per rate, location-based TDs via ffopportunity/pbp, regressed matchup, weather where evidenced, `P(active)` mixture, simulated distributions); 05 §6.2 redistribution prior table from pbp history; 05 §10.2 per-source calibration table fed by the retrospective **and E10 `ff_analyze_evidence` over it** (P2 — OBJ-21; `calibration_state.note: "priors are hand-set"` until `table_n ≥ 200`, C7); 05 §11.4 season simulation tuned; 05 §12.4–12.5 attribution and the weekly re-fit of `h`, `k`, `β_pos`, `w`, weather multipliers; ≥ 3 historical seasons loaded [A-3]; `ff_project_players.model_version = "v2-opportunity"` with `v1-trailing` kept as a baseline.

**Acceptance (hard unless marked).**
- C1 **Projection backtest (05 §1 evaluation):** on ≥ 2 held-out seasons, `v2` beats trailing-4 on CRPS and within-position Spearman, the gain is not concentrated in weeks 1–3, and 80 % interval coverage is within ±5 points of nominal.
- C2 **Start/sit:** regret below the consensus-free baselines (last-week points, `v1-trailing` mean) on the held-out seasons; `P(win)` calibrated within ±5 points per decile (the first place `P(win)` has n — §2.1); "did it matter" share reported; **`objective: pwin` vs `objective: mean` regret with `basis: player_sim` decides the v2 default** (plan 07 C11, round 1 OBJ-04).
- C3 **`P(win)` vs Yahoo:** Brier below Yahoo's `win_probability` on every replayed fixture week for which the pre-week Yahoo value was snapshotted (needs the scoreboard snapshot — tension T11).
- C4 **Waivers:** the usage detector beats the points detector on precision at equal recall in ≥ 2 seasons; `P(win | bid)` calibrated within ±10 points where the league's claim history allows (soft where `n < 30`).
- C5 **Cascade:** beneficiary-share MAE below next-man-up and top-beneficiary hit rate above it on the historical absence set.
- C6 **K/DEF:** beats "last week's score" clearly and matches "lowest implied total" (05 §8 eval); the share of DEF variance explained by `rare_c` reported.
- C7 **News calibration:** `calibration_state.table_n ≥ 200` claims [A-5]; news-augmented `P(active)` Brier ≤ designation-only.
- C8 **Retrospective attribution** populated (opportunity / efficiency / TD / matchup-weather / availability) for every projection-backed call; **`parameter_changes_proposed[]` enters E13's schema here** (round 1, OBJ-05 — held-out seasons exist to test a proposal against) and changes are *proposed* and applied only by a human-run `ff tune --apply` (never automatically — 05 §12.5's own warning).
- C9 The 05 §18 "does not predict" list is re-checked with the product's own numbers and the results written to `docs/evals/` (a recurring pre-season job in plan 06 §1.4 from now on).

**Exit gate.** C1–C3, C5–C6, C8 hard; C4, C7 soft with numbers. Tag `v0.3.0` (candidate for `v1.0.0` once W or a season of use has passed).

### 3.4 Phase W — Conditional writes (M; starts only on provisioning)

**Trigger.** Yahoo grants read/write for the client id (HANDOFF item 4; 03 §F.18). Until then nothing in this phase is scheduled; the seam is designed (plan 02 §4) and `FF_WRITE_ENABLED` is documented as inert.

**Prerequisites (before `FF_WRITE_ENABLED=1` is supported anywhere)** *(added round 1, OBJ-01)*: (a) the refresh token moves to the Keychain `SecretSource` (plan 01 §11; plan 02 §3.3) with an access prompt; (b) the README states that writes are **unsupported in a Claude Code session with unrestricted `Bash`** and prints the offered `permissions.deny` set (plan 02 §3.4); (c) `ff doctor` #13's Claude Code warning is in place (plan 03 §5).

**Scope.** `fspt-w` in `ff auth`; plan 02 §4 gate (`PreparedWrite`, ticket, precondition hash, three channels — channel 2 without a pending file, channel 3 TTY-only; journal states); plan 07 §3.F tools; `journal reconcile` job (plan 06 §1.3); `apply` write mode (plan 09 §3.6); Desktop and Code elicitation smoke; `fixtures/yahoo/writes/` recorded from the **first real writes** (plan 05 §3.1 has no write fixtures today — they can only be recorded once writes exist).

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
- W10 *(added round 1, OBJ-01)* Plan 05 §4.3's round-1 rows green: no file written under `<config>/` during channel 2 (`fs` spy); `ff confirm`/`ff auth` on a pipe → exit 2, zero writes; `doctor` #13 warns under `CLAUDECODE=1` + `FF_WRITE_ENABLED=1`; the refresh token is read from the Keychain `SecretSource` and `tokens.json` no longer contains it (grep test).

**Exit gate.** W1–W4, W7–W10 in CI; W5–W6 with evidence. Tag a minor.

### 3.5 Phase 4 — Later (M each; unordered until pulled)

| Item | Pull trigger | Acceptance sketch |
|---|---|---|
| **`SleeperProvider` (X2)** *(added round 1, OBJ-02)* — the first second platform behind `FantasyPlatform` (plan 01 §8); M | the Ph8 decision point fires without a read grant, **or** Chad (or a user) has a Sleeper league | the 19 P0 tools over a Sleeper league in fixture mode (Sleeper's read API is public and keyless, 04 §B4); plan 08 P14 round trip over Sleeper scoring settings; `ff_` names unchanged; `license: "non-commercial"` visible in `ff status` (personal use only, D1) |
| `ff_get_draft_results`, `ff_analyze_draft`, `draft` Skill | Chad wants it for the next August draft | 05 §13 eval: xVBD-best-available beats ADP-order on ≥ 2 replayed drafts under the league's `S`; DR-1..3 pass |
| ESPN provider — **after** Sleeper, never the first second seam: ESPN's API is ToS-blocked (04 §B5) | an ESPN league **and** a ToS position that permits it | plan 08 P14 round trip; ESPN golden vs `appliedTotal`; `ff_` names unchanged |
| Streamable HTTP + auth server; claude.ai install | a second user or hosted use (plan 01 §3.2/§3.3) | plan 01 §3.2 table implemented; DNS-rebinding tests |
| Marketplace release via `npm` source | D3 = yes and 06 U-6 verified | `claude plugin install` from the published package works on a clean machine |
| Commercial source swaps (Open-Meteo → NWS, Sleeper → own trending; FTN/ffverse attribution) | D1 = commercial | `ff status` lists no `non-commercial` source; attribution lines in every result |

---

## 4. Tensions with the structural plan (plan 01–06) — for the devil's-advocate round

None of these are contradictions the product plan resolved silently; each is a place where 07–10 need plan 01–06 to add or adjust a line. The core planner's files were not edited.

| # | Where | Tension | Proposed resolution |
|---|---|---|---|
| T1 | plan 01 §4.1 verb list | no verb fits the recommendation-log write; plan 07 uses `ff_record_recommendation` | add `record` to the verb list (a local-store write, not a platform write) |
| T2 | plan 01 §4.2 single JSON format vs doc 06 §A.6 compact tables | adopted plan 01; token saving recovered by `detail: compact\|full` (plan 07 C2) | none needed now. *(Revised round 1, OBJ-06: the "Markdown as a second text block" clause is deleted from plan 01 §4.2 — it would have been a third copy; whether clients forward `structuredContent` is answered by A17, and list tools omit it until then.)* |
| T3 | plan 04 §1 tree | no `.claude-plugin/plugin.json`, `marketplace.json`, or plugin-scoped `.mcp.json`; doc 06 §E recommends a plugin; plan 09 K7 makes it an additive P1 layer | if D3 = yes: add the three files to plan 04 §1 and `files` in §2; `check-skills` gains `claude plugin validate --strict` |
| T4 | plan 05 §6 evals | only the mcp-builder 10-question harness; Skills need their own lanes (plan 09 §5) | additive: plan 05 §1 table gains rows "Skills Lane 1 (CI, zero tokens)" and "Skills Lane 2 (manual, tokens)"; plan 04 §4.2 `skills` job gains the dry run |
| T5 | plan 06 §1.2 `store prune` / plan 01 §5.6 | pruning is described for cache, news, backups; the recommendation log and the `league_settings` hashes it references must never be pruned (05 §12) | one sentence in plan 06 §1.2 and plan 01 §5.1: "never pruned: `recommendation_log`, `league_settings` rows referenced by it, `write_journal`" |
| T6 | plan 02 §5 `player_keys ≤ 25` | analytics tools need > 25 players (a FA pool, all rosters); plan 07 uses `PlayerSelector`/`pool` selectors instead of key lists | no change to the bound; note in plan 02 §5 that selectors are the sanctioned way past it |
| T7 | plan 03 §4.2 "nothing lands in the public repo's `.mcp.json`" | a plugin's `.mcp.json` at the repo root is that file (with `${CLAUDE_PLUGIN_ROOT}` paths and no secrets) | if D3 = yes: reword to "no secrets or absolute user paths in the repo's `.mcp.json`"; the plugin file carries only variables |
| T8 | plan 01 §4.1 annotation families | no family for a **local-store write** (`ff_record_recommendation`: `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false`); `defineTool()` forces family annotations | **Applied round 1** (with the advocate's addition, OBJ-19): a sixth family "local write (journal/log)" that also holds `ff_prepare_*` and `ff_cancel_prepared` (`readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false`) — plan 01 §4.1, plan 02 §4.1, plan 07 §2/F7. *(The earlier proposal kept `cancel` at `readOnlyHint: true`; withdrawn.)* |
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
| **D0** | **The Yahoo API access application itself** — when Chad submits it, and with what framing (HANDOFF item 4: personal use, one user, one league, read-only, locally-run open-source tool, low cached request volume; write requested in the notes with the confirmation-gate design as the justification) *(added round 1, OBJ-02)*. **Outranks D1–D10**: it decides whether 1b happens this season | submitted in Phase 0 (Z4); the Ph8 rule then runs: 4 weeks after submission or NFL week 9, whichever is earlier | not submitted → 1b never starts; X1 is the product for Chad's league and X2 for the public; every Yahoo-dependency:`read` line in plans 01–10 stays designed and untested |
| D1 | **Commercial distribution?** (HANDOFF item 6) | personal use | Phase 4 source swaps become Phase 2 work; Sleeper trending → own snapshot diffs; Open-Meteo → NWS; FTN/ffverse attribution in every result |
| D2 | **Buy a consensus projection feed as a baseline?** (HANDOFF item 7; FantasyPros ~$9/mo personal-use) | no — projections are ours | a `DataSource` for the feed lands in Phase 2 as a **retrospective comparator only** (05 §1 evaluation (c)); never shown as the recommendation |
| D3 | **Ship the Claude Code plugin manifest in v1 (Phase 2)?** | yes, additive (plan 09 K7) | no → copy-install stays the only path; T3/T7 close as "not applicable" |
| D4 | **Request a free The Odds API key?** (04 B6; ≈ 108 credits/month) | skip in Phase 1; optional in Phase 2 | yes → `ff_get_schedule.lines.secondary` populated; the multi-book consensus feeds the market anchor |
| D5 | **The validation league's starting FAAB budget and acquisition limits** (not in `settings`, 03 §E) | asked once by `onboard`, stored in the server's config dir, never in the repo | none — just needed at onboarding |
| D6 | **`apply` ships at P0 in read-only "manual clicks" mode?** | yes (plan 09 §1) | no → every P0 Skill ends without the "say apply" line; `apply` arrives with Phase W |
| D7 | **A token budget for Skills Lane 2 in CI (nightly)?** | no — manual pre-release only (plan 05 §8) | yes → Lane 2 runs nightly with `--max-cost` and the results land in `docs/evals/` automatically |
| D8 | **A second fixture league with non-fractional / negative-off / bonus settings** (Phase 2 B13) — does Chad have one, or will he join a public Yahoo league for fixtures? | join one public league on the same account (portal allows one *account*, not one league) | none available → those engine branches stay `verified: false` with the property tests as the only guard, and `ff_get_player_stats.match` stays `null` for such leagues |
| D9 | **How many historical seasons for backtests?** | 2 in Phase 2, ≥ 3 in Phase 3 (a few MB each) | fewer → C1/C4 revert to soft gates |
| D10 | **Is the game-day branch's live `P(win)` (E3 `mode: live`) needed in Phase 1?** *(reworded round 1 — `live` is a branch of `start-sit`, not a Skill, OBJ-18)* | no (P1): in Phase 1 the branch already restricts swaps to unlocked slots and reads Yahoo game-day status; it says live `P(win)` is not yet available | yes → E3 `live` mode moves into Phase 1b (adds ~S effort; the scoreboard's 60 s class already exists) |

---

## 6. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | ≥ 95 % crosswalk resolution on the fixture league without Sleeper/DynastyProcess seeds (04 §D: ids cover ~68 %; the matcher covers rookies) | the Phase 1 crosswalk test; the number is a constant |
| A-2 | Latency targets (500 ms warm; 3 s for 32 × 4 000 sims) on Chad's Mac | first measurement; `node:sqlite` is synchronous — if the simulation stalls the loop, sims move to a worker thread (a seam, not a redesign) |
| A-3 | Two prior seasons suffice for the Phase 2 soft backtests; three for Phase 3 hard gates | first backtest run |
| A-4 | 50 hand-labelled news items and 0.8 precision are enough to trust `rules_v1` | first labelling pass |
| A-5 | 200 claims make the source × claim table meaningful | 05 §10 evaluation |
| A-6 | The per-turn fixed-cost ceilings (plan 07 §5.1 [A-4]: `core` ≤ 40 000 chars, `full` ≤ 70 000, Skills listing ≤ 4 500) are the right order of magnitude *(added round 1, OBJ-08)* | the first fixture-mode measurement in Phase 1a; constants in `tests/mcp/size.test.ts` |
| A-7 | The per-week n estimates in §2.1 (player-weeks, designations, swaps per week for one 12-team league) *(added round 1, OBJ-05)* | E13's `n_by_metric[]` on the first logged weeks; the table's "reaches n by" column is corrected from the real counts |
| U | Yahoo approval latency and whether write is ever granted (03 §F.18) | the application |
| U | Claude Desktop elicitation (HANDOFF) | Phase W W6 |
