# 04 — Repository structure and CI

**Author:** `architecture-planner-core` · **Date:** 2026-09-29 · **Brief:** `docs/scratch/briefs/architecture-planner-core.md`
**Inputs:** plans 01–03 (module map, supply-chain controls, doctor); `docs/HANDOFF.md` (public repo, no identifiers, no branch protection today); `docs/research/02-prior-art-lessons.md` §4 #8–#12; the mcp-builder `node_mcp_server.md` project-structure and tsconfig guidance (adapted, not copied — it targets SDK v1 and Node 16 module resolution); TypeScript SDK v2 README (`zod/v4`, Node ≥ 20 [V-npm]). Legend as in plan 01.

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| R1 | **Single npm package, no workspaces** | one deployable, one lockfile to audit, one `npm ci`; the ESPN seam is an interface, not a package | Turborepo/workspaces (`server`, `skills`, `espn`) | publishing the Skills bundle or a provider separately — then split, the module boundaries (plan 01 §1.1) are already package-shaped |
| R2 | **TypeScript strict ESM, `module: NodeNext`, `target: ES2023`, Node ≥ 22.13** | the SDK v2 is ESM with `zod/v4`; `NodeNext` is the resolution Node actually performs; ES2023 is fully supported by Node 22 | CommonJS; bundling with esbuild | Nothing |
| R3 | **ESLint 9 flat config + typescript-eslint (type-checked), Prettier, import-boundary rules per directory** | boundaries in plan 01 §1.1 must be mechanical; `no-console` outside `src/cli/` protects stdout (plan 01 §2) | Biome (single tool) | Biome gaining type-aware rules equivalent to `no-floating-promises` |
| R4 | **Conventional Commits, checked by a 30-line script in CI** (PR title + every commit on the PR) | changelog and release notes derive from it; a `commitlint` install brings ~100 transitive dev packages for a regex | commitlint | Nothing |
| R5 | **CI on every push and PR: ubuntu, Node 22 and 24 matrix**; macOS job weekly and on release only | Linux minutes are cheap and cover everything but launchd/`osascript`; macOS covers those on a cadence | macOS on every push | a macOS-only bug slipping through more than once |
| R6 | **Secret scanning = gitleaks** (pinned action) with repo-specific rules for Yahoo credential shapes **and** Yahoo league/team keys | single binary, no runtime, custom TOML rules, scans history; the two leaked prior-art repos would have been caught [V-01 #1, #7]; league ids are identifiers this public repo must not carry [V-HANDOFF] | trufflehog (heavier, verification calls out); GitHub push protection alone (secret shapes only, no custom "identifier" rules) | Nothing — both can coexist; push protection should also be turned on |
| R7 | **Mermaid validation with `@mermaid-js/mermaid-cli` pinned, run only when `docs/**` changes** | it is the reference renderer (what GitHub's renderer agrees with most closely); the docs are the plan, and a diagram that does not render is a failed deliverable (brief) | `@mermaid-js/parser` (covers a subset of diagram types) | a lighter parser covering flowchart, sequence, and state diagrams |
| R8 | **Release = tag `vX.Y.Z` → CI builds, tests, checks CHANGELOG, `npm pack --dry-run`, scans the tarball for identifiers, publishes a GitHub Release with the tarball**; npm publish is manual by Chad with `--provenance` (deferred) | no agent publishes anything (docs/15 rule); the tarball scan is the last line against shipping a fixture with a real id | automated `npm publish` from CI | Chad deciding to publish to npm at all |
| R9 | **Branch protection on `main` via a ruleset: required CI status, no force-push, no deletion; PRs not yet required** | the agent program pushes directly to `main` today (HANDOFF); requiring PRs now would break it; the checks still gate what lands | require PRs + review now | the moment product code exists: require PRs with CI green; Chad (admin) merges without review — solo maintainer |
| R10 | **Coverage gate lives in CI, never lowered to pass** — value and rationale in plan 05 §7 | SOTARA's standing rule, carried over | — | — |

---

## 1. Directory tree

```
yahoo-fantasy-football-mcp/
├── package.json                 # name: fantasy-football-mcp · bin: ff · type: module · engines.node >=22.13
├── package-lock.json            # committed; npm ci only
├── .npmrc                       # save-exact=true · ignore-scripts=true · fund=false · audit=true
├── tsconfig.json                # strict ESM (§3)
├── tsconfig.build.json          # excludes tests/fixtures
├── eslint.config.js             # flat config (§3)
├── .prettierrc                  # 100 cols, double quotes, trailing commas
├── .gitleaks.toml               # custom rules (§4.3)
├── .gitignore                   # exists today — untouched by this plan
├── .env.example                 # exists today — untouched by this plan
├── README.md                    # docs-writer's file (attribution + logo live here)
├── CHANGELOG.md                 # Keep a Changelog; CI checks a tag has an entry
├── LICENSE                      # to be recommended in the docs phase (HANDOFF item 3)
├── SECURITY.md                  # docs-writer's file
├── src/
│   ├── cli.ts                   # entry: `ff <subcommand>`; `serve` is the client's command
│   ├── config/
│   │   ├── schema.ts            # zod schema of every env/config key (README table generated from it)
│   │   ├── paths.ts             # XDG resolution, absolute-path assertions
│   │   └── freshness.ts         # TTL / hard-limit constants (plan 01 §5.4)
│   ├── mcp/                     # MCP surface only
│   │   ├── server.ts            # McpServer construction, serveStdio
│   │   ├── registry.ts          # the one ordered tool/resource/prompt list
│   │   ├── define.ts            # defineTool(): forces annotations, outputSchema, envelope
│   │   ├── envelope.ts          # meta/attribution/untrusted_text/page/truncation
│   │   ├── errors.ts            # error-code table (plan 01 §4.3)
│   │   ├── bounds.ts            # numeric/string bounds (plan 02 §5)
│   │   ├── tools/               # one file per tool family (product planner fills)
│   │   ├── resources/
│   │   └── prompts/
│   ├── domain/                  # pure
│   │   ├── league/              # league model, slots, rules predicates
│   │   ├── scoring/             # engine (05 §15) + stat canonical names
│   │   ├── analytics/           # projections, start/sit, waivers … (product planner)
│   │   ├── crosswalk/           # matcher (04 §D), overrides loader
│   │   ├── gate/                # PreparedWrite, ticket, precondition, channels (plan 02 §4)
│   │   └── reclog/              # recommendation log (05 §12)
│   ├── providers/
│   │   ├── platform.ts          # FantasyPlatform interface (plan 01 §8)
│   │   └── yahoo/
│   │       ├── provider.ts
│   │       ├── path.ts          # the one path builder + key grammar
│   │       ├── xml.ts           # parser config (no DTD/entities), normaliser to domain types
│   │       ├── xml-write.ts     # write-body serializer
│   │       ├── errors.ts        # classifier table (plan 02 §3.2)
│   │       ├── limiter.ts       # global bucket + coalescing
│   │       ├── cache.ts         # yahoo_cache policy
│   │       └── stat_map.ts      # Yahoo stat_id → canonical stat name
│   ├── sources/
│   │   ├── source.ts            # DataSource interface
│   │   ├── nflverse/  (schemas.ts holds expected columns per file)
│   │   ├── ffopportunity/
│   │   ├── sleeper/
│   │   ├── dynastyprocess/
│   │   ├── news/                # RSS: rotowire, espn (+ cbs fallback)
│   │   ├── weather/             # open-meteo, nws
│   │   └── odds/                # the-odds-api (optional)
│   ├── store/
│   │   ├── db.ts                # DatabaseSync open, pragmas, busy_timeout
│   │   ├── migrations/          # 001_init.ts …
│   │   └── repos/               # one repository per table family
│   ├── auth/
│   │   ├── oauth.ts             # authorization-code client (oob + listener)
│   │   ├── token-store.ts       # 0700/0600, wx+rename, lock, version
│   │   ├── secret.ts            # SecretSource: env | file (| keychain later)
│   │   └── listener.ts          # fixed-port https callback (plan 03 §2.2)
│   ├── http/
│   │   └── client.ts            # fetch wrapper: host allow-list, timeouts, limiter hook, redaction
│   └── cli/
│       ├── log.ts               # stderr JSON logger + redaction
│       ├── serve.ts · auth.ts · status.ts · doctor.ts · smoke.ts · refresh.ts
│       ├── confirm.ts · snapshot.ts · print-config.ts · install-launchd.ts · uninstall.ts
│       └── launchd/             # plist templates (absolute paths filled at install)
├── tests/                       # mirrors src/ (unit), plus:
│   ├── contract/                # recorded-fixture tests per Yahoo endpoint
│   ├── fault/                   # 999/401/403/timeout/malformed injection
│   ├── property/                # fast-check: key grammar, scoring engine, envelope
│   ├── process/                 # spawn the real binary: shutdown, orphan, lock race, listener close
│   └── evals/                   # 10-question read-only eval (plan 05 §6), run manually
├── fixtures/                    # ANONYMISED only (plan 05 §3) — placeholder ids 461.l.1000…
│   ├── yahoo/                   # raw XML per endpoint, scrubbed
│   ├── nflverse/                # tiny parquet/csv.gz excerpts (≤ 50 rows) for schema tests
│   ├── news/                    # RSS samples incl. injection attempts
│   └── golden/                  # scoring-engine expected outputs
├── skills/                      # the Skills bundle (product planner / skills researcher own content)
│   └── <skill-name>/SKILL.md (+ resources/)
├── scripts/                     # zero-token tooling (plan 06): record-fixture, scrub, gen-config-docs,
│   │                            # check-commits, check-licenses, check-no-scripts, check-mermaid, check-skills, scan-tarball
├── docs/                        # research/, plan/, scratch/, HANDOFF.md (as today)
└── .github/
    ├── workflows/ci.yml · docs.yml · release.yml · scheduled.yml
    ├── dependabot.yml           # security updates only
    └── PULL_REQUEST_TEMPLATE.md # checklist: no identifiers, tests, docs, changelog
```

`dist/` is built, git-ignored, and is what the launch config points at (plan 03 §4).

---

## 2. Package layout and dependencies

**Runtime dependencies (the allow-list; adding one needs a row here with reason and rejected alternative):**

| Package | Pinned at (2026-09-29) | Why | Rejected alternative |
|---|---|---|---|
| `@modelcontextprotocol/server` | 2.2.0 [V-npm] | the SDK (plan 01 D2); brings `@modelcontextprotocol/core` 2.2.0 and `zod ^4.2.0` as its own deps [V-npm] | v1 `@modelcontextprotocol/sdk` 1.31.0 (fallback, plan 01 D2) |
| `zod` | 4.x exact (match the SDK's resolved version) | tool schemas (SDK accepts Zod v4 via `zod/v4` [V-sdk]); config schema | valibot (a second schema library for no gain) |
| `fast-xml-parser` | latest 5.x exact **[A-1 on major]** | Yahoo XML (plan 01 D3); pure JS; no DTD/entity expansion by default [plan 02 A-9] | `@rgrove/parse-xml` (no object mapping); `sax` (unmaintained) |
| `hyparquet` | 1.31.x exact [V-npm: pure JS, MIT, zero deps, no install scripts] | nflverse/ffopportunity parquet (plan 01 D7) | `parquetjs` (native/thrift deps); DuckDB (native) |

That is it: **four direct runtime packages** (five with `core` transitively). Everything else is Node built-ins: `node:sqlite`, `fetch`, `node:crypto`, `node:zlib`, `node:util.parseArgs`, `node:fs/promises`, `node:child_process` (for `osascript`, `openssl`, `lsof`, `launchctl` — all invoked with argument arrays, never a shell string).

**Dev dependencies:** `typescript`, `vitest` + `@vitest/coverage-v8`, `fast-check`, `eslint` + `typescript-eslint` + `eslint-plugin-import-x` (boundaries), `prettier`, `tsx`, `@types/node`. Run via `npx` with pinned versions in CI only: `@modelcontextprotocol/inspector`, `@mermaid-js/mermaid-cli`.

`package.json` essentials: `"type": "module"`, `"bin": { "ff": "dist/cli.js" }`, `"engines": { "node": ">=22.13" }`, `"files": ["dist", "skills", "README.md", "LICENSE", "CHANGELOG.md"]` (fixtures and tests never ship), scripts: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `test:process`, `smoke` (Inspector CLI), `eval` (manual, tokens), `check:commits`, `check:licenses`, `check:no-scripts`, `check:mermaid`, `check:skills`, `check:docs` (generated README table current), `pack:scan`.

---

## 3. TypeScript, lint, format, commits

**`tsconfig.json`** (differences from the house reference are deliberate: it shows `Node16` + `ES2022`; we are on Node 22+ and SDK v2):

```jsonc
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext", "lib": ["ES2023"],
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true, "noFallthroughCasesInSwitch": true, "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true, "isolatedModules": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "src", "sourceMap": true, "declaration": false
  },
  "include": ["src/**/*"]
}
```

`noUncheckedIndexedAccess` is the one that matters for this codebase: Yahoo collections and parquet rows are index-accessed everywhere, and 03 §B.6's shape traps are exactly "index 1 may not exist".

**ESLint (flat):** `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`; `@typescript-eslint/no-explicit-any: error` (an inline `// eslint-disable-next-line … -- reason` is the only escape, as in SOTARA); `@typescript-eslint/no-floating-promises: error`; `no-console: error` with an override allowing it under `src/cli/**`; **import boundaries** via `import-x/no-restricted-paths` zones mirroring plan 01 §1.1 (e.g. `src/domain/**` may not import `src/providers/**`, `src/sources/**`, `src/store/**`, `src/mcp/**`, `@modelcontextprotocol/*`; `src/mcp/**` may not import `src/store/**` or `node:fs`); `no-restricted-imports` bans `child_process`'s `exec`/`execSync` (argument-array `execFile` only) and `eval`.

**Prettier** for format; `format:check` in CI. **EditorConfig** for the rest.

**Commits:** Conventional Commits (`feat|fix|docs|test|chore|refactor|perf|ci|build(scope): subject`), `scripts/check-commits.ts` validates every commit on a PR and the PR title; `Co-Authored-By` trailers allowed. Roadmap-ID references are not required (this repo has no roadmap ids; the SOTARA convention does not transfer).

---

## 4. CI

All workflows: `permissions: contents: read` by default; actions pinned by **commit SHA** (not tag); `concurrency` cancels superseded runs; `npm ci` with the committed lockfile; Node from `.nvmrc`/matrix.

### 4.1 `ci.yml` — every push to any branch, every PR

| Job | Steps | Fails when |
|---|---|---|
| `lint` | `npm ci` → `npm run lint` → `npm run format:check` → `npm run check:commits` (PRs) | any lint/format/commit-format error |
| `typecheck` | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`, includes tests) | any type error |
| `test` (matrix node 22, 24) | `npm run test:coverage` → upload `coverage/` artifact → `scripts/check-coverage.ts` reads `coverage-summary.json` against the gate (plan 05 §7) | any test fails; coverage below gate; a per-file 100 % module below 100 % |
| `process` | `npm run build` → `npm run test:process` (spawns the built binary: startup < 1 s, stdin-EOF exit 0, SIGTERM exit 0, orphan exit, two-process lock race, listener closes) | any process test fails |
| `smoke` | `npm run build` → `npx -y @modelcontextprotocol/inspector@<pin> --cli node dist/cli.js serve --method tools/list` in **fixture mode** (`FF_FIXTURE_DIR=fixtures/yahoo`, no credentials) → assert the expected tool names and that no write tool is listed | list differs from `tests/smoke/expected-tools.json` |
| `supply-chain` | `npm audit --omit=dev --audit-level=high` (gate) · `npm audit` (report only) · `npm run check:no-scripts` (no `install`/`postinstall`/`preinstall` and no `binding.gyp`/`prebuild-install` in `npm ls --omit=dev`) · `npm run check:licenses` (allow-list: MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense; anything else fails with the package name) · `npm ls --omit=dev --depth=0` diff against the §2 allow-list | any high/critical runtime advisory; any install script; any license outside the list; any undeclared runtime dependency |
| `secrets` | gitleaks (pinned) with `.gitleaks.toml`, full history on PRs from forks disabled (no untrusted PR gets secrets anyway — `permissions` are read-only) | any finding not on the allow-list |
| `pack` | `npm run build` → `npm pack --dry-run --json` → `scripts/scan-tarball.ts` asserts: only `files` globs; no `fixtures/`, `tests/`, `.env*`, `*.sqlite`; no string matching a Yahoo key outside the placeholder range | any violation |

### 4.2 `docs.yml` — on changes under `docs/**`, `skills/**`, `README.md`

| Job | Steps |
|---|---|
| `mermaid` | `scripts/check-mermaid.ts` extracts every ```` ```mermaid ```` block into `tmp/*.mmd` → `npx -y @mermaid-js/mermaid-cli@<pin> -i <file> -o /dev/null` per block (a parse error fails with file + block index) |
| `skills` | `scripts/check-skills.ts`: every `skills/*/SKILL.md` has YAML frontmatter with `name` (equal to the directory name, `[a-z0-9-]+`) and `description` (non-empty, ≤ 1024 chars) **[A-2: field rules from the Anthropic Skills format as commonly documented; `docs/research/06` will confirm or amend]**; referenced resource files exist; no file > 200 KB; no Yahoo key outside the placeholder range; the untrusted-text rule sentence (plan 02 §6.4) is present in each skill that reads news or notes |
| `docs-current` | `npm run check:docs` — regenerates the README config table from `src/config/schema.ts` and fails on diff |
| `links` | internal relative links resolve (a 40-line script; no external link checking — flaky) |

### 4.3 gitleaks rules (`.gitleaks.toml`, in addition to the defaults)

| Rule id | Pattern (sketch) | Why |
|---|---|---|
| `yahoo-client-id` | `dj0yJmk9[A-Za-z0-9=\-]{20,}` **[A-3: the `dj0yJmk9` prefix is the base64 of `2&i=` that Yahoo app ids start with — verify against a real id before relying on it]** | app registration id |
| `yahoo-client-secret` | context `(consumer|client)_?secret` + 40 hex chars | secret |
| `yahoo-oauth-token` | context `refresh_token\|access_token` + long base64/URL-safe string | tokens |
| `yahoo-guid` | `xoauth_yahoo_guid` + 26 uppercase alnum | user identifier |
| `yahoo-league-key` | `\b\d{3}\.l\.\d{4,8}\b` with allow-list `\d{3}\.l\.1000\d?` (fixture placeholders) | league ids are identifiers (HANDOFF) |
| `yahoo-team-key` | `\b\d{3}\.l\.\d{4,8}\.t\.\d{1,2}\b` (same allow-list) | team ids |
| `odds-api-key` | `ODDS_API_KEY\s*=\s*[0-9a-f]{32}` | optional key |

Also enable GitHub's built-in push protection (settings, Chad) — no CI can undo a pushed secret; only rotation can [V-02 §6].

### 4.4 `release.yml` — on tag `v*`

Build → full `ci.yml` jobs → `scripts/check-changelog.ts` (the tag's version has a dated section in `CHANGELOG.md`) → `npm pack` → `scan-tarball` → attach the tarball and its sha256 to a GitHub Release with the changelog section as body. **No `npm publish`** from CI (R8); the README documents `npm publish --provenance --access public` for Chad, from a clean checkout at the tag, after `ff doctor` on a fresh store passes. Semantic versioning: breaking changes to tool names/schemas or the store format bump major (pre-1.0: minor).

### 4.5 `scheduled.yml` — weekly (Monday 06:00 UTC) + manual

`npm audit` full report → `npm outdated --json` summarised into the job summary → macOS runner: `npm run test:process` (launchd plist generation, `osascript` notification path with a stub, `lsof` port report) → Inspector smoke. Failures open an issue via the Actions summary (no bot tokens beyond `GITHUB_TOKEN`).

### 4.6 What can be built **before** the server exists
`docs.yml` (Mermaid + links + skills structure), `secrets` job, `dependabot.yml`, `PULL_REQUEST_TEMPLATE.md`, `.gitleaks.toml`, the ruleset (§5) — all of these work on the current docs-only repo and should land first (plan 06 marks them).

---

## 5. Branch protection recommendation for `main`

Today: public, no protection, no rulesets [V-HANDOFF item 1]. Recommended ruleset (Chad applies it; agents do not touch repo settings):

| Now (docs phase) | When product code lands |
|---|---|
| Block force-pushes and deletion of `main` | same |
| Require status checks `docs / mermaid`, `docs / skills`, `secrets` to pass before a push is accepted — **without** requiring a PR (the agent program pushes to `main` directly; a red check blocks the push, which is the protection that matters) **[A-4: whether GitHub rulesets can require checks on direct pushes — if not, the checks run post-push and a red `main` is the agents' `ci-vigilance` obligation, as in SOTARA]** | Require a PR; required checks: all `ci.yml` jobs; linear history; conversation resolution; **no required reviewers** (solo maintainer); admins bypass allowed for Chad only |
| Enable secret-scanning push protection | same |
| Dependabot security updates only | same; version updates monthly, grouped |

---

## 6. Docs that are generated, not written

- README config table ← `src/config/schema.ts` (`scripts/gen-config-docs.ts`), checked in CI.
- `ff print-config` output ← the same schema.
- The tool reference in `docs/` ← `tools/list` output in fixture mode (`scripts/gen-tool-docs.ts`), so the docs cannot drift from the registry; `docs-writer` owns the prose around it.

---

## 7. What this plan does not decide
The tests inside each job (plan 05); the schedule and inputs of every zero-token job beyond CI (plan 06); the Skills' content and validation rules beyond structure (plans 09/10 and `docs/research/06`).

---

## 8. Assumptions and unverified, by name

| # | Assumption | Verify by |
|---|---|---|
| A-1 | `fast-xml-parser` current major is 5.x and has the no-DTD default | npm view at pin time; the XXE fixture test |
| A-2 | Skills frontmatter rules (`name`, `description` ≤ 1024) | `docs/research/06` |
| A-3 | Yahoo app ids start with `dj0yJmk9` | one real id, checked locally, never committed |
| A-4 | GitHub rulesets can require passing checks on direct pushes to `main` | GitHub docs at setup time; fallback stated in §5 |
| A-5 | `import-x/no-restricted-paths` expresses the plan 01 §1.1 zones | write the config; a boundary test imports the wrong module and expects a lint error |
