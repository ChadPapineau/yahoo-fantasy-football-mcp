# Scratch: skills-mcp-researcher

Working notes for the Skills + MCP-design research (brief:
`docs/scratch/briefs/skills-mcp-researcher.md`). Deliverable:
`docs/research/06-skills-and-mcp-design.md`.

## RESUME HERE

- **Status:** STARTED 2026-09-29. Scratch doc created; no research done yet.
- **Owned paths:** `docs/research/06-skills-and-mcp-design.md`,
  `docs/scratch/skills-mcp-researcher.md` (+ `.wip.patch` while in flight).
- **Do not touch:** README.md, .gitignore, .env.example, docs/research/00–05,
  docs/scratch/roster.md, docs/scratch/program.md, docs/scratch/briefs/.
- **Plan (sections of the deliverable):**
  - A. Mechanisms (tools/annotations/elicitation, resources, prompts, Skills,
    plugins, token economics) — with spec revision date + sources.
  - B. Split criteria, applied to every decision type in docs/research/05 §Output
    shapes and every capability in docs/research/03.
  - C. Prior art (fantasy-football Skills/plugins/prompt sets; 2–3 exemplary
    non-sports Skills). Static read only; never run scripts.
  - D. Candidate Skills catalog (purpose, triggers + non-triggers, tools in
    order, inputs, outputs, guardrails, evals, gaps).
  - E. Repo layout + lifecycle (versioning, install paths, evals in CI).
- **Next step:** load `anthropic-skills:mcp-builder`; read skill-creator
  SKILL.md + siblings; read docs/research/00, 02, 03, 05 (§19, §16, output
  shapes), 04 if present; then fetch the MCP spec (current revision) and
  Claude Code Skills/plugins docs. Write A first, push; then B; then C/D; then E.
- **Constraint to design around:** Yahoo API is read-only by default and write
  access is "not available at this time" — confirmation mechanism applies to a
  conditional write capability; every Skill must be fully useful read-only.

## Log

- 2026-09-29: created scratch doc (first action per the brief).
