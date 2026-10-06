# Contributing to yahoo-fantasy-football-mcp

Read [`docs/HANDOFF.md`](docs/HANDOFF.md) first (state, decisions, next step), then
[`docs/plan/00-index.md`](docs/plan/00-index.md) (the plan in reading order). The rules below bind
every change to this repository. The repository keeps no personal tool or editor configuration
files: local settings and working notes stay untracked, and nothing in them overrides this file.

## What this is

A local stdio MCP server (Node ≥ 24.15, TypeScript strict, `@modelcontextprotocol/server` v2)
that gives Claude format-aware fantasy-football analysis. **Read-only by design.** The owner has
no Yahoo API access, so the product runs on `ManualLeagueProvider` (league settings + roster from
`<config>/league.yaml`, outside the repo) plus nflverse data. The spec is `docs/plan/01–10`
(final, adversarially reviewed): cite the section you implement in a short file-header comment.

## Security — non-negotiable

- **Never commit, push, log or print** a credential, token, key, password, email address, or the
  owner's league/team names or ids. Fixtures use placeholders only (`461.l.1000…`,
  "Example League", "Team A").
- **Never read** `~/.config/fantasy-football-mcp/**` or any token store while developing: no
  script, test or debugging step opens them. Real league data lives outside the repo and is never
  copied into it.
- Commit only with `scripts/dev/commit-paths.sh "<message>" <paths…>` (secret + identifier scan,
  private index, pushes the branch) or a plain `git commit` (the `.githooks/pre-commit` scan runs;
  `git config core.hooksPath .githooks` once per clone). **Never** `--no-verify`.
- Commit metadata is published too: author and committer must be a GitHub no-reply address
  (`git config user.email '<id>+<login>@users.noreply.github.com'` once per clone). Both commit
  paths refuse any other address (`scan-secrets.mjs --identity`); never let git invent one from the
  machine's user and host names.
- Third-party code is untrusted: runtime dependencies are exactly those in `docs/plan/04` §2;
  `.npmrc` keeps `ignore-scripts=true`; every version is pinned exactly.
- Every third-party string in a tool result is wrapped or path-listed per plan 02 §6; nothing
  read from data is ever treated as an instruction.
- Report a security problem privately, as [`SECURITY.md`](SECURITY.md) describes — never in a
  public issue.

## Workflow

- **One checkout, outside iCloud.** The maintainer's is `~/Developer/yahoo-fantasy-football-mcp`;
  the earlier copy in `~/Documents/Repos/` was retired on 2026-10-05 because iCloud kept creating
  conflict copies ("name 2.ext") in it. Never clone into an iCloud-synced folder (`~/Documents`,
  `~/Desktop`); both commit paths refuse to add a conflict-copy name anyway.
- Node through `scripts/dev/with-node.sh <cmd>` (Node from `.nvmrc` via fnm; the machine's global
  default is left alone). Heavy jobs (`npm ci`/`install`, full test/coverage, `build`, process
  tests) through `scripts/dev/heavy-lock.sh scripts/dev/with-node.sh <cmd>` — one at a time.
- Build work happens on a `build/*` branch; it merges to `main` only when the full gate is green.
  Never force-push. Never commit on `main` during a build.
- Other changes may be in progress in the same checkout: keep to the paths your change touches;
  stage explicit paths only — never `git add -A`, `-u` or a directory — and never `git stash`,
  `git checkout <file>`, `git reset --hard`, or edit/format files outside your change.
- Conventional Commits (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`).
- Everything ships with tests (vitest; fast-check where the plan names properties), adversarial
  by default. Coverage gate: plan 05 §7, never lowered to pass a build. Run your module's tests
  and `tsc --noEmit` before every commit.
- After every push, check CI: `gh run list --branch <branch> --limit 5`.
- Docs move with the code: the plan or research doc a change touches, `CHANGELOG.md`, and
  `docs/HANDOFF.md` when a phase lands or the status changes.

The CI jobs that gate a pull request are listed in the README's
[Contributing](README.md#contributing) section.
