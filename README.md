<h1 align="center">🏈 Yahoo Fantasy Football MCP Server</h1>

<p align="center"><strong>Format-aware, deeply reasoned fantasy-football recommendations for Claude — read-only first, a human confirms every write, and news is data, never instructions.</strong></p>

<p align="center">
  <a href="#status"><img alt="status: planning" src="https://img.shields.io/badge/status-planning-blue"></a>
  <a href="LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Node >= 24.15" src="https://img.shields.io/badge/node-%3E%3D24.15-339933?logo=node.js&logoColor=white">
  <img alt="MCP spec 2026-07-28" src="https://img.shields.io/badge/MCP-spec%202026--07--28-000000">
  <a href="https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/workflows/docs.yml"><img alt="docs CI" src="https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/workflows/docs.yml/badge.svg"></a>
  <a href="https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/workflows/secrets.yml"><img alt="secrets CI" src="https://github.com/ChadPapineau/yahoo-fantasy-football-mcp/actions/workflows/secrets.yml/badge.svg"></a>
  <img alt="ci.yml: not yet (Phase 0)" src="https://img.shields.io/badge/ci.yml-not%20yet%20(Phase%200)-lightgrey">
</p>

> **This is a plan, not a release.** Every feature on this page is **📋 planned**. No server code exists yet; the build starts **after the owner has reviewed and approved the plan** in [`docs/plan/`](docs/plan/00-index.md) (owner decision, 2026-09-30, recorded in [`docs/HANDOFF.md`](docs/HANDOFF.md)). The only things that run today are the repository's documentation and secret-scanning CI. Read the [Status](#status) section before anything else.

**Status legend used throughout:** ✅ implemented · 🚧 in progress · 📋 planned

---

## What this is

A local [Model Context Protocol](https://modelcontextprotocol.io/) server, written in Node/TypeScript on the official MCP SDK, that gives Claude (Desktop or Code) a **complete, cached, read-only view of your Yahoo Fantasy Football league** — settings, rosters, free agents, transactions, standings, scoreboard, player stats — and a set of **decision engines** that turn that view into recommendations you can act on: start/sit with win-probability reasoning, kicker and defense streaming, waiver targets with FAAB bid curves, trade evaluation, injury cascades, bye-week planning and a weekly briefing. Every number is **format-aware**: the server reads *your* league's scoring, roster slots and rules from Yahoo and re-scores everything with a settings-driven engine that is checked against Yahoo's own point totals, so a half-PPR, 2-flex, 6-point-pass-TD league gets different answers than a standard one. Every recommendation is **deeply reasoned and honest about uncertainty** — a point estimate is never shipped without a distribution, the drivers behind it, the assumptions that would change it, and the deadline by which it matters — and every one is logged so the following week's retrospective can say whether the advice was right for the right reasons. The product is **read-only first** by design and by Yahoo's current policy; if Yahoo ever grants write access, every roster change goes through a preview → **explicit human confirmation** → commit gate whose guarantees are stated per session rather than assumed. Third-party text — Yahoo team names and notes, injury blurbs, news feeds, even the model's own earlier recommendations read back from the log — is **data, never instructions**: it is wrapped, capped, labelled by source and declared non-instructional once, at the server level, for the model. Twelve **Skills** ship alongside the server so the model follows a tested procedure for each decision instead of improvising. Fantasy data provided by [Yahoo Fantasy](https://football.fantasysports.yahoo.com/).

## Table of contents

- [Status](#status)
- [Features](#features)
- [Architecture](#architecture)
- [Tool reference](#tool-reference)
- [Skills reference](#skills-reference)
- [Quickstart and installation (planned)](#quickstart-and-installation-planned)
- [The `ff` CLI as built (Phase 1a)](#the-ff-cli-as-built-phase-1a)
- [Configuration](#configuration)
- [Launch configuration for Claude Desktop and Claude Code](#launch-configuration-for-claude-desktop-and-claude-code)
- [Security model](#security-model)
- [Testing](#testing)
- [Contributing](#contributing)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [Acknowledgements](#acknowledgements)
- [License](#license)

---

## Status

**Planning.** The research (`docs/research/00-*` … `06-*`), the refined plan (`docs/plan/01-*` … `10-*`), a three-round adversarial review ([`adversarial-log.md`](docs/plan/adversarial-log.md): 30 objections, 29 conceded and landed, 1 withdrawn on evidence, 0 pressed) and the [`changelog.md`](docs/plan/changelog.md) of what the review changed are complete. **Development is gated on the owner's approval of that package.** Nothing below the CI rows in the table exists as code.

Four facts shape everything on this page, and the plan carries them openly:

1. **Yahoo API access is application-gated and read-only by default.** Yahoo's developer access page says the Fantasy Sports API "currently provides read access only" and that write access "is not available at this time"; access itself is a form followed by human review, and as of 2026-09-30 no one in the public issue threads reports having been approved through the new form yet. See [`docs/research/03-yahoo-api.md` §A](docs/research/03-yahoo-api.md#a-auth) and [§G](docs/research/03-yahoo-api.md#g-the-three-facts-that-most-constrain-the-architecture). The owner must apply; the plan splits the first phase so that everything that does not need Yahoo is built and accepted first ([Roadmap](#roadmap)).
2. **There are no player projections in Yahoo's API.** The projections here are **ours**, built from nflverse usage, lines, injuries and (later) expected-points data, and every such number carries `meta.estimate: true` and a `model_version`. No free, legal, current projection feed exists, and the plan does not pretend otherwise ([`docs/research/04-data-sources.md` §G](docs/research/04-data-sources.md#g-the-three-constraints-that-most-shape-the-architecture)).
3. **Read-only is the product.** The owner decided (2026-09-30) that thorough reads plus intelligent recommendations are sufficient; lineup, add/drop, waiver and trade *writes* are a **conditional bonus** that lights up only if Yahoo ever grants write scope to this client id (Phase W in the roadmap), and even then behind a confirmation gate.
4. **Confirmation-dialog support in Claude Desktop is unverified.** The plan therefore never relies on MCP elicitation alone; an out-of-band one-time code and a terminal command are always available, and every security claim names the *session condition* under which it holds ([Security model](#security-model)).

| Area | State | Evidence |
|---|---|---|
| Research pack (00–06) | ✅ complete, verified by the orchestrator | [`docs/research/`](docs/README.md) |
| Refined plan (01–10) | ✅ complete, adversarially reviewed, **awaiting owner approval** | [`docs/plan/00-index.md`](docs/plan/00-index.md) |
| Docs CI — every Mermaid block renders, every internal link resolves | ✅ live on every push | [`docs.yml`](.github/workflows/docs.yml) |
| Secrets CI — gitleaks with Yahoo-specific rules, weekly full-history scan | ✅ live on every push | [`secrets.yml`](.github/workflows/secrets.yml), [`.gitleaks.toml`](.gitleaks.toml) |
| Dependabot (actions + npm version updates), PR template | ✅ | [`.github/`](.github/) |
| Yahoo API access application | 📋 owner's step — precedes Phase 0 | [`docs/HANDOFF.md` ▶ NEXT STEP](docs/HANDOFF.md#-next-step) |
| Package skeleton, `ci.yml`, server, CLI, Skills, tests | 📋 after plan approval | [Roadmap](#roadmap) |

---

## Features

Every row is traceable to the tool catalog ([`docs/plan/07-tool-catalog.md`](docs/plan/07-tool-catalog.md)) and the phasing plan ([`docs/plan/10-phasing-and-acceptance.md`](docs/plan/10-phasing-and-acceptance.md)); analytics rows cite the method section of [`docs/research/05-strategy-and-analytics.md`](docs/research/05-strategy-and-analytics.md) they implement. **Priority:** P0 = read-only MVP (Phase 1) · P1 = Phase 2 · P2 = Phase 3 · later = Phase 4 · conditional = Phase W (only if Yahoo grants write). The 19 P0 tools are what the server registers by default (`FF_TOOLSET=core`); `FF_TOOLSET=full` adds the P1/P2 analytics.

### League and discovery

| Tool | What it does | Source | Priority | Status |
|---|---|---|---|---|
| `ff_list_leagues` | Your leagues and your team key per league for the logged-in user | Yahoo `users;use_login=1/games/leagues` | P0 | 📋 |
| `ff_get_league` | The normalised settings digest: scoring rules mapped to canonical stat names, bracket families, roster slots by class, waiver/FAAB/trade/playoff rules, weeks, `settings_hash`; clean negatives carried as fields (`faab_budget: null`, `unverified_fields[]`) | Yahoo `league/settings` + metadata + `game_weeks`, `stat_categories` | P0 | 📋 |
| `ff_get_standings` | Standings plus the per-team scalars rivals' decisions depend on (waiver priority, FAAB balance, moves, adds this week) | Yahoo standings + team fields | P0 | 📋 |
| `ff_get_scoreboard` | Matchups for a week with Yahoo's own projection and win probability as **cross-checks**, never inputs; `meta.provisional` before the week is final | Yahoo scoreboard | P0 | 📋 |
| `ff_list_transactions` | League transactions — Yahoo's most-recent-N merged with the server's persisted history (`history_coverage.gap_suspected` when incomplete) | Yahoo transactions + `transactions_seen` | P0 | 📋 |
| `ff_get_draft_results` | Draft picks, rounds, costs | Yahoo `draftresults` | later | 📋 |

### Roster and lineup

| Tool | What it does | Source | Priority | Status |
|---|---|---|---|---|
| `ff_get_roster` | A roster with slots, eligibility, statuses, byes, `percent_owned`, and the **lock schedule computed once** (kickoff → `lock_at` per player, `latest_execution_time`, empty starting slots, IR-ineligible players, over-limit flag) | Yahoo roster with `out=stats,ownership,percent_owned` + nflverse schedule + crosswalk | P0 | 📋 |
| `ff_get_player_stats` | League-context stat lines with the **scoring engine's recomputation and a `match` flag** against Yahoo's `player_points` — the product's integrity check, one call away | Yahoo `players/stats;type=week` + engine | P0 | 📋 |

### Players and market

| Tool | What it does | Source | Priority | Status |
|---|---|---|---|---|
| `ff_search_players` | Resolve a name to a `player_key` — the **only** path from a name to an id on any write path — with ownership and crosswalk status (`method`, `confidence`) | Yahoo `players;search` + ownership + crosswalk | P0 | 📋 |
| `ff_list_players` | Browse a pool (free agents, waivers, taken, all) with ownership, `percent_owned_delta` (labelled a **competition** signal, never a detection signal), optional stats, next opponent and kickoff; paginated 25/page behind the scenes | Yahoo players collection | P0 | 📋 |
| `ff_list_trending_players` | Sleeper trending adds/drops mapped into *this* league's availability; carries `license: "non-commercial"` | Sleeper `trending/add\|drop` + Yahoo ownership | P1 | 📋 |

### Stats and usage

| Tool | What it does | Source | Priority | Status |
|---|---|---|---|---|
| `ff_get_injuries` | Official designations, practice trend, Yahoo and Sleeper status side by side with `sources_agree`, a first-cut `p_active` with its basis; **on game day availability comes from Yahoo status only** (`p_active_basis: "yahoo_gameday_status"`) because inactives exist in no other free source | nflverse `injuries` (Wed–Sat) · Yahoo status · Sleeper | P0 | 📋 |
| `ff_get_schedule` | Kickoffs, byes, betting lines → implied team totals, roof, surface, rest days, weather where evidenced — the market anchor, one row per game | nflverse `schedules` · The Odds API (optional) · Open-Meteo / NWS | P0 | 📋 |
| `ff_get_player_usage` | Per-game opportunity and efficiency inputs, trailing-window summaries with change points, `xFP − actual` gap; `routes_proxy` named honestly (no free in-season route data exists) | nflverse `stats_player_week`, `snap_counts`, pbp subset · ffopportunity | P1 | 📋 |
| `ff_get_depth_chart` | A team's depth chart with the snap-share cross-check beside it | nflverse `depth_charts` · Sleeper | P1 | 📋 |
| `ff_get_defense_profile` | Regressed opponent adjustments (shrunk, ramping with weeks), pace, pass rate, pressure — never a raw points-allowed table | nflverse `stats_team_week`, pbp · FTN charting | P1 | 📋 |
| `ff_get_news` | RSS items matched to players with a **deterministic** claim extract (`rules_v1`); all text wrapped as `untrusted_text`, URLs never rendered as links | RotoWire + ESPN RSS (CBS fallback) | P1 | 📋 |

### Analytics — the decision engines

Each engine implements a named method from the analytics research; every result carries `data.rec` (action, point estimate, **distribution with its `basis`**, delta vs next best with interval, decision metric, ranked drivers, assumptions with revisit triggers, confidence and input freshness, `latest_execution_time`) and `meta.estimate: true`.

| Tool | What it decides | Method implemented | Priority | Status |
|---|---|---|---|---|
| `ff_project_players` | Floor / median / ceiling per player-week by simulation, stored format-agnostically and **scored per league** through the engine; v1 `v1-trailing` uses nflverse stat lines with position-level spreads (`basis: position_cv`), v2 `v2-opportunity` simulates stat lines (`basis: player_sim`) | 05 §1 (projection construction: market anchor, usage shares, shrinkage, `P(active)` mixture, simulated distributions), §19.1 | P0 → P2 | 📋 |
| `ff_analyze_lineup` | Start/sit as **assignment under the head-to-head objective** — protect when favoured, chase when behind — with Thursday/Monday option value, conditional lineups for Questionable players, `coin_flip` flags; `objective: mean` is the v1 default, `pwin` opt-in until the retrospective shows it wins | 05 §3 (start/sit), §11.1, §14.2, §14.4, §14.5 | P0 | 📋 |
| `ff_analyze_matchup` | H2H win probability (`pre`), live conditioning split final/live/pending (`live`), and the season simulation behind `P(playoffs)` (`season`) | 05 §11 (win probability; season simulation ≥ 10 000 paths) | P0 / P1 | 📋 |
| `ff_analyze_waivers` | Usage-first opportunity detection **before points**, weeks of usable value on *your* roster, competition, FAAB bid curve with shading or claim/wait, the drop with re-add risk; the P0 slice is **K/DEF streaming** (`positions: [K, DEF]`, two-week look-ahead) | 05 §4 (waivers and FAAB), §8 (K and DEF streaming), §14.3 | P0 (K/DEF) / P1 (all) | 📋 |
| `ff_analyze_replacement` | Replacement level by roster allocation (flex-aware), VOR/xVBD, drop-off curves, tiers, streamability | 05 §2 (replacement level, VOR/VBD, scarcity) | P1 | 📋 |
| `ff_analyze_trade` | Roster-contextual value change for **both** sides with intervals, weekly and playoff impact, implied drop, bye/injury adjustments, ratification risk, counters, partner search; `fair` when the interval spans zero | 05 §5 (trade evaluation), §14.6 | P1 | 📋 |
| `ff_analyze_injury_cascade` | Beneficiaries by role affinity with `p_role_holds`, an honest evidence grade (`hypothesis_only` when nothing confirms), market reaction, returning-player ramp | 05 §6 (injury cascade) | P1 | 📋 |
| `ff_analyze_schedule` | Week-by-week roster stress test, the **cost** (not the count) of bye clusters, fixes with cost, and the deliberately weak playoff-matchup term with its shrinkage shown | 05 §7 (bye-week and playoff planning), §18 | P1 | 📋 |
| `ff_analyze_roster` | Rest-of-season construction: bench roles, handcuff and stash values computed per case, consolidation, IR-slot moves, roster-limit compliance | 05 §9 (roster construction), §14.1, §14.3 | P1 | 📋 |
| `ff_analyze_league_activity` | What rivals did, what it cost (price of a point from history), who needs what — the league activity digest | 05 §4.3, §5.7, §12 | P1 | 📋 |
| `ff_analyze_evidence` | News-vs-stats disagreement flags with a calibrated source × claim reliability table; until the table has n ≥ 200 every result says `"priors are hand-set"` | 05 §10 (news-vs-stats disagreement) | P2 | 📋 |
| `ff_record_recommendation` | Writes the recommendation **the model actually made** and the alternatives it offered to the local log (the calibration loop's enabling condition); its free text is untrusted on read-back | 05 §12 (what to log), §19.3 | P0 | 📋 |
| `ff_analyze_retrospective` | Scores last week's calls by regret and proper scoring rules, **leading with the metrics that reach n ≥ 30 for one league** (per-player CRPS/pinball/coverage, swap regret, `P(active)` Brier) and naming the rest as "n too small" | 05 §12 (retrospective and calibration) | P0 | 📋 |
| `ff_list_recommendations` | Browse the recommendation log (tool twin of `ff://rec/…`) | — | P0 | 📋 |
| `ff_analyze_scoring` | What-if scoring of stat lines under this league's settings and named variants | 05 §15 | later | 📋 |
| `ff_analyze_draft` | Best available by xVBD, tiers, ADP gaps, run alerts | 05 §13 | later | 📋 |

### Writes — conditional, behind the prepare/commit gate

**Registered only when `FF_WRITE_ENABLED=1` *and* Yahoo has provisioned this client id for reads** (write capability cannot be probed without writing; the first 401/403 on a write unregisters these tools again). Every write is two tools plus a human step: `ff_prepare_*` computes a human-readable and structured diff from the *current* state and journals it; a human confirms through one of three channels; `ff_commit_*` verifies the HMAC-bound ticket, re-fetches and **compare-and-sets** the precondition, performs exactly one write, journals the outcome. Writes are never auto-retried. Details: [Security model](#security-model), [`docs/plan/02-security-architecture.md` §4](docs/plan/02-security-architecture.md#4-confirmation-gate).

| Tool | What it does | Yahoo write | Priority | Status |
|---|---|---|---|---|
| `ff_prepare_lineup` / `ff_commit_lineup` | Slot moves for a week; refuses locked players and ineligible slots at prepare time | `PUT team/{key}/roster` | conditional | 📋 |
| `ff_prepare_transaction` / `ff_commit_transaction` | add · drop · add/drop · waiver claim (with FAAB bid or priority) · claim edit · claim cancel | `POST league/{key}/transactions`; `PUT`/`DELETE transaction/{key}` | conditional | 📋 |
| `ff_prepare_trade` / `ff_commit_trade` | propose · accept · reject · cancel a trade with an optional capped note | `POST`/`PUT`/`DELETE` trade | conditional | 📋 |
| `ff_cancel_prepared` | Void a prepared write before commit | — (local) | conditional | 📋 |

### Ops

| Feature | What it does | Priority | Status |
|---|---|---|---|
| `ff_get_status` tool · `ff://status` resource | Server version and protocol eras, auth and provisioning state, capabilities, limiter state, per-source freshness and licence, crosswalk coverage, store size, pending journal rows, launchd job results, the offline doctor rows | P0 | 📋 |
| `ff auth` | One-time Yahoo login; `oob` by default (no port, no certificate, no callback to register), an https-localhost listener on a **fixed** port as opt-in | Phase 1b | 📋 |
| `ff doctor` | Twenty-two checks, offline by default (Node ≥ 24.15, absolute launch paths, mode bits, token file, secret file, gate key, store health, dataset ages, pending journal, launchd jobs, `.npmrc`, the write flag's session warning, stale `dist/`, the client's own MCP log tail); `--online` adds token validity, provisioning, clock skew and source reachability; `--fix` repairs with consent; never rotates a token | Phase 1a/1b | 📋 |
| `ff status` | The one-page dashboard the resource and tool also serve | Phase 1a | 📋 |
| `ff refresh <source\|all>` | The **only** writer of dataset files — polls, downloads, asserts schema and codec, publishes a fresh per-source SQLite file by atomic rename | Phase 1a | 📋 |
| `ff install-launchd` / `ff uninstall` | Generates per-job launchd plists with absolute paths; removes what it created and prints what it will not touch | Phase 1a | 📋 |
| `ff print-config --client desktop\|code` | Emits the launch-config snippet with **resolved absolute paths** and no secret values | Phase 1a | 📋 |
| `ff confirm <id>` | The terminal confirmation channel for a prepared write (TTY required) | Phase W | 📋 |
| `ff smoke` | Live smoke against your real league — lists leagues, reads settings, scores one roster week against Yahoo's totals; run by you, never by CI | Phase 1b | 📋 |
| Zero-token automation | Nightly and game-day dataset refreshes, roster and free-agent snapshots with diffs, transactions append, token check, pre-kickoff check, journal reconcile, weekly prune and backup — every job a CLI subcommand under launchd, every failure a `refresh_log` row and a rate-limited macOS notification ([`docs/plan/06-automation-inventory.md`](docs/plan/06-automation-inventory.md)) | Phase 1a → 2 | 📋 |
| Docs CI (Mermaid render + link check) and secrets CI (gitleaks, weekly history scan) | Protect the plan documents and the public repository today | Phase 0 | ✅ |

---

## Architecture

Seven diagrams, each validated by the repository's Mermaid CI on every push. The full design is in [`docs/plan/01-system-architecture.md`](docs/plan/01-system-architecture.md); each caption names the plan section it summarises.

### 1. System context

```mermaid
%% System context — who talks to whom, and where the data and the secrets live
flowchart LR
  USER["You, the manager"]
  subgraph CLIENTS["MCP clients — the model runs here"]
    CD["Claude Desktop"]
    CC["Claude Code"]
  end
  subgraph LOCAL["Your Mac — one OS user"]
    SRV["fantasy-football-mcp-server<br/>one Node process, stdio only"]
    SKILLS["Skills bundle<br/>12 procedures the model follows"]
    STORE["SQLite store + per-source dataset files<br/>~/.cache/fantasy-football-mcp/"]
    TOK["OAuth tokens, gate key, client secret<br/>~/.config/fantasy-football-mcp/ (0700, 0600)"]
    JOBS["ff refresh jobs<br/>launchd, a separate process"]
  end
  subgraph EXT["External — the only hosts the server may reach"]
    YAHOO["Yahoo Fantasy Sports API<br/>XML over HTTPS, OAuth 2.0"]
    NFLV["nflverse + ffopportunity<br/>GitHub release files"]
    SLP["Sleeper API<br/>trending adds and drops, ids"]
    WX["Open-Meteo / NWS<br/>weather"]
    ODDS["The Odds API<br/>optional, key required"]
    NEWS["RotoWire + ESPN RSS<br/>news text, untrusted"]
  end
  USER -- "chat" --> CD
  USER -- "chat" --> CC
  USER -- "terminal: ff auth, ff doctor, ff confirm" --> SRV
  CD -- "stdio" --> SRV
  CC -- "stdio" --> SRV
  SKILLS -. "loaded by the client" .-> CD
  SKILLS -. "loaded by the client" .-> CC
  SRV --> STORE
  SRV --> TOK
  JOBS --> STORE
  SRV -- "cache-first, one global limiter" --> YAHOO
  JOBS -- "timestamp.txt poll, parquet" --> NFLV
  JOBS --> SLP
  JOBS --> WX
  JOBS --> ODDS
  JOBS --> NEWS
```

*One Node process per client session, stdio only, no listening socket; tokens and caches live outside the repository (and outside iCloud sync). The server talks only to the hosts on its allow-list — plan 01 D1, D4, D10, §2, §3; plan 02 §7.*

### 2. End-to-end request flow

```mermaid
%% End-to-end request flow — "who should I start at flex?" from question to logged recommendation
sequenceDiagram
    autonumber
    actor U as Manager
    participant M as Claude with the start-sit Skill
    participant S as MCP server
    participant C as SQLite cache and attached datasets
    participant Y as Yahoo Fantasy API
    participant E as Scoring engine and analytics (pure domain)

    U->>M: Who should I start at flex this week?
    Note over M: The Skill triggers on the phrase and runs Step 0 once per session
    M->>S: ff_get_status, then the ff://league/settings resource
    S->>C: settings digest (24 h TTL, memoised by settings_hash)
    S-->>M: envelope with meta.as_of, freshness, attribution
    M->>S: ff_get_roster (mine), ff_get_scoreboard, ff_get_roster (opponent)
    S->>C: cache lookup by canonical request path
    alt fresh entry
        C-->>S: cached XML and parsed JSON
    else stale or missing
        S->>Y: GET under the global limiter (cache-first, coalesced)
        Y-->>S: XML, parsed with entity expansion off
        S->>C: store body, fetched_at, refresh_rate
    end
    S-->>M: rosters with lock_schedule, free text wrapped as untrusted_text
    M->>S: ff_get_injuries (both rosters)
    S-->>M: designations, practice trend, p_active with its basis
    M->>S: ff_project_players (both rosters, this week)
    S->>C: nflverse stats_player_week lines, schedule lines, weather
    S->>E: scoreSamples over canonical stat lines under settings_hash
    E-->>S: Dist per player (mean, p10 to p90, basis position_cv in v1)
    S-->>M: projections, meta.estimate true, drivers, assumptions
    M->>S: ff_analyze_lineup (objective mean, compare the named pair)
    S->>E: assignment under the head-to-head objective, opponent-aware
    E-->>S: recommended lineup, swaps with delta and interval, coin_flip flags
    S-->>M: rec with distribution, delta_vs_next, drivers, latest_execution_time
    M->>S: ff_record_recommendation (the full rec, alternatives, source_calls)
    S-->>M: log_id
    M-->>U: Recommendation with p10 and p90, what would change it, the deadline, log_id, attribution
```

*A natural-language question becomes a Skill-ordered sequence of tool calls; reads are cache-first, projections are scored per league through the pure engine, and the recommendation is logged before it is shown so next week's retrospective can score it — plan 09 §3.3, plan 07 E1/E2/E12, plan 01 §5.3.*

### 3. Data ingestion and caching pipeline

```mermaid
%% Data ingestion and caching — two paths into one read side. No dataset write ever lands in store.sqlite
flowchart TB
  subgraph SRC["Sources and their own cadence"]
    NV["nflverse releases<br/>stats_player_week, pbp subset, snaps, injuries, depth charts, rosters, schedules<br/>nightly and game-day, timestamp.txt is the version"]
    FFO["ffopportunity ep_weekly<br/>daily"]
    SLP["Sleeper<br/>players once a day, trending every 30 min in season"]
    DP["DynastyProcess ids<br/>weekly"]
    RSS["RotoWire + ESPN RSS<br/>every 15 min in season"]
    WX["Open-Meteo / NWS<br/>hourly for the coming outdoor games"]
  end
  subgraph REFRESH["ff refresh source — launchd, never inside the server"]
    POLL["poll the version<br/>timestamp.txt or release updated_at"]
    SKIP["unchanged — exit 0"]
    DL["download to a temp file"]
    ASSERT["assert schema and parquet codec<br/>a renamed column or a zstd chunk fails loudly and keeps the old file"]
    WRITE["write a fresh ds/source.version.tmp<br/>journal_mode DELETE, one file"]
    FSYNC["fsync, then atomic rename over ds/source.sqlite"]
    LOG["refresh_log row in the store<br/>file_version, rows, ok, error"]
  end
  subgraph SERVER["MCP server — the read side"]
    ATT["ATTACH each ds/source.sqlite read-only<br/>re-attach when file_version changes: a DETACH/ATTACH pair, milliseconds"]
    YC["yahoo_cache — cache-first per data class<br/>settings 24 h, rosters 60 s, free agents 5 min, scoreboard 60 s in games / 15 min otherwise, transactions 2 min"]
    LIM["one global token-bucket limiter per client id<br/>coalescing, 999-aware backoff, force_refresh once per 60 s per key"]
    FRESH["freshness classifier on every result<br/>fresh, stale (served and warned), STALE_ONLY past the hard limit unless allow_stale"]
  end
  YAHOO["Yahoo Fantasy API"]
  INV["Invalidation triggers<br/>a successful commit → rosters, free agents, transactions<br/>week rollover → scoreboard, rosters<br/>golden-test mismatch or ff refresh --settings → league settings<br/>timestamp.txt changed → that nflverse dataset"]
  SRC --> POLL
  POLL --> SKIP
  POLL --> DL --> ASSERT --> WRITE --> FSYNC --> LOG
  FSYNC -. "new inode" .-> ATT
  LOG -. "version changed" .-> ATT
  YC -- "miss or expired" --> LIM --> YAHOO
  YAHOO --> YC
  ATT --> FRESH
  YC --> FRESH
  INV -.-> YC
  INV -.-> ATT
```

*External data is file-release ingestion, not API clients: a separate process polls a version stamp, asserts the schema, writes a whole dataset file and publishes it by atomic rename; the server attaches those files read-only and keeps its own Yahoo cache with per-class TTLs, hard limits and named invalidation triggers — plan 01 D7, D8, §5.2–§5.5; plan 06 §1.2.*

### 4. OAuth and token lifecycle

```mermaid
%% OAuth and token lifecycle — the confidential client, refresh rotation, and the terminal not-provisioned state
stateDiagram-v2
    [*] --> NoTokens
    NoTokens --> Authorizing: ff auth (oob by default, an https listener on a fixed port as opt-in)
    Authorizing --> Valid: get_token 200, tokens.json written atomically under the lock
    Authorizing --> NoTokens: the user abandons, or Yahoo returns an error
    Valid --> Expired: 60 s before expires_at (the proactive refresh window)
    Valid --> Refreshing: API 401 token_rejected (refresh once, retry once)
    Expired --> Refreshing: next API call
    Refreshing --> Valid: 200 and the NEW refresh token is persisted FIRST, then the access token is used
    Refreshing --> NoTokens: 401 invalid_grant (revoked, password changed, rotated away)
    Valid --> NotProvisioned: 401 additional_authorization_required, or 403 not authorized
    NotProvisioned --> Valid: ff auth --recheck succeeds (Yahoo approved the app)
    NotProvisioned --> NoTokens: ff auth --reset
    Valid --> NoTokens: ff auth --reset (deletes tokens.json)
    note right of NotProvisioned
        Terminal until a human acts.
        Every tool returns NOT_PROVISIONED with the application URL in its hint.
        Refreshing the token cannot help, so the server stops calling Yahoo.
    end note
    note right of Refreshing
        Two client processes may run at once.
        A lockfile serialises refreshes and a version counter makes the
        second process reload instead of re-using an already-revoked token.
    end note
```

*Authorization-code grant with a confidential client (Yahoo has no PKCE), `oob` login by default, rotating refresh tokens persisted before use, and a **terminal** not-provisioned state that is never mistaken for an expired token — plan 02 §2, §3.1, §3.2; plan 03 §6.*

### 5. Security and trust boundaries

```mermaid
%% Security and trust boundaries — where untrusted text enters, what receives it, and the confirmation gate
flowchart LR
  subgraph MACHINE["Your Mac — one OS user"]
    USER["Human"]
    CLIENT["MCP client running the model<br/>no-reach session: only this server and other reach-less servers<br/>reach session: Claude Code, or Desktop with a file or shell server beside this one"]
    subgraph PROC["fantasy-football-mcp-server"]
      IN["MCP surface<br/>zod strict schemas, bounds, key grammar, league allow-list, one path builder, no raw GET"]
      GATE["Confirmation gate<br/>prepare_* → human channel → commit_*<br/>HMAC ticket, compare-and-set precondition, journal"]
      DOM["Domain<br/>pure, never sees a wire type"]
      OUT["Output envelope<br/>third-party text wrapped as untrusted_text or path-listed in meta.untrusted_fields"]
    end
    SECRETS["tokens.json, gate_key, client_secret<br/>0600, outside the repository"]
    STORE["store.sqlite and ds/ dataset files"]
    NOTIF["macOS notification<br/>diff summary and a one-time code, no pending file"]
  end
  YAHOO["Yahoo API<br/>facts trusted, free text NOT"]
  DATA["nflverse, Sleeper, DynastyProcess<br/>numbers trusted after schema assertion, text NOT"]
  NEWS["News RSS<br/>the highest injection exposure"]

  USER -- "T0 chat" --> CLIENT
  CLIENT -- "T1 model-authored tool arguments" --> IN
  IN --> GATE --> DOM
  IN --> DOM
  DOM --> OUT --> CLIENT
  DOM -- "T2 XML incl. team names, notes, player names" --> YAHOO
  DOM -- "T3 dataset text" --> DATA
  DOM -- "T4 editorial text" --> NEWS
  DOM -- "T8 the model's own log text, read back" --> STORE
  GATE -- "T6 ticket echoed by the client, HMAC-verified" --> CLIENT
  GATE -- "channel 2: code shown to the human only" --> NOTIF
  NOTIF --> USER
  USER -- "channel 3: ff confirm on a TTY" --> GATE
  CLIENT -. "T7, reach sessions only: Bash or a sibling file or shell server reaches SECRETS, STORE and NOTIF, so writes are UNSUPPORTED there" .-> SECRETS
```

*Every entry point for untrusted text (T1–T4, T8) is labelled and capped; the gate's human channels are unforgeable by the model **only in a no-reach session**, which is why writes are off by default and unsupported wherever the model has file or shell reach — plan 02 §0, §1, §4, §6.*

### 6. Tool-and-Skill map

```mermaid
%% Tool-and-Skill map — which Skills orchestrate which tools. Arrows are the calls each Skill's procedure makes
flowchart LR
  subgraph P0["Skills — P0, Phase 1"]
    ONB["onboard"]
    WK["weekly"]
    SS["start-sit<br/>incl. the game-day branch"]
    KD["stream-kdef"]
    RT["retro"]
    AP["apply<br/>read-only mode at P0, the only Skill allowed to commit"]
  end
  subgraph P1["Skills — P1, Phase 2"]
    WV["waivers"]
    TR["trade"]
    IC["injury-cascade"]
    SP["schedule-plan"]
    RA["roster-audit"]
    NC["news-check"]
  end
  subgraph READS["Platform facts and external reads"]
    T_STAT["ff_get_status"]
    T_LEAG["ff_list_leagues / ff_get_league"]
    T_ROST["ff_get_roster"]
    T_SCOR["ff_get_scoreboard / ff_get_standings"]
    T_PSTAT["ff_get_player_stats"]
    T_PLAY["ff_list_players / ff_search_players"]
    T_TXN["ff_list_transactions"]
    T_INJ["ff_get_injuries"]
    T_SCHED["ff_get_schedule"]
    T_USE["ff_get_player_usage"]
    T_DEPTH["ff_get_depth_chart"]
    T_DEF["ff_get_defense_profile"]
    T_NEWS["ff_get_news"]
    T_TREND["ff_list_trending_players"]
  end
  subgraph ENGINES["Analytics engines"]
    E_PROJ["ff_project_players"]
    E_LINE["ff_analyze_lineup"]
    E_MATCH["ff_analyze_matchup"]
    E_WAIV["ff_analyze_waivers"]
    E_REPL["ff_analyze_replacement"]
    E_TRADE["ff_analyze_trade"]
    E_CASC["ff_analyze_injury_cascade"]
    E_SCHED["ff_analyze_schedule"]
    E_ROST["ff_analyze_roster"]
    E_ACT["ff_analyze_league_activity"]
    E_RETRO["ff_analyze_retrospective"]
    E_EVID["ff_analyze_evidence, Phase 3"]
  end
  subgraph LOG["Local write"]
    REC["ff_record_recommendation<br/>every Skill, before rendering"]
  end
  subgraph WRITES["Conditional writes, Phase W"]
    PREP["ff_prepare_lineup / _transaction / _trade"]
    COMMIT["ff_commit_lineup / _transaction / _trade"]
  end
  ONB --> T_STAT & T_LEAG & T_ROST & T_PSTAT
  WK --> T_SCOR & T_ROST & T_INJ & E_PROJ & E_LINE & E_WAIV & E_RETRO & E_ACT & T_TXN
  SS --> T_ROST & T_SCOR & T_INJ & E_PROJ & E_LINE & E_MATCH
  KD --> T_ROST & T_SCHED & T_DEF & T_PLAY & E_WAIV
  RT --> T_SCOR & E_RETRO & T_TXN
  AP --> T_STAT & PREP & COMMIT & T_ROST
  WV --> T_PLAY & T_USE & T_INJ & T_DEPTH & T_TREND & E_ACT & E_REPL & E_WAIV
  TR --> T_ROST & T_SCOR & E_PROJ & E_REPL & E_TRADE
  IC --> T_INJ & T_DEPTH & T_USE & T_SCHED & E_CASC & E_WAIV
  SP --> T_ROST & T_SCHED & E_PROJ & E_REPL & E_MATCH & E_SCHED
  RA --> T_ROST & T_INJ & E_PROJ & E_REPL & T_PLAY & E_ROST
  NC --> T_NEWS & T_INJ & T_USE & T_SCHED & E_EVID
  P0 -.-> REC
  P1 -.-> REC
```

*Skills are procedures, tools are the computational core: each Skill fixes the tool order, the questions to ask, the guardrails and the output template, and every one ends by logging the recommendation; only `apply` may ever call a commit tool — plan 09 §1–§3, K3; plan 07 §3.*

### 7. Roadmap timeline

```mermaid
%% Roadmap — phases, not dates. Effort scale from the plan: S is days, M is 1 to 3 weeks, L is 4 to 8 weeks
timeline
    title Delivery phases — the build starts after plan approval
    section Before any code
        Plan approval : research 00 to 06 : plan 01 to 10 : adversarial review closed with 30 objections and 0 pressed
        Yahoo API access application : submitted by the owner : starts the decision clock of 4 weeks or NFL week 9
    section Phase 0 — Foundation, S
        Repository protections : docs and secrets CI, live today : ruleset without required checks
        Package skeleton : four pinned runtime dependencies : ci.yml skeleton
    section Phase 1a — Read-only MVP, the Yahoo-free half, L
        Store and refresh : SQLite via node-sqlite : nflverse schedules, injuries, stats_player_week, weather
        Engine and analytics : scoring engine over nflverse lines : projections v1 : lineup : K and DEF ranking : recommendation log and retro
        Surface : the 19 P0 tools under FF_TOOLSET core : ManualLeagueProvider : Skills start-sit, stream-kdef, retro, onboard in manual mode
    section Phase 1b — the Yahoo half, M
        Auth and provider : ff auth with oob : token store : YahooProvider : golden test against Yahoo points : ff smoke
        Skills : onboard in Yahoo mode, weekly, apply read-only : credentialed launchd jobs : tag v0.1.0 when both halves are green
    section Decision point
        Read grant arrives : 1b proceeds
        No grant by the gate : X1 ManualLeagueProvider ships from 1a : X2 SleeperProvider pulled forward
    section Phase 2 — Usage, market and the P1 engines, L
        Sources : snaps, pbp subset, ffopportunity, Sleeper, DynastyProcess, depth charts, news, optional odds
        Tools and Skills : 11 P1 tools, 30 under full : 6 P1 Skills : live and season matchup modes : tag v0.2.0
    section Phase 3 — Model wave, L
        v2-opportunity projections : redistribution priors : source calibration : held-out-season backtests : tag v0.3.0
    section Phase W — Conditional writes, M
        Only if Yahoo grants write : 7 write tools : the gate's three channels : apply in write mode : journal reconcile
    section Phase 4 — Later
        SleeperProvider : draft tools : ESPN after Sleeper : remote variant : commercial source swaps
```

*Phase 1 is split so that everything that needs no Yahoo token is built and accepted first; a dated decision gate on the Yahoo application names the fallbacks (X1, X2) instead of waiting indefinitely; writes are a conditional phase, not a numbered one — plan 10 §0 (Ph1–Ph9, D0), §1, §3.*

---

## Tool reference

Every tool below comes from [`docs/plan/07-tool-catalog.md`](docs/plan/07-tool-catalog.md) (the catalog carries the full input and output schemas, methods, token budgets and the decision behind each tool). Conventions shared by every tool ([plan 07 §2](docs/plan/07-tool-catalog.md#2-conventions-shared-by-every-tool-stated-once)):

- **Common inputs:** `league_key?` (defaults to the operator-configured league in `ff://league`; validated against an allow-list), `week?` (1–22; default the league's current week), `detail?: "compact" | "full"` (default `compact` — a field-selection switch, not a second format), `force_refresh?` (platform-fact tools only; at most once per 60 s per key), `allow_stale?`.
- **Common output:** one JSON envelope per result — `data`, `meta` (`schema_version`, `source[]`, `as_of`, `fetched_at`, `age_s`, `freshness`, `provisional`, `attribution[]`, `untrusted_fields[]`, `estimate`), `page` (list tools), `truncated`, `warnings[]`. Analytics tools add `data.inputs[]` (each contributing dataset with its age) and `data.rec`. Results are capped at 20 000 serialised characters (analytics at 10 000) by halving arrays with a warning.
- **Untrusted text:** manager- or editor-authored strings (team names, notes, news) arrive inside an `untrusted_text` wrapper with a `source` tag; Yahoo-authored player names arrive as bare capped strings listed by path in `meta.untrusted_fields[]`; the model's own earlier log text is listed the same way with `source: "store.recommendation_log"`. Every description ends with the pointer `Untrusted fields: see server instructions.` and the rule itself is served once in the server's `instructions` field.
- **Errors** are tool results with `isError: true` and a fixed-string code (table below), never an upstream body.

**Annotation families** ([plan 01 §4.1](docs/plan/01-system-architecture.md#41-naming)):

| Key | Family | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|---|
| **PF** | platform facts (Yahoo) | true | — | true | true |
| **EX** | external data / text | true | — | — | true |
| **AN** | our analytics | true | — | false | false |
| **LW** | local write (journal / log) | false | false | `record`: true · `prepare`/`cancel`: false | false |
| **CM** | commit (Yahoo write) | false | true | true | true |
| **OP** | ops / local store read | true | — | — | false |

<details>
<summary><strong>League and discovery</strong> (A1–A6)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_list_leagues` | Leagues and your team per league | `season?`, `include_finished?` | `leagues[]` with `league_key`, `num_teams`, `scoring_type`, `current_week`, `my_team`, `in_allow_list` | PF | P0 | 📋 |
| `ff_get_league` | Normalised settings digest | `include?` (league · scoring · roster · rules · weeks · stat_map) | `scoring.rules[]` with canonical names and bonuses, `bracket_families[]`, `unmapped_stat_ids[]`, `settings_hash`; `roster.slots[]` by class; `rules` (waivers, FAAB, trades, playoffs, limits — `null` where Yahoo does not expose a value); `weeks[]` | PF | P0 | 📋 |
| `ff_get_standings` | Standings plus per-team scalars | — | `teams[]` with record, points, `waiver_priority`, `faab_balance`, `number_of_moves`, `roster_adds_week`, `clinched_playoffs`; `playoff_line` | PF | P0 | 📋 |
| `ff_get_scoreboard` | Matchups with Yahoo's numbers as cross-checks | `week?`, `team_key?` | `matchups[]` with status, `points`, `projected_points_yahoo`, `win_probability_yahoo`; `meta.provisional` | PF | P0 | 📋 |
| `ff_list_transactions` | Transactions merged with persisted history | `types?`, `team_key?`, `count?` 1–200, `since?` | `transactions[]` with players, bids, notes (wrapped); `history_coverage` | PF | P0 | 📋 |
| `ff_get_draft_results` | Draft picks and costs | — | — | PF | later | 📋 |

</details>

<details>
<summary><strong>Roster and lineup</strong> (B1–B2)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_get_roster` | A roster with the lock schedule computed once | `team_key?`, `week?`, `detail?` | `players[]` (slot, eligibility, status, `injury_note`, bye, opponent, `kickoff`, `lock_at`, ownership, week points); `lock_schedule[]`; `empty_starting_slots[]`; `ir_ineligible_in_ir[]`; `over_limit`; `latest_execution_time` | PF | P0 | 📋 |
| `ff_get_player_stats` | League-context stat lines with the engine's recomputation | `player_keys[1..25]`, `type: week \| season`, `week?` | `players[]` with `stats[]` (id, canonical, value), `yahoo_points`, `engine_points`, `engine_complete`, `match`, `unmapped_stat_ids[]`; `settings_hash` | PF | P0 | 📋 |

</details>

<details>
<summary><strong>Players and market</strong> (C1–C3)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_search_players` | Name → `player_key`, with crosswalk status | `query` 1–64, `position?`, `limit?` 1–25 | `players[]` with `ownership`, `percent_owned(_delta)`, `crosswalk { method, confidence }`, `has_recent_notes` | PF | P0 | 📋 |
| `ff_list_players` | Browse a pool | `status?` A · FA · W · T · K, `position?`, `sort?`, `with_stats?`, `limit?` 1–100, `offset?` | `players[]` with ownership, `competition_signal`, points, next opponent and kickoff; `page` | PF | P0 | 📋 |
| `ff_list_trending_players` | Sleeper trending mapped to league availability | `kind: add \| drop`, `lookback_hours?`, `limit?` | `players[]` with `count`, `league_status`, `owner_team_key`; attribution `license: "non-commercial"` | EX | P1 | 📋 |

</details>

<details>
<summary><strong>Stats and usage</strong> (D1–D6)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_get_player_usage` | Opportunity and efficiency inputs with trailing summaries | `players: PlayerSelector`, `window?` 1–17, `include_prior_season?` | per player: `trailing` (snap, target, carry, red-zone shares, WOPR, `xfp_gap_sum`, `change_point`), `games[]` (full only), `role_confidence_games`, `data_gaps[]`; `routes_proxy` named as a proxy | EX | P1 | 📋 |
| `ff_get_injuries` | Designations, practice trend, `p_active` | `players?: PlayerSelector` (default: my roster), `only_flagged?` | per player: `official`, `yahoo`, `sleeper` blocks with `as_of`; `p_active` + `p_active_basis`; `trend`; `ir_eligible`; `sources_agree` (suppressed on game day); `game_day` | EX | P0 | 📋 |
| `ff_get_schedule` | Kickoffs, byes, lines, weather | `weeks?` (≤ 6), `nfl_team?`, `include_weather?`, `include_lines?` | `games[]` with `kickoff_et`, `roof`, `rest_days`, `lines { spread_line, total_line, implied, moneyline, secondary }`, `weather`; `byes` | EX | P0 | 📋 |
| `ff_get_depth_chart` | Depth chart with the snap cross-check | `nfl_team?` or `player`, `positions?` | `teams[].groups[].slots[]` with `rank`, `snap_pct_last3`; `sleeper_cross_check` | EX | P1 | 📋 |
| `ff_get_defense_profile` | Regressed opponent adjustments | `nfl_team?` or `all`, `position?`, `window_weeks?` 4–17 | `defenses[]` with `afpa` per position (allowed, league mean, adjusted, `shrink_w`, multiplier), pace, pass rate, pressure, EPA allowed; `evidence_note` | EX | P1 | 📋 |
| `ff_get_news` | RSS items matched to players with a claim extract | `players?`, `nfl_team?`, `since_hours?` 1–168, `limit?` 1–50, `sources?` | `items[]` with `players_matched[]`, `title`/`blurb` (wrapped), `url` (text only), `claim { type, direction, extractor }`, `reliability_prior` | EX | P1 | 📋 |

</details>

<details>
<summary><strong>Analytics engines</strong> (E1–E16)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_project_players` | Distributions per player-week, scored per league | `players: PlayerSelector` or `pool`, `horizon: week \| ros \| season`, `week?`, `n_sims?` 1 000–20 000, `seed?`, `include_stat_line?` | `model_version`; `projections[]` with `weeks[].points: Dist` (`basis` stamped), `ros_total`, `opportunity`, `shrinkage[]`, `multipliers`, `drivers[]`, `assumptions[]`; `inputs[]` | AN | P0 → P2 | 📋 |
| `ff_analyze_lineup` | Start/sit under the H2H objective | `team_key?`, `week?`, `objective?: mean \| pwin \| blend`, `only_unlocked?`, `exclude?`, `force_start?`, `compare?[]` | `recommended_lineup[]`, `mode` protect/chase/neutral with basis, `p_win_before/after` + interval, `swaps[]` (`delta_e`, `delta_pwin` as sign + band in `position_cv` mode, `coin_flip`, option value), `conditionals[]`, `stack_flags[]`, `lock_schedule[]`, `no_move`, `rec` | AN | P0 | 📋 |
| `ff_analyze_matchup` | Win probability — pre, live, season | `mode?: pre \| live \| season`, `method?: normal \| mc`, `n_sims?` | `p_win` + interval, `mu/sigma` both sides, `live` split (final/live/pending), `yahoo_cross_check`, `actionable_slots[]`, `season { p_playoffs, p_bye, p_alive_by_week[], seed_distribution[] }`, `rec` | AN | P0 (pre) · P1 | 📋 |
| `ff_analyze_replacement` | Replacement level, VOR, tiers | `positions?`, `horizon?`, `week?`, `baseline?: starter \| stream \| both` | per position: weekly and ROS baselines, `curve[]`, `tiers[]`, `streamability`, `flex_allocation_trace[]`; `players[]` with `vor_ros: Dist`, `xvbd`, tier | AN | P1 | 📋 |
| `ff_analyze_waivers` | Waiver targets, bids, K/DEF streaming | `positions?` (P0: K/DEF only), `candidates?` ≤ 25, `horizon_weeks?`, `look_ahead?` 0–2, `adds_remaining?`, `faab_budget?`, `reserve?`, `include_drop?` | `candidates[]` with `signals[]`, `weeks_of_value`, `p_role_holds[]`, `marginal_value: Dist`, `competition`, `bid { b_star, p_win_curve[], lambda }`, `claim_or_wait`, `drop` with re-add risk, `kdef` block; `hold_vs_stream`; `waiver_clearing_time`; `rec` | AN | P0 (K/DEF) · P1 | 📋 |
| `ff_analyze_trade` | Trade evaluation and partner search | `offer { partner_team_key, give[], get[] }` or `find_partners { need_position, max_partners }`, `horizon?`, `risk?` | `delta_me`/`delta_partner: Dist`, `weekly_impact[]`, `playoff_weeks_impact`, `implied_drop`, `bye_conflicts[]`, `why_they_accept[]`, `ratification_risk`, `counters[]`, `verdict`, `deadline`, `rec` — or `partners[]` | AN | P1 | 📋 |
| `ff_analyze_injury_cascade` | Beneficiaries of an absence | `player: PlayerSelector`, `assume_weeks_out?` | `expected_weeks` (p25/p50/p75, basis), `beneficiaries[]` with `delta_opportunity`, `delta_proj_by_week[]`, `p_role_holds`, `evidence`, availability; `hypothesis_only`; `rec` | AN | P1 | 📋 |
| `ff_analyze_schedule` | Bye and playoff-week planning | `weeks?`, `include_playoffs?` | `weeks[]` with `lineup_pts: Dist`, `holes[]`, `bye_cluster_cost`, weight; `worst_weeks[]`; `fixes[]`; `playoff_weeks` with `matchup_multipliers[]` and `shrink_w`; `rec` | AN | P1 | 📋 |
| `ff_analyze_roster` | Rest-of-season construction | `competing?: auto \| yes \| eliminated` | `phase`, `bench_plan[]`, `handcuff_values[]`, `stash_values[]`, `consolidation_candidates[]`, `droppable[]`, `ir { … }`, `over_limit`, `adds_remaining`, `rec` | AN | P1 | 📋 |
| `ff_analyze_evidence` | News-vs-stats reconciliation with a calibrated table | `player`, `claim? { text ≤ 400, source?, time?, type? }` | `flag`, `prior`, `evidence[]`, `posterior`, `what_would_confirm[]`, `consequence`, `calibration_state { table_n, note }`, `rec` | AN | P2 | 📋 |
| `ff_analyze_league_activity` | League activity digest | `since_days?` 1–30, `include_rival_needs?` | `transactions` by team with FAAB spent, `standings_movement[]`, `pending_trades_visible[]`, `top_added[]`/`top_dropped[]`, `rival_needs[]`, `faab_price_model`, `rec` | AN | P1 | 📋 |
| `ff_record_recommendation` | Write the recommendation log | `kind`, `week`, `rec`, `alternatives[]`, `source_calls[]`, `followed_hint?`, `client_ref?`, `note?` ≤ 200 | `log_id`, `recorded_at`, `deduplicated` | LW | P0 | 📋 |
| `ff_analyze_retrospective` | Score last week's calls | `week?`, `kinds?`, `min_n?` (30) | `calls[]` (`followed`, `regret`, `decisive`), `metrics` (`per_player` CRPS/pinball/coverage/Spearman, `swap_regret`, `brier` per type or "n too small"), `n_by_metric[]`, `sample_size_caveats[]`, `rec` | AN | P0 | 📋 |
| `ff_list_recommendations` | Browse the log | `week?`, `kind?`, `limit?`, `offset?` | `items[]` with `action_summary` (path-listed as untrusted), `followed`; `page` | OP | P0 | 📋 |
| `ff_analyze_scoring` | What-if scoring under settings variants | `lines[1..25]`, `variants?[0..5]` | `results[]` with `points_league`, `by_variant` | AN | later | 📋 |
| `ff_analyze_draft` | Draft assistant | — | — | AN | later | 📋 |

</details>

<details>
<summary><strong>Writes — conditional</strong> (F1–F7; registered only under <code>FF_WRITE_ENABLED=1</code> with read provisioning)</summary>

Every `ff_prepare_*` returns `{ prepared_id, kind, diff { human, structured[] }, precondition { hash, observed_at }, expires_at (10 min), ticket, how_to_confirm { channels[], cli }, consequences { ir, roster_limit, faab_balance_after, lock_warnings[] }, latest_execution_time }`; locked, ineligible or over-limit moves fail with `VALIDATION` at prepare time. Every `ff_commit_*` takes `{ prepared_id, evidence? }` (`evidence` only for the one-time-code channel) and returns `{ applied: true | false | "unknown", receipt, diff, reconcile }`; a repeat with the same `prepared_id` returns the original receipt without writing. No write argument ever accepts a player *name*.

| Tool | Purpose | Key inputs | Yahoo write | Fam. | Status |
|---|---|---|---|---|---|
| `ff_prepare_lineup` | Preview slot moves | `team_key?`, `week`, `moves[1..20] { player_key, to_slot }` | — | LW | 📋 |
| `ff_commit_lineup` | Execute a prepared lineup change | `prepared_id`, `evidence?` | `PUT team/{key}/roster` | CM | 📋 |
| `ff_prepare_transaction` | Preview add · drop · add/drop · claim · claim edit · claim cancel | `kind`, `add_player_key?`, `drop_player_key?`, `faab_bid?` (≤ balance), `waiver_priority?`, `claim_key?` | — | LW | 📋 |
| `ff_commit_transaction` | Execute a prepared transaction | `prepared_id`, `evidence?` | `POST league/{key}/transactions`; `PUT`/`DELETE transaction/{key}` | CM | 📋 |
| `ff_prepare_trade` | Preview propose · accept · reject · cancel | `kind`, `partner_team_key?`, `give[1..6]`, `get[1..6]`, `trade_note?` ≤ 200, `pending_trade_key?` | — | LW | 📋 |
| `ff_commit_trade` | Execute a prepared trade action | `prepared_id`, `evidence?` | `POST`/`PUT`/`DELETE` trade | CM | 📋 |
| `ff_cancel_prepared` | Void a prepared write | `prepared_id` | — | LW | 📋 |

</details>

<details>
<summary><strong>Ops and debug</strong> (G1–G3)</summary>

| Tool | Purpose | Key inputs | Output summary | Fam. | Prio. | Status |
|---|---|---|---|---|---|---|
| `ff_get_status` | The status snapshot | `include_checks?` | `server` (version, SDK, protocol eras, node, `tool_contract`), `auth`, `capabilities { read, write {…} }`, `league`, `limiter`, `sources[]` with licence and age, `crosswalk`, `store`, `journal`, `jobs[]`, `checks[]` | OP | P0 | 📋 |
| `ff_get_playbook` | A Skill's procedure text for clients without Skills or prompts | `skill` | `body`, `references[]` | OP | later | 📋 |
| `ff_debug_echo` · `ff_debug_elicit` | Two throwaway spikes, **fixture mode only**: does the client forward `structuredContent` to the model? does it render a form-mode elicitation? Results go to `docs/HANDOFF.md` and are deleted afterwards | — | a nonce · an APPROVE/REJECT round trip | OP | Phase 1a week 1 · Phase 1b | 📋 |

</details>

<details>
<summary><strong>Resources and prompts</strong></summary>

Resources are read-side twins of tool data, application-driven, `cacheScope: "private"`, with `ttlMs` from the freshness table ([plan 07 §4.1](docs/plan/07-tool-catalog.md#41-resources-ff-application-driven-each-has-a-tool-twin-envelope-identical-cachescope-private)):

| URI | Content | `ttlMs` | Status |
|---|---|---|---|
| `ff://league` | The operator-configured league identity — set by you, never by the model | 86 400 000 | 📋 |
| `ff://league/settings` | The `ff_get_league` digest | 86 400 000 | 📋 |
| `ff://game/stat-categories` | The season's full stat universe with canonical names | 604 800 000 | 📋 |
| `ff://status` · `ff://status/freshness` | Status without checks · the per-class freshness report | 60 000 | 📋 |
| `ff://roster/snapshot` | Last night's roster snapshot and its diff | 60 000 | 📋 |
| `ff://docs/tool-outputs` | The tool-output cheat-sheet (compact field sets, `Dist`/`Rec` shapes, TTLs, never-refetch rules) and a verbatim copy of the untrusted-text rule | 86 400 000 | 📋 |
| `ff://rec/{log_id}` · `ff://rec/week/{week}` | Recommendation-log entries (free text path-listed as untrusted) | 86 400 000 · 3 600 000 | 📋 |

Prompts (`ff.<workflow>`, one per user-invocable Skill, bodies generated from `SKILL.md` so they cannot drift): `ff.onboard`, `ff.weekly [week]`, `ff.start_sit [week]`, `ff.stream <K|DEF>`, `ff.retro [week]`, `ff.apply <what>` (P0); `ff.waivers`, `ff.trade <offer>`, `ff.injury <player>`, `ff.schedule`, `ff.roster_audit`, `ff.check <claim>` (P1). Each `prompts/get` returns the Skill body, the embedded `ff://league/settings` resource and the untrusted-text rule. 📋

</details>

<details>
<summary><strong>Error codes</strong> (plan 01 §4.3)</summary>

| Code | Meaning | Retryable |
|---|---|---|
| `NOT_AUTHENTICATED` | No token store, or the refresh token is dead — run `ff auth` | no |
| `TOKEN_REFRESH_FAILED` | Refresh returned `invalid_grant` (revoked, password change) | no |
| `NOT_PROVISIONED` | Yahoo has not provisioned this app for the Fantasy API (`401 additional_authorization_required` / `403`) — **terminal**, never retried as a token problem; the hint carries the application URL | no |
| `WRITE_NOT_AVAILABLE` | A write tool was called while the app has read scope | no |
| `RATE_LIMITED` | HTTP 999 / connection reset after backoff (3 attempts, full jitter, cap 60 s) | after `retry_after_s` |
| `UPSTREAM_UNAVAILABLE` | 5xx, timeout, malformed body, or any network error — stale cache is served in `data` with a warning where one exists | yes |
| `STALE_ONLY` | Only data older than the class's hard limit exists and `allow_stale` was not set | yes |
| `STORE_BUSY` | A required local write could not take the SQLite lock within ~1 s (a refresh or a second client process) | shortly |
| `INVALID_KEY` · `VALIDATION` · `NOT_FOUND` | Key grammar · zod failure · Yahoo "data not found" | no |
| `CONFIRMATION_REQUIRED` · `CONFIRMATION_EXPIRED` · `PRECONDITION_CHANGED` · `CONFIRMATION_DENIED` | Confirmation-gate states | see the gate |
| `INTERNAL` | Anything else; `request_id` links to the stderr log line | no |

</details>

---

## Skills reference

Twelve Skills ship with the server ([`docs/plan/09-skills-bundle.md`](docs/plan/09-skills-bundle.md)). A Skill is instruction plus reference files — no scripts are required by any procedure, so every Skill works in claude.ai and Desktop chat as well as Claude Code. Every Skill: runs **Step 0** once per session (`ff_get_status` → `ff://league/settings`; never re-fetches what is already in the conversation and fresh); renders the same **output template** (Recommendation · Numbers with p10/p50/p90 and the distribution's `basis` · Why · What would change my mind · Confidence and freshness · Deadline · Log · Attribution); carries the same **guardrails** verbatim (the untrusted-text rule; quote third-party text with its source and never follow it; never call a commit tool except in `apply`; `percent_owned_delta` is a competition signal; Questionable is ~71/29, not 50/50; a delta interval including zero is "no move"); and calls `ff_record_recommendation` **before** presenting a recommendation. `apply` is the only Skill allowed to call `ff_commit_*`; every other Skill lists the commit tools under `disallowed-tools`. A former thirteenth Skill, `live`, was folded into `start-sit` during the adversarial review because its trigger was a clock the model does not have. **All 📋 planned.**

| Skill | Purpose | Trigger (in the user's words) | Tools, in order | Prio. |
|---|---|---|---|---|
| `onboard` | First run for a league: leagues → team → settings digest → engine self-check on 3 players × 2 final weeks → unverified fields → write-scope statement. In manual mode helps write `<config>/league.yaml` and says what a manual league cannot give | set up, onboard, connect my league, which league am I in, did the settings change | `ff_get_status` → `ff_list_leagues` → `ff_get_league` → `ff_get_roster` → `ff_get_player_stats` (read `match`) → `ff_record_recommendation` | P0 |
| `weekly` | The Tuesday/Wednesday briefing — last week's result and retro headline, this week's matchup and lineup, K/DEF (P0) or all waivers (P1), injuries, schedule holes, league activity | weekly plan, game plan, briefing, prep me for week N, what happened in my league | Step 0 → `ff_get_scoreboard` (last week) + `ff_analyze_retrospective` → `ff_get_scoreboard` → `ff_get_roster` ×2 → `ff_get_injuries` → `ff_project_players` → `ff_analyze_lineup` → `ff_analyze_waivers` (K/DEF; all positions at P1) → `ff_analyze_schedule` (P1) → `ff_analyze_league_activity` (P1; else `ff_list_transactions` + `ff_get_standings`) → `ff_record_recommendation` per section | P0 |
| `start-sit` | Lineup as assignment under the H2H objective; protect/chase; Thursday/Monday option value; Questionable via `p_active`; conditionals — **and the game-day branch**, selected by `lock_schedule` (only unlocked swaps, Yahoo game-day status only, live odds) | who do I start/sit/flex, is my lineup right, Questionable, inactive, late scratch, what can I still change, what are my odds right now | Step 0 → `ff_get_roster` → *branch on `lock_schedule`* → `ff_get_scoreboard` → `ff_get_roster` (opponent) → `ff_get_injuries` → `ff_project_players` → `ff_analyze_lineup` (`objective: mean` by default) → (`ff_analyze_matchup(mode: live)` in the game-day branch, Phase 2) → `ff_record_recommendation` | P0 |
| `stream-kdef` | K/DEF for this week and next from implied totals, spreads, roof and wind, opponent profiles and the league's brackets; hold vs stream | stream, kicker, defense, DST, which K, which defense | Step 0 → `ff_get_roster` → `ff_get_schedule` (two weeks) → `ff_get_defense_profile` (P1) → `ff_list_players` (K, DEF) → `ff_analyze_waivers(positions: [K, DEF], look_ahead: 2)` → `ff_record_recommendation` | P0 |
| `retro` | After finalisation: every logged call scored by regret and proper rules, leading with the metrics that reach n for one league and naming the rest as "n too small" | how did we do, review last week, were you right, calibration, recap my week | Step 0 → `ff_get_scoreboard` (final?) → `ff_analyze_retrospective` → `ff_list_transactions` (if `followed` unknown) → `ff_record_recommendation` | P0 |
| `apply` | Turn an agreed recommendation into the exact manual clicks in Yahoo's vocabulary (read-only) or a previewed diff → explicit confirmation → commit → reconcile (write scope). `disable-model-invocation: true` | apply, do it, submit, make the move, set my lineup, place the claim, send the offer | `ff_get_status` → read-only: render the steps and stop · write: `ff_prepare_<kind>` → show the diff, wait for the user's yes → `ff_commit_<kind>` → `ff_get_roster` / `ff_list_transactions` to reconcile → `ff_record_recommendation` | P0 (read-only) · W (write) |
| `waivers` | Usage-first opportunity detection, weeks of usable value on your roster, competition, bid curve with λ or claim/wait, the drop with re-add risk | who should I pick up, claim, add, drop, bid, how much FAAB, work the wire | Step 0 → `ff_get_roster` → `ff_list_players` (FA, W) → `ff_get_player_usage` → `ff_get_injuries` + `ff_get_depth_chart` → `ff_list_trending_players` → `ff_analyze_league_activity` → `ff_get_standings` → `ff_analyze_replacement` → `ff_analyze_waivers` → `ff_record_recommendation` | P1 |
| `trade` | Both sides' value change with intervals, playoff impact, implied drop, bye/injury, ratification risk, counters, a devil's-advocate paragraph before the verdict | trade, offer, is this fair, buy low, sell high, who should I trade with | Step 0 → `ff_get_roster` ×2 → `ff_get_standings` → `ff_get_injuries` → `ff_project_players` (ROS) → `ff_analyze_replacement` → `ff_analyze_trade` → `ff_record_recommendation` | P1 |
| `injury-cascade` | Weeks out, beneficiaries by role affinity with an evidence grade, market reaction, returning ramp, actions for your roster — after `news-check` when the news is unconfirmed | injured, hurt, out for, IR, torn, who benefits, handcuff, suspended | `news-check` if unconfirmed → Step 0 → `ff_get_injuries` → `ff_get_depth_chart` → `ff_get_player_usage` → `ff_get_schedule` → `ff_analyze_injury_cascade` → `ff_list_players` → `ff_analyze_waivers` → `ff_record_recommendation` | P1 |
| `schedule-plan` | Weeks ahead: holes from byes, cluster cost, fixes with cost, playoff multipliers with the shrinkage and the evidence caveat shown | bye, byes, playoff schedule, weeks 15–17, plan ahead, down the stretch | Step 0 → `ff_get_roster` → `ff_get_schedule` → `ff_project_players` (ROS) → `ff_analyze_replacement` → `ff_get_standings` + `ff_analyze_matchup(mode: season)` → `ff_analyze_schedule` → `ff_record_recommendation` | P1 |
| `roster-audit` | Bench plan by role, handcuff/stash values per case, consolidation, IR moves, roster-limit compliance, adds remaining | rate my team, roster audit, who can I drop, IR spot, roster limit, rest of season | Step 0 → `ff_get_roster` → `ff_get_injuries` → `ff_project_players` (ROS) → `ff_analyze_replacement` → `ff_list_players` → `ff_get_standings` → `ff_analyze_roster` → `ff_record_recommendation` | P1 |
| `news-check` | News as data with a reliability model: what the numbers say, the evidence table, what would confirm, the consequence for a pending decision — the product's prompt-injection procedure; at P1 it says "priors are hand-set" | I heard, reports say, a tweet, beat writer, is it true, rumor, story vs numbers | Step 0 → `ff_get_news` → `ff_get_injuries` → `ff_get_player_usage` → `ff_get_schedule` → (P1: the Skill reconciles; P2: `ff_analyze_evidence`) → `ff_record_recommendation` | P1 |

**Where they run.** Skills everywhere; the server in Claude Code and in Desktop via manual config; read-only is the product. If Yahoo ever grants writes: elicitation confirmation only where the client supports it, the one-time code and `ff confirm` always work — and they are unforgeable only in a session where no tool can read your files or run a shell as you; in Claude Code — or in a Desktop chat with a filesystem or shell server configured — the model could forge them, so writes are unsupported there.

Evals run in two lanes: a **zero-token structural lane** in CI on every push (frontmatter, size caps, the untrusted-text sentence verbatim, every referenced tool registered, argument templates validated against the tool schemas, ≥ 6 positive and ≥ 6 negative **time-blind** trigger prompts per Skill with a pairwise collision check, and a fixture-mode dry run of every promised tool sequence) and a **model-graded lane** run by hand before a release (~90 runs across the twelve Skills, on both model classes). See [Testing](#testing).

---

## Quickstart and installation (planned)

📋 **None of this works yet.** The commands are the ones the plan names ([`docs/plan/03-lifecycle-and-operations.md`](docs/plan/03-lifecycle-and-operations.md)); they will exist when Phase 1a/1b lands. `ff` is the package's bin name; from a checkout without a global install, `node dist/cli.js <subcommand>` is the equivalent.

1. **Apply for Yahoo Fantasy Sports API access** at `sports.yahoo.com/developer/access` — read access only is what Yahoo offers today; describe personal, single-league, read-only, locally-run use. Review latency is unknown and is the binding constraint on the whole plan. Everything in step 3 onward that does not need Yahoo can be used against a hand-filled league file in the meantime (`ManualLeagueProvider`, Phase 1a).
2. **Register the app** once approved and note the client id and client secret. Register **no callback URL**: the default login path is `oob` (you paste a code). Only the opt-in `--listener` path needs `https://localhost:8765/callback` registered.
3. **Node ≥ 24.15** (the line on which `node:sqlite` is a release candidate; Node 22 prints an experimental warning on every start and is rejected): `fnm install 24 && fnm use 24`.
4. **Clone, install, build:**
   ```sh
   git clone https://github.com/ChadPapineau/yahoo-fantasy-football-mcp.git
   cd yahoo-fantasy-football-mcp
   npm ci          # exact pins from the committed lockfile; install scripts are disabled by .npmrc
   npm run build   # emits dist/cli.js — the file every launch config points at
   ```
5. **Put the client secret in a 0600 file** outside the repo (or in the `YAHOO_CLIENT_SECRET` environment variable): `~/.config/fantasy-football-mcp/client_secret`. It is never written beside the tokens.
6. **Log in once:** `ff auth` prints a URL, you approve in the browser, Yahoo shows a one-time code, you paste it (not echoed). The CLI then probes provisioning and tells you plainly whether the app is provisioned for the Fantasy API or not.
7. **Check the installation:** `ff doctor` (offline) and `ff doctor --online` (token, provisioning, clock skew, source reachability). `--fix` repairs mode bits and missing directories after a prompt.
8. **Load the data:** `ff refresh all`, then `ff install-launchd` to schedule the nightly and game-day refreshes.
9. **Add the server to your client:** `ff print-config --client desktop` or `--client code` prints a snippet with resolved absolute paths and no secret values — see [Launch configuration](#launch-configuration-for-claude-desktop-and-claude-code).
10. **Install the Skills:** copy `skills/*` (except `_shared`) into `~/.claude/skills/`, or pass `--add-dir <checkout>/skills` to Claude Code for a session. (A Claude Code plugin manifest is a planned P1 addition.)
11. **Say `/onboard`** — the Skill finds your league and team, summarises the rules, checks the scoring engine against Yahoo's own points for a few players and tells you whether the API grants read-only or read/write access. Then `/weekly`.

Upgrades: `git pull && npm ci && npm run build`, then `ff doctor` (it warns when the client is launching a stale `dist/`). After a Node upgrade re-run `ff print-config` — the launch config carries the exact `node` binary path. Uninstall: `ff uninstall` removes what it created and prints what it will not touch (your client config, Yahoo's consent page).

---

## The `ff` CLI as built (Phase 1a)

Phase 1a is built on the `build/phase-1a` branch (the manual league: `<config>/league.yaml` + nflverse; no Yahoo). `node dist/cli.js <subcommand>` from a checkout; `ff` when installed. The MCP server registers as **`fantasy-football-mcp-server`** (not plan 03 §4.1's `fantasy-football`), because the Skills qualify tool names with it; `ff print-config` writes that name.

| Subcommand | What it does |
|---|---|
| `serve` | The MCP server on stdio (what a client launches). No network at startup; stdin EOF, SIGTERM, SIGINT, SIGHUP, EPIPE or reparenting → a clean shutdown |
| `refresh <target> [--seasons 2025,2026] [--force] [--notify] [--json]` | The only writer of dataset files. Targets: `all`, `nflverse`, `nflverse:schedules`, `nflverse:daily` (injuries + roster_weekly), `nflverse:stats`, the single source ids, `weather` |
| `status [--json]` · `doctor [--json] [--online] [--fix --yes]` | The freshness dashboard; the install diagnosis (exit code = worst finding). Neither creates nor migrates the store |
| `print-config --client desktop\|code` | The launch config with absolute paths and no secrets |
| `install-launchd [--jobs a,b] [--dry-run]` · `uninstall [--dry-run] [--purge [--purge-config] --yes]` | The six LaunchAgents below; removal (data only with `--purge --yes`) |
| `prune` · `backup [--to <abs path>]` | Expired cache rows and temp debris; a consistent `store.sqlite` backup (4 weekly copies kept) |

**Exit codes:** 0 ok · 1 failure · 2 usage or configuration · 5 `serve` forced shutdown.

**Fixture mode:** with `FF_FIXTURE_DIR=<checkout>/fixtures`, `ff refresh` reads the committed fixtures through the production HTTP client's allow-list/size/redirect code (no socket is opened) and `serve` registers the fixture-only `ff_debug_echo`. For example, into a throwaway cache: `FF_FIXTURE_DIR=$PWD/fixtures FF_CACHE_DIR=<tmp> node dist/cli.js refresh nflverse:stats --seasons 2026` (the fixtures hold 2026 stats only).

**Scheduled jobs** (`ff install-launchd`, local time; kickoffs are Eastern, so on a non-Eastern Mac they are approximate): `nflverse-schedules` every 30 min Thu/Sun/Mon and every 6 h otherwise · `nflverse-daily` 10:30 daily and 16:30 Wed–Sat · `nflverse-stats` 04:30 daily plus Sun 13:00/17:00/21:00 and 00:30 Fri/Mon/Tue · `weather` hourly at :05 Wed–Mon (dropped when `FF_WEATHER_SOURCE=off`) · `store-prune` Sun 03:00 · `store-backup` Sun 03:10.

**Checks:** `npm test` (unit + in-process integration), `npm run test:coverage` + `npm run check:coverage` (the gate), `npm run build && npm run test:process` (spawned `dist/` server: lifecycle, end-to-end over stdio, the Skills dry run, latency), `npm run smoke` (the A3a smoke over real stdio, both protocol eras), `npm run check:skills`.

---

## Configuration

**Where things live, and why.** The checkout may sit in an iCloud-synced folder (the owner's does), so nothing secret or large is ever written inside it. Tokens, the gate key and the client-secret file live in `~/.config/fantasy-football-mcp/` (directory `0700`, files `0600`; `XDG_CONFIG_HOME` honoured; `FF_CONFIG_DIR` overrides); the SQLite store, the per-source dataset files, downloads and backups live in `~/.cache/fantasy-football-mcp/` (`XDG_CACHE_HOME`; `FF_CACHE_DIR`). Neither directory is in the "Desktop & Documents" sync set. Time Machine will back the token file up — the plan documents it and the uninstall text mentions it.

**Precedence:** environment variables › `<config>/config.json` (optional; may hold no secret — `ff doctor` rejects a `client_secret` key there) › defaults ([plan 03 §3](docs/plan/03-lifecycle-and-operations.md#3-config-precedence)). Every key will be defined once, in `src/config/schema.ts`, and the table below will be **generated from that schema** by `npm run check:docs` so this README cannot drift from the code ([plan 04 §6](docs/plan/04-repo-structure-and-ci.md#6-docs-that-are-generated-not-written)).

### The planned keys (plan 03 §3)

| Key | Required | Default | Meaning |
|---|---|---|---|
| `YAHOO_CLIENT_ID` | yes | — | The Yahoo app's client id |
| `YAHOO_CLIENT_SECRET` **or** `YAHOO_CLIENT_SECRET_FILE` | one of | file: `<config>/client_secret` (must be `0600`) | The client secret — Yahoo requires a confidential client (no PKCE). Prefer the file so no client config ever carries the value |
| `FF_CONFIG_DIR` | no | `$XDG_CONFIG_HOME/fantasy-football-mcp` or `~/.config/fantasy-football-mcp` | Tokens, gate key, secret file, auth certificate, `league.yaml` (manual provider) |
| `FF_CACHE_DIR` | no | `$XDG_CACHE_HOME/fantasy-football-mcp` or `~/.cache/fantasy-football-mcp` | `store.sqlite`, `ds/<source>.sqlite`, recordings, backups |
| `FF_LEAGUE_KEYS` | no | every league discovered at `ff auth` | Narrows the league allow-list |
| `FF_TOOLSET` | no | `core` | `core` registers the 19 P0 tools; `full` adds the P1/P2 analytics (30, then 31 tools) |
| `FF_WRITE_ENABLED` | no | unset (writes off) | Your statement that Yahoo granted read/write for this client id; requests `fspt-w` at login and registers the write tools once read provisioning is confirmed. **Unsupported in any session where the model has file or shell reach** ([Security model](#security-model)) |
| `FF_AUTH_PORT` | no | `8765` | The opt-in `ff auth --listener` port — fixed, never falls back, because the callback must match Yahoo's registration exactly |
| `FF_LOG_LEVEL` | no | `info` | `error` · `warn` · `info` · `debug`; JSON lines on **stderr only** (stdout is the MCP transport) |
| `FF_WEATHER_SOURCE` | no | `open-meteo` | `open-meteo` (keyless, non-commercial terms) or `nws` (keyless, US venues, public domain) |
| `ODDS_API_KEY` | no | unset (source disabled) | The Odds API free tier as a secondary lines source (≤ 3 polls a day) |
| `FF_FIXTURE_DIR` | test only | unset | Serves recorded, anonymised Yahoo fixtures instead of the network; refused when `YAHOO_CLIENT_ID` is set |

### `.env.example`, line by line

The repository's [`.env.example`](.env.example) was written on day one, **before the plan**, and the plan deliberately leaves it untouched until the config schema exists ([plan 04 §1](docs/plan/04-repo-structure-and-ci.md#1-directory-tree)). Read it as a statement of intent — every value is a placeholder and real tokens never live in a `.env` — and note where the plan's names differ:

| Line | What it means | Where the plan landed |
|---|---|---|
| `YAHOO_CLIENT_ID=your-yahoo-client-id-here` | The app's client id | Same key, same meaning |
| `YAHOO_CLIENT_SECRET=your-yahoo-client-secret-here` | The secret | Same key; the plan adds `YAHOO_CLIENT_SECRET_FILE` and recommends it |
| `YAHOO_REDIRECT_URI=https://localhost:8787/oauth/callback` | The callback registered on the Yahoo app | The plan's default login is `oob`, which needs **no** redirect URI; the opt-in listener uses `https://localhost:<FF_AUTH_PORT>/callback` with `8765` as the default port. The comment "Create an app with the Fantasy Sports Read/Write permission" predates the finding that Yahoo's form no longer offers write access |
| `YFF_TOKEN_STORE=~/.config/yahoo-fantasy-football-mcp/tokens.json` | Where tokens are persisted, outside the repo, mode `0600` | The plan keeps the idea and changes the shape: `FF_CONFIG_DIR` names the *directory* (`~/.config/fantasy-football-mcp/`), `tokens.json` inside it is fixed |
| `YFF_LOG_LEVEL=info` | Log verbosity; stderr only | `FF_LOG_LEVEL` |
| `YFF_CACHE_DIR=~/.cache/yahoo-fantasy-football-mcp` | Local cache for third-party NFL data | `FF_CACHE_DIR` (`~/.cache/fantasy-football-mcp/`) |
| `# ODDS_API_KEY=` | Optional The Odds API key; leave blank to disable | Same key, same meaning |
| `# WEATHER_API_KEY=` | Placeholder for a weather key | Not needed: both planned weather sources are keyless; `FF_WEATHER_SOURCE` picks one |

Once `src/config/schema.ts` exists the example file will be regenerated from it and this table will be replaced by the generated one.

---

## Launch configuration for Claude Desktop and Claude Code

📋 Planned; the shapes are from [plan 03 §4](docs/plan/03-lifecycle-and-operations.md#4-launch-configuration-absolute-paths-env-no-secrets). Two rules that come from failures the owner has actually hit with local MCP servers: **always absolute paths** (GUI clients launch with a minimal `PATH` — no `nvm`/`fnm`/`volta` shims — and relative paths resolve against the client's working directory), and **no secret values in the client config** (reference the secret *file*). `ff print-config` emits exactly this with the paths resolved from the running `node` binary and the built `dist/cli.js`, so you never type them.

**Claude Desktop** — paste into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS; the path is verified at build time):

```json
{
  "mcpServers": {
    "fantasy-football": {
      "command": "/ABSOLUTE/PATH/TO/node",
      "args": ["/ABSOLUTE/PATH/TO/yahoo-fantasy-football-mcp/dist/cli.js", "serve"],
      "env": {
        "YAHOO_CLIENT_ID": "<your client id>",
        "YAHOO_CLIENT_SECRET_FILE": "/ABSOLUTE/PATH/TO/HOME/.config/fantasy-football-mcp/client_secret",
        "FF_LOG_LEVEL": "info"
      }
    }
  }
}
```

`/ABSOLUTE/PATH/TO/node` is the exact binary `ff print-config` finds in `process.execPath` (under a version manager that is a versioned path, which is the point — it survives a shell-less launch). Optional additions: `"FF_TOOLSET": "full"` once the Phase 2 analytics exist; `"FF_CONFIG_DIR"` / `"FF_CACHE_DIR"` if you moved them.

**Claude Code** — `ff print-config --client code` prints the equivalent `claude mcp add` line at **user scope**, so no secret or absolute user path ever lands in the public repository's `.mcp.json` (flag syntax to be verified against the Claude Code docs at build time):

```sh
claude mcp add --scope user fantasy-football \
  -e YAHOO_CLIENT_ID=<your client id> \
  -e YAHOO_CLIENT_SECRET_FILE=/ABSOLUTE/PATH/TO/HOME/.config/fantasy-football-mcp/client_secret \
  -e FF_LOG_LEVEL=info \
  -- /ABSOLUTE/PATH/TO/node /ABSOLUTE/PATH/TO/yahoo-fantasy-football-mcp/dist/cli.js serve
```

A Claude Code session is a **reach session** (the model runs `Bash`/`Read`/`Edit`/`Write` as you), so it is read-only by design here: do not set `FF_WRITE_ENABLED` in it. If Yahoo ever grants writes, the plan *offers* — never assumes — a `permissions.deny` set for Claude Code as the way to make the flag supportable there: `Bash(cat ~/.config/fantasy-football-mcp/**)`, `Bash(ff confirm*)`, `Edit(.claude/settings*.json)`, `Edit(**/hooks.json)`, plus the refresh token in the macOS Keychain. Even then a shell can route around a deny-list (`sed`, `python -c`), so the plan calls writes in such a session unsupported, not safe. `ff doctor` reads whichever client configs it finds, checks that `command` and `args[0]` are absolute, exist and are Node ≥ 24.15, and warns if a config that holds a `YAHOO_CLIENT_SECRET` value is group- or world-readable.

---

## Security model

A summary of [`docs/plan/02-security-architecture.md`](docs/plan/02-security-architecture.md); reporting is in [`SECURITY.md`](SECURITY.md).

**One rule, stated plainly.** No roster change happens without an explicit human confirmation — and in a **no-reach session** (no tool in the session can read your files or run a shell as you) that confirmation is one the model cannot forge. In a **reach session** — Claude Code always; a Claude Desktop chat whenever a filesystem, shell, terminal or git MCP server is configured beside this one — the model has the same reach through a sibling tool, so the server-side gate is defence-in-depth, the actual gate is the client's permission prompts and your own hooks, and **writes are unsupported** there: not "safe", unsupported. Every "cannot" in the plan names the session condition it holds under; a claim with no condition is a server-side property that holds everywhere.

| Control | What the plan specifies |
|---|---|
| **Confidential OAuth client** | Authorization-code grant (Yahoo has no PKCE); `client_id` + secret from an env var or a `0600` file, never stored beside the tokens, never logged, never in a tool result. `oob` login by default — no listener, no port, no certificate, no callback to register. Refresh-once semantics; the new refresh token is persisted **before** the new access token is used (rotation); refreshes are serialised across processes by a lockfile, and a process that finds the token file's version changed reloads instead of refreshing |
| **Token store** | `~/.config/fantasy-football-mcp/tokens.json`, dir `0700`, file `0600`, written `wx` + fsync + rename, mode bits verified on every open; `version` counter; a `provisioning` block that caches the terminal not-provisioned diagnosis so the server stops calling Yahoo. **Reach session:** the model can read this file — stated plainly and accepted for read-only Phase 1 (a read token buys nothing the tools do not already give). Before writes are ever supported, the refresh token moves to a macOS Keychain `SecretSource` — which removes it from disk and backups; in a reach session that is a hurdle, not a proof |
| **Least privilege** | Read scope by default; `fspt-w` requested only with `FF_WRITE_ENABLED=1`; write tools are **registered only** when writes are enabled *and* read provisioning succeeded, and the first rejected write unregisters them with `tools/list_changed`. A hidden tool has no name for injected text to invoke |
| **Confirmation gate** | `ff_prepare_*` → human channel → `ff_commit_*`. Ticket = HMAC-SHA256 over `{prepared_id, kind, diff_hash, precondition_hash, expires_at, nonce}` with a persisted `0600` key; 10-minute TTL; **compare-and-set** on a freshly re-fetched precondition at commit (a game kicked off, someone else claimed the player → `PRECONDITION_CHANGED`, re-prepare and re-read the diff); single use enforced by the journal; a repeat commit returns the original receipt. Three human channels in priority order: (1) form-mode elicitation (the client renders the dialog; the model writes no MCP messages), (2) a one-time 6-digit code shown in a macOS notification together with the diff summary — **no pending file**, only `sha256(code)` in the journal, 3 attempts, (3) `ff confirm <id>` on a **TTY**. All three are unforgeable in a no-reach session; all three are forgeable in a reach session, which is why the flag is unsupported there and `ff doctor` warns (Claude Code launch detected, or other `mcpServers` entries in the Desktop config — a heuristic that says "may") |
| **Input validation** | Zod v4 `.strict()` on every tool (unknown keys rejected); every string has a max, every number bounds; a Yahoo key grammar per key kind, property-tested against 12 mutations; a league allow-list; **one path builder** with a whitelist of resources and filters that rejects `..`, `/`, `;`, `?`, `#` and whitespace in values; **no raw-GET tool**; write XML built by a serializer, never string templates |
| **XML safety** | `fast-xml-parser` with `processEntities: false` and `htmlEntities: false` set **explicitly** (the library's default is to expand — verified at source during the review); fixtures prove an internal-`DOCTYPE` entity is not expanded and the billion-laughs document is inert; a mutation check flips the flag and requires the test to go red; 5 MB body cap |
| **Prompt-injection defences** | Manager- and editor-authored text is wrapped (`untrusted_text` with `source`, caps of 32–400 chars by class, HTML stripped, control/zero-width/bidi code points removed, NFC, URLs never clickable); Yahoo-authored player names are bare capped strings listed by path in `meta.untrusted_fields[]`; the model's own recommendation-log text is listed the same way on read-back — a test walks every tool's output and asserts no unlabelled third-party string exists. The rule is served **once** in the server's `instructions` field, pointed to from every tool description, and repeated verbatim in `ff://docs/tool-outputs` and in every Skill (the pointer is the guarantee; the `instructions` field is the economy). No write argument accepts a player name; news feeds analytics only as deterministic structured features; no Skill may commit in the turn in which it read news |
| **Supply chain** | `save-exact`, committed lockfile, `npm ci` only, `ignore-scripts=true`, `npm audit --omit=dev --audit-level=high` as a gate, a runtime allow-list that is the **full transitive tree with its count** (5 or 11 packages depending on the `fast-xml-parser` line pinned), a licence allow-list, no native addons, no install scripts, actions pinned by SHA, an `httpClient` host allow-list (`fantasysports.yahooapis.com`, `api.login.yahoo.com`, GitHub release hosts, `api.sleeper.app`, the two RSS hosts, `api.open-meteo.com`, `api.weather.gov`, `api.the-odds-api.com`) — nothing else can be reached through the server |
| **Logging and errors** | stderr JSON lines only; known secret values and token-shaped patterns replaced with `[redacted:<kind>]`; query strings stripped; upstream bodies HTML-stripped and truncated to 500 chars in the log and **never** in a tool result; error messages are fixed strings from a table |
| **No telemetry** | No remote error reporting, no analytics sink; one user, one machine, one league |
| **Public repository** | Fixtures anonymised by a scrubber that aborts if a real identifier survives; gitleaks with Yahoo-specific rules on every push and weekly across history; GitHub push protection on |

The threat model ([plan 02 §8](docs/plan/02-security-architecture.md#8-threat-model)) lists twenty threats with mitigation and **residual risk** for each — including the one no server-side control removes: a user persuaded by the model to type the code or press Approve. The diff-first rule and compare-and-set are the mitigations, not the cure.

---

## Testing

From [`docs/plan/05-testing-strategy.md`](docs/plan/05-testing-strategy.md). The standard: everything ships with tests, adversarial by default, the coverage gate is never lowered to pass, and a regression test counts only once it has been shown red against the un-fixed code (mutation-verified). Two lessons from the owner's other project shape it: *fake the native seam with its failure modes* (2,376 green tests once shipped a broken run because the fake modelled the API they wished for) and *test the property, not the value* (four of ten field findings were regressions from fixes that passed their own tests). 📋

| Level | Tool | In CI | Yahoo credentials | Model tokens |
|---|---|---|---|---|
| Unit (mirrors `src/`) | Vitest | every push | no | no |
| Property — scoring engine (14 invariants), key grammar, envelope size and labelling, freshness classifier, log redactor, limiter | Vitest + fast-check | every push | no | no |
| Contract — every Yahoo endpoint against **recorded, anonymised XML fixtures** (five known shape traps) | Vitest, `FixtureTransport` | every push | recording only, by hand, never in CI | no |
| Fault injection — 999 with HTML, 429/5xx, timeout, reset, non-XML, malformed, XXE, `token_rejected` once/twice, not-provisioned, `invalid_grant`, torn token write, two-process refresh race, a 3-second writer lock held by another process, network errors on a refresh | injected `fetch`, no `nock`/`msw` | every push | no | no |
| Process / lifecycle — spawns the built binary: startup < 1 s with no network, stdin EOF → exit 0, SIGTERM, double SIGINT → forced exit 5, orphaned by a SIGKILLed parent, EPIPE, in-flight write journaled `sent_unknown`, listener port busy → exit 2, `serve` opens no socket, newer-store refusal, every historical migration | Vitest spawning `dist/cli.js` | every push (ubuntu); weekly on macOS | no | no |
| Confirmation gate — accept/decline/cancel, wrong code ×3, tampered and expired tickets, replay, precondition change, TTY refusal, no file written during the code channel, the sibling-server heuristic, legacy protocol era | in-process client ↔ server over `InMemoryTransport` | every push | no | no |
| Inspector smoke — `tools/list` equals the expected list in registry order (19 under `core`, no write tools), a call returns the envelope with attribution and freshness, `resources/list` carries `ttlMs`, the `instructions` field carries the untrusted-text rule exactly once and every description the pointer | `@modelcontextprotocol/inspector --cli` in fixture mode | every push | no | no |
| Skills Lane 1 — structure, caps, verbatim rule, registered tools, argument templates, time-blind trigger prompts, collision check, fixture dry run of every tool sequence | `npm run check:skills` | every push | no | no |
| Live smoke — leagues, settings, one roster week scored against Yahoo's totals | `ff smoke` | **never** | yes | no |
| Model-driven evals — 10 read-only, multi-hop questions over the frozen fixture league, pass bar ≥ 8/10 | the mcp-builder Python harness | manual, pre-release | no (fixture mode) | **yes** |
| Skills Lane 2 — the per-Skill cases (ON-, WK-, SS-, KD-, RT-, AP-, WV-, TR-, IC-, SP-, RA-, NC-), rubric ≥ 80 %, trigger evals on two model classes; the injection cases run twice, with wrappers on and off, so the wrapper's value is a number | `npm run eval:skills` | manual, pre-release | no | **yes** |

**Coverage gate:** 90 % lines / 85 % branches / 90 % functions globally, and **100 % lines and branches** for seven named modules where an untested branch is a silent wrong score, an accepted bad key, an unrecognised terminal error, a torn token file, a leaked secret or a wrong calibration metric: `src/domain/scoring/**`, `src/domain/gate/**`, `src/providers/yahoo/path.ts`, `src/providers/yahoo/errors.ts`, `src/auth/token-store.ts`, `src/cli/log.ts`, `src/domain/reclog/metrics.ts`. Enforced in CI by `scripts/check-coverage.ts`; never lowered to pass a build.

**Zero tokens, zero credentials:** lint, typecheck, unit, property, contract, fault, process, gate, Inspector smoke, coverage, audit, licence and dependency allow-list checks, secret scan, Mermaid rendering, link check, Skills structure, tarball scan. The only credentialed steps are fixture recording and `ff smoke`, on the owner's machine; the only token-consuming steps are the two model-graded eval lanes, before a release.

**Fixtures** are recorded by a manual script through the real provider, then passed through a **scrubber** that rewrites league ids to the placeholder range `461.l.1000…`, team names to `Team N`, managers to `Manager N`, notes to `note N`, removes URLs, GUIDs and e-mails, keeps public-figure player data, and **aborts** if any real identifier survives; a manifest hash makes a "quick edit" to a fixture a deliberate, reviewed change. Every latency or size bound in the plan names the fixture or dataset size it is measured on and the test that measures it.

---

## Contributing

The build has not started; contributions of the *plan* — a claim that is wrong, an assumption that can be verified, an objection the adversarial round missed — are welcome now as issues. Once code exists ([`docs/plan/04-repo-structure-and-ci.md`](docs/plan/04-repo-structure-and-ci.md)):

- **Conventional Commits** (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`), checked by a script on every PR commit and the PR title; `Co-Authored-By` trailers are fine.
- **Stage explicit paths only** — never `git add -A`, `-u` or a directory. The PR template asks you to confirm it.
- **No secrets, no identifiers, ever** — not a real client id, token, GUID, league or team key, e-mail, username or team name. The repository is public; the `secrets` workflow (gitleaks with Yahoo-specific rules) and GitHub push protection run on every push, and a weekly job scans the whole history.
- **Fixtures are anonymised** through the scrubber; only the placeholder id range may appear.
- **Everything ships with tests**; the coverage gate is untouched.
- **Adding a runtime dependency** needs a row in plan 04 §2 with the reason and the rejected alternative, and it must pass the no-install-scripts, licence and full-tree allow-list checks.
- **Docs move with the code:** the plan or research doc a change touches, `docs/HANDOFF.md` if status changed, `CHANGELOG.md` (Keep a Changelog) once it exists.

**CI checks that gate a PR** (what exists today is marked):

| Job | What fails it | Status |
|---|---|---|
| `docs` → `mermaid` | Any ```` ```mermaid ```` block in any Markdown file that does not render under the pinned `@mermaid-js/mermaid-cli` (the checker first proves it can fail on a known-bad fixture) | ✅ |
| `docs` → `links` | Any internal Markdown link or `#fragment` that does not resolve | ✅ |
| `secrets`, `secrets-selftest`, `secrets-history` | Any gitleaks finding (7 Yahoo rules + defaults) not on the allow-list; the self-test asserts every rule fires on its fixture and stays quiet on the placeholders; weekly full history | ✅ |
| `ci.yml` → `lint`, `typecheck` | ESLint (type-checked, import boundaries between `mcp` / `domain` / `providers` / `sources` / `store`, `no-console` outside `src/cli`), Prettier, commit format | 📋 |
| `ci.yml` → `test` | Any failing test; coverage below the gate; a 100 %-module below 100 % | 📋 |
| `ci.yml` → `process`, `smoke` | Lifecycle tests against the built binary; the Inspector tool-list assertion | 📋 |
| `ci.yml` → `supply-chain`, `pack` | A high/critical runtime advisory, an install script, a licence outside the allow-list, a package at any depth not on the allow-list; a tarball that carries fixtures, tests, `.env*`, `*.sqlite` or a key outside the placeholder range | 📋 |
| `docs` → `skills`, `docs-current` | A Skill failing Lane 1; a generated README table or tool reference that differs from the code | 📋 |

**Branch rules:** `main` gets a ruleset (no force-push, no deletion, linear history) and **no required status checks** during the docs phase — a required check would reject every direct push that has not run the check somewhere, which breaks the "push before you are torn down" rule the agent program runs on. The substitute is an obligation on every pusher: verify the push's `docs` and `secrets` runs and fix or revert a red `main` before reporting. When product code lands, PRs with all `ci.yml` jobs green become required (no required reviewers — solo maintainer).

**Running the Skills evals** (📋): `npm run check:skills` runs Lane 1 with zero tokens (it is the `docs` → `skills` job); `npm run eval:skills` runs Lane 2 — the cases in each `skills/<name>/evals/cases.json` against the fixture league in `FF_FIXTURE_DIR`, with the Skill body as the system prompt — and writes the report to `docs/evals/<date>.md`. The 10-question read-only eval is `python scripts/evaluation.py -t stdio -c node -a dist/cli.js serve -e FF_FIXTURE_DIR=<abs path> -o docs/evals/<date>.md tests/evals/read-only.xml` (needs `pip install anthropic mcp` and an `ANTHROPIC_API_KEY`). Both consume tokens; run them before a release and after any tool-description or Skill change, never on every push.

---

## Roadmap

From [`docs/plan/10-phasing-and-acceptance.md`](docs/plan/10-phasing-and-acceptance.md). Effort: S ≈ days, M ≈ 1–3 weeks, L ≈ 4–8 weeks of one senior engineer with agents; **no dates**. Every acceptance criterion is a test, a CI job, a fixture assertion or a one-line manual check with named evidence; soft gates report a number and must not regress, hard gates block the tag. Phase 1 is split so the Yahoo-free half proceeds while the access application is pending; a **dated decision gate** (4 weeks after the application or NFL week 9, whichever is earlier) names the fallbacks instead of waiting indefinitely.

| Phase | Scope in one line | Effort | Exit gate (summary) | Status |
|---|---|---|---|---|
| **Before code** | Plan approval by the owner; the Yahoo access application submitted (it precedes Phase 0 and starts the decision clock) | — | approval recorded; application date recorded in `docs/HANDOFF.md` | 🚧 approval pending · 📋 application |
| **0 — Foundation** | Docs-only repo protections (live), package skeleton with the four pinned runtime dependencies, `ci.yml` skeleton, the branch ruleset | S | Z1–Z4: `docs`/`secrets` green; every plan Mermaid block renders; `npm ci && lint && typecheck` pass on an empty `src/` with the boundary rules; the Mermaid job green with `.npmrc` present | ✅ CI half · 📋 rest |
| **1a — Read-only MVP, Yahoo-free half** | Store + migrations, `ff refresh` for nflverse `schedules`/`injuries`/`roster_weekly`/`stats_player_week` and weather, crosswalk, scoring engine over nflverse lines, projections v1, lineup, K/DEF ranking, recommendation log + retrospective, the 19 P0 tools under `core` with `ManualLeagueProvider`, Skills `start-sit`/`stream-kdef`/`retro` + `onboard` (manual), the data launchd jobs. Two cuts — **1a-minimum** (store, three datasets, crosswalk, engine, E1/E2/E5, two Skills, the log) and **1a-full** — are the owner's choice at approval | L | A1a engine properties at 100 % coverage · A3a Inspector smoke (19 tools, `instructions` once, pointer everywhere) · A4a store and source fault rows incl. dataset publish/re-attach and the 3-s lock contention test (p95 < 300 ms, zero errors) · A5a crosswalk on the fixture YAML · A6 envelope labelling and size ledger · A7 start/sit regret ≤ "last week's points" (hard) with `pwin` vs `mean` reported · A8 K/DEF ≥ 3 candidates with implied totals · A9 retrospective metrics with the "n too small" naming · A10 Skills Lane 1 · A13–A15 process, coverage, latency · A17 structured-content spike | 📋 |
| **1b — Read-only MVP, Yahoo half** | `ff auth` + token store + lockfile, `YahooProvider` (XML, path builder, limiter, cache, error classifier), the platform-fact tools over Yahoo, the golden test against `player_points`, Yahoo fixtures, `ff smoke`, Skills `onboard` (Yahoo)/`weekly`/`apply` (read-only), the credentialed launchd jobs. Starts on a provisioned token; pauses at the decision gate if none | M | A1b golden gate (every rostered player-week within 0.01) · A2 live self-check · A3b/A4b Inspector and Yahoo fault rows · A5b ≥ 95 % crosswalk · A11b/A12 model-graded evals ≥ 8/10 · A16 usefulness check on the live league · A18 XML safety with the mutation check · A19 elicitation verified per client. **Tag `v0.1.0` when both halves are green** | 📋 |
| **Decision gate** | Read grant → 1b proceeds. No grant → **X1**: `v0.1.0` ships from 1a's green SHA with `ManualLeagueProvider` for the owner's league (keeps start/sit over his roster, an availability-blind K/DEF ranking, the log and `retro`; loses the live FA pool, opponent rosters, game-day inactives; costs a weekly YAML re-edit) and **X2**: `SleeperProvider` is pulled forward as the first second platform | — | — | 📋 |
| **2 — Usage, market, P1 engines** | Team stats, snaps, pbp subset, ffopportunity, Sleeper, DynastyProcess, depth charts, news, optional odds; the 11 P1 tools (30 under `full`); the 6 P1 Skills; `live`/`season` matchup modes; a second fixture league for the unverified engine branches; the plugin manifest (if chosen); two prior seasons for soft backtests | L | B1–B14: every source loads with schema assertion and shows its licence; usage for ≥ 95 % of rostered players; ≤ 2 unmatched on the live league; waiver-detector precision reported; trade/cascade/schedule invariants; the news injection fixtures never unlabelled; live mode never lists a locked slot; 30 tools in order; Lane 2 for all 12 Skills. Tag `v0.2.0` | 📋 |
| **3 — Model wave** | `v2-opportunity` projections, redistribution priors from pbp history, the calibrated source table and `ff_analyze_evidence`, weekly parameter re-fit with proposals applied only by a human, ≥ 3 held-out seasons | L | C1–C9: v2 beats trailing-4 on CRPS and Spearman on ≥ 2 held-out seasons with 80 % coverage within ±5; start/sit regret below the baselines and `P(win)` calibrated per decile; `P(win)` Brier below Yahoo's; waivers and cascades beat their baselines; news calibration at n ≥ 200; attribution populated. Tag `v0.3.0` | 📋 |
| **W — Conditional writes** | **Only if Yahoo grants write.** Prerequisites first: the refresh token in the Keychain, the README's session rule, the doctor warning. Then `fspt-w`, the gate with its three channels, the 7 write tools, journal reconcile, `apply` in write mode, Desktop and Code elicitation smoke, write fixtures recorded from the first real writes | M | W1–W11: every gate test green; write tools appear only when provisioned and vanish on the first rejection; no prepare accepts a name; never auto-retried; a live round trip on the real league through each channel with evidence; a signed Keychain helper priced and decided, never assumed | 📋 conditional |
| **4 — Later** | `SleeperProvider` (X2), draft tools and Skill, ESPN after Sleeper (ToS-blocked today), Streamable HTTP + auth server for a hosted variant, marketplace release, commercial source swaps, `ff_get_playbook`, `ff_analyze_scoring` | M each | per item | 📋 |

Ten product decisions with stated defaults (commercial distribution, a paid projection baseline, the plugin manifest, an odds key, the FAAB budget at onboarding, `apply` at P0, a token budget for nightly evals, a second fixture league, backtest seasons, live `P(win)` in Phase 1) and the application decision **D0** that outranks them are listed in plan 10 §5 for the owner.

---

## FAQ

**Why read-only first?**
Two reasons that reinforce each other. Yahoo's API "currently provides read access only" and write access "is not available at this time" — so a write-first design would be a design for an API that does not exist for a personal app. And the owner decided that thorough reads plus intelligent recommendations *are* the product; writes are a bonus. The plan therefore makes every Skill fully useful read-only (`apply` gives you the exact clicks in Yahoo's vocabulary) and designs the write path as a conditional phase.

**Will it ever change my roster without asking?**
**Never.** There is no code path from any tool call to a Yahoo write that does not pass through `ff_prepare_*` (a preview and a journal row), a human confirmation through a channel the model does not author, and `ff_commit_*` with an HMAC-bound, single-use, compare-and-set ticket. Writes are off by default (`FF_WRITE_ENABLED` unset), the write tools are not even registered until Yahoo has provisioned the app, and no write argument accepts a player name. The honest qualification is about *sessions*, not about the server: in a session where the model already has your files and shell (Claude Code, or a Desktop chat with a filesystem/shell server configured), it could forge the confirmation channels, which is why writes are declared unsupported there rather than "safe".

**What if Yahoo denies API access, or never answers?**
The plan is built for that branch. Everything that does not need Yahoo — the store, the nflverse ingestion, the scoring engine, projections, lineup and K/DEF analytics, the recommendation log and the retrospective, four Skills — is Phase 1a and is built and accepted first. At a dated decision gate with no grant, **X1** ships: the same product over a hand-filled `league.yaml` (`ManualLeagueProvider`) for the owner's league — start/sit over his own roster, an availability-blind K/DEF ranking, the log — at the cost of a weekly re-edit and without the live free-agent pool, opponent rosters or game-day inactives; and **X2**, a `SleeperProvider`, is pulled forward so the public gets a platform that can actually be built (Sleeper's read API is public and keyless). Every line of Phases 2–3 stays valuable for the following season.

**Why not scrape Yahoo's website instead of waiting for API access?**
Because the API is the sanctioned surface. Yahoo's developer terms (the full agreement is presented at application time) bar altering the API or separating its underlying data and bar automated means for account creation; a logged-in browser driven by a model sits outside that contract, and in the audited repositories that do it — one hands the model a logged-in Chrome profile — the audit's verdict is **Do not use**. The plan's fallback under a denial is honest degradation (X1/X2), not a workaround of the terms.

**Does it work for other leagues and formats — half-PPR, superflex, TE premium, 2 flex, 6-point passing TDs, FAAB or priority waivers?**
**Yes, by construction.** Nothing about scoring, slots or rules is hard-coded: `ff_get_league` reads *your* league's `stat_categories`, `stat_modifiers`, `roster_positions` and rules from Yahoo, the engine maps stat ids to canonical names by pattern (so a league that enables "Rushing 1st Downs" resolves on first read), bracket families for points-allowed and field-goal distance are derived from the setting names, and every projection is stored format-agnostically and scored per league. The engine is checked against Yahoo's own `player_points` for every rostered player-week in the fixtures, and `onboard` runs the same check on your league. Format sensitivity is a named part of every analytics method in the research.

**ESPN? Sleeper?**
Both sit behind the same `FantasyPlatform` seam, with four named implementations: `YahooProvider` (Phase 1b), `ManualLeagueProvider` (Phase 1a and fallback X1), `SleeperProvider` (fallback X2 / Phase 4 — the **first** second platform, because Sleeper's read API is public, keyless and not ToS-blocked) and `EspnProvider` (later, seam only: ESPN's unofficial API is blocked by Disney's terms of use today). The seam abstracts league discovery, normalised scoring settings, roster slots, players, stats, matchups, standings, transactions and write intents; the only cross-platform player identity is `gsis_id` through the crosswalk. Tool names never say "yahoo" for this reason (`ff_` prefix).

**Where are my tokens and my data?**
Tokens, the gate key and the client-secret file: `~/.config/fantasy-football-mcp/` (`0700`/`0600`). Cache, datasets, recordings and backups: `~/.cache/fantasy-football-mcp/`. Both are outside the repository and outside iCloud's Desktop & Documents sync. `ff uninstall` removes them after asking (the recommendation log and write journal live there and are not rebuildable; `--export-journal` saves them first) and tells you where Yahoo's consent can be revoked.

**Is my league data sent anywhere?**
Only to the hosts on the server's allow-list, and only for the purpose each serves: **Yahoo** (`fantasysports.yahooapis.com`, `api.login.yahoo.com`) for your league; **GitHub release hosts** (`github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`) to *download* nflverse, ffopportunity and DynastyProcess files — nothing is uploaded; **`api.sleeper.app`** for trending adds/drops and player ids (public, keyless); **`rotowire.com`** and **`espn.com`** RSS feeds; **`api.open-meteo.com`** or **`api.weather.gov`** for stadium weather; **`api.the-odds-api.com`** only if you set a key. Your league data itself goes to none of them: the external sources are read, never written. There is no telemetry and no remote error reporting. The model, of course, sees what the tools return — that is the point — through your MCP client.

**Can I run it remotely, or install it from claude.ai?**
Not in v1, and the plan says why: it would need a publicly reachable HTTPS endpoint acting as an OAuth 2.1 resource server, a hosted Yahoo callback, and it would put one developer's single Yahoo client id behind a multi-user service — the confused-deputy shape the MCP security guidance warns about. The design is a local stdio server per machine, `ff auth` once, tokens local. The Streamable HTTP + authorization-server variant is a Phase 4 item with its requirements written down, pulled only by a second user or a wish to host.

**Are the projections any good?**
They are ours and they are labelled: every projected number carries `meta.estimate: true`, a `model_version` and a distribution whose `basis` says where its spread came from (a position-level table in v1, a per-player simulation in v2). Whether they beat "last week's points" is an acceptance criterion the retrospective measures, not a claim the README makes.

---

## Acknowledgements

The design stands on research recorded in [`docs/research/`](docs/README.md). Nothing was copied from any third-party repository; the repositories below were read statically (never installed or executed) and are acknowledged as **inspiration only**. Their verdicts, evidence and the mistakes to avoid are in [`docs/research/01-repo-security-audit.md`](docs/research/01-repo-security-audit.md) and [`02-prior-art-lessons.md`](docs/research/02-prior-art-lessons.md).

**Prior art the design learned from (inspiration only):** `asteiger/yahoo_fantasy_mcp`, `spilchen/yahoo_fantasy_mcp` and `spilchen/yahoo_fantasy_api`, `brettadams0/yahoo-fantasy-mcp`, `kwonye/yahoo-fantasy-agent`, `michaelfromorg/mcp-yahoo-fantasy`, `deepak-or1/yahoo-fantasy-mcp`, `whatadewitt/yahoo-fantasy-sports-api`, `uberfastman/yfpy`, `josuebrunel/yahoo-oauth`, `nflverse/nflreadpy` and `nflverse/nflreadr`, `ffverse/ffscrapr`, `dtsong/sleeper-api-wrapper`; and, for the Skills design, `TheClaudeFather/ff-advisor`, `jdguggs10/flaim`, `eponerine/espn-fantasy-football-mcp-node`, `HamCops/dodi` and `jbaros/sleeper-ffb-worker` ([`06-skills-and-mcp-design.md` §C](docs/research/06-skills-and-mcp-design.md#c-prior-art--vetted-inspiration-only)). Several other repositories in the audit are marked *Do not use* — chiefly for real credentials in their git history — and taught only by counter-example.

**Data providers** (each `DataSource` carries its licence, and `ff status` lists the non-commercial and share-alike ones so the constraint is visible in the running system):

| Provider | Used for | Licence / terms |
|---|---|---|
| [nflverse](https://github.com/nflverse/nflverse-data) | Play-by-play, weekly stats, snap counts, injuries, depth charts, rosters and id crosswalk, schedules with betting lines | CC-BY 4.0; FTN-derived charting CC-BY-SA 4.0 ("FTN Data via nflverse") |
| [ffopportunity](https://github.com/ffverse/ffopportunity) (ffverse) | Expected fantasy points | Models and data CC-BY-SA 4.0 |
| [Sleeper API](https://docs.sleeper.com/) | Trending adds/drops, player ids and injury fields | Free for non-commercial use, no key |
| [DynastyProcess](https://github.com/DynastyProcess/data) | Player-id crosswalk seed | Licence not stated in the repository (recorded as unverified) |
| [Open-Meteo](https://open-meteo.com/) | Stadium weather forecasts | CC-BY 4.0 data; free API for non-commercial use |
| [NWS `api.weather.gov`](https://www.weather.gov/documentation/services-web-api) | Weather for US venues | US government data, public domain |
| [The Odds API](https://the-odds-api.com/) | Optional secondary betting lines | Free tier by key; storing permitted; attribution not required |
| RotoWire and ESPN RSS | Player news (editorial feeds; all text treated as untrusted) | Publishers' feed terms |

**Standards and references:** the [Model Context Protocol specification](https://modelcontextprotocol.io/specification/latest) (revision 2026-07-28) and the official TypeScript SDK (`@modelcontextprotocol/server` v2), the MCP Inspector, and Anthropic's `mcp-builder` and `skill-creator` authoring references and Agent Skills format.

**Attribution.** *Fantasy data provided by [Yahoo Fantasy](https://football.fantasysports.yahoo.com/).* Yahoo's developer terms ask for this line, linking back to Yahoo Fantasy, together with the official Yahoo Fantasy logo used unaltered wherever Yahoo data is displayed. The logo file is **not** redistributed in this repository (brand-use terms); a UI that renders this server's output should place the unaltered logo next to the line above, obtained from Yahoo's Fantasy Sports developer pages (`sports.yahoo.com/developer`), where the attribution terms were verified. Tool results carry the same line and link in `meta.attribution` on every result that used Yahoo data, and every Skill repeats it in its output template.

---

## License

[MIT](LICENSE) — `Copyright (c) 2026 Chad Papineau`.

Why MIT: it is the norm for MCP servers and small open-source tools, it maximises reuse (a fork, a provider for another platform, a Skill lifted into another bundle), and it carries no NOTICE-file overhead. Apache-2.0's explicit patent grant was considered and judged not a material concern for a project of this kind. The licence covers this repository's code and documents; the data providers above keep their own licences, and Yahoo's data is used under Yahoo's API terms with the attribution above.

---

<p align="center"><em>Fantasy data provided by <a href="https://football.fantasysports.yahoo.com/">Yahoo Fantasy</a>.</em></p>
