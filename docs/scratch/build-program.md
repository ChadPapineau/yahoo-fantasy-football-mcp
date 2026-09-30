# Build program — Phase 0 remainder + Phase 1a-full (branch `build/phase-1a`)

Owner decisions (2026-09-30, `docs/HANDOFF.md`): build approved; no Yahoo application →
Phase 1b deferred, X1 (`ManualLeagueProvider`) is the league source; 1a-full; personal use,
no purchases; rigorous secret hygiene. Spec: `docs/plan/10` §3.0 + §3.1a (acceptance Z1–Z3,
A1a, A3a, A4a, A5a, A6, A7–A10, A13–A15, A17).

Every stage runs as a Workflow (`Ultracode`); the orchestrator verifies each at source
(SHAs on origin, CI runs, the gate re-run) before starting the next.

| stage | workflow | what | exit |
|---|---|---|---|
| A | `ffmcp-foundation` | scaffold (exact pins, `.npmrc` first, tsconfig/eslint/prettier/vitest, `ci.yml`, supply-chain scripts) → shared contracts + foundational modules (errors, envelope, bounds, config, paths, logger) → two critics → revise → independent gate | gate green locally and in CI on the branch |
| B | `ffmcp-modules` | parallel modules by file ownership: store · sources (nflverse, weather, http) · scoring engine · crosswalk · league + `ManualLeagueProvider` · reclog · Skills content; then analytics (after scoring); then MCP surface + CLI/lifecycle; integration gate | full gate green; 19 P0 tools callable end to end in fixture mode |
| C | `ffmcp-qa-pentest` | QA + penetration-test finders (many lenses) → 3-way adversarial verification → remediation by owners → re-verification; loop until two dry rounds | no confirmed finding open |
| D | merge | final gate, docs (README status, CHANGELOG, HANDOFF), merge `build/phase-1a` → `main`, CI green on `main` | `main` green |

Agent rules: repo `CLAUDE.md`. Commits only via `scripts/dev/commit-paths.sh`; Node via
`scripts/dev/with-node.sh`; heavy jobs via `scripts/dev/heavy-lock.sh`.

## RESUME HERE

- Stage A DONE and verified (`fbcd8e8`, wrap-up `cd7fc75`); the build runs in
  `~/Developer/yahoo-fantasy-football-mcp` (outside iCloud).
- Stage B DONE and verified (`b69e439`) — workflow `ffmcp-modules`, run `wf_c928f9e4-827` (grounding → 8 parallel
  modules → analytics → MCP + CLI → integration → independent gate + fix loop). Resume in the same
  session with `Workflow({scriptPath: <session>/workflows/scripts/ffmcp-modules-wf_c928f9e4-827.js,
  resumeFromRunId: "wf_c928f9e4-827"})` (completed agents replay from cache). In a new session:
  read each module's commits on `origin/build/phase-1a` (`git log --format='%h %s'`), then re-run
  only the stages whose commits are missing.
- **Stage C RUNNING** — workflow `ffmcp-qa-pentest` (12 finder lenses → 2–3 adversarial verifiers each → remediation by area with regression tests → round gate → re-verification; loop until 2 dry rounds, max 4). Then Stage D (merge).
