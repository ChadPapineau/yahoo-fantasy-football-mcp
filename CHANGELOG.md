# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: a breaking change to tool
names, tool schemas or the store format bumps the minor version — `docs/plan/04-repo-structure-and-ci.md` §4.4).

## [Unreleased]

### Added

- **Season-agnostic, schedule-driven, fresh at answer time** (`build/season-fresh`, 2026-10-14):
  - The season model: the season in progress, its phase (preseason, regular season, postseason,
    off-season) and week, its regular and postseason weeks and its game days come from the loaded
    NFL schedule (`src/domain/league/season.ts`, `src/config/game-calendar.ts`); a calendar rule is
    used only to bootstrap before a schedule first loads. Kickoff-relative windows, the same in every
    time zone; a fallback calendar treats every instant as game time when no usable schedule exists.
  - `ff refresh due`, the one scheduled tick (launchd `refresh-due`, minutes 0/15/30/45 and at load):
    it decides per source from the schedule what is due — schedules every 15 min from 3 h before a
    kickoff, hourly whenever a kickoff is within 7 days, 6 h off-season; injuries, stats, rosters and
    weather on their own phase cadence — with repair first, a 14-minute floor across processes,
    failure backoff 15/30/60 min, a TTL guard and `--dry-run` explanations; a `job_run` heartbeat.
  - Answer-time refresh: before a tool answers, `serve` revalidates the sources it reads through a
    bounded, single-flight `ff refresh --on-demand` child (6 s for fast sources, 15 s to repair a
    required one; ≤ 3 children, ≤ 20 an hour; fixed argv, an environment allow-list, no credentials,
    no shell); the server process itself still makes no network call. `meta.refresh` reports each
    source's outcome, with fixed warnings; `FF_ON_DEMAND_REFRESH` (`wait` default, `background`,
    `off`; `off` in fixture mode). New child flags: several targets, `--on-demand`, `--no-migrate`,
    `--expect-version`, a `--json` result shape.
  - Kickoff-change detection: every schedules publish is diffed (kickoff, date, venue, added,
    removed, week moves) into the `schedule_change` table, with one collapsed `--notify`
    notification; G1 `schedule.recent_changes`, warnings in the roster, league, schedule,
    projection, lineup, matchup and waiver tools, E13/E14 `lock_status` on logged recommendations,
    and E12's warning when a cited analysis predates a change.
  - Tentative kickoffs: Week-18 placeholder weeks, NFL flex windows (`src/config/flex-rules.ts`,
    advisory) and TBD times — D3 `kickoff_tentative`, `tentative_reason`, `flex_deadline`, G1
    `schedule.tentative_weeks`, warnings with the re-check time.
  - G1 and `ff status`: `season` and `schedule` blocks built by the same functions; `sources[]`
    `not_published`, `next_check_at`, `backoff_until`; `jobs[]` from heartbeats; seven new checks.
    `ff doctor` row 23 (the league file's season, reference tables past their vintage, the week
    bound).
  - Store migration 003 (`schedule_change`, `job_run`, `season_check`, `provider_backoff`), the
    `refresh:<source>` run lock taken before the first request, a persisted provider pause on
    429 / Retry-After (`rate_limited`), `season_check` rows for a season upstream has not published.
  - A reference-vintage registry (`src/config/reference-vintage.ts`) for the venue table, the flex
    rules and the analytics base rates; publish warnings for a game roof that disagrees with the
    venue table past its vintage and for a neutral-site game resolved to its home team's stadium.
  - Skills: orient reads the season and schedule blocks, never asks for `ff refresh` for a season
    not published upstream, explains `meta.refresh` and allows one re-ask after `in_progress`; a
    moved kickoff comes first with the new lock time and tentative weeks carry their re-check time;
    start-sit and stream-kdef re-run in the final 90 minutes before the earliest lock; retro marks
    calls made under a moved lock; onboard's new-season step keeps last season's file as
    `league-<season>.yaml` and names no fixed season; new evals SS-8–SS-10, KD-4, RT-4, ON-M6.
  - Tests: season-model and zone-invariance properties over synthetic 18/19/20-week seasons
    2026–2030 in all 39 UTC offsets, the cadence replay of a healthy tick, the politeness property,
    answer-time fault rows with real children, a year in the life of an install 2027–2030, the
    no-network-in-server spy, `tests/lint/season-agnostic.test.ts`.
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

- **launchd jobs** (season-fresh build): `refresh-due` (`RunAtLoad` true), `store-prune` and
  `store-backup` replace the per-source jobs; the retired labels `nflverse-schedules`,
  `nflverse-daily`, `nflverse-stats` and `weather` are booted out and removed by
  `ff install-launchd` and by `ff uninstall`, and `ff doctor` row 11 warns on a retired or
  out-of-date plist and a missing tick heartbeat. **Upgrade step, once: `ff install-launchd`.**
  Until then the old plists keep working. Off macOS, schedule `ff refresh due` every 15 min.
- **TTL rule:** schedules and lines are judged by kickoff windows from the schedule — 30 min inside
  `[kickoff − 24 h, kickoff + 4 h)`, otherwise until the next window opens (≤ 6.5 h); the weekday
  set `GAME_DAYS` is deleted; expiry never depends on the calendar.
- **Refresh seasons** follow the phase season: schedules always last, this and next season (the next
  season loads from its May release); stats this and last; injuries this; weekly rosters by phase.
  A new season's empty file is `not_published`, not a schema failure.
- Coverage-aware gating: a finished season's data no longer expires; a season upstream has not
  published is a named assumption (optional source) or `STALE_ONLY` `season_not_published`
  (required source), never an outage; `STALE_ONLY` gains the `refresh_in_progress` and
  `refresh_failed` variants.
- Week bounds come from each season's schedule (a structural bound of 30 in the data layer); the
  tool-input bound stays 22 under tool contract 1, flagged by doctor row 23 and G1 when a schedule
  passes it. A league file without `end_week` ends one week before its season's last regular week
  (the named fallback, week 17, only while that season's schedule is not loaded, with a warning).
- Analytics no longer assume an 18- or 22-week season: input freshness is judged under the game
  calendar (`collectInputs(stamps, clock, cal)`); the trailing window's prior-season games are that
  season's own regular weeks (never a postseason week), with the assumption "the <S−1> schedule is
  not loaded: the trailing window holds <S> games only" when it is missing; a week without a game
  reads "bye" only in a regular-season week, otherwise the postseason round, "the <S> season ended in
  week <L>" or "no game scheduled"; the K/DEF look-ahead stops at the season's own last week; E1
  names the analytics base rates once a season passes their vintage.
- ESLint: `src/mcp` may not import `src/http`, `src/sources` or `node:child_process`.
- **Store version 3 (migration 003) — rollback note:** a build from before this change refuses a v3
  store. To roll back, restore `store.sqlite.bak-v2` from the backup directory (taken before the
  migration), boot out and delete `io.github.fantasy-football-mcp.ff.refresh-due`, and run the older
  build's `ff install-launchd`.
- **Dependencies** (`80fdbbf`, the same pins as Dependabot PR #7): `@modelcontextprotocol/server`
  and `@modelcontextprotocol/client` 2.2.0 → 2.3.1 (`@modelcontextprotocol/core` 2.3.1; the SDK's
  manifest licence is Apache-2.0 since 2.3.0, on the licence allow-list), `hyparquet` 1.31.2 →
  1.31.3, `@types/node` 24.19.2, `eslint` 10.12.0, `typescript-eslint` 8.71.1; still a
  five-package runtime tree. Visible change: `prompts/get` without `arguments` now answers for
  `ff.start_sit` and `ff.retro` (validated as `{}`); `ff.stream` still refuses. `ff_get_status`
  reports `sdk_version` 2.3.1. Rollback: revert `80fdbbf` (lockfile and allow-list move together).
- **QA round 2 behaviour changes** (`docs/qa/2026-10-06-qa-round2.md`):
  - **Dataset files are now `ds_schema` 3** (QA-2-032): a file written by an earlier build may hold
    the opponent's sack yardage with the wrong sign, so it is refused until it is republished. Run
    `ff refresh all` once after upgrading; until then such a file is not served (the tools that need
    it answer `STALE_ONLY`, `ff_get_status` reads it `unreadable`), `ff doctor` row 8 names the
    refresh, and the next scheduled refresh republishes it.
  - `ff_analyze_lineup`: each change is decided on its own Δ interval — made when it excludes 0, held
    as a coin flip when it includes 0, skipped when it gains nothing — so `rec.action` can read "make
    1 lineup change, hold 1 coin flip and skip 1 change that gains nothing". An `exclude`d player
    scores 0, as `status: O` does; a starter who will not score and whom no rostered scorer can
    replace is left out of `rec.lineup`, with an assumption naming his seat. A seat held by an
    unmatched starter is kept and P(win) withheld. A `force_start` it cannot honour is `VALIDATION`
    with the reason `cannot_seat_together`, `on_ir` or `locked`; a lineup too deep for one result
    (more than about 14 starting seats with a full bench) is `VALIDATION` with the reason
    `lineup_too_deep` and a hint. A league whose `scoring_type` is not head-to-head gets
    `objective: "mean"`, mode `neutral` and no P(win).
  - `ff_analyze_matchup` answers `NOT_FOUND` with a hint for a league that is not head-to-head, and
    when one of my starters matches no NFL player.
  - `ff_get_injuries` reads the injury report as the projections do: a practice-only report does not
    clear a player, a designation is carried for up to two weeks and then `p_active` is null, a new
    injury DNP without a designation reads 0.4 (the practice-trend rate), and `warnings[]` name the
    teams whose players are carried, expired or pending.
  - `ff_get_roster` warns with the keys of rostered players the NFL data does not match.
  - `ff_get_status`: `sources[].freshness` gains `unreadable`, and `datasets_loaded` fails for it;
    `ff status` reads a deleted or non-regular current dataset file as `unreadable` too, never
    `never_loaded`.
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

- **QA-2-037** — game days off Thursday, Sunday and Monday (Wednesday openers, Thanksgiving Friday,
  Saturdays, Christmas on any weekday) got the off-day cadence and TTL: game days now come from the
  schedule data (owner's decision), and a lines check made on a Saturday-game day reads stale after
  30 min in every time zone.
- **The September `STALE_ONLY`**: core tools refused for days while the new season's injuries and
  stats were not yet published upstream, and the hint looped on `ff refresh all`.
- **QA-2-062** — `exclude` and `status: O` could give different `delta_vs_next` intervals for one
  lineup (the solver's tie-break chose which entrant took which freed seat): the made changes are now
  chosen canonically (largest made gain, then the highest sum of made-change p10s, then a fixed
  key/seat order) and lineup totals are summed in `player_key` order.
- **The season-fresh verification round (2026-10-14, SF-27 to SF-40 in the QA register; each fix
  has a regression test, mutation-checked):**
  - A run that found its season unpublished upstream (injuries from the May schedule release to the
    first report) wrote only `season_check` rows, which the 14-minute floor did not read: the tick
    re-polled it every quarter-hour (about 190 GitHub requests a day for months), every answer
    reading injuries spawned a child that polled it again, and those spawns used up the hourly cap
    so the schedules revalidation itself was `throttled`. A season check is now an attempt; such a
    season is re-checked at its phase cadence from that attempt (2 h around games, 6 h otherwise),
    never by a repair every tick, never by the TTL guard on another season's file, and never waited
    on at answer time (SF-27).
  - The 14-minute floor was measured from the end of a run, so a run ending more than a minute after
    its quarter-hour left the next tick `min_gap` (the pregame 15-minute schedules cadence became
    30): a publish's `refresh_log.started_at`, an unchanged check's `checked_at` and every
    `season_check` now carry the run's start (SF-28).
  - Answer time: a transient spawn error (EAGAIN, EMFILE, ENOMEM) turned answer-time refresh off for
    the life of the server; only a missing or non-executable binary or a sandbox refusal does now —
    any other fails that call (`failed`/`spawn` with its retry time) and holds new children back
    15 min (`backoff`/`spawn`) (SF-29). G1's `on_demand` check reported the configured mode after
    the server had turned the refresh off; it now reports `disabled_spawn` / `disabled_version` as
    not ok (SF-30). A child that found the run lock taken (the tick starting at its quarter-hour)
    answered `joined` at once; it now joins that run within the budget, so the answer usually
    carries the new release (SF-31).
  - A recommendation whose lock came from a game moved to another week read `unknown`, never
    `moved`, because the diff files both of the move's rows under the new week (SF-32).
  - The next season's schedule before its release: `games.parquet` holds every season, so S+1 was
    copied as an empty season, never recorded, and the tools' hint asked for `ff refresh
    nflverse:schedules --seasons S+1` — which published a schedules file with no game, dropping
    every season. S+1 is now recorded `not_published` (the tools then say `season_not_published`),
    a schedules file without a game is never published, a manual `--seasons` run adds to the
    seasons the file holds, and the hint asks for `--seasons` only for a past season (SF-33).
  - A league file without `end_week` always ended at week 17: the provider now passes the league
    season's last regular week (`last_reg_week − 1`), re-normalises when that schedule arrives, and
    the fallback's warning reaches every tool that reads the league (SF-34).
  - Past the venue table's vintage the game row's roof won for every venue, so the open-air MCG,
    Stade de France and Allianz Arena (nflverse: `dome`) lost their weather; a venue whose roof
    cannot change (a fixed dome, an open-air venue abroad) now keeps its physical roof in every
    season, one rule for the reader and the weather sources (SF-35).
  - The tools' week input, the `ff://rec/week/{week}` resource and `ff_get_league`'s weeks list
    used a literal 22, the manual provider read weeks 1–22 only, and D2's base-rate note named its
    seasons in a string: all read `TOOL_INPUT_WEEK_MAX`, `ALL_WEEK_INDEXES` and the reference
    registry now (SF-36).
  - Tests: the politeness property reads a simulated store through the production `sourceStateOf`
    with not-published attempts; the launchd replay models 0–120 s runs; the rollover end-to-end
    publishes injuries, rosters and stats as upstream does and holds D2 and E1–E3, E5 to "never
    `STALE_ONLY`"; the on-demand path's kickoff-change hook and the answer-time repair of an expired
    required file are covered (SF-37 to SF-40).
- Two concurrent refreshes of one source both downloaded; a 429 was recorded as `network` and its
  `Retry-After` ignored; weather re-fetched every venue on every run; stats post-game runs fired only
  after Thursday, Sunday and Monday games; G1 `jobs[]` was always empty; a renamed or removed
  launchd job left its plist behind.
- **QA round 2, re-verification, second sweep and integration round**
  (`docs/qa/2026-10-06-qa-round2.md`: 105 fixes re-checked, 22 reopened; 20 new findings, QA-2-026 to
  QA-2-045; the fix round then verified independently and its problems and hand-offs worked in an
  integration round; each fix below has a regression test, mutation-checked; QA-1-080, QA-2-037,
  QA-2-047, QA-2-048 and QA-2-045's TE premium are deferred and QA-2-028 closed, as the register
  records):
  - `ff_analyze_lineup`: an `exclude`d starter kept the replacement out ("keep the current lineup")
    and stayed in `rec.lineup`; he now scores 0, his replacement is priced by its own quantiles
    (any Questionable bench player's projection is skewed), and he is benched whenever a scorer
    exists (QA-2-038). One coin-flip swap held back a change that could not lose points, and later a
    decisive change carried an unrelated coin flip; each change is now decided on its own interval,
    and entrants are matched to freed seats so that the changes made gain the most (QA-1-020,
    QA-1-040). A seat held by a starter the crosswalk cannot match is kept, never "filled"
    (QA-2-039). An unseatable `force_start` is refused instead of dropped (QA-1-010). A schema-legal
    lineup too deep for one result got `INTERNAL`; it now gets `VALIDATION` `lineup_too_deep` while
    the truncation contract is decided (QA-1-080).
  - `ff_analyze_matchup`: the no-opponent hint names what is missing (QA-1-069); P(win) was computed
    without my unmatched starter's points and named nothing (QA-2-046).
  - Availability: a practice-only injury report no longer reads as "cleared to play", and look-ahead
    weeks carry the newest designation for up to two weeks, then report availability as unknown
    (QA-2-034, QA-1-021); `ff_get_injuries` now agrees with the projections, and a new injury DNP
    without a designation is no longer read as cleared.
  - `ff_get_roster` gave no warning for a starter the NFL data does not match (QA-2-039).
  - `ff_analyze_waivers`: a decision week without betting lines is named, and a K/DEF without its line
    is never streamed over a starter who plays (QA-2-044); a locked bench K/DEF no longer freezes the
    position or becomes the hold-vs-stream baseline (QA-2-033).
  - Scoring: team-defence yards allowed added the opponent's sack yardage instead of subtracting it,
    in the ingest and in the store's reader (QA-2-032; `ds_schema` 3, so run `ff refresh all`); a
    threshold bonus on an FG-distance or points-allowed bin was listed but never paid (QA-2-036);
    `league.yaml` can state missed-FG bins and yards-allowed brackets, and an unknown override key
    now says what is accepted (QA-2-045; a TE premium cannot be stated yet).
  - Retrospective: a past week's `followed` no longer flips after a later league-file edit, so it
    agrees with `ff_list_recommendations` (QA-2-040); regret compares like with like, and the Skills
    log alternatives it can score (QA-2-041); per-player metrics count the opponent's stored
    projections too (QA-2-042).
  - Freshness: injuries read stale about 60 h a week under their own job, and one failed run caused
    `STALE_ONLY` (QA-2-035); a `not_published` run did not end a failure streak (QA-1-037);
    `ff_get_status` called an unreadable dataset `fresh`, and `ff status` called a deleted one never
    loaded (QA-1-038).
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
  - Tooling: the supply-chain checks failed in a checkout under a UUID-named directory, whose path
    `npm ls` prints redacted (QA-2-049).
  - Skills: onboard's save commands now resolve `FF_CONFIG_DIR` as the server does, and catch every
    name the sync apps give their folders and a dotfiles repository whose `core.worktree` holds the
    folder (QA-1-072, QA-2-008, QA-1-044, QA-1-067); onboard no longer says the manual league cannot
    give transactions (QA-1-062), asks about missed-FG and yards-allowed bins by key and says a TE
    premium cannot be stated (QA-2-045), and warns about a league deeper than about 14 starting
    seats (QA-1-080); start-sit and the tool cheat-sheet describe the lineup and matchup rules above,
    each claim checked against the server (QA-2-038, QA-2-039, QA-2-043, QA-2-046, QA-1-010, QA-1-020);
    orient notes every `sources[]` state that is not fresh, with its repair (QA-1-038); the tests
    behind QA-2-005, QA-2-007 and QA-2-025 now catch the variants that escaped them, and the A9 chain
    asserts a numeric `regret` (QA-2-041).
  - Docs: the README's FAQ says a TE premium cannot be stated in `league.yaml` yet, and its job list,
    plan 01 §5.2 and plan 06 §1.2 give the new `nflverse-daily` calendar; plan 07 E2, E3, E5, D2, G1
    and E13 record the rules above; `CONTRIBUTING.md` § Security says both commit paths scan the
    message (QA-2-026).
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
