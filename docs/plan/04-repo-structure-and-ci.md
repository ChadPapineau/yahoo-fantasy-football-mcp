# 04 — Repository structure and CI

**Author:** `architecture-planner-core` · **Date:** 2026-09-29 · **Brief:** `docs/scratch/briefs/architecture-planner-core.md`
**Inputs:** plans 01–03 (module map, supply-chain controls, doctor); `docs/HANDOFF.md` (public repo, no identifiers, no branch protection today); `docs/research/02-prior-art-lessons.md` §4 #8–#12; the mcp-builder `node_mcp_server.md` project-structure and tsconfig guidance (adapted, not copied — it targets SDK v1 and Node 16 module resolution); TypeScript SDK v2 README (`zod/v4`, Node ≥ 20 [V-npm]). Legend as in plan 01.
**Yahoo-dependency:** **`none`** — repo layout and CI need no Yahoo access; the `secrets` rules only *scan* for Yahoo credential and key shapes; fixtures are recorded elsewhere (plan 05 §3.1). *(tag added round 1, D.2 item 1: what survives a Yahoo denial is visible at a glance.)*

---

## 0. Decisions at a glance

| # | Decision | Why | Alternative considered | What would change it |
|---|---|---|---|---|
| R1 | **Single npm package, no workspaces** | one deployable, one lockfile to audit, one `npm ci`; the ESPN seam is an interface, not a package | Turborepo/workspaces (`server`, `skills`, `espn`) | publishing the Skills bundle or a provider separately — then split, the module boundaries (plan 01 §1.1) are already package-shaped |
| R2 | **TypeScript strict ESM, `module: NodeNext`, `target: ES2023`, Node ≥ 24.15** *(revised round 1, OBJ-09)* | the SDK v2 is ESM with `zod/v4`; `NodeNext` is the resolution Node actually performs; ES2023 is fully supported by Node 24; the floor is `node:sqlite`'s release-candidate line (plan 01 D2 — v22 warns at every start) | CommonJS; bundling with esbuild; Node 22 with the warning | Nothing downward |
| R3 | **ESLint 9 flat config + typescript-eslint (type-checked), Prettier, import-boundary rules per directory** | boundaries in plan 01 §1.1 must be mechanical; `no-console` outside `src/cli/` protects stdout (plan 01 §2) | Biome (single tool) | Biome gaining type-aware rules equivalent to `no-floating-promises` |
| R4 | **Conventional Commits, checked by a 30-line script in CI** (PR title + every commit on the PR) | changelog and release notes derive from it; a `commitlint` install brings ~100 transitive dev packages for a regex | commitlint | Nothing |
| R5 | **CI on every push and PR: ubuntu, Node 24 only** (25 is added to the matrix when it becomes LTS); macOS job weekly and on release only *(revised round 1, OBJ-09: was a 22 + 24 matrix)* | Linux minutes are cheap and cover everything but launchd/`osascript`; macOS covers those on a cadence; testing on 22 would test a `node:sqlite` API the maintainers may still change and admit a floor the product rejects | macOS on every push; a 22 + 24 matrix | a macOS-only bug slipping through more than once; Node 25 LTS |
| R6 | **Secret scanning = gitleaks** (pinned action) with repo-specific rules for Yahoo credential shapes **and** Yahoo league/team keys | single binary, no runtime, custom TOML rules, scans history; the two leaked prior-art repos would have been caught [V-01 #1, #7]; league ids are identifiers this public repo must not carry [V-HANDOFF] | trufflehog (heavier, verification calls out); GitHub push protection alone (secret shapes only, no custom "identifier" rules) | Nothing — both can coexist; push protection should also be turned on |
| R7 | **Mermaid validation with `@mermaid-js/mermaid-cli` pinned — and its `puppeteer` peer pinned beside it, Chrome installed explicitly, `--ignore-scripts=false` on `npx` — run only when `docs/**` changes** *(revised round 1, OBJ-12: the project `.npmrc`'s `ignore-scripts=true` would otherwise skip puppeteer's Chrome-downloading postinstall, §4.2)* | it is the reference renderer (what GitHub's renderer agrees with most closely); the docs are the plan, and a diagram that does not render is a failed deliverable (brief) | `@mermaid-js/parser` (covers a subset of diagram types); a third-party Mermaid action (one more supply-chain item) | a lighter parser covering flowchart, sequence, and state diagrams |
| R8 | **Release = tag `vX.Y.Z` → CI builds, tests, checks CHANGELOG, `npm pack --dry-run`, scans the tarball for identifiers, publishes a GitHub Release with the tarball**; npm publish is manual by Chad with `--provenance` (deferred) | no agent publishes anything (docs/15 rule); the tarball scan is the last line against shipping a fixture with a real id | automated `npm publish` from CI | Chad deciding to publish to npm at all |
| R9 | **Branch protection on `main` via a ruleset: no force-push, no deletion, linear history, secret-scanning push protection (already on) — and no required status checks** until PRs are required when product code lands; the docs-phase substitute is the `ci-vigilance` obligation (§5) *(revised round 1, OBJ-13: the earlier row required `docs`/`secrets` checks on direct pushes)* | the agent program pushes directly to `main` today (HANDOFF); requiring PRs now would break it. Required checks would break it too: GitHub's rule is "After all required status checks pass, any commits must either be pushed to another branch and then merged or pushed directly to the protected branch" [V-web docs.github.com about-protected-branches, 2026-09-30 — log §1.0], so a commit that has not run the checks anywhere is **rejected** on a direct push — exactly at a usage cutoff, when "push before teardown" matters most; and `docs.yml` is path-filtered, so a required check that does not run would block the push as well. `ci-bootstrap` reached the same conclusion independently (HANDOFF 2b) | require PRs + review now; required checks without PRs (the earlier draft) | the moment product code exists: require PRs with CI green; Chad (admin) merges without review — solo maintainer |
| R10 | **Coverage gate lives in CI, never lowered to pass** — value and rationale in plan 05 §7 | SOTARA's standing rule, carried over | — | — |

---

## 1. Directory tree

```
yahoo-fantasy-football-mcp/
├── package.json                 # name: fantasy-football-mcp · bin: ff · type: module · engines.node >=24.15
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
| `fast-xml-parser` | **4.x or 5.x exact — decided at pin time by the rule below** *(revised round 1, OBJ-14)* | Yahoo XML (plan 01 D3); pure JS. Entity expansion is **on** by default (`processEntities: true`, verified 2026-09-30 — plan 02 §5); `xml.ts` disables it explicitly. **Pin-time rule: prefer the smaller tree.** 4.x carries one runtime dependency (`strnum`); 5.11.2 carries six (`strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`, `@nodable/entities`, `path-expression-matcher`) [V-npm 2026-09-30, log §1.0]. Pin 4.x unless 5.x has a feature this code needs — decided when `package.json` is written, with the reason recorded in this row | `@rgrove/parse-xml` (no object mapping); `sax` (unmaintained) |
| `hyparquet` | 1.31.x exact [V-npm: pure JS, MIT, zero deps, no install scripts] | nflverse/ffopportunity parquet (plan 01 D7); reads snappy natively, which is what nflverse writes (plan 01 D7, round 1 OBJ-20) — no `hyparquet-compressors` | `parquetjs` (native/thrift deps); DuckDB (native) |

That is it: **four direct runtime packages** — and the **allow-list is the full transitive tree with its count** *(round 1, OBJ-14)*: `@modelcontextprotocol/server` → `@modelcontextprotocol/core` → `zod` (3) + `fast-xml-parser` and its dependencies (2 at 4.x, 7 at 5.x) + `hyparquet` (1) = **5 packages at the 4.x pin, 11 at the 5.x pin**. The count and the names are what `npm ls --omit=dev --all` must print, and what the CI diff (§4.1) compares against. Everything else is Node built-ins: `node:sqlite`, `fetch`, `node:crypto`, `node:zlib`, `node:util.parseArgs`, `node:fs/promises`, `node:child_process` (for `osascript`, `openssl`, `lsof`, `launchctl` — all invoked with argument arrays, never a shell string).

**Dev dependencies:** `typescript`, `vitest` + `@vitest/coverage-v8`, `fast-check`, `eslint` + `typescript-eslint` + `eslint-plugin-import-x` (boundaries), `prettier`, `tsx`, `@types/node`, and **`@modelcontextprotocol/client` 2.2.0 exact** *(added round 1, OBJ-23 c)* — test-only, for `InMemoryTransport.createLinkedPair()` in the in-process client↔server tests (plan 05 §4.3) and the Skills Lane 1 dry run (plan 09 §5.1 items 3 and 7); it brings `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, `eventsource-parser` and `core` [V-npm 2026-09-30, log §1.0] into the **dev** tree only — never in `files`, never in the runtime allow-list, and `npm audit --omit=dev` does not see it (the full `npm audit` reports it). Run via `npx` with pinned versions in CI only: `@modelcontextprotocol/inspector`, `@mermaid-js/mermaid-cli` (+ its `puppeteer` peer, §4.2).

`package.json` essentials: `"type": "module"`, `"bin": { "ff": "dist/cli.js" }`, `"engines": { "node": ">=24.15" }` (round 1, OBJ-09), `"files": ["dist", "skills", "README.md", "LICENSE", "CHANGELOG.md"]` (fixtures and tests never ship), scripts: `build`, `typecheck`, `lint`, `format:check`, `test`, `test:coverage`, `test:process`, `smoke` (Inspector CLI), `eval` (manual, tokens), `check:commits`, `check:licenses`, `check:no-scripts`, `check:mermaid`, `check:skills`, `check:docs` (generated README table current), `pack:scan`.

---

## 3. TypeScript, lint, format, commits

**`tsconfig.json`** (differences from the house reference are deliberate: it shows `Node16` + `ES2022`; we are on Node 24+ and SDK v2):

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

All workflows: `permissions: contents: read` by default; actions pinned by **commit SHA** (not tag); `concurrency` cancels superseded runs (PRs only — a cancelled run on `main` is a commit without a verdict, as `docs.yml` already does); `npm ci` with the committed lockfile; Node from `.nvmrc` (`24`, matching `engines`).

### 4.1 `ci.yml` — every push to any branch, every PR

| Job | Steps | Fails when |
|---|---|---|
| `lint` | `npm ci` → `npm run lint` → `npm run format:check` → `npm run check:commits` (PRs) | any lint/format/commit-format error |
| `typecheck` | `npm run typecheck` (`tsc --noEmit -p tsconfig.json`, includes tests) | any type error |
| `test` (node 24 — R5) | `npm run test:coverage` → upload `coverage/` artifact → `scripts/check-coverage.ts` reads `coverage-summary.json` against the gate (plan 05 §7) | any test fails; coverage below gate; a per-file 100 % module below 100 % |
| `process` | `npm run build` → `npm run test:process` (spawns the built binary: startup < 1 s, stdin-EOF exit 0, SIGTERM exit 0, orphan exit, two-process lock race, listener closes) | any process test fails |
| `smoke` | `npm run build` → `npx -y @modelcontextprotocol/inspector@<pin> --cli node dist/cli.js serve --method tools/list` in **fixture mode** (`FF_FIXTURE_DIR=fixtures/yahoo`, no credentials) → assert the expected tool names and that no write tool is listed | list differs from `tests/smoke/expected-tools.json` |
| `supply-chain` | `npm audit --omit=dev --audit-level=high` (gate) · `npm audit` (report only) · `npm run check:no-scripts` (no `install`/`postinstall`/`preinstall` and no `binding.gyp`/`prebuild-install` in `npm ls --omit=dev`) · `npm run check:licenses` (allow-list: MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, CC0-1.0, Unlicense; anything else fails with the package name) · `npm ls --omit=dev --all --json` diff against the §2 **full-tree** allow-list (a `--depth=0` diff cannot see a transitive addition — round 1, OBJ-14) | any high/critical runtime advisory; any install script; any license outside the list; any runtime package, at any depth, not on the list |
| `secrets` | gitleaks (pinned) with `.gitleaks.toml`, full history on PRs from forks disabled (no untrusted PR gets secrets anyway — `permissions` are read-only) | any finding not on the allow-list |
| `pack` | `npm run build` → `npm pack --dry-run --json` → `scripts/scan-tarball.ts` asserts: only `files` globs; no `fixtures/`, `tests/`, `.env*`, `*.sqlite`; no string matching a Yahoo key outside the placeholder range | any violation |

### 4.2 `docs.yml` — on changes under `docs/**`, `skills/**`, `README.md`

| Job | Steps |
|---|---|
| `mermaid` | `scripts/check-mermaid.mjs` extracts every ```` ```mermaid ```` block → `npx --yes --ignore-scripts=false -p @mermaid-js/mermaid-cli@<pin> -p puppeteer@<pin> mmdc …` per block (a parse error fails with file + block index). **Interaction with `.npmrc` (round 1, OBJ-12):** `ignore-scripts=true` at the repo root (§1) is read by `npx` and would skip `puppeteer`'s `postinstall` (`node install.mjs` — the Chrome for Testing download) when mermaid-cli's **peer** dependency `puppeteer` (`^23 \|\| ^24 \|\| ^25`) is installed, turning this job red the day Phase 0 lands `.npmrc`. So `docs.yml` pins `puppeteer` exactly beside `mermaid-cli`, installs Chrome explicitly with `npx --yes puppeteer@<pin> browsers install chrome` (no postinstall involved), and passes `--ignore-scripts=false` on every `npx` invocation; its header comment names the interaction and plan 10 Z3 exercises the job with `.npmrc` present. Registry facts read 2026-09-30: mermaid-cli 11.17.0 `peerDependencies.puppeteer`, puppeteer 25.12.0 `scripts.postinstall` [V-npm] |
| `skills` | `scripts/check-skills.ts`: every `skills/*/SKILL.md` has YAML frontmatter with `name` (equal to the directory name, `[a-z0-9-]+`) and `description` (non-empty, ≤ 1024 chars) **[A-2: field rules from the Anthropic Skills format as commonly documented; `docs/research/06` will confirm or amend]**; referenced resource files exist; no file > 200 KB; no Yahoo key outside the placeholder range; the untrusted-text rule sentence (plan 02 §6.4) is present in each skill that reads news or notes |
| `docs-current` | `npm run check:docs` — regenerates the README config table from `src/config/schema.ts` and fails on diff |
| `links` | internal relative links resolve (a 40-line script; no external link checking — flaky) |

### 4.3 gitleaks rules (`.gitleaks.toml`, in addition to the defaults)

| Rule id | Pattern (sketch) | Why |
|---|---|---|
| `yahoo-client-id` | `dj0yJmk9[A-Za-z0-9=\-]{20,}` **[A-3: `dj0yJmk9` is the base64 of `v=2&i=` (corrected round 1, OBJ-23 d — the earlier text said `2&i=`, which encodes to `MiZpPQ==`); that Yahoo app ids start with it is still assumed — verify against a real id locally before relying on it]** | app registration id |
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

| Now (docs phase) *(revised round 1, OBJ-13)* | When product code lands |
|---|---|
| Block force-pushes and deletion of `main`; require linear history | same |
| **No required status checks.** GitHub rejects a direct push of a commit that has not passed the required checks somewhere (R9), which would break every agent's "commit and push before teardown" at the moment it exists for. The substitute is the **`ci-vigilance` obligation**: every agent that pushes verifies its push's `docs` and `secrets` runs (`gh run list --branch main`, `gh run watch <id> --exit-status`) and fixes or reverts a red `main` **before replying**; a red `main` is never left standing, and success reported with a red or unverified run is a failed report | Require a PR; required checks: all `ci.yml` jobs; linear history; conversation resolution; **no required reviewers** (solo maintainer); admins bypass allowed for Chad only |
| Secret-scanning push protection (already enabled — HANDOFF 2b) | same |
| Dependabot security updates only | same; version updates monthly, grouped |

Chad's exact `gh api` command for the ruleset is in `docs/scratch/ci-bootstrap.md` § "For Chad" (agents do not touch repo settings).

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
| ~~A-1~~ | ~~`fast-xml-parser` current major is 5.x and has the no-DTD default~~ — **resolved round 1**: 5.x is current (5.11.2 [V-npm 2026-09-30]) and its entity default is expansion **on**; the flags are set explicitly (plan 02 §5) and the §2 pin-time rule decides 4.x vs 5.x | closed |
| A-2 | Skills frontmatter rules (`name`, `description` ≤ 1024) | `docs/research/06` |
| A-3 | Yahoo app ids start with `dj0yJmk9` (= base64 of `v=2&i=`; derivation corrected round 1, OBJ-23 d) — stays [U] until checked | one real id, checked locally, never committed; the gitleaks rule is already live (`ci-bootstrap`), so a wrong prefix means a silent non-match, not a false positive |
| ~~A-4~~ | ~~GitHub rulesets can require passing checks on direct pushes to `main`~~ — **resolved round 1 (OBJ-13), and the answer is the problem**: they can, and an unchecked commit is then rejected on a direct push (docs.github.com, read 2026-09-30 — log §1.0); §5 therefore requires no checks in the docs phase | closed |
| A-5 | `import-x/no-restricted-paths` expresses the plan 01 §1.1 zones | write the config; a boundary test imports the wrong module and expects a lint error |
