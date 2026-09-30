# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: a breaking change to tool
names, tool schemas or the store format bumps the minor version — `docs/plan/04-repo-structure-and-ci.md` §4.4).

## [Unreleased]

### Added

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
