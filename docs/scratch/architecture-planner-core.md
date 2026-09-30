# architecture-planner-core — working notes

Agent: `architecture-planner-core` (brief: `docs/scratch/briefs/architecture-planner-core.md`).
Owns: `docs/plan/01-system-architecture.md` … `docs/plan/06-automation-inventory.md`, this file,
and (while in flight) `docs/scratch/architecture-planner-core.wip.patch`.
Must not touch: README, .gitignore, .env.example, docs/research/*, docs/HANDOFF.md,
docs/scratch/roster.md, docs/scratch/program.md, docs/scratch/briefs/*, docs/plan/07-* … 10-*.

## RESUME HERE

**Status: COMPLETE 2026-09-29.** All six plan files written, committed and pushed to `origin/main`.
Nothing is in flight; no `.wip.patch` exists. If a later agent revises a plan file, start from the
pushed versions below — do not re-derive.

**Plan-file status:**

| File | Status | Commit |
|---|---|---|
| `docs/plan/01-system-architecture.md` | pushed | `c5bb839` |
| `docs/plan/02-security-architecture.md` | pushed (Mermaid `;` hardening in the final commit) | `9d8af24` |
| `docs/plan/03-lifecycle-and-operations.md` | pushed | `d137945` |
| `docs/plan/04-repo-structure-and-ci.md` | pushed | `dc10430` |
| `docs/plan/05-testing-strategy.md` | pushed | `f3fa827` |
| `docs/plan/06-automation-inventory.md` | pushed | final commit (see `git log`) |

**Findings for the orchestrator (things the brief did not anticipate):**

1. **The MCP spec moved under the brief.** The latest published revision is **2026-07-28** (stateless,
   no `initialize`; MRTR replaces server-initiated elicitation; Logging/Roots/Sampling deprecated;
   `ttlMs`/`cacheScope` mandatory on list results; Streamable HTTP lost sessions and the GET stream).
   The house reference `node_mcp_server.md` is written against SDK **v1** (`@modelcontextprotocol/sdk`);
   the TypeScript SDK **v2** (`@modelcontextprotocol/server` 2.2.0, published 2026-09-28, Node >=20,
   Zod 4) is "the stable release line" and its `serveStdio` serves both eras by default. Plan 01 D2
   pins v2 with v1 >=1.31.0 as the fallback. The product planner should use v2 API names
   (`registerTool` with `annotations`/`outputSchema`, `inputRequired(...)`, `acceptedContent(...)`).
2. **Claude Desktop cannot be relied on for elicitation today** (open issues: dropped / immediately
   cancelled), Claude Code can (form + URL on 2026-07-28 connections). The confirmation gate therefore
   has three human channels (elicitation → out-of-band code via macOS notification → `ff confirm`
   CLI); the fallback is load-bearing, not theoretical. Search-snippet evidence only — verify in the
   Desktop smoke.
3. **The https-localhost callback port cannot float** (the callback must match the Yahoo app
   registration), which kills the brief's "fallback port range" idea for that path and is the
   decisive reason `oob` is the default login. The listener stays as an opt-in with a fixed port and an
   exact conflict message.
4. **`node:sqlite`** ("Stability: 1.2 - Release candidate", unflagged since 22.13, sync-only) makes a
   zero-native-addon store possible and forces refreshes into a separate `ff refresh` process
   scheduled by launchd (plan 01 D8) — the MCP server never loads datasets.
5. **A prepare/commit token alone proves the model saw the diff, not that a human agreed** — the
   model can copy it. Plan 02 §4.2 says this plainly and builds the human channel separately.
6. Remote install from claude.ai is a **clean negative** (plan 01 §3.3).

**Open questions for Chad (mirrors of HANDOFF items, not new asks):** whether his other local MCP
servers use `~/.config` on macOS (plan 01 A-3); whether he prefers `oob` after trying it; branch
ruleset application (plan 04 §5); the Yahoo access application.

## Working notes

(appended as work proceeds)
