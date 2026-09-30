# ci-bootstrap — working notes

**Agent:** `ci-bootstrap` · **Brief:** `docs/scratch/briefs/ci-bootstrap.md` · **Started:** 2026-09-29 · **Done:** 2026-09-30
**Scope:** docs-only CI (plan 06 §4 step 1 / plan 04 §4.6): `docs.yml` (Mermaid + internal links), `secrets.yml` (gitleaks diff/weekly + custom Yahoo rules + self-test), `dependabot.yml`, PR template, dependency-free scripts. No product code, no `package.json`, nothing installed locally.

## RESUME HERE

**Status: DONE — both workflows green on `origin/main`; nothing in flight.** If you are resuming: there is nothing to continue. Read "For Chad" below (repository settings that only Chad applies) and the "Handed to the orchestrator" list. To re-verify: `gh run list --branch main --limit 8`.

**Pushed SHAs (all on `origin/main`):** `8569a6c` scratch start · `3051246` docs workflow + checkers + self-test fixtures · `5711395` secrets workflow + `.gitleaks.toml` + self-test + dependabot + PR template · `0722918` scratch checkpoint · `044f57f` cancel-in-progress PR-only + verified A-D2 · (this commit) final notes.

**Green runs observed (quoted, not assumed):**
- `secrets` on `0722918`: https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/runs/36667555396 — success (jobs `secrets`, `secrets-selftest`)
- `docs` on `0722918`: run 36667555298 — **cancelled** by the workflow's own concurrency group when the orchestrator pushed `e95802d` seconds later (fixed in `044f57f`: cancellation is PR-only now)
- `docs` on `e95802d`: https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/runs/36667571841 — success (`mermaid`: 7/7 blocks rendered; `links`: 42 files, 0 broken; both self-tests failed as required)
- `secrets` on `e95802d`: run 36667571719 — success
- `secrets` **workflow_dispatch** on `main` (`ebe848d`; runs `secrets-history` = full history, all refs): https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/runs/36667735667 — success on all three jobs; `secrets-history`: `69 commits scanned`, `scanned ~994688 bytes`, `no leaks found`, `pinned gitleaks 8.30.1; latest release 8.30.1`
- `docs` on `044f57f`: https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/runs/36667742061 — success
- `secrets` on `044f57f`: https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/runs/36667742018 — success
- the final commit (this file) triggers one more pair of runs; the reply quotes them, and `gh run list --branch main --limit 6` shows them

**Owned paths (mine):** `.github/workflows/docs.yml`, `.github/workflows/secrets.yml`, `.github/dependabot.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.gitleaks.toml`, `scripts/**`, `docs/scratch/ci-bootstrap.md`.
**Off-limits (never touched):** `docs/plan/**`, `docs/research/**`, `docs/HANDOFF.md`, `docs/scratch/roster.md`, `docs/scratch/program.md`, `docs/scratch/product-planner.md`, `docs/scratch/briefs/**`, `README.md`, `.gitignore`, `.env.example`.

**Facts established (do not re-derive):**
- `.gitignore:47` `secrets.*` ignores `.github/workflows/secrets.yml` (`git check-ignore -v` confirms). Force-added once (`git add -f` on the explicit path) in `5711395`; tracked from now on. **Orchestrator: add `!.github/workflows/secrets.yml` under the secrets block of `.gitignore`** — otherwise the next person to delete-and-recreate the file loses it silently.
- Mermaid blocks in the tree: **7** in 4 files (plan 01 ×1, plan 02 ×4, plan 03 ×1, `docs/plan/08-scoring-engine.md` ×1). All 7 render with mermaid-cli 11.17.0; no doc needed a fix.
- Markdown links in the tree today: **zero** — the docs cite with backticks and `[V-xx]` markers, so the link check is vacuous on the current tree. That is exactly why `docs.yml` first proves each checker can fail on `scripts/docs-check-selftest/` (3 broken links / 1 non-diagram block) before trusting a pass.
- Placeholder identifiers that stay allowlisted (per rule, by regex, not by path): `461.l.1000` and `461.l.10000–10009` (+ `.t.<n>`); `461.l.100…` notation in plan 05:85 and `nfl.p.7200` (research 04) never matched the league/team rules to begin with. `must-pass.txt` pins all of them.
- gitleaks 8.30.1 `dir` reports **absolute** paths → the fixture path allowlist is unanchored (`scripts/gitleaks-selftest/`) and the self-test copies go to `$RUNNER_TEMP/selftest-*-copy/`. Verified by the green tree scan with fixtures in place plus 7/7 rules firing on the copy.
- Pins: `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1` (full SHA, Dependabot-managed). gitleaks 8.30.1 linux_x64 sha256 `551f6fc8…470eb` (release checksums file). mermaid-cli **11.17.0** via `npx --yes -p` (12.0.0 shipped 2026-09-24 with breaking changes; GitHub renders mermaid 11 — A-D1 in `scripts/README.md`). No `setup-node`: ubuntu-24.04 ships Node 22.23.2, asserted in-job. Puppeteer downloads its own Chrome (~20 s); switch to the preinstalled Chrome via `PUPPETEER_EXECUTABLE_PATH` only if that ever flakes.
- gitleaks via the release binary, not `gitleaks/gitleaks-action` (v3.0.0): the action needs `GITHUB_TOKEN` API calls, cannot scan one directory (so no self-test), and downloads a binary anyway. No license secret exists or is needed (personal account).
- Plan 04 A-3 nit: `dj0yJmk9` is base64 of `v=2&i=`, not of `2&i=`. Orchestrator may correct plan 04 §4.3 / A-3.
- Plan 04 A-4 answered — see "For Chad" §1.
- Deviation from plan 04 §4 ("`concurrency` cancels superseded runs"): cancellation is **PR-only**. A cancelled run on `main` is a commit without a verdict, which is the exact hole the `ci-vigilance` rule exists to close; the run on `0722918` demonstrated it. Header comments in both workflows say so.
- Check-run **names** GitHub records (= the `context` a ruleset needs): `mermaid`, `links`, `secrets`, `secrets-selftest`, `secrets-history` — the job names, not `docs / mermaid`. App id 15368 = GitHub Actions. Read from `gh api repos/…/commits/e95802d/check-runs`.

## Handed to the orchestrator (not mine to change)

1. `.gitignore`: add `!.github/workflows/secrets.yml` (see above).
2. Plan 04 §4.3 / A-3: `dj0yJmk9` = base64(`v=2&i=`).
3. Plan 04 §4.2 lists `docs / skills` and `docs-current` jobs — they arrive with `skills/` and `package.json`; `docs.yml` has a header note.
4. Plan 04 §5 A-4 is answered (below); the plan's "Now" column should drop required checks until PRs are required.
5. `docs/plan/04 §4` concurrency wording, if the PR-only cancellation is accepted.

## Log

- 2026-09-29 — read brief, plan 04 §4/§5, plan 06 §1.1/§4, HANDOFF, `.gitignore`; inventoried Mermaid blocks and placeholder ids. Scratch doc pushed (`8569a6c`).
- 2026-09-30 — all artefacts written; local proofs: check-links 0 broken on tree / 3 broken on fixture (exit 1); check-mermaid extracts 6+1 blocks on tree / 2 on fixture; YAML parses (ruby psych); node --check and bash -n clean. Pushed `3051246`, `5711395`, `0722918`.
- 2026-09-30 — `044f57f` runs green: docs 36667742061, secrets 36667742018. Final scratch commit follows.
- 2026-09-30 — first runs: `secrets` green first try on `0722918` (self-test: exit 99 on the must-flag copy, `leaks found: 13`, `assert-report: expected 7 rule ids, fired 7/7`; must-pass copy: `no leaks found`, exit 0, `0 findings, as required`; tree with fixtures in place: `no leaks found`; diff scan of `16db238..0722918`: `no leaks found`). `docs` on `0722918` cancelled by concurrency (orchestrator pushed `e95802d`); `docs` on `e95802d` green (`rendered 7/7, failed 0`; links `42 markdown files, 0 internal links checked, 0 broken`; self-tests `rendered 1/2, failed 1` exit 1 and `3 broken` exit 1). Pushed `044f57f` (PR-only cancellation, A-D2 verified). Dispatched `secrets.yml` for the full-history job: run 36667735667 green — `secrets-history` scanned 69 commits (all refs), no leaks; the newer-release notice correctly stayed silent (8.30.1 is latest).

## For Chad — repository settings (agents never touch these)

Read-only state on 2026-09-30 (`gh api`): **0 rulesets**; secret scanning **enabled**; **push protection already enabled** (plan 04 §5 asked for it — nothing to do); Actions `allowed_actions=all`; default workflow token permissions `read`; `can_approve_pull_request_reviews=false`.

### 1. Ruleset for `main` — now (docs phase)

Plan 04 §5 wanted required status checks on direct pushes and flagged it A-4. Answer, from GitHub's own docs ("About protected branches → Require status checks before merging"): a commit is accepted on the protected branch only after the required checks have passed **on that commit**, i.e. it must be pushed to another branch first. A required-checks rule would therefore reject every fresh direct push — which is how the agent program works today. So this ruleset has **no** required checks; the checks run post-push and a red `main` is the agents' `ci-vigilance` obligation (the fallback plan 04 §5 already names).

```bash
gh api -X POST repos/ChadPapineau/yahoo-fantasy-football-mcp/rulesets --input - <<'JSON'
{
  "name": "main: no force-push, no deletion, linear history",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" }
  ],
  "bypass_actors": []
}
JSON
# verify
gh api repos/ChadPapineau/yahoo-fantasy-football-mcp/rulesets --jq '.[] | "\(.id) \(.name) \(.enforcement)"'
```

- `bypass_actors: []` on purpose: nobody, admin included, can force-push `main` without first editing the ruleset — that is the protection. To keep an escape hatch instead: `"bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]` (5 = repository admin).
- `required_linear_history` is safe with today's flow (every agent pushes rebased commits; the PR template asks for squash/rebase).
- The API also accepts `"enforcement": "evaluate"` (dry run), which GitHub documents as an Enterprise feature; on this account use `active`, and if a legitimate push is ever rejected: `gh api -X PATCH repos/ChadPapineau/yahoo-fantasy-football-mcp/rulesets/<ID> -f enforcement=disabled`.

### 2. When product code lands — require PRs and the checks (plan 04 §5, right column)

Replace the ruleset (same `<ID>` from the verify command) with the PR flow. Before enabling: **remove the `paths:` filters from `docs.yml`** (a required check that does not run blocks the merge — the workflow header says so) and add the `ci.yml` job names when they exist.

```bash
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/rulesets/<ID> --input - <<'JSON'
{
  "name": "main: PRs with green checks, linear history",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
      } },
    { "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": true,
        "required_status_checks": [
          { "context": "mermaid",          "integration_id": 15368 },
          { "context": "links",            "integration_id": 15368 },
          { "context": "secrets",          "integration_id": 15368 },
          { "context": "secrets-selftest", "integration_id": 15368 }
        ]
      } }
  ],
  "bypass_actors": [ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]
}
JSON
```

- Contexts are the **job names** exactly as GitHub recorded them on `e95802d` (`gh api repos/…/commits/e95802d/check-runs`), not `docs / mermaid`. `integration_id` 15368 is the GitHub Actions app (from the same call); omit it to accept the check from any app.
- `required_approving_review_count: 0` = no required reviewers (solo maintainer); `required_review_thread_resolution` = conversation resolution; admin bypass = "Chad only" — all per plan 04 §5.
- `strict_required_status_checks_policy: true` = the PR branch must be up to date with `main` before merging.

### 3. Settings I would have changed, and did not (yours)

```bash
# a. Actions: only GitHub-owned actions may run (the workflows use actions/checkout and nothing else).
#    When ci.yml needs a third-party action, add its pattern to patterns_allowed (e.g. "codecov/*").
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/actions/permissions --input - <<'JSON'
{ "enabled": true, "allowed_actions": "selected" }
JSON
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/actions/permissions/selected-actions --input - <<'JSON'
{ "github_owned_allowed": true, "verified_allowed": false, "patterns_allowed": [] }
JSON

# b. Dependabot alerts + security updates (plan 04 §5 "security updates only"; version updates are
#    already driven by .github/dependabot.yml, weekly, grouped).
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/vulnerability-alerts
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/automated-security-fixes

# c. Fork PRs: require approval for every outside contributor before their workflow runs
#    (the workflows are read-only and secret-free, so this is belt and braces). Newer endpoint —
#    if it 404s, set it in Settings → Actions → General → "Fork pull request workflows".
gh api -X PUT repos/ChadPapineau/yahoo-fantasy-football-mcp/actions/permissions/fork-pr-contributor-approval --input - <<'JSON'
{ "approval_policy": "all_external_contributors" }
JSON
```

Already correct, verified, nothing to do: secret scanning + push protection **enabled**; workflow token default **read**; `can_approve_pull_request_reviews=false`.
