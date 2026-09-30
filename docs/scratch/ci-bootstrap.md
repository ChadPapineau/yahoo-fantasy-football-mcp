# ci-bootstrap — working notes

**Agent:** `ci-bootstrap` · **Brief:** `docs/scratch/briefs/ci-bootstrap.md` · **Started:** 2026-09-29
**Scope:** docs-only CI (plan 06 §4 step 1 / plan 04 §4.6): `docs.yml` (Mermaid + internal links), `secrets.yml` (gitleaks diff/weekly + custom Yahoo rules + self-test), `dependabot.yml`, PR template, dependency-free scripts. No product code, no `package.json`, nothing installed locally.

## RESUME HERE

**Status:** started — nothing built yet. Next: write `scripts/check-links.mjs` and `scripts/check-mermaid.mjs`, run the link checker locally (zero deps), then `docs.yml`, push, read the run.

**Owned paths (mine):** `.github/workflows/docs.yml`, `.github/workflows/secrets.yml`, `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.gitleaks.toml`, `scripts/**` (`check-links.mjs`, `check-mermaid.mjs`, `README.md`, `gitleaks-selftest/**`), `docs/scratch/ci-bootstrap.md` (+ `.wip.patch`).
**Off-limits:** `docs/plan/**`, `docs/research/**`, `docs/HANDOFF.md`, `docs/scratch/roster.md`, `docs/scratch/program.md`, `docs/scratch/product-planner.md`, `docs/scratch/briefs/**`, `README.md`, `.gitignore`, `.env.example`.

**Order of work (tick as pushed):**
- [ ] scripts: `check-links.mjs`, `check-mermaid.mjs` (extract blocks → render each with pinned mermaid-cli in CI), `scripts/README.md`
- [ ] `.github/workflows/docs.yml` → push → `gh run list` → green
- [ ] `.gitleaks.toml` + `scripts/gitleaks-selftest/` fixture + `.github/workflows/secrets.yml` (diff scan, weekly full history, self-test) → push → green; `workflow_dispatch` the full-history scan and quote it
- [ ] `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] final: retire `.wip.patch`, write §"For Chad" below, reply with SHAs + run URLs

**Facts established (do not re-derive):**
- `.gitignore:47` `secrets.*` ignores `.github/workflows/secrets.yml` (`git check-ignore -v` confirms). I do not own `.gitignore`; the file is force-added once (`git add -f` on the explicit path) and stays tracked. Orchestrator: add `!.github/workflows/secrets.yml` under the secrets block of `.gitignore`.
- Mermaid blocks in tree: 6 (plan 01 ×1, plan 02 ×4, plan 03 ×1).
- Placeholder identifiers that must stay allowlisted: `461.l.1000…` family (plan 02:289, 04:108, 05:150, research 03:405), `461.l.100…` (plan 05:85), `nfl.p.7200` (research 04:201 — a player key, not matched by the league/team rules anyway).
- Tree has a dirty file that is not mine (`docs/scratch/roster.md`, orchestrator). Push protocol: `git fetch origin main`; if `origin/main` is an ancestor of HEAD → push; else `git pull --rebase --autostash origin main` **only if** `git diff --name-only HEAD origin/main` shares no path with the dirty set (never `git stash` by hand, never touch the dirty files).

## Log

- 2026-09-29 — read brief, plan 04 §4/§5, plan 06 §1.1/§4, HANDOFF, `.gitignore`; inventoried Mermaid blocks and placeholder ids. Scratch doc pushed (this commit).

## For Chad — repository settings (to be completed at the end)

_(filled in the final commit: exact `gh` ruleset commands; settings I would have changed but did not.)_
