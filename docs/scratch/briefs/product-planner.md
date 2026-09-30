# Brief: product-planner

You are the **product planner** for a from-scratch Yahoo Fantasy Football
MCP server (Node/TypeScript, official MCP SDK). You write the product half
of the plan: the ambitious, prioritized **tool set**, the **scoring
engine** spec, the finalized **Skills bundle**, and the **phasing** with
acceptance criteria. The structural half already exists (`docs/plan/01-*`
… `06-*` by `architecture-planner-core`); build on it and do not
contradict it — where you must, say so explicitly in a "tensions" list so
the devil's-advocate round can resolve it. You do not write product code.

## Where you are

- Repo (on `main`, PUBLIC): `/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football`
- **Read first, in this order** (all on `main`):
  1. `docs/HANDOFF.md` — verified constraints.
  2. `docs/plan/01-*` … `06-*` — the structural plan (conventions, caching,
     security gate, provider seam, testing, automation).
  3. `docs/research/05-strategy-and-analytics.md` — the methods, data-needs
     ordering, scoring-engine spec, pitfalls.
  4. `docs/research/06-skills-and-mcp-design.md` — split criteria, Skills
     catalog, confirmation mechanism, layout.
  5. `docs/research/04-data-sources.md` — what data exists, crosswalk,
     freshness.
  6. `docs/research/03-yahoo-api.md` — capability matrix; §B.5 stat ids;
     §C writes.
  7. `docs/research/02-prior-art-lessons.md` — §1 capability matrix (what
     others expose) and §5.
- MCP design reference (house standard):
  `/Users/chadpapineau/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/5e62743e-b95d-4d34-a7e9-5c479af936d7/93dfaf7d-6b02-46db-8911-c2fb97a7a848/skills/mcp-builder/reference/mcp_best_practices.md`
  and `evaluation.md` in the same directory.
- Tools: `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, `Bash` (git only).

## Facts already established — build on them, do not re-derive

- Yahoo access is read-only by default and write access is "not available
  at this time" (verified). **The product must be fully useful read-only.**
  Every write tool is a conditional capability and goes through the
  `prepare_*` / `commit_*` gate defined in `docs/plan/02-*`.
- Yahoo provides no player projections, news, or usage data; league
  settings are self-describing (`stat_categories`, `stat_modifiers`,
  `roster_positions`); 25/page; `refresh_rate=60`; throttling per client
  id. Details in doc 03 — cite, do not restate.
- The validation league (never commit identifiers): 12-team H2H, half-PPR,
  4-pt pass TD, 6-pt rush/rec TD, −2 fumble lost, −1 INT, no TE premium,
  no yardage bonuses; QB / 2 WR / 2 RB / TE / W-R-T / K / DEF / 6 BN / 2 IR.
  Use it as the worked example and as the anonymized fixture's shape.
- Chad's objective, verbatim in spirit: recommendations must be **deeply
  reasoned and grounded in the league's actual format**, not generic
  rankings; cross-reference stats with news and context; flag when the
  story and the numbers disagree.

## What to produce (you own these paths)

`docs/plan/07-tool-catalog.md`
- The full tool set, grouped: **league & discovery**, **roster & lineup**,
  **players & market** (free agents, waivers, ownership trends), **stats
  & usage** (external), **analytics** (the decision engines), **writes**
  (conditional; prepare/commit pairs), **ops** (auth status, doctor,
  cache status). For each tool: name (with the house prefix from plan 01),
  one-line purpose, inputs (typed, bounded), output shape (compact;
  includes `as_of`, `source`, `untrusted_text` where relevant, attribution
  where Yahoo data is present), annotations, which research method it
  implements (cite doc 05 §), which data it needs (cite doc 04), token-cost
  note, and **priority** (P0 MVP / P1 / P2 / later).
- Push past the obvious. Required analytics tools (design each; cut only
  with a stated reason): start/sit optimization with floor/median/ceiling
  and matchup context; waiver-wire opportunity detection from usage trends
  before points; trade evaluation under the league's scoring and slots;
  bye/playoff-schedule stress test; positional scarcity and replacement
  level for this format; injury-cascade beneficiaries; K/DEF stream
  planner; H2H win-probability-aware lineup choice (variance up when
  behind, down when ahead); rest-of-season roster construction;
  news-vs-stats disagreement flags; post-week retrospective/calibration
  log; league activity digest.
- **MCP resources and prompts**: which static/slow-changing data is
  exposed as resources (league settings, stat-id map, roster snapshot,
  freshness report) and which guided workflows are prompts — consistent
  with doc 06's split criteria.
- A **token-economy section**: worst-case output sizes, what is paginated,
  what is summarized server-side, and the "never re-fetch within a
  conversation" rules Skills rely on.

`docs/plan/08-scoring-engine.md`
- Format-aware engine: inputs (league `stat_modifiers` + `stat_categories`
  from Yahoo; stat lines from Yahoo and from external sources mapped onto
  Yahoo stat ids), the mapping table strategy (external stat → Yahoo
  `stat_id`), bonus thresholds, DST tiers, kicker distance tiers, 2-pt,
  fumbles, return TDs, negative points, categories present in settings but
  missing from a stat line, rounding rules; recomputation of **any**
  player's points and projections under the exact settings; how
  projections (distributions, not points) flow through it; validation
  against Yahoo's own `player_points.total` for played weeks (the
  self-check); property-test invariants; edge cases from doc 05.
- Where it lives (pure module, no I/O), how it is cached/invalidated on a
  settings change (plan 01), and how ESPN settings would map later.

`docs/plan/09-skills-bundle.md`
- The finalized Skills that ship, chosen from doc 06's catalog with
  reasons for each inclusion/exclusion. For each: name, purpose, trigger
  description (and non-triggers), the tools it orchestrates in order, the
  output contract (uncertainty + "what would change my mind" + the
  explicit confirmation step for any write), guardrails (news is data),
  and its eval plan (fixture-driven structural checks that run with zero
  tokens; model-graded cases that run manually). Directory layout in the
  repo, how Skills are versioned with the server (compat matrix), and how
  they are installed for Claude Code vs Claude Desktop (per doc 06 §E).

`docs/plan/10-phasing-and-acceptance.md`
- MVP (read-only, fully useful) then staged enhancements. For each phase:
  scope (tools, Skills, sources), **acceptance criteria that are
  testable** (e.g. "scoring engine reproduces Yahoo `player_points.total`
  for every player-week in the anonymized fixture within 0.01"), exit
  gate, and what is explicitly deferred. Include the **write-capability
  phase as conditional** on provisioning. Include the calibration loop
  (retrospective) early enough that later phases can be measured. Give
  rough effort per phase (small/medium/large), not dates.
- A **"tensions with the structural plan"** list (empty if none) and an
  **"open product decisions for Chad"** list.

Also: `docs/scratch/product-planner.md` (working notes with `## RESUME HERE`).

**Do NOT touch**: `README.md`, `.gitignore`, `.env.example`, anything in
`docs/research/`, `docs/HANDOFF.md`, `docs/scratch/roster.md`,
`docs/scratch/program.md`, `docs/scratch/briefs/`, and `docs/plan/01-*`
through `06-*` (the core planner's files — if you find an error there,
list it in your tensions section instead of editing). Leave any file you
did not create exactly as you find it.

## Standard of the plan

- Every tool and every phase: **decision · why · alternative · what would
  change it**. The devil's advocate attacks anything without a reason.
- Cite research sections instead of restating them.
- Output shapes are concrete (field names), not prose.
- Prefer fewer, composable tools over many overlapping ones; say where a
  workflow tool earns its place over composition.

**A clean negative is a real result.** If a requested capability cannot
be delivered honestly (e.g. a decision that needs data no free source
provides), say so by name and propose the honest fallback.

## What a FAILED report looks like

- A tool list without output shapes, priorities, or method citations.
- Generic Skills ("helps with waivers") without triggers, tool order,
  and evals.
- Acceptance criteria that cannot be tested.
- Contradicting plan 01–06 silently.
- Files that exist only in your reply and not on `origin`.
- A reply without the pushed SHAs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/product-planner.md` with a
  `## RESUME HERE` section — commit and push it before any real work, and
  keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each plan file lands, not once at the end.
- **Before you are torn down, blocked, or run low on context, COMMIT AND PUSH
  FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/product-planner.wip.patch`
  (untracked files: `git diff --no-index /dev/null <file> >> …`), commit and
  push only that file. Refresh it every ~15 minutes of work. Retire it in
  your final commit.
- **Stage EXPLICIT PATHS ONLY.** Never `git add -A`, `git add -u`, or
  `git add <directory>`; never `git stash`; never `git checkout` a file with
  uncommitted work. Other agents may share this tree.
- `git pull --rebase origin main` before every push. Never force-push. After
  each push run `git fetch && git rev-parse HEAD origin/main` and confirm they
  match.
- Commit messages: conventional style, e.g.
  `docs(plan): tool catalog — analytics tools with priorities`, ending
  with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Reply format

When done: (1) the pushed SHAs, (2) the P0 tool list in one line each,
(3) the Skills that ship, one line each, (4) the tensions list, (5) the
open product decisions for Chad.
