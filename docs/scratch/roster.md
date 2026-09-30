# Agent roster — pre-build program

Program: `docs/scratch/program.md`. Briefs (verbatim, as sent):
`docs/scratch/briefs/<agent>.md`. Update this table on every agent event
(spawn, completion, cutoff) in the same commit as whatever that event produced.

Status vocabulary: ⚪ not started · 🟢 running · 🟠 cut off · ✅ done · ⛔ blocked

| agent | id | wave | status | owns | last SHA | resume pointer |
|---|---|---|---|---|---|---|
| repo-security-auditor | a57af5ca8474df500 | 1 | 🟢 running | `docs/research/01-repo-security-audit.md`, `docs/research/02-prior-art-lessons.md`, `docs/scratch/repo-security-auditor.md` | — | `docs/scratch/repo-security-auditor.md` §RESUME HERE |
| yahoo-api-specialist | a38988c557adbd317 | 1 | 🟢 running | `docs/research/03-yahoo-api.md`, `docs/scratch/yahoo-api-specialist.md` | — | `docs/scratch/yahoo-api-specialist.md` §RESUME HERE |
| data-source-evaluator | — | 2 | ⚪ not started | `docs/research/04-data-sources.md`, `docs/scratch/data-source-evaluator.md` | — | brief not yet written |
| fantasy-strategy-analyst | — | 2 | ⚪ not started | `docs/research/05-strategy-and-analytics.md`, `docs/scratch/fantasy-strategy-analyst.md` | — | brief not yet written |
| skills-mcp-researcher | — | 3 | ⚪ not started | `docs/research/06-skills-and-mcp-design.md`, `docs/scratch/skills-mcp-researcher.md` | — | brief not yet written |
| architecture-planner | — | 4 | ⚪ not started | `docs/plan/*` | — | brief not yet written |
| devils-advocate | — | 5 | ⚪ not started | `docs/plan/adversarial-log.md` | — | brief not yet written |
| docs-writer | — | 6 | ⚪ not started | `README.md`, `LICENSE`, `SECURITY.md`, `docs/README.md` | — | brief not yet written |

## Cutoff procedure

See the `agent-roster` skill: do not touch the tree; inventory `git status
--short` against the `owns` column; preserve each agent's WIP as
`docs/scratch/<agent>.wip.patch` (explicit paths, pushed); mark 🟠; resume the
same ID via `SendMessage` in wave order; respawn cold from the saved brief
only if the ID is gone.

## Event log

- 2026-09-29 — wave 1 spawned: `repo-security-auditor`, `yahoo-api-specialist`.
