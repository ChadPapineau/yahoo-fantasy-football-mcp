# yahoo-api-specialist — working notes

Agent: yahoo-api-specialist. Brief: `docs/scratch/briefs/yahoo-api-specialist.md`
(ignored by git — see note below). Owned paths: this file,
`docs/research/03-yahoo-api.md`, `docs/scratch/yahoo-api-specialist.wip.patch`.

## RESUME HERE

**Status:** started 2026-09-29. Nothing researched yet.

**Done**
- Repo oriented: one commit on `main` (`487c88f`), tree clean, `origin/main` in sync.
- This scratch doc created and pushed (first action per brief).

**Not done**
- Sections A (auth), B (read surface), C (write surface), D (limits), E (gaps)
  of `docs/research/03-yahoo-api.md` — none written yet.

**Next concrete step**
- Fetch Yahoo's official docs: Fantasy Sports Guide
  (`https://developer.yahoo.com/fantasysports/guide/`) and OAuth 2.0 guide
  (`https://developer.yahoo.com/oauth2/guide/`). Write section A first, commit,
  push, then B.

**Blockers / findings for the orchestrator**
- `docs/scratch/` is **gitignored** (`.gitignore:83`, pattern `scratch/`). The
  brief says push this scratch doc but do not touch `.gitignore`. Resolution
  used: `git add -f docs/scratch/yahoo-api-specialist.md` (explicit path,
  force-add; `.gitignore` untouched). Consequence: `docs/scratch/program.md`,
  `docs/scratch/roster.md` (if any) and `docs/scratch/briefs/*` are NOT on
  `origin` — the orchestrator should decide whether the ignore rule or the
  push rule wins. The `.wip.patch` file will need `-f` too.

## Rules I am operating under (from the brief)
- No Yahoo app, no authenticated calls, no real league/team/user identifiers.
- Source URL per claim; verified / unverified marked explicitly.
- Stage explicit paths only; `git pull --rebase origin main` before every push;
  never force-push; confirm `HEAD == origin/main` after each push.
- Commit after each section lands. Stop taking scope at ~20% context.

## Source log
(appended as sources are read — URL, date fetched, what it established)
