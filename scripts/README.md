# scripts/

Zero-token, zero-dependency tooling (plan 04 §1, plan 06). Everything here runs with **Node ≥ 22
built-ins only** (`node:*` imports, no `package.json`, nothing to install) or plain bash. The one
tool that needs third-party code — the Mermaid renderer — is fetched **only inside GitHub Actions**;
no script here installs anything on a developer machine.

| Script | What it does | Who runs it |
|---|---|---|
| `check-links.mjs` | Every relative / repo-root-absolute link in every `*.md` must resolve to an existing file or directory; `#fragments` must match a heading (GitHub slug rules) or an HTML anchor. External links are ignored on purpose. | `.github/workflows/docs.yml` → job `links`; locally: `node scripts/check-links.mjs [--verbose]` |
| `check-mermaid.mjs` | Extracts every ```` ```mermaid ```` block into `<out>/<file>--<n>.mmd`; with `--renderer` it renders each one and fails with file, block index, line and the renderer's error. Also fails if the renderer writes no SVG or mermaid's error diagram. | `docs.yml` → job `mermaid` with `--renderer "npx --yes -p @mermaid-js/mermaid-cli@<exact> mmdc -q --puppeteerConfigFile scripts/puppeteer-config.json"`; locally: `node scripts/check-mermaid.mjs` (extract + list only) |
| `puppeteer-config.json` | `--no-sandbox` for the Chromium that mermaid-cli launches on Ubuntu 24.04 runners. | `docs.yml` |
| `docs-check-selftest/` | Deliberately broken links and a non-diagram Mermaid block; each `docs.yml` job first runs its checker here (`--root`) and asserts the exact failing verdict. The empty marker `.docs-check-skip` keeps the directory out of the real run. See its README. | `docs.yml` (both jobs, first step after setup) |
| `install-gitleaks.sh` | Downloads the pinned gitleaks release (exact version **and** sha256 from the release's checksums file) into a temp dir on the runner. Refuses to run outside Linux x86_64. | `.github/workflows/secrets.yml` (all three jobs) |
| `gitleaks-selftest/` | Fixtures + assertion script proving the custom rules in `.gitleaks.toml` fire and the allowlists are no wider than the documentation placeholders. See its README. | `secrets.yml` → job `secrets-selftest` |

Both checkers take `--no-annotate` (no `::error` annotations, no step summary) — the self-test steps
use it so an *expected* failure does not show up as a red annotation on the run.

## Rules

1. **Zero dependencies.** A script may import `node:*` and nothing else. If a check needs a package,
   the package is pinned to an exact version and invoked with `npx --yes -p <pkg>@<exact>` **in the
   workflow**, never from the script, and never on a developer machine.
2. **Every check must be able to fail, and proves it on every run.** `docs.yml` runs each checker on
   `docs-check-selftest/` and asserts the failing verdict before trusting the tree's pass;
   `secrets.yml` does the same with `gitleaks-selftest/`. Do not add a check without its negative case.
3. **Pins are explicit and bumped deliberately.** Dependabot manages action SHAs only. The npx pin
   (`MERMAID_CLI` in `docs.yml`) and the gitleaks pin (`install-gitleaks.sh`, version + checksum) are
   bumped by hand; the weekly `secrets-history` job prints a notice when gitleaks has a newer release.
4. **Nothing secret, nothing personal** — including in fixtures. `gitleaks-selftest/README.md` shows
   how every fake value is derived.

## Assumptions

| # | Assumption | Verify by |
|---|---|---|
| A-D1 | GitHub renders Mermaid with the 11.x line, so mermaid-cli 11.17.0 (mermaid 11) is the closest reference; 12.0.0 (2026-09-24) changed themes/layouts. | Compare a diagram GitHub renders against the CI verdict when a difference appears; bump `MERMAID_CLI` when GitHub moves to 12. |
| A-D2 | **Verified 2026-09-30 (gitleaks 8.30.1):** `gitleaks dir` reports *absolute* paths (`/home/runner/work/…/scripts/gitleaks-selftest/must-flag.txt`), so the path allowlist in `.gitleaks.toml` is deliberately **unanchored** (`scripts/gitleaks-selftest/`, no `^`) and the self-test copies live under `$RUNNER_TEMP/selftest-*-copy/`, a path the allowlist cannot match. | The self-test asserts both directions on every push; a change in gitleaks' path reporting turns it red. |
