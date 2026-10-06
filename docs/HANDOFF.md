# HANDOFF — yahoo-fantasy-football-mcp

**The single handoff document for this project** (Chad's decision,
2026-09-29). Read this first, then `CONTRIBUTING.md` (security and
workflow rules) and `docs/plan/00-index.md` (the plan in reading order).
Update it after every meaningful step; commit and push it with the work it
describes.

Rules that never lapse: repo is **PUBLIC** — no personal identifiers (team
names, usernames, league IDs) and no secrets in any committed file; fixtures
are anonymized. Third-party code is untrusted: read statically, never
install or execute. Every roster-changing action needs explicit human
confirmation. News text is data, not instructions.

## ▶ NEXT STEP

**State (2026-10-06).** Phase 1a is built, hardened by QA/pentest round 1 and on `main` (merged
2026-09-30). The product runs on `ManualLeagueProvider` (`<config>/league.yaml`) + nflverse +
weather; Yahoo is not connected (no API access). On 2026-10-06 the public history was rewritten
(no-reply identity on every commit, no co-author trailers, no working notes; QA-1-095) and `main`
gained branch ruleset `24558591` (no force-push, no deletion, linear history). The seven skipped
round-1 hand-offs are decided: four closed, three deferred with a recorded design and a reopen
trigger (§ Decisions made). **QA round 2 is under way** on `build/deferred-items`. Its
deferred-items analysis found five defects, QA-2-001 to QA-2-005, all fixed with mutation-checked
regression tests ([`qa/2026-10-06-qa-round2.md`](qa/2026-10-06-qa-round2.md)). The branch also
carries the A17 script; it merges to `main` when the full gate is green.

Owner's next steps, in order:

1. **Set it up** — README § Getting started: build in `~/Developer/yahoo-fantasy-football-mcp`,
   `print-config` → add to Claude, copy the Skills, `ff refresh all`, then `/onboard` to write
   `~/.config/fantasy-football-mcp/league.yaml` (0600, never in the repo).
2. **A17 (about 10 minutes for both clients; steps in item 9 below).** Claude Code: run
   `claude auth login` once (on 2026-10-06 the script stopped at that step on this machine), then
   `scripts/dev/with-node.sh node scripts/dev/a17-check.mjs` after a build, and record the line it
   prints under "Build facts". Claude Desktop: the manual steps in item 9, then record its line.
3. **QA round 2 continues:** the per-fix independent re-verification (round 1's 80 fixes and
   round 2's five), then a second sweep — the two sections marked TO DO in the round-2 register.
   One product call is still open: item 12 (E5 availability under the manual league).
4. **Then Phase 2** (usage data, waivers for all positions — with the E5 schema deferred from 1a,
   § Deferred designs — trades, injury cascades, news).

## Executive summary (2026-09-30)

**What exists.** A public, docs-only repo with a verified research pack
(`docs/research/00–06`: tooling inventory, a 21-repo security audit,
prior-art lessons, the Yahoo API reference, a data-source evaluation, the
strategy/analytics methodology, the Skills/MCP design), a ten-file plan
(`docs/plan/01–10`) refined through a three-round adversarial review
(30 objections: 29 conceded-and-landed, 1 withdrawn on evidence, 0
pressed), the changelog, a 947-line README with seven CI-rendered
diagrams, LICENSE (MIT), SECURITY.md, and live CI (Mermaid/link
validation; gitleaks with Yahoo-specific rules and a weekly full-history
scan). No product code exists; the build is gated on Chad's review.

**The five findings that shaped it.**
1. **Yahoo API access is application-gated and read-only**; write access
   is "not available at this time". Chad has decided read-only *is* the
   product. No one has publicly reported approval under the new form.
2. **Yahoo has no player projections, news or usage data** — the
   intelligence comes from nflverse/ffopportunity/lines/injuries, and the
   projections are ours, labelled as estimates.
3. **No prior server has a confirmation gate, and most mishandle
   tokens** (two public repos leak real credentials in git history). Ours
   stores tokens outside the repo, and its gate's guarantees are stated
   per session condition — never "safe" where the model has shell reach.
4. **The free data stack is real and current** (nflverse CC-BY, updated
   the day it was checked), but the Yahoo-id join misses every 2025–26
   rookie — so the crosswalk is a persisted matcher, built first.
5. **The season clock is the binding constraint.** Phase 1a (Yahoo-free)
   starts on plan approval and is 4–8 weeks; even an immediate Yahoo
   grant may yield a playoffs-only product this season. A 1a-minimum cut
   exists to reach the optimistic end.

**The shape of the product.** A local stdio MCP server (Node ≥ 24.15,
official SDK v2, exact-pinned); 19 read tools by default (`core`), 31 in
`full`, 7 conditional write tools; a settings-driven scoring engine
checked against Yahoo's own totals; 12 Skills; a recommendation log and
weekly retrospective so the advice is measured; launchd jobs for
zero-token data refreshes and roster/FA-pool snapshots.

**Decisions that need Chad** (ranked; details in the items below and in
`docs/plan/10-*` §5):
1. **Submit the Yahoo API application now** — not development; starts the
   only clock nobody controls.
2. **Approve the plan** (or send it back), and choose **1a-minimum vs
   1a-full** for the first build phase.
3. **Repo visibility and the branch ruleset** — public with no
   protection today; the recommended protection is a branch ruleset (no
   force-push, no deletion, linear history; plan 04 §5).
4. **Notify the two repo owners whose credentials are in public git
   history?** Nothing has been sent.
5. **Commercial intent?** (changes two data sources) and **paid
   projections baseline?** (default: no to both).
6. Smaller defaults to confirm: plugin manifest in Phase 2 (yes), Odds
   API key (skip for now), a second fixture league for unverified scoring
   branches, Sunday live `P(win)` in Phase 1 (no).

## The finding that reshapes the product (verified at source)

Yahoo's API access page (sports.yahoo.com/developer/access) says, verbatim:
*"The Yahoo Fantasy Sports API currently provides read access only."* and
*"Write access is not available at this time."*, with an exception path —
*"If your use case is unique and requires read/write access, please include
additional details in the notes section below."* Access itself is
application-gated (form → human review). Consequences for the plan: the
product must be **fully useful read-only**; lineup/waiver/trade tools are
**conditional capabilities** that light up only if write access is granted;
Chad must apply for API access (personal, single-league use) before any
live testing; and a `401 additional_authorization_required` /
`403 not authorized` must be diagnosed as *not provisioned*, not as an
expired token. Details: `docs/research/03-yahoo-api.md` §A, §G.

## Program status (pre-build: research → plan → adversarial review → docs)

| phase | status | artefacts |
|---|---|---|
| 0 — repo setup | ✅ done | `.gitignore`, `.env.example`, `main` pushed, description + 14 topics applied via `gh`, tooling inventory (`docs/research/00-*`) |
| 1 — research (waves 1–3) | ✅ 01–06 all verified (SHAs on origin, identifier scan, one load-bearing claim per doc checked at source) | `docs/research/01-*` … `06-*` |
| 2 — plan | ✅ all ten files (`docs/plan/01-*`…`10-*`, 2,935 lines), both halves verified; plan 10 §4 lists 13 small tensions to fold in during the adversarial round | `docs/plan/` |
| 2b — docs-only automation (plan 06 §4 step 1) | ✅ `docs` (Mermaid 7/7 + links, with self-tests) and `secrets` (gitleaks 8.30.1 pinned by sha256, 7 Yahoo rules, self-test, weekly full-history scan) green on `main` at `c30b997`; Dependabot (weekly version updates; security updates and vulnerability alerts are **not** on — Open items, QA-2-019); PR template. GitHub secret scanning + push protection were already enabled. **Branch ruleset applied 2026-10-06** (`24558591`: no force-push, no deletion, linear history, no bypass actors; plan 04 §5); required status checks deliberately deferred until PRs are required (a required check rejects every fresh direct push) | `.github/**`, `.gitleaks.toml`, `scripts/**` |
| 3 — adversarial review | ✅ **closed after three rounds** (`a98d41f`): 30 objections — 29 conceded-and-landed, 1 withdrawn on evidence, 0 pressed; round 3 raised no objections, three nits (fixed), remainder declared marginal; `## Closing verdict` in the log; `docs/plan/changelog.md` finalised (numbers, closing summary, rounds 1–3) | `docs/plan/adversarial-log.md`, `docs/plan/changelog.md` |
| build — Phase 0 + 1a-full (foundation, modules, QA/pentest) | ✅ merged to `main`: 19 tools, 7 resources, 3 prompts, 4 Skills, `ff` CLI; 3,867 unit + 127 process tests, 98.65 % lines; QA/pentest round 1: 101 findings, 80 confirmed, **80 fixed** | `src/`, `tests/`, `skills/`, `docs/qa/` |
| docs — README, LICENSE, SECURITY.md | ✅ `README.md` (947 lines, 16 sections, 7 Mermaid diagrams rendered by CI, 121 features marked 📋 planned), `LICENSE` (MIT), `SECURITY.md`, `docs/README.md`, `docs/plan/00-index.md` — verified; CI green on `a7dad60` | root + `docs/README.md`, `docs/plan/00-index.md` |
| QA round 2 | 🔄 under way (2026-10-06, `build/deferred-items`): the deferred-items analysis is done — the 7 skipped hand-offs decided, QA-2-001…005 fixed (mutation-checked), A17's Claude Code half scripted; per-fix re-verification and the second sweep are next | `docs/qa/2026-10-06-qa-round2.md` |

## Decisions made

| date | decision | why |
|---|---|---|
| 2026-09-29 | Repo lives at `~/Documents/Repos/Yahoo Fantasy Football` (iCloud-synced folder), per Chad | alongside his other MCP servers. Consequence: OAuth tokens and caches are stored **outside** the repo dir by design (`~/.config/…`, `~/.cache/…`) so nothing secret syncs |
| 2026-10-05 | **Superseded: one checkout, `~/Developer/yahoo-fantasy-football-mcp`.** The `~/Documents` copy was retired (moved to the Trash, nothing unpushed) and the merged `build/phase-1a` branch deleted; the pre-commit hook now refuses conflict-copy names too | Chad: "the option that imposes the least amount of clutter and is the most optimally efficient and effective going forward"; iCloud kept recreating conflict copies there |
| 2026-09-29 | Handoff document = `docs/HANDOFF.md`, committed | Chad's choice; the state survives a change of hands and of machines |
| 2026-09-29 | Stack default: Node/TypeScript + official MCP SDK | matches Chad's other local MCP servers; deviations must be justified in the plan |
| 2026-09-30 | **Development approved — build begins** (Chad: "Let's go ahead and begin development"; thorough testing, QA + penetration testing with remediation). Supersedes the review gate below | Chad's instruction |
| 2026-09-30 | **No Yahoo API application** — Chad has no business-entity details to supply and will not apply. Plan 10's Ph8 decision point is treated as **fired**: fallback **X1** (`ManualLeagueProvider`) is the path for Chad's league; **Phase 1b is deferred indefinitely** (the `FantasyPlatform` seam stays; `YahooProvider`, OAuth and token storage are **not built** now — so no Yahoo credential exists anywhere) | Chad's decision; plan 10 §0 Ph8/Ph9. Note: Yahoo's form asks about "personal or single league use", so an individual may be able to apply later — free, optional |
| 2026-09-30 | **Scope: 1a-full** (not 1a-minimum) — `ManualLeagueProvider`, weather and `retro` are essential once Yahoo is out | follows from the row above |
| 2026-09-30 | **Personal use, open source, no purchases or subscriptions** — non-commercial sources (Sleeper, Open-Meteo) are acceptable; no paid projection feed; outside contributors may be approved later (a PR workflow + the branch ruleset become relevant then) | Chad's instruction (plan 10 §5 D1/D2 = no) |
| 2026-09-30 | **Credentials: none requested or needed.** Chad must never send his Yahoo password; the build needs no keys (nflverse, Open-Meteo, NWS are keyless) | Chad's security requirement |
| 2026-09-30 | **Runtime dependency added: `yaml` 2.9.1** (ISC, zero dependencies, no install scripts) for the hand-edited `<config>/league.yaml`; **`fast-xml-parser` deferred** (only Phase 1b parses XML). Plan 04 §2 carries the rows | rejected: JSON (no comments, error-prone by hand); a hand-rolled YAML subset parser (a parser is attack surface) |
| 2026-09-30 | **Secret defences in depth**: gitleaks CI + GitHub push protection (existing), plus a local zero-dependency scanner (`scripts/dev/scan-secrets.mjs`) run by `.githooks/pre-commit` and by `scripts/dev/commit-paths.sh`; a local-only identifier deny-list at `~/.config/fantasy-football-mcp-dev/scan-denylist.txt` (never in the repo) | Chad's "absolutely rigorous" security requirement |
| 2026-09-30 | **Build branch `build/phase-1a`**; merged to `main` only when the full gate (lint, typecheck, tests + coverage, build, process, smoke, supply-chain, pack, docs, secrets) is green and the QA/pentest loop is dry. Node 24.21 via fnm (`.nvmrc` = 24); global default untouched | plan 04 §5; OBJ-09 |
| 2026-09-30 | **QA loop stopped after round 1**: round 1's 80 confirmed findings were all fixed with failing-first, mutation-checked regression tests; per-fix independent re-verification and a second sweep are deferred to QA round 2 | a scheduling decision: per-fix re-verification and a second sweep were deferred; the register says what was and was not run |
| 2026-09-30 | **No development or testing until Chad has reviewed the completed research + planning package** (refined plan, adversarial log + changelog, README/docs, executive summary) and approves | Chad's explicit instruction |
| 2026-09-30 | **Projection storage (modules gate, fix round 2):** samples stored in a compact column form (header + little-endian Float64 matrix, base64; exact; JSON fallback; legacy rows still read) and only a `SIMS.stored` = 1,000-sample prefix of each run's iid draws (plan 08 §5 says `StatLine[n_sims]`) | the only reader (E13) scores ≤ 500; full JSON storage was 43 % of an E1 call and ~25 MB per roster call into a never-pruned table (A15) |
| 2026-09-30 | **E12 checks `week` against its `source_calls`** (modules gate, fix round 2): a per-server ledger of the last 1,024 successful calls (request_id → tool, week); a cited call answered by another tool or about another week is `VALIDATION`; an id this session never answered is warned, not refused | the gate logged a week-3 lineup rec as week 4 and E13 would have scored it against the wrong week; plan 07 E12 is silent |
| 2026-09-30 | **Fixture mode's default seasons come from the fixture manifest** (`default_seasons`), not the clock | a bare `ff refresh all` in fixture mode asked for 2025 stats the excerpts do not hold and exited 1 |
| 2026-09-30 | **E5's K universe is every team's kicker = status `ACT` in its newest `roster_weekly` row** (modules gate, fix round 3); the ranking pass is bounded by `LIMITS.maxKdefCandidates` (96), not E1's 64; the served list is an even, rank-interleaved share of `E5_CANDIDATES_OUT` (10 compact / 6 full) | plan 07 E5 says "every team's kicker" and "10 candidates compact"; on the real file the universe was 32 DEF + 40 K (cut/practice-squad included) + mine > 64 → every call `VALIDATION`; K then DEF blocks of 10 were halved to ten kickers and no defence |
| 2026-09-30 | **A required write reserves its longest observed yield (≥ poll + the store's own 110 ms stall) before sleeping** (modules gate, fix round 3) | the last yield could wake past the 1 s budget (982 ms measured; the test allowed +50 ms); now ~880 ms and the tests assert the literal ≤ 1 s |
| 2026-09-30 | **Read-only is acceptable as the product** (Chad): thorough reads of free agents, roster, adds/drops, league activity, stats + intelligent move recommendations are sufficient. Write access is a bonus if Yahoo ever grants it, not a requirement | Yahoo's "write access is not available at this time"; the plan's Phase 1–3 are read-only by design, Phase W stays conditional and low priority |
| 2026-10-06 | **Contributor rules live in `CONTRIBUTING.md`**; local working notes and personal tool settings stay untracked and out of the repository | the owner's decision |
| 2026-10-06 | **Public history rewritten (QA-1-095).** Every commit's author and committer is the GitHub no-reply address; the co-author trailers were removed; `docs/scratch/` and `CLAUDE.md` (now local-only) were removed from every commit, which dropped the 62 commits that touched only those notes (312 → 250, plus `1446c7a`, which remaps the commit ids the docs cite). Each rewritten commit was verified against its original: the same names and dates, and the same tree apart from the removed paths and two in-file edits (the commit helper's trailer lines; the machine user name and router domain quoted in the QA register). `main` moved from `f2cdbc5` to `1446c7a` by one force-push, before the ruleset below existed. Old commit ids no longer resolve in a clone of the rewritten history (GitHub may still serve pre-rewrite commits by URL until they are purged); the remapped ones do, and code comments cite them too (QA-2-021). Full record: QA register round 1, Open items | the owner's decision: the machine-derived address was in every early commit of a public repository. Copies taken before the rewrite (clones, forks, caches) keep the old history; there were no forks, pull requests or tags. GitHub Support can purge cached views (and pre-rewrite commits still served by id) if ever needed |
| 2026-10-06 | **Branch ruleset on `main`**: id `24558591`, "main: no force-push, no deletion, linear history", enforcement active on the default branch, rules `deletion`, `non_fast_forward` and `required_linear_history`, **no bypass actors** (admins included). Required status checks are deliberately **not** required; revisit when pull requests are required (plan 04 §5) | plan 04 §5. `main` still takes direct pushes, and a required check would reject a fresh direct push; `docs.yml` is path-filtered, so a required docs check would block pushes it never runs on. Check: `gh api repos/<owner>/<repo>/rulesets/24558591` |
| 2026-10-06 | Skipped hand-off **"return lineup comparisons separately": closed**, no code change. `comparisons[]` already ships apart from `swaps[]` (QA-1-010); only the internal engine/tool split remains, which fails safe and is held by tests | moving the split changes no output and reopens `lineup.ts` for no user value. Reopen with the next change to `lineup.ts`'s swap/compare construction, or a second caller passing `compare` (QA register round 1, Open items 1) |
| 2026-10-06 | Skipped hand-off **"server-side git-working-tree guard": deferred** — if built, a **warning only**, never a refusal (§ Deferred designs) | a refusal locks out a home that is itself a dotfiles repository and cannot see bare-repo or yadm setups; Phase 1a stores no credential. Reopen when a credential lands in the config dir, the tool is distributed beyond the owner, league data turns up in a repository, or `~`/`~/.config` becomes a work tree (Open items 2). Its "fix now" part became QA-2-001/002 |
| 2026-10-06 | Skipped hand-off **"worker thread for E1": deferred to Phase 2** | after QA-1-079's work bound the worst in-bounds E1 call is about 2.0 s unloaded, 2.5 s warm under load — inside the 10 s shutdown ceiling, so plan 10 A-2's trigger is not met. Reopen when a worst-in-bounds analytics case passes 3 s warm and a work budget cannot fix it, a feature needs the loop free (cancellation, progress, HTTP transport, a scheduler), or a sibling call or shutdown waits past its budget (Open items 3) |
| 2026-10-06 | Skipped hand-off **"crosswalk row in `ff doctor`": closed** | unmatched players are reported by `ff_get_status.crosswalk`, every roster tool's warnings and the Skills (plan 10 A5a/B3); doctor stays a value-free install/runtime check. Reopen when plan 06's `crosswalk rebuild` job stores an unmatched report, a text names doctor/status for the list, a field round shows the warning lost, or a non-chat front end is supported (Open items 4). The analysis also found QA-2-003 |
| 2026-10-06 | Skipped hand-off **"`quick_check` on every publish": closed** — not for cost (3–150 ms measured) but because it cannot catch anything that can happen | the file is written only through SQLite and fsync'd before the rename; damage after the publish is already caught and repaired by `ff refresh` and doctor row 8. Reopen if a dataset file is ever produced other than by SQLite's own writes, or a `quick_check` failure is traced to a file nothing touched after its publish (Open items 5) |
| 2026-10-06 | Skipped hand-off **"persist only near-lock projection weeks": closed** | E13 reads only the newest pre-lock row, so far-week rows never displace a better forecast; the Skill path writes none. The real growth term is player row size (item 14 below). Reopen if a real season's store passes plan 01 §5.6's 100 MB after that change with far-week rows over 25 % of projection bytes, or a single-lead-time forecast is needed (read-side cap) (Open items 6) |
| 2026-10-06 | Skipped hand-off **E5 per-candidate ranges and per-position verdicts: deferred to Phase 2** (E5 for all positions). E5 keeps one `hold_vs_stream` — now labelled with the `position` it describes (QA-2-004, additive) — and no per-candidate Dist in Phase 1a; consumers rank one position per call | under the v1 `position_cv` basis a per-candidate band adds no information, and a full Dist per candidate would push a K-only compact result to the edge of halving. The Phase 2 design is in § Deferred designs. Plan 09 §3.4's per-candidate p10/p90 is deferred to Phase 2's E5-for-all-positions schema (in 1a a candidate carries no range of its own; QA-2-011). Reopen when Phase 2's E5 work starts, `player_sim` lands, an eval or real use misreads `marginal_value`'s interval, or a Skill ranks K and DEF in one call (Open items 7). The analysis also found QA-2-005 |
| 2026-10-06 | **`tool_contract` stays 1 before the first release** (QA-2-010): an additive output field, nested or not (`hold_vs_stream.position`, QA-2-004), does not bump it while the package and Skills are `0.0.0`; a renamed, removed or retyped field, an input-schema change or a tool rename still does. The first release starts the counter, after which every change plan 09 §4 lists bumps it, additive fields included | an older Skill never reads a field it does not know, and before a release the Skills and the server come from one checkout; plan 09 §4 carries the rule |

## Stack facts (checked 2026-09-29)

- `@modelcontextprotocol/server` **2.2.0** is the npm `latest` dist-tag
  (registry read; nothing installed). The plan pins it exactly.
- `node:sqlite` loads on the local Node **22.23.2** but still emits
  `ExperimentalWarning: SQLite is an experimental feature and might change
  at any time`. The plan (01 D4) calls it a release candidate and assumes
  Node 24 is current LTS (03 A-7) — the Node floor and the warning are
  material for the adversarial round.

## Build facts (foundation stage, 2026-09-30 — verified)

- **The only checkout is `~/Developer/yahoo-fantasy-football-mcp`** (outside iCloud). The first
  checkout, `~/Documents/Repos/Yahoo Fantasy Football`, was retired on 2026-10-05 (moved to the
  Trash after confirming nothing was unpushed): iCloud created 207 conflict duplicates inside its
  `node_modules` during the foundation stage, later restored deleted build output with 149 more,
  and left 13 "name 2.ext" copies of scripts and workflows (`ci 2.yml` would have run as a second
  workflow if committed). Both commit paths (`.githooks/pre-commit` and `scripts/dev/commit-paths.sh`, via
  `scan-secrets.mjs --index`) now refuse to add a conflict-copy name.
- Node **24.21.0** via fnm for this repo only (`.nvmrc` = 24; the machine's global default stays
  22). `node:sqlite` on 24 prints no experimental warning; `ATTACH 'file:…?mode=ro'` is
  honoured; **at most 10 attached databases** — Phase 2 needs attach-on-demand (LRU).
- Pins (exact): `@modelcontextprotocol/server` 2.2.0, `zod` 4.6.5 (one copy, test-enforced),
  `hyparquet` 1.31.2, `yaml` 2.9.1 → a **5-package runtime tree**; TypeScript **6.0.3** (not
  7.x: typescript-eslint 8.71 requires < 6.1 and TS 7 has no JS API for typed lint).
- Contract deviations from the plan text (deliberate, documented in the file headers):
  `FantasyPlatform.getPlayerWeekStats` → `getPlayerStats` (week or season), every read returns
  `Stamped<T>`; `DataSource` publishes a fresh per-source dataset file (`publish(files,
  DatasetWriter)`) instead of `load(file, tx)` — round 2 OBJ-27; the envelope gained
  `meta.request_id`; `release-assets.githubusercontent.com` joined the host allow-list (GitHub
  release downloads redirect there); `config.json` unknown keys warn; `availability` is
  `FA | W | T | unknown` (plan 07); `delta_pwin` bands |Δ| < 0.04 small, < 0.10 medium, else large.
- Tools must be registered as `registerTool(name, { inputSchema: deferValidation(schema), … },
  wrapHandler(schema, fn))` — the only pattern that keeps plan 01 §4.3 coded errors under SDK
  2.2.0.
- **A17 — does the client show the model `structuredContent`?** (plan 10 A17; item 9 below says
  how to run it). Replace each "not recorded yet" with the line the check prints or the manual
  step gives:
  - Claude Code: not recorded yet (`scripts/dev/a17-check.mjs`; on 2026-10-06 it stopped at the
    login step, exit 3).
  - Claude Desktop: not recorded yet (manual).

## Deferred designs (recorded 2026-10-06, so they are not re-derived)

Each belongs to a deferred hand-off (§ Decisions made; the QA register round 1, Open items, has the
reasoning and the reopen triggers). Build one only when its trigger fires.

- **E5 for all positions (Phase 2).** (a) `candidates[].projection`: the candidate's own
  decision-week Dist, already computed in `kdef.ts` (no extra work); compact form `{ mean, p10,
  p50, p90, basis }`, about 75 chars, so a K compact result stays near 9.5k chars. (b)
  `candidates[].vs_starter`: `{ value, p10, p90 } | null`, the Δ against holding, computed with the
  verdict's combined-σ formula so a candidate's interval and the coin-flip test always agree; null
  without a starter. `marginal_value` keeps plan 07's meaning. (c) One `hold_vs_stream` entry per
  requested position, `{ position, streamability, current_starter_delta, verdict: hold | stream |
  locked }`; a locked starter's position gets `locked` instead of competing on Δ. As an array this
  is breaking (bump `metadata.tool_contract` 1 → 2 in every Skill); the non-breaking route is a new
  `hold_vs_stream_by_position[]` beside the labelled `hold_vs_stream` that QA-2-004 shipped. (d)
  `rec` stays single, so the recommendation log and retro contract do not change. (e) While `rec`
  is single, check-skills' one-position-per-call rule moves from stream-kdef's block to every
  Skill's `ff_analyze_waivers` steps. Tests and mutations: `projection.mean` equals the stream
  signal's value; `vs_starter` straddles 0 exactly when `rec` carries the coin-flip assumption
  (computing it without the starter's σ must go red); a K-and-DEF call with the kicker locked gives
  K `locked` and pairs DEF with `rec`; a K-only compact result with every assumption present still
  fits in 10,000 chars without halving.
- **Git-working-tree guard (a warning, never a refusal).** `enclosingGitWorkTree(p)` in
  `src/config/paths.ts`: for the given and the real spelling of the path, walk up with `lstat`
  looking for a `.git` directory or file (worktree/submodule); never spawn git, never read `.git`.
  `loadConfig` adds one warning per affected key (`FF_CONFIG_DIR`, `FF_CACHE_DIR`, a non-fixture
  `FF_LEAGUE_FILE`) that carries no path (serve writes config warnings to the client log), never an
  issue; this checkout keeps its hard refusal. `ff doctor` rows 4 and 8 report `warn` and name the
  work-tree root locally; the exit code is unchanged. The onboard Skill then says doctor warns, and
  cannot see a bare-repository or yadm home. Lock-out regression test: a home that holds `.git`
  still loads.
- **E1 pacing (if the worker item reopens).** An async `projectPlayersAsync` that yields
  (`setImmediate`) when more than about 16 ms have passed, checked between player-weeks, and honours
  an `AbortSignal` (a `cancelled` error; nothing stored); results bit-identical to the sync path for
  a fixed seed (each subject-week draws from its own forked stream). E1/E2/E3/E5 await it with the
  request's signal, and shutdown aborts in-flight calls. A worker thread only if parallel CPU is
  needed.
- **Projection sample encoding (item 14).** Each stored player sample line is the expectation
  times one gamma multiplier, so storing the multiplier instead of the line cuts every player row
  about 11×, on every path. Lossless only if the engine passes its own gamma draw g (dividing a
  stored line by its mean is bit-exact for 1 of 40 measured rows); a v3 tag in
  `src/store/repos/samples-codec.ts`, with v1/v2 reads kept (QA-2-023).

## Confirmation-gate facts (verified 2026-09-29)

- MCP spec current revision is **2026-07-28**; elicitation is a
  client-offered feature (modelcontextprotocol.io/specification/latest).
- Claude Code supports form-mode elicitation (doc 06 §A.3, v2.1.76+ —
  relayed, not re-verified). **Claude Desktop: unverified** —
  `anthropics/claude-code#41110` ("MCP elicitation support in Claude
  Desktop app") is closed `completed` with only a bot comment; no positive
  evidence either way. The plan therefore treats elicitation as an
  optional layer over the two-step `prepare_*`/`commit_*` token gate, which
  works on every client, and never as the sole confirmation mechanism.

## Yahoo terms the plan must honor (verified on sports.yahoo.com/developer, 2026-09-29)

- Attribution: *"Fantasy data provided by Yahoo Fantasy"*, linking back to
  Yahoo Fantasy, with the official logo used unaltered → README, docs, and a
  `source` field in tool output.
- *"Developers may create only a single account and must not use automated
  tools or other means to create multiple accounts."*
- *"Developers may not modify, reverse engineer, decompile, or otherwise
  alter the API or separate its underlying data."*
- Throttling is discretionary and unnumbered (*"may temporarily throttle or
  limit access"*). The full "API Access and Use Agreement" is not public —
  it is presented at application time; the canonical ToS URL cited by
  wrappers (`legal.yahoo.com/…/fantasysportsapi/`) returns 404 today.

## Things Chad needs to know / decide (accumulating; summarized at the end)

1. Repo visibility is **PUBLIC** with no branch protection and no rulesets.
   Was that intended? (Everything pushed is treated as public regardless.)
   **Resolved 2026-10-06:** public; `main` is protected by ruleset
   `24558591` (§ Decisions made).
2. The checkout is in an iCloud-synced folder. Mitigated by design (no
   secrets in the repo dir), but `node_modules`/build output will churn
   through iCloud once the build starts. **Resolved 2026-10-05:** one
   checkout, `~/Developer/yahoo-fantasy-football-mcp`, outside iCloud.
3. License choice — to be recommended in the docs phase.
4. **Yahoo API access must be applied for** (form at
   sports.yahoo.com/developer/access; read-only by default; write access
   "not available at this time" except for "unique" use cases described in
   the notes). Does Chad already hold an approved Yahoo client id with the
   Fantasy permission from an earlier project? If so, live testing can start
   sooner. If not, the application should go in early — review latency is
   unknown (`03-yahoo-api.md` §F.18). Verified 2026-09-29: the
   403 "not authorized" wave on previously working apps began 2026-07-22
   (user reports in `uberfastman/yfpy#84`), the create-app form no longer
   offers the Fantasy permission, and **no one in that thread reports
   having been approved through the new form yet**. Approval for a
   personal, single-league tool is therefore an open risk, not a formality.
   A legacy app that still works would be valuable — check before applying.
   **Resolved 2026-09-30: Chad has no existing Yahoo developer app.** The
   application is the only path; recommended framing: personal use, one
   user, one league, read-only, locally-run open-source tool, low cached
   request volume. Until approval, all Yahoo-layer work is built and
   tested against recorded, anonymized fixtures; the analytics layer
   needs no Yahoo access.
5. **Two public repos contain real Yahoo credentials/tokens in their git
   history** (`carterfawson/fantasy-football-mcp` and
   `derekrbreese/fantasy-football-mcp-public`; verified from file names in
   the temporary research clones, values never printed or tested).
   Notifying the owners is Chad's decision; nothing has been sent.
6. **Will this ever be distributed commercially?** Two sources in the
   recommended free stack are non-commercial (Sleeper's API for trending
   adds/drops; Open-Meteo for weather) and two are share-alike (FTN
   charting, ffopportunity). Personal use is fine as planned; a commercial
   path means swapping Open-Meteo → NWS and Sleeper → an own trending
   signal, plus attribution. The plan will default to personal use unless
   Chad says otherwise (`docs/research/04-data-sources.md` §G.3).
7. **Ten product decisions with defaults** are in `docs/plan/10-phasing-and-acceptance.md`
   §5 (D1–D10: commercial? paid projections? plugin manifest in Phase 2?
   Odds API key? FAAB budget at onboarding; `apply` at P0 read-only; nightly
   token budget for Skill evals; a second fixture league; backtest seasons;
   Sunday `live` in Phase 1?). The plan proceeds on the stated defaults
   unless Chad overrides.
8. **Projections will be ours, not a vendor's.** No free, legal, current
   projection source exists (FantasyPros' cheap tier is personal-use only,
   ~$9/mo). The plan builds projections from usage + play-by-play +
   expected-points + lines + injuries and labels them as such. If Chad
   would rather pay for a consensus feed as a baseline/comparator, say so
   (`04` §C, `05` §16 item 12).

9. **A17 needs Chad (about 10 minutes for both clients, most of it the Claude Desktop restart).**
   The automated half is green: in fixture mode `ff_debug_echo`'s nonce is only in
   `structuredContent`, and the C10 list tools omit it. The question only a real client answers:
   does Claude Code, and does Claude Desktop, show the model the `structuredContent` copy as well
   as the text (two copies per result → plan 07 §5.1's token budgets halve)? Record each answer
   under "Build facts" (A17). Plan 07 §5.1 is then re-based on measured tokens per client (its
   measured chars are already recorded there). Both halves run the built server in fixture mode
   through `tests/smoke/fixture-serve.mjs`, which uses its own private temp home, config and cache
   and never reads `~/.config/fantasy-football-mcp/`. Build first, from the checkout:
   `scripts/dev/heavy-lock.sh scripts/dev/with-node.sh npm run build`.

   **Claude Code (scripted).** Once: `claude auth login`. Then, from the checkout:
   `scripts/dev/with-node.sh node scripts/dev/a17-check.mjs`. It runs `claude -p` headlessly
   in a temp directory against the fixture server, asks the model to repeat the nonce, and decides
   from Claude Code's own transcript whether the tool result handed to the model holds it. Exit 0
   prints the verdict and the exact line to add under "Build facts"; exit 3 means Claude Code is not
   logged in or its login expired (on 2026-10-06 the CLI on this machine stopped there). The other
   exit codes, `--timeout`, `--save <file>` and `--from <file>` are in the script's header.

   **Claude Desktop (manual).**
   1. Note two absolute paths: the Node 24 binary
      (`scripts/dev/with-node.sh node -p process.execPath`) and the checkout (`pwd` in it).
   2. Quit Claude Desktop. If `~/Library/Application Support/Claude/claude_desktop_config.json`
      exists, copy it aside (for example to `claude_desktop_config.json.a17-backup` in the same
      folder).
   3. Add one entry under `mcpServers`, keeping every existing entry:
      `"ff-a17": { "command": "<Node 24 path>", "args": ["<checkout>/tests/smoke/fixture-serve.mjs"] }`.
      Do not use `ff print-config` for this. It does support fixture mode (it copies
      `FF_FIXTURE_DIR`, `FF_TOOLSET` and the other non-secret `FF_*` settings set in the shell),
      but its entry is always named `fantasy-football-mcp-server`, the real server's name, so
      merging it would replace your real entry. Its config and cache would also be whatever
      `FF_CONFIG_DIR` and `FF_CACHE_DIR` the shell sets, not private temp folders.
   4. Start Claude Desktop, open a new chat and send: *"This is an automated client check. Call
      the tool ff_debug_echo exactly once, with no arguments. Then look at everything the tool
      result shows you. If you can see a 12-character lowercase hexadecimal nonce anywhere in it,
      reply with exactly one line: NONCE <the nonce>. If you cannot see one, reply with exactly one
      line: NO NONCE. Never guess or invent a value."* Allow the tool call when asked.
   5. `NONCE` followed by 12 hex characters means the model saw `structuredContent` (48 random
      bits cannot be guessed); `NO NONCE` means it did not. Record under "Build facts":
      `A17 Claude Desktop <version>: structuredContent visible to the model: yes|no (<date>)` (the
      version is in Claude → About Claude).
   6. Quit Claude Desktop, remove the `ff-a17` entry (or put the backup back), and start it again.
10. ~~**A15 reading to confirm.**~~ **Resolved 2026-09-30 (modules gate, fix round 2) — no decision
    needed.** `ff_project_players` for the whole 16-player roster at the default 4000 sims now
    answers in a ≈ 293 ms median over real stdio (was 729–830 ms), so A15 is met as literally
    written; the latency test holds it to 500 ms (the pro-rata allowance is gone). 32 × 4000:
    693 ms. Root cause and fix in the Log below; `n_sims` defaults are unchanged.
11. `tools/list` under `core` is 19,483 of its 20,000-char, downward-only ceiling (2.6 % headroom):
    the next tool added to `core` must shrink a schema or go to `full`.
12. **E5 under the manual league ignores what `league.yaml` does know (product call).** Plan 07 E5
    (round 2) says every K/DEF candidate carries `availability: "unknown"` under
    `ManualLeagueProvider`, and the tool does exactly that — so a kicker `league.yaml` lists on
    another team's roster (fixture: Brandon Aubrey, Team B) is still offered as a streaming
    candidate, and one listed under `waivers` shows `unknown`, not `W`. Option: mark players the
    YAML rosters as `T` (and drop them from streaming), YAML `waivers` as `W`, everyone else
    `unknown` — a change to plan 07 E5's text, so it waits for you. The warning stays either way.
13. **Stored projections keep a 1,000-sample prefix, not all `n_sims` (deviation from plan 08 §5
    wording, recorded as a decision).** Only the retrospective reads them, and it scores at most
    500; storing all 4,000 wrote ~25 MB per roster call into a never-pruned table.
14. **Projection player rows could be about 11× smaller (not scheduled).** Found while deciding
    the near-lock hand-off (2026-10-06): each stored player sample line is the expectation times
    one gamma multiplier, so storing the multiplier instead of the line would shrink every player
    row about 11× (rows are about 53 KB at 500 samples on the fixture league). It is the larger
    growth term of the projection table; the near-lock item's reopen trigger is measured after it.
    Lossless only if the engine passes its own gamma draw g: dividing a stored line by its mean
    is bit-exact for 1 of 40 measured rows, so deriving g by division would silently change the
    stored samples. Store it under a v3 tag in `src/store/repos/samples-codec.ts`, with v1/v2
    reads kept (QA-2-023).

## Open items

- [x] research waves 1–3 complete and verified (docs 00–06)
- [x] plan (01–10), three adversarial rounds, changelog
- [x] docs-only CI (Mermaid/links, gitleaks + self-test, Dependabot, PR template)
- [x] README, LICENSE, SECURITY.md, docs indexes
- [x] executive summary for Chad (above)
- [x] ~~**Chad:** submit the Yahoo API application~~ — decided 2026-09-30: no application; X1
  (`ManualLeagueProvider`), Phase 1b deferred
- [x] **Chad:** review the package; approve; 1a-minimum vs 1a-full — approved 2026-09-30, 1a-full
- [x] **Chad:** repo visibility + branch ruleset — public; ruleset `24558591` (2026-10-06);
  commercial intent and paid projections — no to both (2026-09-30)
- [ ] **Chad:** notify the two repo owners whose credentials are in public git history (item 5;
  nothing sent)
- [x] build Phase 0 + Phase 1a — merged to `main` 2026-09-30 (QA/pentest round 1: 80 fixed)
- [x] history rewrite for the machine-derived commit email (QA-1-095) — 2026-10-06
- [x] the seven skipped round-1 hand-offs decided — 2026-10-06 (§ Decisions made)
- [ ] **Chad:** A17 per client (item 9) — record both lines under "Build facts"
- [ ] **Chad:** turn on vulnerability alerts and Dependabot security updates (QA-2-019; plan 04 §5's
  "Now" column lists them, and neither is on: `security_and_analysis.dependabot_security_updates`
  is `disabled`, `GET …/vulnerability-alerts` returns 404). Repository Settings → Code security, or
  `gh api -X PUT repos/<owner>/<repo>/vulnerability-alerts` then
  `gh api -X PUT repos/<owner>/<repo>/automated-security-fixes`. Owner only: nothing automated
  touches repository settings. Until then no one is alerted to a CVE in the runtime dependencies
- [ ] QA round 2: per-fix re-verification and the second sweep (`docs/qa/2026-10-06-qa-round2.md`)

## Log

- 2026-09-29 — Phase 0 complete. Research wave 1 started; waves 2–3 scoped.
  No Yahoo/NFL/sports connector exists in the MCP registry.
- 2026-09-29/30 — Research 01–06 complete, each verified at source. Plan
  01–10 written in two halves (structural 01–06,
  product 07–10). Docs-only CI built and proven green.
- 2026-09-30 — Chad's decisions: no legacy Yahoo app; read-only is the
  product; no development until the package is reviewed.
- 2026-09-30 — Adversarial review: three rounds, 30 objections, review
  closed (`a98d41f`); plan revised twice (`00038db`, `65e5483`); changelog
  finalised (`dd54be2`).
- 2026-09-30 — README/LICENSE/SECURITY/indexes landed (`a7dad60`).
  **Pre-build work complete; waiting on Chad.**
- 2026-09-30 — **Build approved.** Guard-rails first (`6c27fdc`): secret/identifier
  scanner + pre-commit hook + commit helper, all self-tested.
- 2026-09-30 — **Foundation stage green**: scaffold (`.npmrc` alone first `1e1c2b5`, Z3
  proven), exact pins, strict TS, ESLint with layer boundaries, coverage gate, zero-dep
  supply-chain checks, `ci.yml`; the contract layer, critiqued in two independent reviews
  (46 issues: 44 applied, 2 routed to the owning modules) and revised (`c0811f6`); an
  independent gate re-ran everything from a clean install — green first time, **1,014 tests**,
  ~99.5 % coverage, CI green. Re-verified in a fresh clone outside iCloud, and the build moved
  there; the domain `Math.random`/`Date.now` ban and the conflict-copy guard were added.
- 2026-09-30 — **Modules gate, fix round 1** (gate RED on the Mac only): the A4a p95 contention test
  moved to the `process` project (`*.perf.test.ts` rule, partition test); the unit project's hang
  detector is 30 s (CPU-bound tests hit the 5 s default at load 22–45); a real single-flight race
  in `ff refresh` fixed (the "unchanged" check re-made under the job lock); the A6 size ledger now
  reaches the CI job summary and plan 07 §5.1; `ff refresh` prints its schema warnings.
  `test:coverage` + `check:coverage` green 3/3 in sequence locally at load ≤ 38. A17's manual
  half and the A15 reading are Chad's (items 9–10 above).
- 2026-09-30 — **Modules gate, fix round 2** (gate RED on A15 literal; A17 manual). **A15 met as
  written** (`a613301`): profiling the served E1 call showed 43 % of it storing samples
  (`JSON.stringify` of 4,000 full `StatLine`s per player-week, ~1.6 MB each) and most of the rest
  in `scoreSamples` building per-sample contributions and a string round trip per term in
  `denoise`. Fixed: compact exact sample storage + a 1,000-sample stored prefix; the sample path
  skips contributions/ignored; `denoise` has a string-free fast path proved (and fast-check-tested
  over every bit pattern and the ulp neighbours of decimal ties) equal to
  `Number(x.toPrecision(15))`. Roster call 729–830 → ≈ 293 ms; 32 × 4000 1.3–1.4 s → 693 ms;
  the latency test now holds E1 to the literal 500 ms. Also fixed: bare `ff refresh all` in fixture
  mode (`9f2b6e6`), E12's unchecked week (`04eb926`); `docs/evals/1a-backtest.md` now says the
  served K universe (roster_weekly kickers: 3 on the fixture excerpt) differs from the backtest's
  32. A17's manual half stays with Chad (item 9); item 12 (E5 availability) is a product call.
  **A13 on macOS in CI on this round's head:** the first dispatch (`36777995749`, on `1286ecf`)
  was the A4a contention test's first macOS CI run and failed (p95 551 ms): best-effort writes
  used SQLite's busy handler, which sums its *intended* sleeps, so on a macOS VM whose short
  sleeps overshoot a "100 ms" wait stalled ~5×. Fixed at the root (`0512b20`: non-blocking tries
  until a monotonic 100 ms deadline); dispatch `36779073123` on `0512b20` is green on both OSes —
  macOS A4a p95 126 ms, E1 roster 222 ms, 32 × 4000 556 ms; ubuntu A4a 97 ms, E1 250 ms. A
  pre-existing fast-check oracle flake in the CRPS property (a subnormal counterexample whose
  correctly rounded CRPS is 0) was fixed in the test (`f54e3e9`).
- 2026-09-30 — **Modules gate, fix round 3** (gate RED only on A17's manual half, which is Chad's —
  item 9; plan 10's 1a-full exit gate does not list A17). The three thin margins were fixed at the
  root. **A8:** the "exactly 3 K candidates" margin hid a production defect — the roster excerpt
  held only the fixture league's kickers, while on the real `roster_weekly` E5 ranked 32 DEF + 40 K
  + my K/DEF through E1's 64-target validation, so every served `ff_analyze_waivers` was
  `VALIDATION`. Fixed (`90ac543`): E5's own 96 bound, `ACT`-only kickers, a balanced 5 + 5 compact /
  3 + 3 full list that fits C8 without halving, and a roster excerpt that keeps every kicker's row
  (regenerated with `make-fixtures --only weekly_rosters` from byte-identical upstream).
  **A4a:** `STORE_BUSY` measured 982 ms against the 1 s budget with a +50 ms test tolerance; each
  yield now reserves the longest one observed (`41f2042`), ~880 ms, tests assert the literal 1 s.
  **Exit on stdin close during maximum-size synchronous calls (~1.28 s):** not changed — a
  synchronous `node:sqlite`/engine call cannot be pre-empted; plan 05 §4.2's bound is 3 s and the
  idle case exits in 15–17 ms. **CI green on `297642e`** (push `36782980116` + dispatch
  `36782980065` with macOS): A4a `STORE_BUSY` 891 ms ubuntu / 875 ms macOS, p95 97 / 110 ms.
- 2026-09-30 — **Modules stage done**: dataset contract grounded in the real 2026 nflverse files
  (`50414d9`), 8 modules built in parallel (store, network/runner/weather, nflverse, scoring,
  crosswalk, league + `ManualLeagueProvider`, reclog, Skills), analytics, MCP surface (19 P0
  tools, 7 resources, 3 prompts) + `ff` CLI, integration (golden over real nflverse lines, E2E
  over stdio, Skills dry run, latency), 3 gate/fix rounds.
  Head `3182482`: every automated check green — **3,392 unit + 115 process tests, 98.8 % lines**,
  smoke in both protocol eras, CI green. The gate's only open item is **A17's manual half**
  (Chad asks Claude Code and Claude Desktop to repeat the `ff_debug_echo` nonce). A re-run of
  the gate from a clean install got the same numbers. QA + pentest next.
- 2026-09-30 — QA + pentest round 1: 101 findings, 80 confirmed, 73 fixed area by area. The
  round gate (the integration pass) applied the 55 cross-area hand-offs and the 7 deferred
  `serve.ts` findings (store-open messages, transport close → clean shutdown, plan 05 §4.2 serve
  process tests), each with a failing-first, mutation-checked test. Notable contract changes:
  store migration 002 (reclog dedup scope), `ds_schema` 2 (D/ST fumble-return TDs — existing
  dataset files are refused until the next `ff refresh`), nullable FAAB/playoff rule flags, E2
  `swaps[].out` nullable for fills, E1 persisting only returned projections at 500 samples. CI now
  cancels superseded non-main runs. Skipped hand-offs (product/architecture decisions) are listed
  in the round report: git-tree location guard, E5 per-candidate points, lineup `comparisons`
  refactor, E1 worker thread, publisher `quick_check`, far-week projection persistence.
- 2026-09-30 — **QA + pentest round 1**: 12 review lenses, 101 findings, 237 independent
  refutation checks → 80 confirmed (9 high, 50 medium, 21 low); 73 fixed area by area + 7
  completed in the integration pass (`acd6db1`), every fix with a failing-first,
  mutation-checked regression test; loop stopped after round 1. The full gate was re-run from a
  clean install: 3,867 + 127 tests green, 98.65 % lines, CI green. Register
  `docs/qa/2026-09-30-phase1a-qa-pentest.md`. README now describes the built product. Merged to `main`.
- 2026-10-05 — **One checkout.** 13 iCloud conflict copies were found in the `~/Documents`
  checkout (untracked, byte-identical to versions in history) and removed. On Chad's choice of the
  least-clutter option: the pre-commit hook refuses conflict-copy names (test-first, mutation-checked),
  the `~/Documents` checkout was moved to the Trash after a final no-unpushed-work check, and the merged
  `build/phase-1a` branch was deleted. `~/Developer/yahoo-fantasy-football-mcp` is the only checkout.
- 2026-10-06 — **History rewrite and branch ruleset** (QA-1-095; § Decisions made). Contributor
  rules moved into `CONTRIBUTING.md` (`0fa85e3`). The history was rewritten (312 → 250 commits,
  no-reply identity throughout, no co-author trailers, no working notes) and the cited commit ids
  remapped (`1446c7a`); `main` moved from `f2cdbc5` to `1446c7a` in one force-push. Ruleset
  `24558591` was then created: no force-push, no deletion, linear history, no bypass actors.
- 2026-10-06 — **QA round 2 started: the deferred-items analysis** (`build/deferred-items`). The
  seven skipped round-1 hand-offs were decided (four closed, three deferred; designs in § Deferred
  designs). The analysis found five defects, each fixed with a regression test and mutation-checked
  on the branch head: QA-2-001 (`8852df5`), QA-2-002 (`3469278`), QA-2-003 (`acdf50e`), QA-2-004
  (`0d210f4`), QA-2-005 (`ebe095b`); `5302d5c` corrected the README and plan 09 §3.4 for
  stream-kdef's one position per call. A17's Claude Code half is now a script (`149e05e`; `b1dcd85` made
  SIGTERM/SIGHUP interrupt like Ctrl-C, `c99a067` stopped reading an API error line as the
  model's answer); run on this machine it stopped at the login step. Next: the per-fix
  re-verification and the second sweep.
- 2026-10-06 — **QA round 2: review of the round's own commits.** 19 findings, QA-2-006 to
  QA-2-024 (three medium: the stream-kdef test accepted either sign of the hold interval, the
  a17-check interrupt test covered SIGHUP only, and plan 04 §5 claimed Dependabot security updates
  that are off), all fixed; the code fixes have
  regression tests, each mutation-checked (round-2 register). The a17-check script now kills a
  leftover child after the CLI exits, opens `--save` before the run and keeps no session record.
  One owner step came out of it: turn on vulnerability alerts and Dependabot security updates
  (§ Open items).
