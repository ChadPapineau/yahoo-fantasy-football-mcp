# product-planner — working notes

Brief: `docs/scratch/briefs/product-planner.md`. Owns `docs/plan/07-tool-catalog.md`,
`08-scoring-engine.md`, `09-skills-bundle.md`, `10-phasing-and-acceptance.md`, and this file.
Does not touch anything else.

## RESUME HERE

**Status:** reading complete (HANDOFF, plan 01–06, research 05/06/04/03/02, mcp_best_practices,
evaluation.md). Decisions below are settled. Writing plan 07 next.

**Next step:** write `docs/plan/07-tool-catalog.md` → commit+push → 08 → 09 → 10, updating this
section after each push. If resuming cold: the decisions in "Settled decisions" are binding for
all four files; do not re-derive them.

**Done:** scratch doc (2c9b6b0).

**Pushed SHAs:** 2c9b6b0 (scratch start).

**Tensions with plan 01–06 noticed so far:** see "Tensions" below (carried into plan 10).

**Open decisions for Chad noticed so far:** see "Open decisions" below (carried into plan 10).

## Settled decisions (binding for 07–10)

1. **Naming = plan 01 D9/§4.1, not doc 06.** Prefix `ff_`, verbs `get|list|search|analyze|project|
   compare|prepare|commit|cancel` (+ `record` for the recommendation log — a tension, listed).
   Doc 06's `yahoo_*`/`nfl_*`/`proj_*` names are mapped to `ff_*` in a table in plan 07.
   URI scheme `ff://`; prompts `ff.<workflow>`; server `fantasy-football-mcp-server`.
2. **Output contract = plan 01 §4.2** (structuredContent + one JSON text block; envelope; 20 000-char
   budget; `limit`/`offset`). Doc 06's compact-table `content` and opaque `page_cursor` are NOT
   adopted; the token savings are recovered with a `detail: "compact"|"full"` field-selection
   argument on list/card tools. Recorded as a tension.
3. **Confirmation gate = plan 02 §4** (`ff_prepare_*` → human channel → `ff_commit_*(prepared_id,
   evidence)`, HMAC ticket, three channels). Doc 06's 128-bit-token variant is superseded.
4. **Write tools register only with `FF_WRITE_ENABLED=1` + provisioning** (plan 02 S5).
5. **Fixture league** = plan 05's `461.l.1000` "Fixture League", settings = the validation league
   shape (12-team H2H half-PPR, QB/2WR/2RB/TE/W-R-T/K/DEF/6BN/2IR). Golden paths = plan 01 §8.1.
6. **Skills that ship (13 of 14):** onboard, weekly, start-sit, stream-kdef, retro, apply (P0);
   waivers, trade, injury-cascade, schedule-plan, roster-audit, news-check, live (P1). `draft`
   deferred (05 §13 low priority; off-season; no draft-room API). Reasons per Skill in plan 09.
7. **Skills layout:** `skills/<name>/SKILL.md` + `references/` + `evals/` authored in place (plan 04
   tree); shared references live in `skills/_shared/references/` and are **generated** into each
   Skill's `references/` by `scripts/build-skills.ts`, checked by `check:skills` (plan 04 §6 pattern:
   generated, not written). No `skills-src/`. Plugin manifest (`.claude-plugin/`) is a P1 additive
   layer — tension with plan 04's tree, listed.
8. **Twelve required analytics tools all designed** (none cut): lineup (start/sit + pwin objective),
   waivers (usage-first; K/DEF via positions + look_ahead), trade, schedule (bye/playoff), replacement
   (scarcity), injury_cascade, evidence (news-vs-stats), league_activity (digest), roster (ROS),
   matchup (P(win) pre/live + season sim), record_recommendation + retrospective (calibration).
9. **Retrospective is P0** (brief: calibration loop early).
10. **Clean negatives stated by name in 07/10:** routes run (snap-share proxy), projections (ours),
    props (none), beat-writer news (RSS editorial only), FAAB starting budget (ask), acquisition
    limits (ask), Yahoo `win_probability` method (cross-check only), Desktop elicitation (never sole gate).

## Tensions (draft; final list in plan 10)

- T1 plan 01 §4.1 verb list lacks a verb for the recommendation log → propose `record`.
- T2 plan 01 §4.2 single JSON format vs doc 06 §A.6 compact tables → adopt plan 01; add `detail`.
- T3 plan 04 §1 tree has no `.claude-plugin/` / `.mcp.json`; doc 06 §E recommends a plugin → plan 09
  makes the plugin an additive P1 layer; plan 04 tree needs two entries added.
- T4 plan 05 §6 evals = mcp-builder harness (10 read-only Qs) only; Skills need their own eval lane →
  plan 09 adds a zero-token structural lane + manual model-graded lane; no contradiction, an addition.
- T5 plan 01 §5.2 has no `recommendation_log` retention/pruning row; plan 06 `store prune` does not
  mention it → plan 10 asks that the log is never pruned (only cache is).
- T6 plan 02 §5 bounds: `player_keys ≤ 25` per call — analytics tools take rosters (≤ 16) fine, but
  `ff_project_players` for "all FAs at a position" needs > 25 → tool takes `team_key`/`positions`
  selectors instead of raw key lists over 25; no bound change needed. (Not a tension; a note.)
- T7 plan 03 §4.2 says nothing lands in the repo's `.mcp.json`; a plugin `.mcp.json` at repo root is
  exactly that file (with `${CLAUDE_PLUGIN_ROOT}` paths, no secrets) → needs reconciling in plan 04.

## Open decisions for Chad (draft; final list in plan 10)

- D1 commercial distribution (HANDOFF item 6) — default personal.
- D2 paid projections baseline (HANDOFF item 7) — default ours.
- D3 whether to ship the Claude Code plugin manifest in v1 or copy-install Skills only.
- D4 The Odds API free key (optional secondary lines) — request or skip.
- D5 FAAB starting budget and acquisition limits for the validation league (not in settings) — values
  needed at onboarding (never committed).
- D6 Whether `apply` ships at P0 in read-only "manual steps" mode (recommended) or waits for writes.

## Checkpoint log

| when | what | SHA |
|---|---|---|
| start | scratch doc created | 2c9b6b0 |
| reading done | decisions + tensions recorded | (this commit) |
