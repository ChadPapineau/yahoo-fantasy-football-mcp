# Agent roster — pre-build program

Program: `docs/scratch/program.md`. Briefs (verbatim, as sent):
`docs/scratch/briefs/<agent>.md`. Update this table on every agent event
(spawn, completion, cutoff) in the same commit as whatever that event produced.

Status vocabulary: ⚪ not started · 🟢 running · 🟠 cut off · ✅ done · ⛔ blocked

| agent | id | wave | status | owns | last SHA | resume pointer |
|---|---|---|---|---|---|---|
| repo-security-auditor | a57af5ca8474df500 | 1 | ✅ done (SHAs verified on origin; leak claims spot-checked in clones) | `docs/research/01-repo-security-audit.md`, `docs/research/02-prior-art-lessons.md`, `docs/scratch/repo-security-auditor.md` | `fb69384` | — |
| yahoo-api-specialist | a38988c557adbd317 | 1 | ✅ done (SHAs verified; read-only/write-unavailable claim verified on sports.yahoo.com/developer/access) | `docs/research/03-yahoo-api.md`, `docs/scratch/yahoo-api-specialist.md` | `473a6d9` | — |
| data-source-evaluator | a3b161a00df32916a | 2 | ✅ done (SHAs verified; nflverse 2026 freshness + Sleeper keyless spot-checked live) | `docs/research/04-data-sources.md`, `docs/scratch/data-source-evaluator.md` | `7dad267` | — |
| fantasy-strategy-analyst | a370e42955935355b | 2 | ✅ done (SHAs verified; Questionable-tag 71% claim spot-checked at source) | `docs/research/05-strategy-and-analytics.md`, `docs/scratch/fantasy-strategy-analyst.md` | `d9bd716` | — |
| skills-mcp-researcher | a5edf2189cef8e218 | 3 | ✅ done (SHAs verified; spec rev 2026-07-28 confirmed at source; claude-code#41110 is closed `completed` with no visible out-of-scope statement → Desktop elicitation = unverified, design falls back automatically) | `docs/research/06-skills-and-mcp-design.md`, `docs/scratch/skills-mcp-researcher.md` | `5b30fba` | — |
| architecture-planner-core | a45fab2bbf0065893 | 3 | ✅ done (SHAs verified; SDK v2 2.2.0 = npm `latest` and `node:sqlite` on Node 22.23 checked live — the latter still prints ExperimentalWarning) | `docs/plan/01-*` … `06-*`, `docs/scratch/architecture-planner-core.md` | `c5ea355` | — |
| product-planner | a47f1502e3ab64907 | 4 | ✅ done (SHAs verified; identifier scan clean; 13 tensions + 10 open decisions in plan 10 §4–§5) | `docs/plan/07-*` … `10-*`, `docs/scratch/product-planner.md` | `b830114` | — |
| ci-bootstrap | afe971bb2e5796cc9 | 4 | ✅ done (orchestrator verified: `docs` + `secrets` green on `f3a0a48`; full-history scan green; 20 files tracked) | `.github/**`, `.gitleaks.toml`, `scripts/**`, `docs/scratch/ci-bootstrap.md` | `f3a0a48` | — |
| devils-advocate | a2ed55e691cda6d2a | 5 | 🟢 running (round 2, resumed via SendMessage on `8c39191`) | `docs/plan/adversarial-log.md`, `docs/scratch/devils-advocate.md` | `dfde1b6` | `docs/scratch/devils-advocate.md` §RESUME HERE; resume the same ID for round 3+ |
| plan-reviser | a4ae16bdc0e7b6482 | 5 | ✅ done (orchestrator verified: 16 group SHAs on origin, CI green on `8c39191`, three spot-checks passed, identifiers clean) | `docs/plan/01-*`…`10-*`, `docs/plan/changelog.md`, `.github/workflows/docs.yml` (OBJ-12 only), `docs/scratch/plan-reviser.md` | `8c39191` | resume the same ID via SendMessage for round-2 revisions |
| docs-writer | — | 6 | ⚪ not started | `README.md`, `LICENSE`, `SECURITY.md`, `docs/README.md`, `docs/plan/00-index.md`, `docs/scratch/docs-writer.md` | — | brief: `docs/scratch/briefs/docs-writer.md` |

## Cutoff procedure

See the `agent-roster` skill: do not touch the tree; inventory `git status
--short` against the `owns` column; preserve each agent's WIP as
`docs/scratch/<agent>.wip.patch` (explicit paths, pushed); mark 🟠; resume the
same ID via `SendMessage` in wave order; respawn cold from the saved brief
only if the ID is gone.

## Event log

- 2026-09-29 — wave 1 spawned: `repo-security-auditor`, `yahoo-api-specialist`.
- 2026-09-29 — `yahoo-api-specialist` ✅ (`276c3ae`…`473a6d9`). Orchestrator
  verified on the live portal: "read access only", "write access is not
  available at this time".
- 2026-09-29 — `repo-security-auditor` ✅ (`2385f43`, `fb69384`), 21 repos.
  Orchestrator spot-checked both credential-leak claims in the scratch clones
  (file names only): confirmed.
- 2026-09-29 — wave 2 spawned: `data-source-evaluator`, `fantasy-strategy-analyst`.
- 2026-09-29 — `fantasy-strategy-analyst` ✅ (`c0763f9`…`d9bd716`), 1,394 lines.
  Orchestrator spot-checked the Questionable-tag base rate at its source
  (Footballguys Injury Index): 71 % played, Doubtful 5.9 % — confirmed.
- 2026-09-29 — wave 3 (first slot) spawned: `skills-mcp-researcher`.
  `architecture-planner-core` waits for `04-data-sources.md`.
- 2026-09-29 — `data-source-evaluator` ✅ (`4ce2b5b`…`7dad267`). Orchestrator
  spot-checked live: nflverse `stats_player_week_2026.csv` last-modified
  2026-09-29 15:45 GMT (timestamp.txt 11:46 EDT); Sleeper trending endpoint
  HTTP 200 with no key.
- 2026-09-29 — wave 3 (second slot) spawned: `architecture-planner-core`.
- 2026-09-29 — `skills-mcp-researcher` ✅ (`b6f7fdc`…`5b30fba`), 567 lines,
  14-Skill catalog. Orchestrator verified the MCP spec revision
  (2026-07-28) at source; the cited Desktop-elicitation issue is closed
  `completed` with no statement → recorded as unverified in HANDOFF.
  Research phase complete: 01–06 all verified. `product-planner` waits for
  the core plan (`docs/plan/01-*`…`06-*`).
- 2026-09-29 — `architecture-planner-core` ✅ (`c5bb839`…`c5ea355`), six
  plan files, 1,693 lines. Orchestrator verified SDK v2 2.2.0 on the npm
  registry and `node:sqlite` on local Node 22.23 (loads; ExperimentalWarning
  still printed — flagged for the adversarial round).
- 2026-09-29 — wave 4 spawned: `product-planner` (sole agent in the tree).
- 2026-09-29 — wave 4 (second slot) spawned: `ci-bootstrap` — the
  "Now (docs-only repo)" items of plan 06 §4 step 1 (Mermaid + link CI,
  gitleaks with Yahoo rules + self-test, Dependabot, PR template). Owns
  `.github/**`, `.gitleaks.toml`, `scripts/**` only; no product code.
- 2026-09-30 — `product-planner` ✅ (`d10835c`…`b830114`), four plan files,
  1,242 lines; 34 read tools (19 P0), 7 conditional writes, 13 Skills ship.
  Plan phase complete (10 files, 2,935 lines).
- 2026-09-30 — wave 5 spawned: `devils-advocate` round 1 (reads only;
  writes `docs/plan/adversarial-log.md`). Orchestrator defends in the same
  file under `## Round N — defence` and edits the plan for conceded points.
- 2026-09-30 — `ci-bootstrap` ✅ (`3051246`…`f3a0a48`): `docs.yml` (Mermaid
  7/7 rendered via mermaid-cli 11.17.0; internal links; self-tests that
  prove both checks can fail) and `secrets.yml` (gitleaks 8.30.1 pinned by
  sha256, 7 custom Yahoo rules, self-test 7/7 fired on the must-flag copy,
  0 on the tree; weekly full-history scan: 69 commits, no leaks), Dependabot,
  PR template. Orchestrator verified every run green on `main`. Handed
  back: `.gitignore` `secrets.*` swallowed `secrets.yml` (fixed by the
  orchestrator); Chad's ruleset `gh` command is in
  `docs/scratch/ci-bootstrap.md` § "For Chad".
- 2026-09-30 — `devils-advocate` round 1 delivered (`52337a3`): 23
  objections (2 blocking: the "unforgeable gate" claim in Claude Code; no
  dated gate/fallback on Yahoo approval). Orchestrator verified two open
  facts at source (nflverse parquet = snappy; fast-xml-parser
  `processEntities: true` default — plan A-9 inverted) and pushed the
  defence (`f2abb64`): 21 concede/concede-modified, 1 justified with
  evidence (OBJ-20), all 13 tensions accepted.
- 2026-09-30 — wave 5 (second slot) spawned: `plan-reviser` — applies the
  rulings across plan 01–10 + `docs.yml` (OBJ-12) and starts
  `docs/plan/changelog.md`. Advocate resumes for round 2 when it lands.
- 2026-09-30 — `plan-reviser` ✅ (`59d0d99`…`8c39191`, 16 commits, one per
  ruling group + consistency pass + changelog). Nothing it could not
  apply; its forced choices are listed in its reply and scratch doc.
  Orchestrator verified SHAs, CI (docs + secrets green on `8c39191`, incl.
  the edited `docs.yml`), identifiers, and three spot-checks (1a/1b split
  in plan 10 §1 and §3; client-qualified "cannot"s in plan 02; no stale
  `live`-Skill references).
- 2026-09-30 — `devils-advocate` resumed for **round 2** on `8c39191`.
