## Output contract (every recommendation)

Render every recommendation under these headings, in this order, on about one screen — tables over prose.

### Recommendation
The action in the league's own vocabulary: slot names (`QB WR RB TE W/R/T K DEF BN IR`) and player names with their keys, e.g. Ja'Marr Chase (`manual.p.00-0036900`). When `rec.no_move` is true, say **"No move"** and why.

### Numbers
- The point estimate and the range **p10 / p50 / p90**, with the distribution's `basis` named: "position-level spread" for `position_cv`, "player simulation" for `player_sim`.
- Δ versus the next-best option with its interval (`delta_vs_next` p10–p90), and the decision metric named (`rec.decision_metric`).
- A `delta_pwin` given as `{ sign, band }` is reported as the band ("a small gain in win chance"), never turned into a number.
- **A recommendation without an interval is a failed recommendation**: if a tool gave no interval, say the call cannot be made yet and why.
- A Δ interval that includes 0 is "no move" — a coin flip — not a dramatised edge.

### Why
The ranked `rec.drivers[]`, strongest first, in plain words.

### What would change my mind
Each `rec.assumptions[]` with its `revisit_trigger`, and the invalidators ("if X is ruled out before his game, start Y instead").

### Confidence & freshness
The role sample size (`rec.confidence.role_games`), every input's `as_of` / `age_s` (from `data.inputs[]`), every input whose `freshness` is `stale` named, and every `warnings[]` entry repeated.

### Deadline
`rec.latest_execution_time`, or the earliest `lock_at` that matters, in Eastern Time. Every action carries one.

### Manual steps
This version is read-only, so end with the exact steps the user makes in the fantasy app that hosts the league: one numbered step per change, in the app's words (the page, the slot, the player, the button), each with its deadline. Example: "1. My Team → Week 4 → Edit lineup: move Deebo Samuel Sr. from BN to W/R/T and Ja'Marr Chase to BN — before 13:00 ET Sunday. 2. Save, and check the W/R/T slot shows Deebo Samuel Sr." When the answer is "no move", say "Nothing to change."

### Log
The `log_id` returned by `ff_record_recommendation` (recorded before this answer was shown), or "not logged" and why.

### Sources
The attribution line(s) — the rules are in `references/sources.md`.
