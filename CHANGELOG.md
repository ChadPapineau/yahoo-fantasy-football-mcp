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

### Fixed

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
- The shared contract layer every module codes against (Stage A, adversarially critiqued — 46
  issues, 44 applied): the `FantasyPlatform` seam and its types (`src/providers/platform.ts`,
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
