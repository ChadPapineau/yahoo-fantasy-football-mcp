# devils-advocate — working notes

Agent: `devils-advocate` (brief: `docs/scratch/briefs/devils-advocate.md`).
Owned paths: `docs/plan/adversarial-log.md`, `docs/scratch/devils-advocate.md`
(and the transient `docs/scratch/devils-advocate.wip.patch`). Nothing else.

Off-limits (owned by `ci-bootstrap`, in flight in the same tree): `.github/**`,
`.gitleaks.toml`, `scripts/**` — currently untracked; never stage them.

## RESUME HERE

**Round:** 1 (attack). **Status:** plans 01–10 read; notes below. Research
pass (HANDOFF, research 02–06, 01 verdict table, MCP reference) next; then
primary-source checks (SDK v2 transitive deps on npm; MCP spec 2026-07-28
claims; nflverse/ffopportunity currency for 2026).

**Next step:** finish the research pass, verify the load-bearing claims listed
above, then write `docs/plan/adversarial-log.md` § `## Round 1 — objections`
(table + details, `OBJ-nn` · target · claim · evidence · severity · satisfying
bar), commit, push, reply with SHA + table + the one objection staked on.

**If resuming cold:** check whether `docs/plan/adversarial-log.md` exists on
`origin/main`. If it does, round 1 is at least partly landed — read it and the
notes below before adding anything. If a `## Round N — defence` section has
been appended by the orchestrator, the next action is round N+1: verdict table
first, then new/pressed objections.

**Pushed SHAs:** (appended as they land)

## Reading notes (per file, attack angles only)

Plans 01–10 read in full (2026-09-30). Research pass next.

- **01** D2/D4: Node floor "22.13, unflagged" vs orchestrator fact (a): 22.23.2 still
  prints `ExperimentalWarning` for `node:sqlite`. D8 says "server only reads datasets"
  but the server writes `yahoo_cache`, `write_journal`, `recommendation_log`,
  `crosswalk`, `limiter_state`, `league_settings` — with a *synchronous* API and a
  concurrent refresh writer (WAL = one writer). §4.2: `structuredContent` **and** the
  same JSON in a text block → double payload per result; 20k-char budget ×2.
  `untrusted_text` wrapper (~90 chars) on **every player name** in every list.
  `prepare_*` annotated `readOnlyHint: true` although it writes the journal and mints
  the gate key. §11 "Skills validation … when docs/research/06 lands" — it has landed.
- **02** S6/§4.2: "the model cannot forge" the human channel — false for Claude Code,
  where the model has Bash/Read as the same OS user: it can `cat` `pending/<id>.txt`
  (channel 2 code), run `ff confirm <id>` (channel 3), or read `tokens.json` and hit
  Yahoo directly, bypassing the server. Threat model §8 #2 says "None from the model".
  §7 "five packages" — SDK v2 transitive tree unverified (v1 pulled express/cors/ajv…).
  §3.3 lock: hand-rolled pid lockfile; fine. §6.2 wrapper: theatre question — model
  reads `value` anyway; benefit unproven, cost measured in tokens.
- **03** §7 pre-migration backup = **file copy under WAL** (inconsistent unless
  checkpointed first; `node:sqlite` has `backup()`). §1.1 `busy_timeout=5000` on a
  synchronous API = event loop blocked ≤ 5 s during a refresh swap. Doctor: no check
  for stale `dist/` after `git pull`, no read of the client's MCP log for the last exit
  reason. L4 `process.execPath` under nvm breaks on every Node upgrade (doctor catches
  only if run).
- **04** R7 `npx @mermaid-js/mermaid-cli` needs puppeteer's Chromium **postinstall**;
  S10 sets `ignore-scripts=true` project-wide in `.npmrc` → conflict in the same
  directory. R9/A-4: required checks on direct pushes reject the push (the check
  cannot have run yet) — contradicts "agents push to main".
- **05** T6 evals 10 questions, fixture-only: fine. §3.2 fixtures: nflverse redistributed
  CC-BY OK; ffopportunity CC-BY-SA excerpt OK. A-1 in-memory transport unverified.
  Golden test needs ≥3 weeks of *every rostered player of every team* — 12 teams × 16
  players × 3 weeks ≈ 576 player-weeks ÷ 25/req ≈ 70 requests; fine.
- **06** 5 credentialed launchd jobs at Phase 1 + refresh jobs; `osascript` notifications.
  `snapshot fa-pool` 12 req nightly. Fine. `store backup` via `VACUUM INTO` — correct
  (contrast plan 03 §7's file copy).
- **07** C3: **34 read tools + 7 write + 2 later = 43 tools**; plan's own defence is
  Claude Code Tool Search deferral; Claude Desktop has no deferral → 34 schemas in every
  prompt (~100 tokens each per 06 §A.6 ≈ 3.4k+ tokens, likely far more with these
  schemas). E1 v1-trailing "floor/ceiling by simulation" from trailing Yahoo stat lines +
  position CVs = a dressed-up point estimate (brief dim 5). E13 retrospective P0 with
  `n < 30` refusal → with one league, one user, ~5 calls/week, n=30 arrives ~week 6+;
  Brier on p_win with ~14 H2H outcomes/season is noise. §5.1 claims 20k chars ≈ 5–7k
  tokens; JSON with long keys is ~3–3.5 chars/token → 6–7k, plus doubled by the text
  block → 12–14k tokens per worst-case result; Claude Code warns at 10k.
- **08** Solid. E6 "live mismatch blocks downstream analytics" — a single Yahoo stat
  correction (stat corrections happen Wed/Thu) would block every analytics tool until
  "explained"; no auto-clear path. U-6 DST PA definition. §3.2 nflverse column names A-1.
- **09** K3 `disallowed-tools`/`disable-model-invocation` — ignored by claude.ai/Desktop
  (plan admits). 13 Skills ≈ 13 × ~100 tokens listing per turn; trigger collisions
  (`weekly` vs `start-sit` vs `live` vs `stream-kdef`) checked only by phrase overlap.
  Lane 2 ≈ 100 model runs pre-release. `apply` P0 read-only "manual clicks" mode.
- **10** Phase 1 = L (4–8 weeks) for a season that is at week 4 of 18 on 2026-09-30;
  Phase 2 = L; Phase 3 = L → the product's *usable* analytics (usage-based waivers)
  land after the 2026 season ends. A16 usefulness check presumes Yahoo approval; no
  Phase-1 acceptance is defined for "application denied". A7 soft gate compares
  v1-trailing regret vs "last week's points" over 3 fixture weeks = ~36 decisions.

## Candidate objections (pre-triage)

Blocking candidates: gate-in-Claude-Code (02 §4.2/§8 #2); phasing vs calendar +
no denied-provisioning path (10); 43-tool surface without deferral in Desktop (07 C3).
Significant: node:sqlite experimental (01 D2/D4 + 03 §5 #1); server writes + sync API +
busy_timeout (01 D8/03 §1.1); WAL file-copy backup (03 §7); double-serialised output
(01 §4.2/07 §5.1); untrusted_text on names (01 §4.2/02 §6.2); ignore-scripts vs
mermaid-cli (04 R7/S10 — ci-bootstrap will hit it); SDK v2 transitive deps (02 §7);
v1-trailing distributions (07 E1); retrospective n (07 E13/10 A9); E6 mismatch block
(08); prepare readOnlyHint (01 §4.1). Marginal: verb `record` (T1), 01 §11 stale ref,
R9/A-4, doctor gaps, execPath/nvm.
