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
| 3 | OBJ-18 / plan 09 (`live` → `start-sit` branch; 12 Skills) + xrefs in 07/10 | [ ] | — |
| 4 | OBJ-08 + OBJ-21 / plans 07, 10 (`FF_TOOLSET`, outputSchema, E15/E10/G2, ledger, Skill desc ≤350) | [ ] | — |
| 5 | OBJ-09 / plans 01, 03, 04 (Node >= 24.15, RC cite, CI matrix, fnm) | [ ] | — |
| 6 | OBJ-14 / plans 02, 04 (fast-xml-parser flags, allow-list tree, pin-time rule) | [ ] | — |
| 7 | OBJ-06/07/15 / plans 01, 02, 07 (untrusted_fields labelling, wrappers, structuredContent, rec-log source) | [ ] | — |
| 8 | OBJ-04/05 / plans 07, 10 (Dist.basis, A7, mean default, delta_pwin, E13, n≥30 table, params → Phase 3) | [ ] | — |
| 9 | OBJ-10/11/16/17/19/22/23 / plans 01, 02, 03, 05, 07, 08 | [ ] | — |
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
- G1: effort sizes for the split — 1a = L, 1b = M, X2 `SleeperProvider` = M (defence gave none; kept the total ≥ the old L).
- G1: 1a Skills — defence names `stream-kdef`/`retro`; added `start-sit` (E2 is in 1a; X1 promises start/sit) and `onboard`'s manual-YAML mode (defence says `onboard` helps write the YAML). `weekly`/`apply` stay 1b.
- G1: weather moved into 1a because D.1 OBJ-02 item 1 lists "weather/lines" in 1a (plan 10 had deferred weather to Phase 2). Odds stay deferred.
- G1: fixture manual league path `fixtures/manual/league.yaml`; `ManualLeagueProvider` returns `match: null` and all-false write capabilities (minimum needed for the seam to be honest). Provider-selection mechanism (env/config key) deliberately NOT decided — build-time.
- G1: original A-numbers kept (plans 05/07 cite them); Yahoo-half/Yahoo-free-half items split as `a`/`b`. 1a has no tag of its own; `v0.1.0` tags when both halves are green; X1 ships from 1a's green SHA if Ph8 fires first.
- G1: "plan 01 §3" in the brief read as §8 (the `FantasyPlatform` seam lives there); also touched §1 diagram and §11.

### Cross-reference inconsistencies found
- Plan 07 C3 "34 read tools (19 P0 + 15 P1)" was a miscount: the P1 list (C3, D1, D4–D6, E4, E6–E11, E15, G2) is 14. After OBJ-21 (E15, G2 → later; E10 → P2): v1 = 31 (19 P0 + 11 P1 + 1 P2); Phase 2 tools/list = 30 under `FF_TOOLSET=full`. Plan 10 B10/B12 said 34 → fix to 30 (G4).

### Notes
- WIP patch (if any): `docs/scratch/plan-reviser.wip.patch` — retired in the final commit.
