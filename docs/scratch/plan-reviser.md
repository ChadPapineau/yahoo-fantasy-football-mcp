# plan-reviser — working notes

Brief: `docs/scratch/briefs/plan-reviser.md`. Spec: `docs/plan/adversarial-log.md`
§ "Round 1 — defence" (§D.1) + plan 10 §4 (T1–T13) + log §1.3 additions.
Owned paths: `docs/plan/01-*` … `10-*`, `.github/workflows/docs.yml` (OBJ-12
only), `docs/plan/changelog.md` (new), this file.

## RESUME HERE

Status legend: `[ ]` not started · `[~]` in progress · `[x]` committed+pushed · `[!]` could not apply (see notes)

| # | Group | Status | Commit |
|---|---|---|---|
| 0 | Scratch doc + RESUME HERE pushed | [x] | 19c6020 |
| R | Read: adversarial-log (all), plan 10 §4, plans 01–10, HANDOFF, docs.yml | [x] | — |
| 1 | OBJ-02 / plan 10 (Phase 1a/1b split, D0, X1/X2, EV para) + plan 01 §8 providers (brief says §3; seam is §8); OBJ-03 stats_player_week → 1a (plan 07 E1, plan 08 §3.2) | [x] | 59d0d99 |
| 2 | OBJ-01 / plan 02 (§0 rule, §1, §4.2 per-client column, §8 #2/#5, S3/S6) + "cannot"/"never" audit (S5, §7 qualified; §6.2 "no code path" waits for G7) | [x] | d5f7934 |
| 3 | OBJ-18 / plan 09 (`live` → `start-sit` branch; 12 Skills) + xrefs in 07/10 | [x] | 22b5553 |
| 4 | OBJ-08 + OBJ-21 / plans 07, 10 (+01, 03, 05, 09) (`FF_TOOLSET`, outputSchema, E15/E10/G2, ledger, Skill desc ≤350) | [x] | 1403118 |
| 5 | OBJ-09 / plans 01, 03, 04, 06 (Node >= 24.15, RC cite, CI matrix, fnm) | [x] | b5c8968 |
| 6 | OBJ-14 / plans 02, 04 (+05, 10 A18) (fast-xml-parser flags, allow-list tree, pin-time rule) | [x] | 1cc2dfc |
| 7 | OBJ-06/07/15 / plans 01, 02, 07 (+05, 09, 10) (untrusted_fields labelling, wrappers, structuredContent, rec-log source) | [x] | 0b4489a |
| 8 | OBJ-04/05 / plans 07, 10 (+08, 09) (Dist.basis, A7, mean default, delta_pwin, E13, n≥30 table, params → Phase 3) | [x] | e04efde |
| 9 | OBJ-10/11/16/17/19/22/23 / plans 01–10 | [x] | 94bc8fb |
| 10 | OBJ-12 / docs.yml + plan 04 §4.2 + plan 10 Z3 — PROVE GREEN | [ ] | — |
| 11 | OBJ-13 / plan 04 §5, plan 10 Z1 | [ ] | — |
| 12 | OBJ-20 / plan 01 D7 (snappy, upload.R:85) | [ ] | — |
| 13 | D.2 items (Yahoo-dependency header tag ×10, FF_TOOLSET default, re-tag sources) | [ ] | — |
| 14 | T1–T13 per plan 10 §4 + log §1.3 additions | [ ] | — |
| C | Consistency pass (xrefs, decisions tables, assumptions tables, Mermaid) | [ ] | — |
| L | `docs/plan/changelog.md` `## Round 1` | [ ] | — |
| F | Final reply: SHAs per group, run URLs, landing table, could-not-apply, choices, xref fixes | [ ] | — |

### Could not apply
(none yet)

### Choices I had to make
- G9: game-day window = within 3 h of the player's kickoff (defence said 'within 3 h' — used as given); the 10 % league-wide mismatch threshold lives in `src/domain/scoring/policy.ts` [plan 08 A-5]; doctor rows numbered 19–22 (T9's 19–20 + OBJ-22's 21–22); Claude Desktop log path tagged [plan 03 A-8]; `ff_debug_elicit` named as G3's sibling for A19; `STORE_BUSY` retry window ≤ 1 s and cache `busy_timeout` 100 ms as the defence stated; the swap-transaction bound (< 50 ms) is mine.
- G8: the §2.1 per-week n estimates (player-weeks ~150–190/wk, designations ~8–15/wk, swaps ~3–6/wk …) are mine, tagged [A-7]; E13's `n_by_metric[]` corrects them. The coarse `delta_pwin` shape is `{ sign, band: small|medium|large }` and `coin_flip` widens to `|ΔP(win)| < 0.04` in `position_cv` mode (defence said 'widened', no number).
- G7: `meta.untrusted_fields[]` entries become `{ path, source }` objects (were bare path strings) — the minimum that lets the OBJ-15 ruling ('listed … with `source: "store.recommendation_log"`') be true. The defence scoped bare strings to *player names* only; dataset text (nflverse `desc`, depth-chart labels, Sleeper notes) stays wrapped.
- G7: plan 02 §6.3's verbatim sentence gained 'and the fields listed in `meta.untrusted_fields`' + 'player names, earlier recommendations' so it covers the path-listed classes; plan 09 carries the same wording.
- G7: the wrappers-on/off eval switch is described as 'a fixture-mode-only switch' (no env-var name invented); `ff_debug_echo` is named G3 in plan 07 §3.G and never appears in the production expected-tools lists.
- G4: per-turn fixed-cost ceilings (defence said 'with a ceiling', no number): `core` ≤ 40 000 chars, `full` ≤ 70 000, Skills listing ≤ 4 500 — [A-4]/[A-6], calibrated on first measurement.
- G4: the C10 list-tool set that drops `outputSchema` = the five §5.1 rows with a 12 000–20 000 worst case (`ff_list_players`, `ff_list_transactions`, `ff_list_recommendations`, `ff_get_player_usage`, `ff_get_news`).
- G4: Skill description cap applied as a rule (≤ 350; the §3 trigger paragraphs are content, trimmed at authoring time with phrases moving to `when_to_use`) rather than rewriting 12 descriptions now.
- G1: effort sizes for the split — 1a = L, 1b = M, X2 `SleeperProvider` = M (defence gave none; kept the total ≥ the old L).
- G1: 1a Skills — defence names `stream-kdef`/`retro`; added `start-sit` (E2 is in 1a; X1 promises start/sit) and `onboard`'s manual-YAML mode (defence says `onboard` helps write the YAML). `weekly`/`apply` stay 1b.
- G1: weather moved into 1a because D.1 OBJ-02 item 1 lists "weather/lines" in 1a (plan 10 had deferred weather to Phase 2). Odds stay deferred.
- G1: fixture manual league path `fixtures/manual/league.yaml`; `ManualLeagueProvider` returns `match: null` and all-false write capabilities (minimum needed for the seam to be honest). Provider-selection mechanism (env/config key) deliberately NOT decided — build-time.
- G1: original A-numbers kept (plans 05/07 cite them); Yahoo-half/Yahoo-free-half items split as `a`/`b`. 1a has no tag of its own; `v0.1.0` tags when both halves are green; X1 ships from 1a's green SHA if Ph8 fires first.
- G1: "plan 01 §3" in the brief read as §8 (the `FantasyPlatform` seam lives there); also touched §1 diagram and §11.

### Cross-reference inconsistencies found
- G9: plan 03 §1.1 step 3 cited '(§6)' for migrations; plan 03's migration section is §7 (§6 is token expiry) → fixed.
- G4: plan 09 §3.12 `news-check` called E10 (now P2) at P1 → the Skill reconciles D6/D2/D1/D3 itself at P1 and says "priors are hand-set".
- Plan 07 C3 "34 read tools (19 P0 + 15 P1)" was a miscount: the P1 list (C3, D1, D4–D6, E4, E6–E11, E15, G2) is 14. After OBJ-21 (E15, G2 → later; E10 → P2): v1 = 31 (19 P0 + 11 P1 + 1 P2); Phase 2 tools/list = 30 under `FF_TOOLSET=full`. Plan 10 B10/B12 said 34 → fix to 30 (G4).

### Notes
- WIP patch (if any): `docs/scratch/plan-reviser.wip.patch` — retired in the final commit.
