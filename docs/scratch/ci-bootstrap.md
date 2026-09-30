# ci-bootstrap — working notes

**Agent:** `ci-bootstrap` · **Brief:** `docs/scratch/briefs/ci-bootstrap.md` · **Started:** 2026-09-29
**Scope:** docs-only CI (plan 06 §4 step 1 / plan 04 §4.6): `docs.yml` (Mermaid + internal links), `secrets.yml` (gitleaks diff/weekly + custom Yahoo rules + self-test), `dependabot.yml`, PR template, dependency-free scripts. No product code, no `package.json`, nothing installed locally.

## RESUME HERE

**Status:** all files written and pushed (this commit); **watching the first CI runs** — iterate until `docs` (mermaid, links) and `secrets` (secrets, secrets-selftest) are green on `origin/main`, then `workflow_dispatch` the `secrets` workflow to run `secrets-history` and quote it. Then write the "For Chad" section and reply.

**Owned paths (mine):** `.github/workflows/docs.yml`, `.github/workflows/secrets.yml`, `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.gitleaks.toml`, `scripts/**` (`check-links.mjs`, `check-mermaid.mjs`, `puppeteer-config.json`, `install-gitleaks.sh`, `README.md`, `gitleaks-selftest/**`, `docs-check-selftest/**`), `docs/scratch/ci-bootstrap.md` (+ `.wip.patch`).
**Off-limits:** `docs/plan/**`, `docs/research/**`, `docs/HANDOFF.md`, `docs/scratch/roster.md`, `docs/scratch/program.md`, `docs/scratch/product-planner.md`, `docs/scratch/briefs/**`, `README.md`, `.gitignore`, `.env.example`.

**Order of work (tick as pushed):**
- [x] scripts: `check-links.mjs`, `check-mermaid.mjs`, `puppeteer-config.json`, `docs-check-selftest/` (negative fixtures: 3 broken links, 1 non-diagram block), `scripts/README.md`
- [x] `.github/workflows/docs.yml` (jobs `mermaid`, `links`; each self-tests first) — pushed, **runs not yet observed**
- [x] `.gitleaks.toml` + `scripts/gitleaks-selftest/` (must-flag / must-pass / expected-rule-ids / assert-report) + `scripts/install-gitleaks.sh` + `.github/workflows/secrets.yml` (jobs `secrets`, `secrets-selftest`, `secrets-history`) — pushed, **runs not yet observed**
- [x] `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- [ ] CI green on origin/main for both workflows (quote run URLs); dispatch `secrets-history`
- [ ] final: write the "For Chad" section below, reply with SHAs + run URLs

**Facts established (do not re-derive):**
- `.gitignore:47` `secrets.*` ignores `.github/workflows/secrets.yml` (`git check-ignore -v` confirms). Force-added once with `git add -f` on the explicit path; it is tracked from now on. Orchestrator: add `!.github/workflows/secrets.yml` under the secrets block of `.gitignore`.
- Mermaid blocks in tree at start: 6 (plan 01 x1, plan 02 x4, plan 03 x1); the product-planner docs have since added at least one more — the CI log has the count.
- Markdown links in the tree today: **zero** (docs cite with backticks and `[V-xx]` markers). The link check is therefore vacuous on the current tree — which is why `docs.yml` proves the checker can fail on `scripts/docs-check-selftest/` before every real run.
- Placeholder identifiers that must stay allowlisted: `461.l.1000…` family (plan 02:289, 04:108, 05:150, research 03:405), `461.l.100…` notation (plan 05:85), `nfl.p.7200` (research 04:201 — a player key; the league/team rules do not match it anyway).
- Pins: `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1` (full SHA, Dependabot-managed). gitleaks 8.30.1 linux_x64 sha256 `551f6fc8…470eb` (from the release checksums file). mermaid-cli **11.17.0** (npx, exact) — 12.0.0 shipped 2026-09-24 with breaking changes; A-D1 in scripts/README.md. No setup-node: the ubuntu-24.04 image ships Node 22.23.2 (asserted in-job). Chrome 153 is preinstalled but puppeteer downloads its own — the documented path; switch to `PUPPETEER_EXECUTABLE_PATH` only if the download ever flakes.
- gitleaks via the release binary, not `gitleaks/gitleaks-action` (v3.0.0): the action needs `GITHUB_TOKEN` API calls, cannot scan one directory (no self-test), and downloads a binary anyway.
- Plan 04 A-3 nit: `dj0yJmk9` is base64 of `v=2&i=`, not of `2&i=`. Orchestrator may correct plan 04 §4.3 / A-3.
- Plan 04 A-4 answered: GitHub docs (about-protected-branches, "Require status checks before merging") — commits reach the protected branch only after the checks passed on them, i.e. they must be pushed to another branch first. A required-status-check rule therefore REJECTS every fresh direct push. Hence the "For Chad" section recommends deletion + non-fast-forward + linear history now, and required checks only together with required PRs.
- Tree has files that are not mine (`docs/scratch/roster.md` modified, `docs/plan/09-*` untracked). Push protocol: `git fetch origin main`; if `origin/main` is an ancestor of HEAD then push; else `git pull --rebase --autostash origin main` **only if** `git diff --name-only HEAD origin/main` shares no path with the dirty set. Before every commit: `git diff --cached --name-only` must list only my paths.

## Log

- 2026-09-30 — all artefacts written; local proofs: check-links 0 broken on tree / 3 broken on fixture (exit 1); check-mermaid extracts 6+1 blocks on tree / 2 on fixture; YAML parses (ruby psych); node --check and bash -n clean. Pushed; first CI runs pending.

- 2026-09-29 — read brief, plan 04 §4/§5, plan 06 §1.1/§4, HANDOFF, `.gitignore`; inventoried Mermaid blocks and placeholder ids. Scratch doc pushed (this commit).

## For Chad — repository settings (to be completed at the end)

_(filled in the final commit: exact `gh` ruleset commands; settings I would have changed but did not.)_
