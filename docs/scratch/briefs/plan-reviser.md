# Brief: plan-reviser

You apply the orchestrator's **round-1 defence rulings** to the plan.
The devil's advocate attacked (`docs/plan/adversarial-log.md` § "Round 1
— objections"); the orchestrator ruled on every objection (§ "Round 1 —
defence", §D.1) and accepted the 13 tensions in plan 10 §4. Your job is to
make the ten plan files and the docs workflow **say what the rulings say**
— precisely, consistently, and nowhere else — and to start the changelog.
You do not re-litigate rulings. If a ruling cannot be applied as written
(it contradicts a fact, or two rulings collide), you do not improvise: you
list it in your reply under "could not apply" and leave that spot
untouched. You do not write product code.

## Where you are

- Repo (on `main`, PUBLIC): `/Users/chadpapineau/Documents/Repos/Yahoo Fantasy Football`
- **Read first, in order:** `docs/plan/adversarial-log.md` (all of it —
  the objections give the target sections; the defence gives the change),
  `docs/plan/10-phasing-and-acceptance.md` §4 (tensions T1–T13 with their
  proposed resolutions), then every plan file `docs/plan/01-*` … `10-*`
  end to end, and `docs/HANDOFF.md` (verified facts and Chad's decisions —
  notably 2026-09-30: read-only is the product; Phase W is conditional and
  low priority; no legacy Yahoo app).
- Tools: `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Bash` (git, `gh`).
  Install nothing. No other agent is in the tree right now.

## What you own (exactly these paths)

- `docs/plan/01-system-architecture.md` … `docs/plan/10-phasing-and-acceptance.md`
- `.github/workflows/docs.yml` — **only** for OBJ-12 (the puppeteer /
  `ignore-scripts` fix). It is validated by CI on every push: after you
  push it, run `gh run list --branch main --limit 4` and then
  `gh run watch <id> --exit-status` for both the `docs` and `secrets`
  runs; if red, fix or revert **before you reply**. Quote the green run
  URLs.
- `docs/plan/changelog.md` — new file: "What the adversarial process
  changed", with a `## Round 1` section: one line per objection (id →
  ruling → where it landed, file §) and a "survived unchanged" list (from
  the advocate's §1.4 plus anything the rulings left alone). The
  orchestrator finalizes it after the last round.
- `docs/scratch/plan-reviser.md` — working notes with `## RESUME HERE`.

**Do NOT touch:** `docs/plan/adversarial-log.md` (the advocate's and the
orchestrator's), anything in `docs/research/`, `docs/HANDOFF.md`,
`docs/scratch/roster.md`, `docs/scratch/program.md`,
`docs/scratch/briefs/`, `README.md`, `.gitignore`, `.env.example`,
`.gitleaks.toml`, `scripts/**`, `.github/**` other than `docs.yml`.

## The work, ruling by ruling (D.1 is the spec; this is the checklist)

Apply every ruling in §D.1 to the sections the objection targeted, and
every T1–T13 resolution as proposed in plan 10 §4 (with the advocate's two
additions in log §1.3). The largest edits, so you plan them first:

1. **OBJ-02 / plan 10** — split Phase 1 into **1a (Yahoo-free)** and **1b
   (Yahoo)** with separate scope, acceptance lists and exit gates; add the
   dated decision gate (rule fixed, date placeholder "recorded in HANDOFF
   when Chad submits"); name fallbacks X1 (`ManualLeagueProvider`) and X2
   (`SleeperProvider` first, ESPN later with the reason); add the honest
   expected-value paragraph for {approved by wk 6, by wk 10,
   denied/unanswered}; add **D0 — the application** to §5; `stats_player_week`
   into 1a (OBJ-03). Update §1's overview table and §2's ledger to match.
   Plan 01 §3 gains the `ManualLeagueProvider` and `SleeperProvider` as
   named implementations of `FantasyPlatform` (seam only; sizes in plan 10).
2. **OBJ-01 / plan 02** — rewrite §1 (boundaries), §4.2 (channel table:
   the "Model can forge it?" column becomes per-client), §8 (#2, #5 rows),
   S6/S3 decision rows, per D.1 items 1–4: client-set-qualified claims,
   `FF_WRITE_ENABLED` unsupported under unrestricted Claude Code Bash +
   the offered `permissions.deny` set, no plaintext pending file, TTY
   requirement (hurdle, not proof), Keychain `SecretSource` as a Phase W
   prerequisite, tokens-readable-in-Claude-Code stated plainly. Add the
   §0 rule: **every "cannot" in a security claim names the client set
   for which it holds** — then audit plan 02 for every "cannot"/"never"
   and qualify each.
3. **OBJ-18 / plan 09** — fold `live` into `start-sit` as a
   `lock_schedule`-selected branch; Skills count → 12; update §1's table,
   K1's rationale, the eval lists (time-blind Sunday prompts), and every
   cross-reference to `live` in plans 07/09/10.
4. **OBJ-08 + OBJ-21 / plan 07, 10** — `FF_TOOLSET=core|full` (core =
   the 19 P0 tools, default); `outputSchema` omitted on large list tools;
   E15 → later, E10 → P2 with the "priors are hand-set" rule, G2 → later;
   ledger row for per-turn fixed cost; Skill descriptions ≤ ~350 chars
   noted in plan 09.
5. **OBJ-09 / plans 01, 03, 04** — Node floor `>= 24.15`; cite the v24
   line correctly (RC; `backup()` Promise); CI matrix Node 24 only;
   quickstart note `fnm install 24`.
6. **OBJ-14 / plans 02, 04** — `processEntities: false`, `htmlEntities:
   false` explicit + fixtures; allow-list = full `npm ls --omit=dev --all`
   tree with count; the pin-time rule (prefer the smaller tree).
7. **OBJ-06, OBJ-07, OBJ-15 / plans 01, 02, 07** — one labelling mechanism
   for Yahoo-authored player names (`meta.untrusted_fields[]` paths + bare
   strings); wrappers kept only for the manager/editor-authored classes
   listed in D.1 OBJ-07; list tools omit `structuredContent` until the
   nonce spike is measured; the "Markdown as a second text block" clause
   deleted; recommendation-log free text listed as untrusted on read with
   `source: "store.recommendation_log"`; plan 02 §6.1 adds the store as an
   injection source.
8. **OBJ-04, OBJ-05 / plans 07, 10** — `Dist.basis`; A7 pwin-vs-mean;
   v1 default `mean`; coarse `delta_pwin` in `position_cv` mode; E13/retro
   reframed; the "metric → week n ≥ 30" table; parameter proposals →
   Phase 3.
9. **OBJ-10, OBJ-11, OBJ-16, OBJ-17, OBJ-19, OBJ-22, OBJ-23 / plans 01, 02,
   03, 05, 07, 08** — as ruled (backup API + lock + test; best-effort
   cache writes, `STORE_BUSY`, attached staging DB, the latency test;
   Yahoo-only game-day status + `p_active_basis`; local degradation with
   the 10 % league-wide threshold; local-write annotation family incl.
   `prepare_*`/`cancel_*`; doctor rows + network classifier row; §11
   fix, `@modelcontextprotocol/client` devDependency row, A-3
   correction, hedged A-7).
10. **OBJ-12 / `docs.yml` + plan 04 §4.2** — explicit
    `npx --yes puppeteer@<exact pin> browsers install chrome` step and
    `--ignore-scripts=false` on the mermaid-cli invocation; header comment
    naming the interaction; plan 04 §4.2 sentence; Z3 in plan 10 exercises
    `docs.yml` with `.npmrc` present. **Prove green** (see ownership).
11. **OBJ-13 / plan 04 §5, plan 10 Z1** — no required checks now; the
    `ci-vigilance` substitute stated.
12. **OBJ-20 / plan 01 D7** — record: snappy by Arrow R default,
    `nflverse/nflverse-data R/upload.R:85`; loader asserts the codec.
13. **D.2 items** — a one-line **"Yahoo-dependency: none | read | write"**
    tag in every plan file's header (after the Inputs line); the plan 02
    "every cannot names its client set" rule; `FF_TOOLSET=core` as the
    default in plan 07/01; re-tag every claim you touch with the source
    you actually read (`[V-…]` only when you read it; otherwise `[A]`/`[U]`).
14. **T1–T13** exactly as plan 10 §4 proposes, plus log §1.3's additions.

Consistency pass at the end: every cross-reference between plan files
(tool names, Skill names, phase names, table names, annotation families,
env vars) agrees; each file's "Decisions at a glance" table reflects the
new decisions (add rows; never silently change a row's meaning — mark
changed rows "(revised round 1)"); each file's assumptions table drops
what is now verified and adds what is now assumed; Mermaid diagrams that
mention `live`, the pending file, or Phase 1 are updated and still
render (quote labels; the `docs` workflow will tell you).

## Standard

- **Fidelity to the rulings.** The defence is the spec; where it is
  silent on wording, write the minimum that makes the ruling true.
- **No new decisions.** If applying a ruling forces a choice the defence
  did not make, pick the most conservative option and list it in your
  reply under "choices I had to make".
- Nothing personal or secret; the repo is public.
- Commit per ruling group (the numbered items above), so the advocate can
  diff by topic.

## What a FAILED report looks like

- Rulings applied in one place and contradicted in another (e.g. `live`
  folded in plan 09 but still a Skill in plan 07's prompts list).
- The Phase 1a/1b split done in §1 but not in §3's acceptance lists.
- A "cannot" left unqualified in plan 02.
- `docs.yml` edited and not proven green.
- Changelog lines that do not name the file § where the change landed.
- Files that exist only in your reply and not on `origin`.
- A reply without the pushed SHAs and run URLs.

## COMMIT/PUSH DISCIPLINE — Chad's standing rule, non-negotiable

**No work you do may be lost.**
- **Your FIRST action is** `docs/scratch/plan-reviser.md` with a
  `## RESUME HERE` section (the numbered checklist above with a status per
  item) — commit and push it before any real work, and keep it current.
- **Commit and push to `origin/main` at every natural checkpoint** — after
  each numbered group, not once at the end. Commit subjects start with
  `docs(plan): round-1 revisions — <group>` so the advocate can find them.
- **Before you are torn down, blocked, or run low on context, COMMIT AND PUSH
  FIRST, then reply.**
- **Track your remaining budget.** At roughly **20% context remaining**, stop
  taking on new scope: commit, push, update `## RESUME HERE`, reply.
- **Preserve unfinished work on `origin` as a PATCH, never as broken files**:
  `git diff -- <your paths> > docs/scratch/plan-reviser.wip.patch`
  (untracked files: `git diff --no-index /dev/null <file> >> …`), commit and
  push only that file. Refresh it every ~15 minutes of work. Retire it in
  your final commit.
- **Stage EXPLICIT PATHS ONLY.** Never `git add -A`, `git add -u`, or
  `git add <directory>`; never `git stash`; never `git checkout` a file with
  uncommitted work.
- `git pull --rebase origin main` before every push. Never force-push.
  After each push run `git fetch && git rev-parse HEAD origin/main` and
  confirm they match.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Reply format

When done: (1) the pushed SHAs per group and the green `docs`/`secrets`
run URLs after the `docs.yml` change, (2) a table objection-id → file §
where it landed, (3) "could not apply" and "choices I had to make", by
name, (4) the cross-reference inconsistencies you found and fixed.
