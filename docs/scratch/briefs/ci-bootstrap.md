# Brief: ci-bootstrap

You build the **zero-token automation that can exist before the server
does** — the "Now (docs-only repo)" items of `docs/plan/06-automation-inventory.md`
§4 step 1, as specified in `docs/plan/04-repo-structure-and-ci.md`. The
product build has NOT been approved; you write **no product code**, no
`package.json`, no `src/`. Only CI workflows, scanner configuration, a
Dependabot config, a PR template, and dependency-free helper scripts.
Every workflow you add must be **green on `origin/main`** when you finish —
you prove that by pushing and reading the run results with `gh`, not by
assertion.

## Where you are

- Repo (on `main`, PUBLIC, docs-only): `/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football`
- **Read first:** `docs/plan/04-repo-structure-and-ci.md` (§ CI jobs, secret
  scanning, Mermaid validation, branch ruleset) and
  `docs/plan/06-automation-inventory.md` §1.1 + §4. Then `docs/HANDOFF.md`
  (rules) and `.gitignore`.
- Tools: `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash` (git, `gh`, node
  built-ins). `gh` is authenticated as the repo owner.
- Another agent (`product-planner`) is working in the same tree on
  `docs/plan/07-*`…`10-*` and `docs/scratch/product-planner.md`. Do not
  touch its files. Do `git pull --rebase` before every push.

## Hard rules

- **Install nothing on this machine.** No `npm install`, no global tools,
  no `npx` that downloads packages locally (mermaid-cli pulls Chromium).
  Validation tooling runs **in GitHub Actions only**; you iterate by
  pushing and reading `gh run list` / `gh run view <id> --log-failed`.
  Local checks are limited to Node built-ins (`node --check`, a script
  with zero dependencies).
- **Nothing secret, nothing personal** in any file. The repo slug
  (`ChadPapineau/yahoo-fantasy-football-mcp`) is fine; nothing else.
- **Do not create or change repository settings** (rulesets, branch
  protection, Actions permissions, secrets). Those are Chad's — write the
  exact `gh` commands into `docs/plan/04-*`? No: you do not own that file.
  Put them in your reply and in your scratch doc's final section.
- Pin every action to a **major tag or a full commit SHA** (say which and
  why); pin every `npx`-invoked package in CI to an exact version.
- Workflows must be **safe on a public repo**: `permissions: contents: read`
  by default; no secrets required; `pull_request` (not
  `pull_request_target`); no third-party action that needs a token beyond
  `GITHUB_TOKEN` read.

## What to build (you own exactly these paths)

1. `.github/workflows/docs.yml` — on push/PR touching `docs/**`,
   `README.md`, `*.md`: **Mermaid validation** of every ```mermaid block
   in the repo (render each block; fail with file + block index + error),
   and an **internal-link check** (every relative markdown link resolves to
   a file/anchor in the repo). Mermaid: use `@mermaid-js/mermaid-cli`
   pinned via `npx --yes <pkg>@<exact>` in the runner, or a pinned action —
   your choice, justified in the workflow header comment. Links: a
   dependency-free `scripts/check-links.mjs` (Node ≥ 22, ESM, no imports
   beyond `node:*`).
2. `.github/workflows/secrets.yml` — gitleaks on every push/PR (diff) and
   weekly full-history scan; `.gitleaks.toml` extending the default rules
   with **custom rules for Yahoo credentials and identifiers**: Yahoo app
   ids/consumer keys (they start with `dj0yJmk9`), OAuth tokens/refresh
   tokens in JSON, and **Yahoo league/team keys** of the form
   `<game>.l.<league>` / `<game>.l.<league>.t.<team>` — with an
   **allowlist** for Yahoo's own documentation placeholders already used
   in `docs/research/03-yahoo-api.md` and the plan (the `461.l.1000…`
   family, `nfl.p.7200`-style examples) so the current tree passes.
   Prove the rule fires: add a fixture under `scripts/gitleaks-selftest/`
   containing a fake-but-well-formed key, and a job step that runs
   gitleaks against that fixture expecting a non-zero exit (the self-test
   guards against a rule that silently matches nothing). Gitleaks is free
   for personal accounts; do not add a license secret.
3. `.github/dependabot.yml` — `github-actions` weekly; `npm` weekly
   (harmless until `package.json` exists), grouped minor/patch.
4. `.github/PULL_REQUEST_TEMPLATE.md` — the checklist from plan 04 (no
   secrets/identifiers, fixtures anonymised, explicit-path staging,
   Conventional Commit, roadmap/plan reference, docs updated).
5. `scripts/check-links.mjs` and `scripts/README.md` (what each script
   does, how CI calls it, zero-dependency rule).
6. `docs/scratch/ci-bootstrap.md` — working notes with `## RESUME HERE`,
   ending with the **exact `gh` commands Chad can run** for the branch
   ruleset plan 04 §5 recommends (no force-push, linear history, required
   checks `docs` + `secrets` — read the plan for the list), and any
   repository setting you would have changed but did not.

**Do NOT touch**: anything under `docs/plan/`, `docs/research/`,
`docs/HANDOFF.md`, `docs/scratch/roster.md`, `docs/scratch/program.md`,
`docs/scratch/briefs/`, `README.md`, `.gitignore`, `.env.example`. If a
Mermaid block in an existing doc fails validation, **do not edit that
doc** — report the file, block and error in your reply and scratch doc;
the orchestrator fixes plan/research docs. (Exception: if a doc the CI
must pass on has a *trivial* syntax error and the fix is unambiguous, you
may fix it in a separate commit whose message starts `docs(mermaid): fix`,
and list it in your reply.)

## Definition of done

- `gh run list --branch main --limit 10` shows `docs` and `secrets`
  workflows **green** on your final SHA, and you quote the run URLs.
- The gitleaks self-test step **fails on the fixture and passes on the
  tree** (quote the log lines).
- The link check found 0 broken internal links (or you listed the broken
  ones by file:line and did not paper over them).
- Every ```mermaid block in the repo rendered (quote the count).

## What a FAILED report looks like

- Workflows pushed but never observed running; "should be green".
- A gitleaks config with no self-test, or an allowlist so broad the rule
  cannot fire.
- Installing anything locally, or `npx` downloading packages on this Mac.
- Touching files you do not own.
- A reply without the pushed SHAs and run URLs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/ci-bootstrap.md` with a
  `## RESUME HERE` section — commit and push it before any real work, and
  keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** —
  after each workflow lands (a red workflow on `main` is acceptable
  *briefly* while you iterate — but never leave the session with a red
  workflow: fix it or remove it before you reply).
- **Before you are torn down, blocked, or run low on context, COMMIT AND PUSH
  FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/ci-bootstrap.wip.patch`
  (untracked files: `git diff --no-index /dev/null <file> >> …`), commit and
  push only that file. Refresh it every ~15 minutes of work. Retire it in
  your final commit.
- **Stage EXPLICIT PATHS ONLY.** Never `git add -A`, `git add -u`, or
  `git add <directory>`; never `git stash`; never `git checkout` a file with
  uncommitted work. Another agent shares this tree.
- `git pull --rebase origin main` before every push. Never force-push.
  After each push run `git fetch && git rev-parse HEAD origin/main` and
  confirm they match.
- Commit messages: conventional style, e.g.
  `ci: docs workflow — mermaid validation and internal link check`,
  ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Reply format

When done: (1) the pushed SHAs and the green run URLs, (2) the gitleaks
self-test evidence, (3) Mermaid blocks validated (count) and any that
failed with file/block/error, (4) the exact `gh` ruleset commands for
Chad, (5) anything you could not make green and why.
