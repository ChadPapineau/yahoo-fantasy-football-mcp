# architecture-planner-core — working notes

Agent: `architecture-planner-core` (brief: `docs/scratch/briefs/architecture-planner-core.md`).
Owns: `docs/plan/01-system-architecture.md` … `docs/plan/06-automation-inventory.md`, this file,
and (while in flight) `docs/scratch/architecture-planner-core.wip.patch`.
Must not touch: README, .gitignore, .env.example, docs/research/*, docs/HANDOFF.md,
docs/scratch/roster.md, docs/scratch/program.md, docs/scratch/briefs/*, docs/plan/07-* … 10-*.

## RESUME HERE

**Status:** READING DONE 2026-09-29 (all research docs, mcp-builder refs, MCP spec 2026-07-28 pages,
SDK README, npm registry). Verifying three last facts (SDK v2 legacy-client compat, `node:sqlite`
stability, client elicitation support), then writing plan files 01 → 06 in order.

**Next step:** write `docs/plan/01-system-architecture.md`; commit + push; then 02 … 06.
If resuming cold: the "Working notes" below hold every verified fact and every decision taken so
far — do not re-derive them.

**Plan-file status:**

| File | Status |
|---|---|
| `docs/plan/01-system-architecture.md` | not started |
| `docs/plan/02-security-architecture.md` | not started |
| `docs/plan/03-lifecycle-and-operations.md` | not started |
| `docs/plan/04-repo-structure-and-ci.md` | not started |
| `docs/plan/05-testing-strategy.md` | not started |
| `docs/plan/06-automation-inventory.md` | not started |

**Decisions taken so far (provisional until written into the plan files):**
- Transport: stdio only in v1; Streamable HTTP + remote install = clean negative (needs an OAuth AS
  + public https callback; single-user tool). Spec 2026-07-28 says stdio servers take credentials
  from the environment, not the authorization spec.
- OAuth default = `oob` (no listener, no port, no self-signed cert; the Yahoo callback must match
  the app registration so a port cannot float — which kills the "fallback port range" idea for the
  https path; the https-localhost path is optional/opt-in with a FIXED port).
- Store = SQLite via `node:sqlite` (no native addon → no postinstall; verify stability) in
  `~/.cache/<app>/`; tokens in `~/.config/<app>/` 0700/0600 atomic+lockfile; client secret via env
  or a separate 0600 file, never in the token file.
- Confirmation gate = `prepare_*`/`commit_*` with HMAC token bound to the diff + a precondition
  hash (compare-and-set at commit); human confirmation via elicitation where the client supports
  it; fallback = out-of-band one-time code (macOS notification) or CLI `confirm <id>`.
- SDK: decide v1 (1.31.0, spec ≤2025-11-25) vs v2 (2.2.0, spec 2026-07-28) after checking legacy
  client compatibility; exact pin either way.

**Open questions for the orchestrator:** none yet.

## Working notes

(appended as work proceeds)
