# 00 — Tooling inventory (connectors, skills, agents available during this program)

Date: 2026-09-29. Purpose: Phase-0 item 3 — what is available to the
orchestrating session, which of it helps this project, and which Skills
this project should have of its own. Nothing here is a product dependency.

## Connectors / MCP servers reachable from the orchestrating session

| connector | relevant? | how it is used here |
|---|---|---|
| GitHub (`gh` CLI, authenticated, SSH keys) | **yes** | repo settings, description/topics, visibility checks, API reads |
| Web search / fetch | **yes** | all research; official docs first |
| Built-in browser | later | verifying the Yahoo developer console / OAuth redirect behaviour once an app exists |
| Scheduled tasks (cloud Claude routines) | later, cautiously | model-driven recurring briefings (Tuesday waiver report, Sunday inactives). **Not** for zero-token automation — that is scripts/launchd/cron |
| MCP registry search | checked | **no Yahoo, NFL, or sports connector exists** in the registry (searched `yahoo`, `fantasy`, `football`, `nfl`, `sports`) — confirms the gap this project fills |
| Sentry | maybe, later | error reporting for a local stdio server is optional; decided in the plan |
| PostHog | no | no analytics for a single-user local tool |
| Supabase, Cloudflare, Vercel, Adobe, Strava, Claude Docs, iOS simulator, computer-use | no | unrelated to this project |

## Skills available to the orchestrator that matter here

| skill | use |
|---|---|
| `anthropic-skills:mcp-builder` | MCP-server design guidance (tool naming, schemas, transport, errors). Loaded in the plan phase and by the skills researcher |
| `skill-creator` (plugin) | authoring standard for the Skills this server ships |
| `code-review`, `security-review`, `simplify` | gates during the build phase (post-approval) |
| `agent-brief`, `agent-roster`, `tree-hygiene`, `mutation-verify` | orchestration discipline (from Chad's SOTARA repo; applied here) |
| `schedule` / `loop` | recurring model-driven runs, if adopted |
| `dataviz` | any chart in docs or reports |

## Skills this project should ship with (proposed; finalized by `docs/research/06-*`)

Candidate list to be researched, not a decision:
weekly game-plan briefing · start/sit protocol · waiver/FAAB strategy ·
trade analysis · injury-cascade response · bye/playoff planning ·
K/DEF streaming · draft assistant · league-settings onboarding and
validation · post-week retrospective · news-vs-stats disagreement check ·
roster health audit.

## Agents used in this program

See `docs/scratch/roster.md`. All are `general-purpose` sub-agents with a
saved verbatim brief; none has write access outside its owned paths.
