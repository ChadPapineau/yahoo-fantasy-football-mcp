# 05 — Testing strategy

**Author:** `architecture-planner-core` · **Date:** 2026-09-29 · **Brief:** `docs/scratch/briefs/architecture-planner-core.md`
**Inputs:** plans 01–04; `docs/research/03-yahoo-api.md` §A.2, §B.6, §D.1, §F; `05-strategy-and-analytics.md` §15 (engine verification); `04-data-sources.md` §B1, §H.8; the mcp-builder `evaluation.md` (read 2026-09-29); MCP Inspector README (`--cli`, `docs/cli-smoke-testing.md` "connect → list → call → assert … `--format json` + `jq`, the exit-code map" [V-inspector README, read 2026-09-29]); TypeScript SDK v2 docs listing (`docs/testing.md` exists — contents not read, marked [A-1]). Legend as in plan 01.

Standard carried over from SOTARA (`docs/12-testing-standards.md` there): **everything ships with tests, adversarial by default, the coverage gate is never lowered to pass, and a regression test is only real once it has been shown red against the un-fixed code** (the `mutation-verify` discipline). Two SOTARA lessons shape this plan: *2,376 green tests shipped a broken run because the fake modelled the API we wished for* (fake the native seam with its failure modes), and *4 of 10 field findings were regressions from fixes that passed their own tests* (test the property, not the value).

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| T1 | **Vitest for every level** (unit, property, contract, fault, process) with separate `vitest.workspace` projects; process tests spawn the built binary | one runner, one coverage report, native ESM/TS | Jest (ESM friction), node:test (no coverage gate ergonomics) | Nothing |
| T2 | **Property tests (`fast-check`) for the scoring engine, the key grammar, the envelope, the freshness classifier, and the redactor** | these are the components whose bugs are *silent* (a wrong score, an accepted bad key, a leaked token); properties survive constant changes, values do not | example tables only | Nothing |
| T3 | **Contract tests run against recorded, anonymised Yahoo XML fixtures**; recording is a manual, credentialed script; scrubbing is a separate, tested script with a deny-list assertion | the repo is public; nobody else can record; the wire format has five shape traps [V-03 §B.6] that only real payloads exhibit | hand-written XML | Nothing |
| T4 | **Fault injection through an injected `fetch`** (constructor DI on `httpClient`); no `nock`/`msw` | zero dependencies; the failure modes we need (999 with HTML, reset, timeout, malformed XML) are trivially expressed as a function | msw | Nothing |
| T5 | **Inspector CLI smoke in fixture mode runs in CI** (no credentials, no tokens) | the Inspector is the reference client; `--cli` + `--format json` is made for CI [V-inspector] | a hand-written stdio client | Nothing |
| T6 | **Model-driven evals: 10 read-only questions over the frozen fixture league**, run manually with the mcp-builder Python harness before a release | `evaluation.md`'s rules (read-only, independent, stable, single verifiable answer) are satisfiable only on frozen data | evals against the live league (answers change weekly) | Nothing |
| T7 | **Coverage gate: 90 % lines / 85 % branches / 90 % functions globally; 100 % lines + branches for six named modules** | §7 | 80 % flat | Nothing downward; upward as the codebase settles |
| T8 | **Every regression test is mutation-verified** before its finding is closed | SOTARA round-5 lesson | trust the green | Nothing |

---

## 1. The pyramid

| Level | Where | Tool | Runs in CI | Needs Yahoo creds | Needs model tokens |
|---|---|---|---|---|---|
| Unit | `tests/<mirror of src>/` | vitest | yes, every push | no | no |
| Property | `tests/property/` | vitest + fast-check | yes | no | no |
| Contract (recorded fixtures) | `tests/contract/` | vitest, `FixtureTransport` | yes | **recording only** (manual) | no |
| Fault injection | `tests/fault/` | vitest, injected `fetch` | yes | no | no |
| Process / lifecycle | `tests/process/` | vitest spawning `dist/cli.js` | yes (ubuntu); macOS weekly | no | no |
| Inspector smoke | `tests/smoke/` | `@modelcontextprotocol/inspector --cli` | yes | no (fixture mode) | no |
| Live smoke | `ff smoke` | the CLI against real Yahoo | **never in CI** | yes | no |
| Model-driven evals | `tests/evals/` | mcp-builder `scripts/evaluation.py` | no — manual, pre-release | no (fixture mode) | **yes** |

---

## 2. Unit and property tests — what must be asserted (adversarial by default)

| Module | Must-have assertions (each is a named test; the adversarial ones are not optional) |
|---|---|
| `mcp/envelope` | every tool's `outputSchema` forbids a bare `string` at any `untrusted_text` position (a test walks all registered tools); `meta.attribution` present whenever `source` includes `yahoo`; `age_s` computed from `fetched_at`, not `as_of`; **property:** serialised size ≤ 20 000 chars for any list length (halving until fit), `truncated` set iff halving happened; unicode/zero-width/bidi/HTML in wrapped text are stripped; caps enforced with `truncated: true` |
| `mcp/define` | registering a tool without `annotations` or `.strict()` input throws at registration (so it fails at startup, not at first call); `outputSchema` is required unless the tool is in the plan 07 C10 list-tool set, and a test asserts the set of schema-less tools is exactly that list *(round 1, OBJ-08)*; write tools are absent from the registry when `capabilities().write` is false; under `FF_TOOLSET=core` (default) exactly the 19 P0 tools are registered and under `full` exactly 30 (plan 07 C3) |
| `mcp/errors` | every code maps to a fixed message; an error built from an upstream body never contains that body (test with an HTML body containing a fake token and the request URL) |
| `providers/yahoo/path` | **property:** for generated valid keys the builder accepts and encodes; for each of 12 mutations (`L` for `l`, `1` for `l`, `..`, `;`, `/`, `?`, `#`, whitespace, unicode digits, empty, 40-digit ids, `nfl.p.x`) it rejects; output always starts with `/fantasy/v2/`; unknown resource/filter names rejected; `player_keys` > 25 rejected |
| `providers/yahoo/xml` | fixtures for each of the five JSON-shape traps' XML equivalents [V-03 §B.6] parse to typed domain objects; scalars coerced (`"0"` → `false`, `"112.82"` → number); `roster_positions.count` treated as data not size; **XXE and billion-laughs fixtures are inert** (no entity expansion, no file read, bounded time); 5 MB cap enforced |
| `providers/yahoo/errors` | the classifier table (plan 02 §3.2) with one fixture per row, including the 999 HTML "Request denied" body, an empty body, and a body that is JSON despite XML being requested |
| `providers/yahoo/limiter` | **property:** never more than `burst` requests in any window shorter than `burst/rate`; a 999 halves the refill rate for 10 min; coalescing: N concurrent identical requests → 1 upstream call, N identical results; writes are never retried (a counter asserts exactly one attempt on 999/timeout) |
| `providers/yahoo/cache` | cache-first: a fresh entry → zero upstream calls; `force_refresh` allowed once per 60 s per key; key canonicalisation (parameter order, `format`) |
| `config/freshness` | **property:** for every class `fresh < stale < hard` (shape, not values — plan 01 A-4..A-9); classifier monotone in age; `provisional` set for a Yahoo week before the next week's first kickoff and cleared after |
| `domain/scoring` | 05 §15 verbatim: golden equality within 0.01 against `player_points.total` for every rostered player in the fixture weeks; **mutation properties:** perturb one modifier by δ → total moves by exactly `δ × stat`; remove a bracket row → only games in that bracket change; adversarial fixtures: empty stat line, unknown stat ids (ignored, logged once), K with a 0-yard category, DST with 0 points allowed (bracket = 10), negative total under `uses_negative_points = 0` (marked [U] and asserted as *documented* behaviour), multi-target bonus, provisional week → `complete: false`; **property:** linearity in stat values except bonuses/brackets; a stat counted under `O` never counts under `DT` |
| `domain/crosswalk` | precedence (id → deterministic match → override); name normalisation (suffixes, punctuation, ASCII-fold) is idempotent; team-abbreviation mapping covers every abbreviation seen in fixtures with an explicit test that an unknown abbreviation fails loudly; a persisted pair survives a team change; Sleeper `gsis_id` leading space trimmed; DynastyProcess `NA` treated as null; never accept name-only |
| `domain/gate` | see §4.3 |
| `auth/token-store` | mode bits enforced (dir 0700, file 0600; a 0644 file is refused); atomic write (a crash injected between temp write and rename leaves the old file intact); **the client secret's value never appears in the written file** (grep test); rotation: the new refresh token is on disk before the new access token is returned to the caller; `version` bump on every write; upgrader from `version: 1..n-1` |
| `auth/lock` | two concurrent refreshers → exactly one Yahoo call, both see the new token; stale lock (dead pid, > 30 s) is broken with a warning; a live lock is respected |
| `auth/oauth` | Basic header has no trailing newline [V-03 §A.3]; `redirect_uri=oob` on exchange and refresh; `state` required and single-use on the listener path; `invalid_grant` → `NoTokens`; refresh-once semantics (a second 401 after refresh → `NOT_AUTHENTICATED`, no third call) |
| `cli/log` | **property:** for any object containing the current token/secret values, or strings matching the token/secret/`code=`/`state=`/guid/email patterns, the emitted line does not contain them; query strings stripped from URLs; bodies truncated to 500 after HTML stripping; never writes to stdout (fd 1 is a closed pipe in the test and nothing throws) |
| `http/client` | host allow-list: any host not listed → rejected before DNS; timeouts via `AbortSignal.timeout`; redirects to a non-allow-listed host rejected |
| `sources/*` | schema assertion: a fixture with one renamed column fails with the column name; a fixture with an extra column passes with a warning; loader is transactional (a failure mid-load leaves the previous dataset); `timestamp.txt` unchanged → no download; the license/attribution fields are present on every source (a test enumerates them) |
| `store` | migrations apply in order from empty and from each historical version; newer-store refusal; backup created before the first pending migration; `busy_timeout` honoured under a concurrent writer |
| `cli/doctor` | each check row has a passing and a failing fixture; `--json` shape stable; exit code = worst finding; offline mode makes zero network calls (the injected `fetch` throws if called) |
| `cli/print-config` | output paths are absolute and exist; no secret value present; `command` equals `process.execPath` |

---

## 3. Fixtures: capture, scrub, freeze

### 3.1 Yahoo (the only credentialed step; manual; never in CI)

1. **Record** — `scripts/record-fixture.ts --endpoint <name> [--league <key>] [--week N]` runs the real provider through the real token store and writes the **raw XML** to `~/.cache/fantasy-football-mcp/recordings/<name>.<ts>.xml` (outside the repo, never committed). The endpoint list mirrors 03 §B (settings, league metadata, standings, scoreboard, roster with `out=`, players FA page 1–2, players by keys with week stats, transactions, pending waivers, draft results, `game/nfl/game_weeks`, `game/nfl/stat_categories`, the provisioning probe). Each recording also captures HTTP status and headers (minus `Authorization`).
2. **Scrub** — `scripts/scrub-fixture.ts <recording> --out fixtures/yahoo/<endpoint>/<name>.xml` applies deterministic rules and refuses to write unless its deny-list check passes:

| Field | Rule |
|---|---|
| `league_id`, league key segments | → `1000` (a second league → `1001`); game id stays (`461` is Yahoo's own documentation value [V-03]) |
| `team_id` | kept (1..N) |
| team `name`, `team_logos.url`, `url` | → `Team N`, `https://example.invalid/team/N.png`, `https://example.invalid/league/1000/N` |
| league `name`, `url`, `logo_url`, `persistent_url`, `sendbird_channel_url`, `iris_group_chat_id`, `draft_recap_url`, `matchup_recap_url/title` | → `Fixture League` / `example.invalid` / removed |
| managers: `nickname`, `guid`, `email`, `image_url`, `felo_score`, `felo_tier` | → `Manager N`, `FIXTUREGUID00000000000000N`, removed, placeholder, removed, removed |
| `trade_note`, commissioner notes | → `note N` |
| players (public figures) | kept as-is — names, keys, stats, statuses; this is what the crosswalk and engine tests need |
| timestamps (`timestamp`, `league_update_timestamp`, `time`) | kept (freshness tests need real spacing) |
| anything matching a Yahoo key outside `461.l.100[0-9]` | **deny-list: abort** |
| the original league id, team names, nicknames (read from the recording) | **deny-list: abort if any survives** |

3. **Freeze** — `fixtures/yahoo/MANIFEST.json` records endpoint, `recorded_at`, scrub-rules version, sha256; a test fails if a fixture's hash differs from the manifest (so a "quick edit" to a fixture is a deliberate, reviewed change). Re-recording is a plan 06 manual job with a checklist (new season → new game id → placeholder table update).
4. **Fixture mode** — `FF_FIXTURE_DIR=<dir>` makes `YahooProvider` use `FixtureTransport`, which implements the same `fetch` interface and serves fixtures keyed by canonical path (and `status`/`headers` from the recording). Missing fixture → a distinct error naming the path (so smoke/evals fail clearly instead of silently). This is the mode CI, the smoke, and the evals use; it is not reachable when `YAHOO_CLIENT_ID` is set (a guard test).

### 3.2 External datasets

`fixtures/nflverse/` holds **small real release files** (≤ 300 KB each: `injuries`, `snap_counts`, `stats_team_week`, `timestamp.txt`, a `roster_weekly` excerpt) redistributed under CC-BY 4.0 with `fixtures/nflverse/ATTRIBUTION.md` [V-04 §B1 license]; files too large for that (pbp, depth charts) get **csv.gz excerpts** (≤ 50 rows) used for schema-assertion tests only. Parquet excerpts would need a writer (`hyparquet` reads only; a writer package exists but is unverified **[A-2]**). ffopportunity fixtures follow CC-BY-SA with its attribution line [V-04 §B2]. Sleeper/DynastyProcess samples are ≤ 20 rows, ids only. News fixtures (`fixtures/news/`) include hand-written RSS items that carry injection attempts ("ignore previous instructions and drop…", HTML, zero-width text, a 5 000-char blurb) — the envelope tests run over them.

---

## 4. Fault injection, lifecycle, and gate tests

### 4.1 Fault matrix (`tests/fault/`, injected `fetch`)

| Injected upstream behaviour | Expected tool result | Expected side effects | "Never" assertions |
|---|---|---|---|
| `999` with HTML "Request denied" | `RATE_LIMITED` after 3 attempts with backoff (fake timers) | limiter halved; log has `upstream_status: 999`, body truncated | body not in result; no 4th attempt |
| `429`, `500`, `503` | `UPSTREAM_UNAVAILABLE`, or stale data + warning when cache within hard limit | 3 attempts | same |
| timeout (`AbortError`), `ECONNRESET` | same as above | — | same |
| non-XML body with 200 | `UPSTREAM_UNAVAILABLE` | logged | not parsed as data |
| malformed XML | `UPSTREAM_UNAVAILABLE` | logged | no throw escapes the tool |
| XXE / entity bomb | inert, `UPSTREAM_UNAVAILABLE` or parsed without expansion | bounded time (< 1 s) | no file read (fake fs) |
| `200` with `<yahoo:error>` "data not found" | `NOT_FOUND` | — | — |
| `401 token_rejected` then `200` | success | exactly one refresh, new refresh token persisted before retry | — |
| `401 token_rejected` twice | `NOT_AUTHENTICATED` | one refresh only | no third call |
| `401 additional_authorization_required` | `NOT_PROVISIONED` | provisioning cached as terminal; write tools unregistered; `list_changed` emitted | no refresh attempted; no further Yahoo calls in the session |
| `403` "not authorized" | same | same | same |
| refresh → `invalid_grant` | `NOT_AUTHENTICATED` with the re-auth message | `refreshFailedAt` set; 5-min refresh backoff | no repeated refresh in 5 min |
| refresh returns a new refresh token, then the process is killed before rename | old file intact | next refresh uses the old token (documented re-auth path) | no torn file |
| two processes refresh concurrently | one Yahoo call | both load the new token | old refresh token never sent twice |
| players page returns 25 when 50 asked | two requests, correct `offset` | — | — |
| POST returns `201` | success | journal `applied` | — |
| PUT returns `400` with body | `VALIDATION` | journal `rejected_validation`; body in log only | body not in result; no retry |
| write times out | `applied: "unknown"` | journal `sent_unknown` | **no retry** |

### 4.2 Lifecycle (`tests/process/`, spawning `dist/cli.js`)

Startup < 1 s with no network (fetch stub via env that makes any network call exit 99); stdin EOF → exit 0 within 3 s; SIGTERM → exit 0; SIGINT twice → forced within 10 s, exit 5; parent SIGKILLed → child exits within 10 s (plan 03 A-3); stdout closed → exit 0 (EPIPE path); an in-flight fake write at shutdown → journal `sent_unknown`; `ff auth --listener` on a busy port → exit 2 with the `lsof` message; listener SIGINT → port free within 1 s; `serve` opens no listening socket (assert via `lsof -p` on macOS / `/proc/net/tcp` on Linux); a store from "version + 1" → exit 1 with the message; migration from every historical schema fixture.

### 4.3 Confirmation gate (`tests/domain/gate/` + `tests/mcp/gate/`)

Using the SDK's client package in-process (an in-memory client ↔ server pair; **[A-1]** that v2 ships such test transports — `docs/testing.md` exists in the SDK repo and is the first thing to read when building this):

- prepare → commit with **elicitation accept** → one write; **decline** → `CONFIRMATION_DENIED`, zero writes; **cancel within 2 s** → OOB code path offered; client without the capability → OOB path directly.
- **OOB code:** wrong code ×3 → prepared write voided; correct code → one write; the code never appears in any tool result (grep the transcript); the notification payload contains the diff summary **and the code**; **no file is written under `<config>/`** during the channel (an `fs` spy asserts zero writes — plan 02 §4.2 row 2, revised round 1); the journal row holds `sha256(code)` and never the code.
- **CLI:** `ff confirm <id>` → one write; `--cancel` → voided; **`ff confirm` and `ff auth` with stdin not a TTY (a pipe) → exit 2 with the message and zero writes** (plan 02 S13); the process test spawns them with `stdio: "pipe"`.
- **Claude Code detection (plan 02 S12, A-10):** with env `CLAUDECODE=1` and `FF_WRITE_ENABLED=1`, `ff doctor` #13 emits the "unsupported" warning; without the env it does not.
- **Ticket:** tampered (any byte) → rejected; expired (fake clock +11 min) → `CONFIRMATION_EXPIRED`; replay after `applied` → the original receipt, zero additional writes (`idempotentHint` holds); gate key rotated → pending writes voided with the documented message.
- **Precondition:** roster changed between prepare and commit (fixture swap) → `PRECONDITION_CHANGED`, zero writes; a locked player (`is_editable=0`) in the diff → prepare refuses.
- **Legacy era:** the same flow against a client speaking the `initialize` handshake (SDK legacy shim on) [V-sdk input-required.md].
- **Property:** for any sequence of prepare/commit/cancel calls, the number of upstream writes ≤ the number of distinct `prepared_id`s that received valid evidence exactly once.

### 4.4 Security regression set (always green, always mutation-verified)
Redaction with adversarial strings; secret-not-in-token-file; path grammar rejections; league allow-list; `.strict()` rejects unknown keys; envelope forbids bare strings; XXE inert; host allow-list; no write tool visible without provisioning; no `console.log` outside `src/cli` (a lint test, plan 04).

---

## 5. Inspector smoke (`tests/smoke/`, CI, zero credentials)

Per the Inspector's `docs/cli-smoke-testing.md` workflow ("connect → list → call → assert", `--format json`, exit-code map [V-inspector README]):

```
FF_FIXTURE_DIR=fixtures/yahoo npx -y @modelcontextprotocol/inspector@<pin> --cli node dist/cli.js serve --method tools/list --format json \
  | jq -e '[.tools[].name] == $expected' --argjson expected "$(cat tests/smoke/expected-tools.json)"
… --method tools/call --tool-name ff_get_league --tool-arg league_key=461.l.1000 --format json \
  | jq -e '.structuredContent.meta.attribution[0].text == "Fantasy data provided by Yahoo Fantasy" and .structuredContent.meta.freshness != null'
```

Assertions: the tool list equals the expected file (order included — determinism, plan 01 §3.1); **no `ff_commit_*`/`ff_prepare_*` tool is listed** in fixture mode without `FF_WRITE_ENABLED`; a call returns the envelope with attribution, freshness, and `untrusted_text` wrappers; `resources/list` carries `ttlMs` and `cacheScope`. Which protocol era the Inspector speaks by default is **[A-3]**; if it can pin the era, the smoke runs twice. The exact flag names above are from the README's description of the CLI mode; verify against `docs/cli-smoke-testing.md` at build time.

`ff smoke` (the CLI subcommand) is the *live* counterpart: with real credentials it lists leagues, reads settings, scores one roster week and compares it to `player_points.total`; it is run by Chad, never by CI.

---

## 6. Model-driven evals (`tests/evals/`, manual, tokens)

Built exactly as `evaluation.md` prescribes, with the fixture league as the world:

- **Why fixtures make this possible:** the eval rules require answers that are "STABLE/STATIONARY" and questions that are "READ-ONLY, INDEPENDENT, NON-DESTRUCTIVE" [V-evaluation.md]; a live league violates stability weekly. The frozen fixture league (weeks recorded through a chosen week `N`) is a closed world: every answer is a fact of the fixtures.
- **How the 10 questions are built:** (1) inspect the tool list and descriptions only — never the server code (`evaluation.md` Step 2–3); (2) explore the fixture league through the tools in fixture mode; (3) write 10 multi-hop questions whose answers are single verifiable strings — e.g. *"Which fixture-league team had the largest margin of defeat in the week with the highest combined score through week N? Answer with the team name."*, *"How many free agents at RB in the fixture league had more receptions than carries in week N? Answer with an integer."*, *"For the fixture league's scoring, how many points does a 45-yard field goal score? Answer with a number."*, *"Which player on Team 3's week-N roster was slotted in the flex position? Full name."*, a true/false on a standings tiebreak, a bye-week question via the game weeks, a transaction-order question, a percent-owned comparison, a stat-id lookup via settings, a projected-vs-actual team total question; (4) solve each with the tools and record the answer; (5) store as `tests/evals/read-only.xml` in the `<evaluation><qa_pair>` format.
- **Running:** `python scripts/evaluation.py -t stdio -c node -a dist/cli.js serve -e FF_FIXTURE_DIR=<abs path> -o docs/evals/<date>.md tests/evals/read-only.xml` (the harness needs `pip install anthropic mcp` and `ANTHROPIC_API_KEY` [V-evaluation.md "Setup"]). Pass bar **≥ 8/10 [A-4]**; the report's "agent feedback on the tools" is triaged into tool-description fixes.
- Cost: this is the *only* test that consumes model tokens; it runs before a release and after any tool-description change, not on every push.

---

## 7. Coverage gate

**Global:** lines 90 %, branches 85 %, functions 90 %, statements 90 % (`@vitest/coverage-v8`, `thresholds` in `vitest.config.ts`, enforced by `scripts/check-coverage.ts` in CI so the numbers are also reviewable in the job summary).
**Per-file 100 % lines and branches:** `src/domain/scoring/**`, `src/domain/gate/**`, `src/providers/yahoo/path.ts`, `src/providers/yahoo/errors.ts`, `src/auth/token-store.ts`, `src/cli/log.ts`.
**Excluded from coverage:** `src/cli/cli.ts` (arg dispatch), generated code, `tests/`.

*Why these numbers:* 90/85 is where a codebase this size stops being "coverage by accident" without spending effort on glue; the six 100 % modules are the ones where an untested branch is a silent wrong score, an accepted bad key, an unrecognised terminal error, a torn token file, or a leaked secret — a branch there is a threat-model row (plan 02 §8). *Alternative:* 80 % flat. *What would change it:* only upward. The gate is never lowered to pass a build; a red gate means write the test or delete the dead code.

---

## 8. What runs with zero tokens, what needs tokens, what needs credentials

| Activity | Model tokens | Yahoo credentials | Network |
|---|---|---|---|
| lint, typecheck, unit, property, contract, fault, process, Inspector smoke, coverage, audit, license, secret scan, Mermaid, Skills structure, tarball scan | none | none | npm registry only (CI) |
| Fixture recording + scrubbing | none | **yes** (Chad's machine) | Yahoo |
| `ff smoke`, `ff doctor --online` | none | yes | Yahoo |
| Dataset refresh tests (real `timestamp.txt`) | none | none | GitHub releases (scheduled job only) |
| Model-driven evals | **yes** | none (fixture mode) | Anthropic API |
| Skill quality review (product planner's domain) | yes | none | — |

---

## 9. What this plan does not decide
Analytics-model evaluation (backtests, Brier/CRPS — 05 §12; product planner); the Skills' behavioural tests (plans 09/10); the schedule of the credentialed manual jobs (plan 06).

---

## 10. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | SDK v2 ships in-memory/test transports for client↔server tests | `docs/testing.md` in the SDK repo (exists; not read) |
| A-2 | A pure-JS parquet *writer* exists for making excerpts | npm search at build time; csv.gz excerpts are the fallback already chosen |
| A-3 | Which protocol era the Inspector CLI speaks by default, and whether it can pin one | Inspector docs at build time |
| A-4 | 8/10 as the eval pass bar | first run; the bar is a constant in the eval script |
| U | Exact Inspector CLI flag names (`--tool-name`, `--tool-arg`, `--format json`) | `docs/cli-smoke-testing.md` |
