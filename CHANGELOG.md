# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: a breaking change to tool
names, tool schemas or the store format bumps the minor version — `docs/plan/04-repo-structure-and-ci.md` §4.4).

## [Unreleased]

### Added

- **Phase 1a (1a-full, the Yahoo-free half; `docs/plan/10-phasing-and-acceptance.md` §3.1a)** on
  `build/phase-1a`:
  - Store (`src/store`): `node:sqlite` with WAL, STRICT tables, forward-only migrations with a
    consistent pre-migration backup, all 14 repositories, per-source dataset files published by
    atomic rename and re-attached read-only, the busy-lock write classes.
  - Network and refresh (`src/http`, `src/sources/runner.ts`): one allow-listed HTTPS client
    (redirect/size/gzip/timeout guards), a rate limiter, the retrying refresh runner.
  - Sources: nflverse `schedules`, `injuries`, `roster_weekly`, `stats_player_week` (parquet,
    schema + codec assertion, team-defence weeks derived at load) and weather (Open-Meteo, NWS).
  - Scoring engine (`src/domain/scoring`, plan 08 in full over nflverse lines), the crosswalk
    (`src/domain/crosswalk`, overrides file), the league model and `ManualLeagueProvider`
    (hardened `league.yaml` parser), the analytics engines E1/E2/E3 `pre`/E5 K/DEF, the
    recommendation log and retrospective (`src/domain/reclog`).
  - The MCP surface: the 19 P0 tools under `FF_TOOLSET=core`, 7 resources, 3 prompts, the
    fixture-only `ff_debug_echo`; the `ff` CLI (`serve`, `status`, `doctor`, `refresh`,
    `print-config`, `install-launchd`, `uninstall`, `prune`, `backup`).
  - Skills `start-sit`, `stream-kdef`, `retro`, `onboard` (manual mode) with the shared
    references, `build-skills` / `check-skills`.
  - Integration: a golden test over every fixture nflverse player-week and team defence
    (`fixtures/golden/nflverse/`), the whole product end to end over real stdio against the
    built `dist/` (every tool, resource and prompt; hostile arguments; raw JSON-RPC frames), the
    Skills Lane 1 fixture dry run and the A9 week-N → N+1 chain, the A15 latency suite.
  - CI: `process` (ubuntu on every push; macOS weekly/on demand), `smoke` (the MCP Inspector CLI
    pinned to 2.8.0 plus `npm run smoke`), and the `docs` → `skills` job; package scripts
    `test:process`, `test:all`, `smoke`, `build:skills`, `check:skills`.
- `CONTRIBUTING.md`: the rules every change follows — security (no secrets, identifiers or
  machine-derived commit emails), the two commit paths, the one-checkout and heavy-job workflow,
  tests and docs with every change.
- `scripts/dev/a17-check.mjs`: the Claude Code half of plan 10 A17 run headlessly. It starts
  `claude -p` in a temp directory against the fixture-mode server (`tests/smoke/fixture-serve.mjs`,
  private temp home, config and cache), asks the model to repeat `ff_debug_echo`'s nonce, and
  decides from Claude Code's own transcript whether the tool result handed to the model holds
  `structuredContent`; it prints the line to record in `docs/HANDOFF.md` "Build facts". Zero
  dependencies; distinct exit codes (3 = not logged in); the CLI's process group is stopped
  (SIGTERM, then SIGKILL 3 s later) at the time limit, on Ctrl-C, SIGTERM or SIGHUP, and when the
  CLI exits; `--save` is opened (0600) before the run; `--no-session-persistence` keeps the
  session record out of `~/.claude/projects` (user-level Claude Code settings still apply). Run
  it as `scripts/dev/with-node.sh node scripts/dev/a17-check.mjs`; needs a build and
  `claude auth login`.
- Project scaffold (Phase 0 remainder, `docs/plan/10-phasing-and-acceptance.md` §3.0):
  - `.npmrc` — `save-exact`, `ignore-scripts`, `engine-strict`, `audit`, no funding noise; landed
    alone before `package.json` so the docs workflow could be shown green with it present (Z3).
  - `package.json` (private, ESM, `bin: ff`, Node `>=24.15`, `files` allow-list) with every
    version pinned exactly and a committed lockfile. Runtime dependencies:
    `@modelcontextprotocol/server` 2.2.0, `zod` 4.6.5, `hyparquet` 1.31.2, `yaml` 2.9.1 — a
    five-package runtime tree (`docs/plan/04-repo-structure-and-ci.md` §2). `fast-xml-parser` is
    deferred to Phase 1b and not installed.
  - Strict TypeScript (`tsconfig.json` type-checks src, tests and the CI scripts;
    `tsconfig.build.json` emits `src/` to `dist/`), `src/version.ts`.
  - ESLint flat config: type-checked strict + stylistic rules, the module-boundary table of
    `docs/plan/01-system-architecture.md` §1.1 enforced by a lexical rule and by
    `import-x/no-restricted-paths`, and bans on shell-string `exec`, `shell: true`, `eval`,
    `node:vm`, and console/stdout writes outside the CLI.
  - Prettier and EditorConfig; Markdown is left to authors.
  - Vitest with the coverage gate of `docs/plan/05-testing-strategy.md` §7 (90/85/90/90 global;
    100 % lines and branches for seven named modules), shared with the CI re-check.
  - Zero-dependency supply-chain checks in `scripts/ci/`: no install scripts or native builds in
    the runtime tree, runtime licenses on an allow-list, the full runtime tree equal to a
    committed allow-list (with registry provenance and integrity), the coverage re-check, and a
    scan of what `npm pack` would ship. Each one has a test proving it fails on bad input.
  - `ci.yml`: lint, typecheck, test (with coverage gate), supply-chain and pack jobs on every
    push and pull request, actions pinned by commit SHA, read-only permissions.
- The shared contract layer every module codes against (foundation stage, adversarially reviewed —
  46 issues, 44 applied): the `FantasyPlatform` seam and its types (`src/providers/platform.ts`,
  `src/domain/league/types.ts`), the `DataSource` contract publishing immutable per-source dataset
  files (`src/sources/source.ts`), scoring, analytics, reclog, crosswalk and store types, a
  deterministic `Clock`/seeded `Rng` (`src/domain/clock.ts`), the output envelope with
  untrusted-text wrapping and budgets (`src/mcp/envelope.ts`), the error-code table
  (`src/mcp/errors.ts`), input bounds and key grammars (`src/mcp/bounds.ts`), the configuration
  schema, safe paths and freshness table (`src/config/`), and a stderr-only redacting logger
  (`src/cli/log.ts`).
- Development guard-rails: a zero-dependency secret and personal-identifier scanner run by a
  pre-commit hook and by the commit helper (`scripts/dev/`); `src/domain` may not call
  `Math.random` or `Date.now` (seeded `Rng` and injected `Clock` only).

### Changed

- **QA round 2 behaviour changes** (`docs/qa/2026-10-06-qa-round2.md`):
  - `ff_analyze_lineup`: `rec.action` can read "make N lineup changes and hold M coin flips"; a
    `force_start` it cannot honour is `VALIDATION` with the reason `cannot_seat_together`, `on_ir` or
    `locked`; a league whose `scoring_type` is not head-to-head gets `objective: "mean"`, mode
    `neutral` and no P(win). `ff_analyze_matchup` answers `NOT_FOUND` for such a league.
  - `ff_get_status`: `sources[].freshness` gains `unreadable`, and `datasets_loaded` fails for it.
  - `ff_analyze_waivers`: betting lines omitted as stale (QA-1-004) now also stop a K/DEF stream over a
    starter who plays.
  - The `nflverse-daily` job runs every 6 h (04:30, 10:30, 16:30, 22:30); run `ff install-launchd`
    again to pick up the new calendar.
  - Commit guards: `.githooks/commit-msg` scans the commit message, and `scripts/dev/commit-paths.sh`
    refuses a message that fails the scan with exit 11; the `scan-secrets: allow` marker no longer
    hides a deny-listed name.
- **Public history rewritten (2026-10-06, the owner's decision; QA-1-095).** Every commit's author
  and committer is the GitHub no-reply address, the co-author trailers are gone, and the local
  working notes (`docs/scratch/`, `CLAUDE.md`) were removed from every commit: 312 commits became
  250. The commit ids cited in the docs and the gitleaks allow-list were remapped (`1446c7a`).
  **Old commit ids no longer resolve in a clone of the rewritten history** (GitHub may still serve
  pre-rewrite commits by URL until they are purged); a clone taken before 2026-10-06 must be
  re-cloned (or reset to `origin/main`). Details: `docs/qa/2026-09-30-phase1a-qa-pentest.md` § Open items.
- `main` is protected by a branch ruleset: no force-push, no deletion, linear history, no bypass
  actors (`docs/plan/04-repo-structure-and-ci.md` §5).
- The contributor guide (`CONTRIBUTING.md`) holds every repository rule; personal tool settings
  and working notes stay untracked and out of the repository.

### Fixed

- **QA round 2, re-verification and second sweep** (`docs/qa/2026-10-06-qa-round2.md`: 105 fixes
  re-checked, 22 reopened; 20 new findings, QA-2-026 to QA-2-045; each fix below has a regression
  test, mutation-checked; two items are deferred and one closed, as the register records):
  - `ff_analyze_lineup`: an `exclude`d starter now scores 0, as `status: O` does, so his replacement
    is advised instead of "keep the current lineup" (QA-2-038). One coin-flip swap no longer holds
    back a change that cannot lose points, such as filling an empty seat (QA-1-020, QA-1-040). A seat
    held by a starter the crosswalk cannot match is kept, never "filled" (QA-2-039). An unseatable
    `force_start` is refused instead of dropped (QA-1-010).
  - `ff_analyze_matchup`'s no-opponent hint names what is missing (QA-1-069).
  - Availability: a practice-only injury report no longer reads as "cleared to play", and look-ahead
    weeks carry the newest designation for up to two weeks, then report availability as unknown
    (QA-2-034, QA-1-021). Projections and the analytics tools use it; `ff_get_injuries` does not yet.
  - `ff_analyze_waivers`: a decision week without betting lines is named, and a K/DEF without its line
    is never streamed over a starter who plays (QA-2-044). The engine no longer freezes a position
    for a locked bench K/DEF (QA-2-033); the tool does not pass the roster slot to it yet.
  - Scoring: team-defence yards allowed added the opponent's sack yardage instead of subtracting it
    (QA-2-032; republish existing files with `ff refresh nflverse:stats --force`); a threshold bonus
    on an FG-distance or points-allowed bin was listed but never paid (QA-2-036); `league.yaml` can
    state missed-FG bins and yards-allowed brackets, and an unknown override key now says what is
    accepted (QA-2-045; a TE premium cannot be stated yet).
  - Retrospective: a past week's `followed` no longer flips after a later league-file edit, so it
    agrees with `ff_list_recommendations` (QA-2-040); regret compares like with like, and the Skills
    log alternatives it can score (QA-2-041); per-player metrics count the opponent's stored
    projections too (QA-2-042).
  - Freshness: injuries read stale about 60 h a week under their own job, and one failed run caused
    `STALE_ONLY` (QA-2-035); a `not_published` run did not end a failure streak (QA-1-037);
    `ff_get_status` called an unreadable dataset `fresh` (QA-1-038).
  - CLI and config: `ff uninstall --purge` deleted user directories under `<cache>/tmp`, and prune
    could remove a person's folder inside its own `tmp/` (QA-2-029); doctor row 8 passed a read-only
    `store.sqlite` and now names every read-only store path, which `--fix` repairs (QA-1-053); an
    absolute `FF_CONFIG_DIR` that is a file or cannot be entered was reported as a `config.json`
    error (QA-1-057, QA-1-096); a slot name in lower or mixed case got a non-actionable reason
    (QA-1-047); a mistyped `gsis_id` that lands on a same-team backup was trusted (QA-1-042); the
    log's pre-cut could pull most of a split secret into the kept text (QA-2-031).
  - Secret defences: commit messages were never scanned (QA-2-026); a deny-listed name split by a line
    wrap or written with unusual spacing passed (QA-2-027); the scanner skipped its own file
    (QA-2-030); UTF-16 text scanned "clean" (QA-1-089).
  - Skills: onboard's save commands now resolve `FF_CONFIG_DIR` as the server does, and catch every
    name the sync apps give their folders and a dotfiles repository whose `core.worktree` holds the
    folder (QA-1-072, QA-2-008, QA-1-044, QA-1-067); onboard no longer says the manual league cannot
    give transactions (QA-1-062); the tests behind QA-2-005, QA-2-007 and QA-2-025 now catch the
    variants that escaped them.
  - Docs: the README's FAQ says a TE premium cannot be stated in `league.yaml` yet, and its job list,
    plan 01 §5.2 and plan 06 §1.2 give the new `nflverse-daily` calendar; plan 07 E2, E3, E5, D2 and
    E13 record the rules above (plan changelog, implementation amendments).
- **QA round 2, deferred-items analysis** (`docs/qa/2026-10-06-qa-round2.md`; each fix has a
  regression test, mutation-checked):
  - A config, cache or league-file path in `~/Dropbox`, `~/Google Drive` or `~/OneDrive*` was
    refused with a message naming only Documents, Desktop, iCloud Drive and CloudStorage; the
    message now names every folder the guard refuses (QA-2-001).
  - The onboard Skill and its league-file guide said the server does not look for `~/Dropbox`;
    they now name every folder it refuses (QA-2-002).
  - The league-file guide said `ff doctor` names the rule fields a league file leaves out; it
    names `ff_get_league` (`rules.unverified_fields`), the tool that lists them (QA-2-003).
  - `ff_analyze_waivers`: `hold_vs_stream` gains `position` (additive), because with K and DEF in
    one call it can describe another position than `rec` (QA-2-004).
  - stream-kdef gave `marginal_value` p10/p90 as the range of the gain over the current starter;
    it now gives `marginal_value.mean` and takes the range from the verdict's
    `rec.delta_vs_next` (QA-2-005).
- **QA round 2, review of the round's own commits** (`docs/qa/2026-10-06-qa-round2.md`, QA-2-006 to
  QA-2-024; each code fix has a regression test, mutation-checked):
  - The onboard Skill and its guide said the server refuses "the synced folders in the home
    folder" and that the save commands catch every synced folder; both refuse only the named
    apps' folders (Nextcloud, Box Sync and the like are caught by neither), and the texts now say
    so (QA-2-008). The tests behind QA-2-002, QA-2-003 and QA-2-005 now also catch a folder named
    as not looked for, a surface named in a following sentence, and a sign error in
    `rec.delta_vs_next` (QA-2-006, QA-2-007, QA-2-009).
  - `scripts/dev/a17-check.mjs`: a completed run whose leftover child ignored SIGTERM was reported
    as a timeout; an unwritable `--save` path lost the verdict after the full run, and an existing
    file kept its mode; each run left a Claude Code session record behind; a result subtype error
    after the tool call gave an empty note (QA-2-014 to QA-2-016, QA-2-018). Its tests now cover
    SIGINT, SIGTERM and SIGHUP each, the SIGKILL step, and clean up after a failed run
    (QA-2-012, QA-2-013). `b1dcd85` made SIGTERM and SIGHUP interrupt like Ctrl-C.
  - Docs: plan 04 §5 said its whole "Now" column is applied, but Dependabot security updates and
    vulnerability alerts were off (QA-2-019; both enabled on 2026-10-06); plan 07 G3 and plan 01 §4.2
    now say "Build facts" (QA-2-017); plan 09 §3.4 no longer promises a per-candidate range
    (QA-2-011) and §4 says how `tool_contract` counts before the first release (QA-2-010); the
    README's `ff_analyze_lineup` row lists `comparisons[]?` and the nullable `swaps[].out`
    (QA-2-020); two code comments cited a pre-rewrite commit id (QA-2-021).
- The pre-commit hook now refuses to add an iCloud/Finder conflict copy (`ci 2.yml`,
  `src/cli 2/x.ts`) — previously only `scripts/dev/commit-paths.sh` did; deleting one is never
  blocked.
- **QA + penetration-test round 1** (`docs/qa/2026-09-30-phase1a-qa-pentest.md`): 80 confirmed defects fixed, each with a failing-first, mutation-checked regression test — among them lineup advice that missed an empty starting slot, players listed Out or on injured reserve projected active, a fresh random seed per call (identical requests gave different answers), `ff prune` following a symlinked cache directory, a >10 MiB frame crashing `serve`, the secret scanner missing non-ASCII and type-changed files, and machine-derived commit emails (commits now use the GitHub no-reply address). Dataset files are now `ds_schema` 2 (a fumble-return touchdown column): run `ff refresh all` after upgrading.
- `ManualLeagueProvider` scoring goes through the engine's `normalizeSettings`, so
  `negative_points: false` floors the player-week total (plan 08 §4.4 / P9) and `settings_hash`
  has one definition.
- A team-level nflverse row (no `player_id`) now credits its team defence (the 2026 week-2 BUF
  safety was lost); the games reader uses the venue's physical roof for open-air and fixed-roof
  venues (nflverse says `dome` for the MCG, Stade de France and Allianz Arena); a transient
  failure polling an nflverse `timestamp.txt` is retried instead of failing the refresh.
- `ff_project_players` meets A15 as written (a 16-player roster at 4,000 sims ≈ 0.3 s, was
  ≈ 0.8 s): projection samples are stored in a compact exact column form, and only a 1,000-sample
  prefix is kept (the store grew by ~25 MB per roster call); `scoreSamples` skips per-sample
  explanations and `denoise` no longer round-trips through a string (bit-identical results).
- `ff_record_recommendation` refuses a rec logged under a different week (or tool) than a source
  call this server session answered.
- A bare `ff refresh all` in fixture mode exits 0: fixture mode defaults to the seasons the fixture
  manifest records.
