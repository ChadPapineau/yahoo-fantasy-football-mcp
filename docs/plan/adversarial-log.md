# Adversarial log — devil's advocate vs the plan

**Author:** `devils-advocate` · **Brief:** `docs/scratch/briefs/devils-advocate.md` · **Plan state attacked:** `docs/plan/01-*` … `10-*` as on `main` at `7663b6a` (2026-09-30), plus `docs/HANDOFF.md`, `docs/research/02-*` … `06-*`, `01-*`'s verdict table, and the mcp-builder `mcp_best_practices.md` reference.

**How this log works.** Each round I attack; the orchestrator appends `## Round N — defence` under it (justify with evidence, or concede and edit the plan); my next round opens with a verdict table over every prior objection (withdrawn / conceded-by-defence / pressed) and then raises anything the revisions broke. Rounds end when I say the remainder is marginal. Severity vocabulary: **blocking** = the plan cannot be trusted or acted on until this is answered; **significant** = a decision or claim is wrong or unjustified and will cost real time, tokens or trust if built as written; **marginal** = worth a line in the plan, not a redesign.

**Facts I do not dispute** (verified by the orchestrator on primary sources): Yahoo access is application-gated, read-only by default, write "not available at this time"; Yahoo provides no projections/news/usage; league settings are self-describing; no PKCE; refresh tokens rotate; Chad's rules (public repo, no identifiers, no secrets, third-party code untrusted, human confirmation on every roster change, news is data). Everything the plan *does* with those facts is in scope.

---

## Round 1 — objections

### 1.0 What I verified this round on primary sources (2026-09-30), and what it did to the attack

| Checked | Result | Effect |
|---|---|---|
| `@modelcontextprotocol/server@2.2.0` and `@modelcontextprotocol/core@2.2.0` manifests (npm registry) | `server` → `zod ^4.2.0` + `core 2.2.0`; `core` → `zod ^4.2.0` only; no install scripts; `engines.node >=20` | The SDK half of plan 02 §7's runtime allow-list is **verified clean**. I withdraw the "SDK transitive deps" attack before making it. |
| `fast-xml-parser@5.11.2` manifest | six runtime dependencies: `strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`, `@nodable/entities`, `path-expression-matcher` | The "five packages" count is wrong at the transitive level → OBJ-14. |
| `node:sqlite` docs, v22.x vs v24.x lines | v22.x: "Stability: 1.1 – Active development … no longer behind `--experimental-sqlite` but still experimental"; v24.x: "Stability: 1.2 – Release candidate" (history: "v24.15.0: SQLite is now a release candidate"); `sqlite.backup()` documented on both lines (v22.16.0 / v23.8.0) | Plan 01 D4 conflates the two lines → OBJ-09; plan 03 §7's file-copy backup has a proper API available → OBJ-10. |
| TypeScript SDK v2 `docs/testing.md` | `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/client` — "returns two transports that are each other's wire"; example connects a client and server in-process | Plan 05 **A-1 resolves positive**. But `@modelcontextprotocol/client@2.2.0` (deps `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, `eventsource-parser`, `core`) is not in any dependency list in plan 04 → OBJ-23(c). |
| `@mermaid-js/mermaid-cli@11.17.0` (the pin in `.github/workflows/docs.yml`) and `puppeteer@25.12.0` manifests | mermaid-cli: `peerDependencies: { puppeteer: "^23 \|\| ^24 \|\| ^25" }`; puppeteer: `scripts.postinstall: "node install.mjs"` (the Chrome download) | Collides with `.npmrc` `ignore-scripts=true` → OBJ-12. |
| GitHub docs, "Require status checks before merging" | "After all required status checks pass, any commits must either be pushed to another branch and then merged or pushed directly to the protected branch." | Direct pushes of unchecked commits are rejected → OBJ-13 (plan 04 A-4 answered, in the bad direction). |
| Claude Code hooks reference | An `Elicitation` hook "fires when an MCP server requests user input during a tool call" and may return `{"action":"accept","content":{…}}`; configured in `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, plugin `hooks/hooks.json`, or Skill/subagent frontmatter | Channel 1 of the gate is auto-answerable in Claude Code → OBJ-01. |
| `hyparam/hyparquet` README | "By default, hyparquet supports uncompressed and snappy-compressed parquet files. To support the full range … (gzip, brotli, zstd, etc), use the hyparquet-compressors package." Zero dependencies confirmed. | Codec of nflverse parquet is the open question → OBJ-20 (marginal). |
| Claude Code MCP docs (`readOnlyHint` auto-approval, 06 U-1) | Page came back truncated; not resolved | OBJ-19 is phrased conditionally. |
| fast-xml-parser `processEntities` default | The docs paths I tried 404'd; **not re-verified** this session | OBJ-14's entity half is marked [knowledge, verify at pin time]. |
| nflverse parquet writer source (compression codec) | Repository path not found; **not verified** | OBJ-20 stays marginal and says so. |

### 1.1 Objection table

| id | target | severity | one-line claim |
|---|---|---|---|
| OBJ-01 | plan 02 §4.2, §8 #2, S6; plan 01 D11 | **blocking** | "The model cannot forge the human confirmation" is false for Claude Code, a named primary client: the model has shell as the same OS user — it can read the channel-2 pending file, drive `ff confirm` through a pipe, install an `Elicitation` hook that auto-accepts, or read `tokens.json` and skip the server entirely. |
| OBJ-02 | plan 10 §1, §3.1 (A1/A2/A16), §3.4; HANDOFF item 4 | **blocking** | The critical path runs through a Yahoo approval with no observed grant, no date and no fallback; with Phase 1 = L starting at NFL week 4, the plan's honest value for the 2026 season is near zero and it does not say so. |
| OBJ-03 | plan 07 E1 (`v1-trailing` from Yahoo stat lines); plan 10 §3.1 sources | significant | v1 projections are hostage to the Yahoo approval for no gain: nflverse `stats_player_week` has the same stat lines, keyless, and is already the first Phase-2 source. |
| OBJ-04 | plan 07 E1/E2 (`objective: pwin` default), plan 10 A7 | significant | In v1 the "distribution" is a position-level CV table around a trailing mean; p10/p90 and ΔP(win) are dressed-up point estimates, and A7 never tests `pwin` against `mean`. |
| OBJ-05 | plan 07 E12/E13 (P0), plan 09 `retro`, plan 10 Ph2/A9 | significant | The calibration loop is P0 but structurally near-empty for one league (~14 H2H outcomes/season; `n < 30` refusal); the honest weekly output is swap regret and `P(active)` Brier, not the metric suite as framed. |
| OBJ-06 | plan 01 §4.2; plan 07 C1, §5.1 | significant | Every result is serialised twice; whether the clients feed both copies to the model is unverified (06 U-2) and the entire token-economy table assumes one copy. |
| OBJ-07 | plan 01 §4.2 `untrusted_text`; plan 02 §6.2; plan 07 `UT` on `name` | significant | Wrapping every player name (Yahoo-authored) costs ~40 % of list payloads, duplicates `meta.untrusted_fields[]` which already exists in the envelope, and its behavioural benefit is unmeasured. |
| OBJ-08 | plan 07 C3 (34 tools), §4.2 prompts, G2; plan 09 (13 Skills); §5 | significant | The per-turn fixed cost (34 tool definitions with `outputSchema` in Desktop, 13 Skill listings, 13 prompts, a playbook tool) is unbudgeted; C3's defence covers Claude Code only. |
| OBJ-09 | plan 01 D2/D4 "1.2 – Release candidate, unflagged since 22.13"; plan 03 §5 #1; plan 04 R2/R5 | significant | Conflation: the v22 line is "1.1 – Active development" and warns on every launch; only v24.15+ is the RC the plan describes. The floor admits the unstable line and CI tests it. |
| OBJ-10 | plan 03 §7 (pre-migration backup = file copy) | significant | A file copy of a WAL database with another process live is not a backup; `sqlite.backup()` / `VACUUM INTO` (which plan 06 already uses) is. |
| OBJ-11 | plan 01 D8 "server only reads datasets"; §5.3; plan 03 §1.1 `busy_timeout=5000` | significant | The server writes six tables through a synchronous API; a refresh's swap transaction blocks the stdio loop for up to 5 s on the game days the refresh runs most. |
| OBJ-12 | plan 02 S10/§7 + plan 04 §1 (`.npmrc ignore-scripts=true`) vs plan 04 R7/§4.2 (`npx mermaid-cli`) | significant | Two decisions that cannot both hold in one directory: `ignore-scripts=true` skips puppeteer's Chrome-downloading `postinstall`, so the Mermaid gate turns red the day Phase 0 lands `.npmrc`. |
| OBJ-13 | plan 04 R9/§5 "Now" column; plan 10 Z1; plan 06 §4 step 1 | significant | Required checks on `main` reject direct pushes of unchecked commits (GitHub docs) — this breaks the agent program's "push before teardown" rule at the moment it matters. |
| OBJ-14 | plan 02 §5 [A-9], §7 "five packages"; plan 04 §2, §4.1 | significant | The runtime tree is ≥ 11 packages, not 5 (fast-xml-parser 5.x alone adds six), the `--depth=0` check cannot see it, and the stated entity-expansion default is, to my knowledge, inverted. |
| OBJ-15 | plan 07 E12 → E13/E14/`ff://rec/*` | significant | The recommendation log is an unlabelled persistence channel for injected text across sessions: model-authored free text goes in under influence and comes back out as "our own record". |
| OBJ-16 | plan 07 D2; plan 06 `sleeper:players` 05:00; plan 09 `live`, `pre-kickoff check` | significant | On Sunday, game-day inactives exist in none of the non-Yahoo sources (nflverse has no inactives; Sleeper is loaded once at 05:00), so `sources_agree`/`p_active` are stale when they matter; only Yahoo `status` is live, and the plan does not say so. |
| OBJ-17 | plan 08 E6/§6.3; plan 09 `onboard` guardrail | significant | "A mismatch blocks downstream analytics" fails the whole product closed for one player-week's 0.5-point discrepancy or one newly enabled category. |
| OBJ-18 | plan 09 §1 `live` Skill; K1 fold rejection | significant | `live`'s trigger is temporal but the model has no clock; it will collide with `start-sit` on Sundays, and its "Tuesday timestamp" eval negatives assume information the model lacks. The discriminator is data (`lock_schedule`), not trigger. |
| OBJ-19 | plan 01 §4.1 `prepare_*` = `readOnlyHint:true`; plan 07 F7 | marginal | `prepare_*` writes the journal, mints the gate key and (channel 2) writes a file and fires a notification; labelling it read-only is the mislabel the spec warns clients about. |
| OBJ-20 | plan 01 D7 (`hyparquet`); research 04 §H.8 | marginal | hyparquet decodes only uncompressed/snappy natively; the codec nflverse writes was never checked; if zstd/gzip, D7 needs a sixth package. |
| OBJ-21 | plan 07 E15, E10 (P1), G2 | marginal | Scope a one-league manager never uses (cross-format what-if; a "Bayesian" merge over hand-set priors whose calibration table needs 200 claims; a third copy of every Skill body), each adding to OBJ-08. |
| OBJ-22 | plan 03 §5 doctor, §6; plan 01 §4.3 | marginal | Doctor misses the stale-`dist/` and last-exit-reason failure modes; a refresh that fails on *network* is not in the classifier (only `invalid_grant` is). |
| OBJ-23 | plan 01 §11; plan 02 S6 [V-web]; plan 04 dev-deps; plan 03 A-7; plan 04 A-3 | marginal | Unverified or stale items carried as fact — including a now-positive A-1 whose package is missing from the dependency list. |

Count: 2 blocking · 16 significant · 5 marginal.

### 1.2 Details

#### OBJ-01 — The gate's "unforgeable" claim is false for Claude Code — **blocking**

- **Target.** Plan 02 §4.2 (table column "Model can forge it? **No**" for all three channels), §8 #2 ("Residual risk: None from the model"), S6; plan 01 D11 ("it must be impossible to bypass by adding a tool"); the plan's own headline: "no roster change happens without an explicit human confirmation that the model cannot forge … mechanical rather than aspirational."
- **Claim.** The claim holds only when the model has no OS-level access as the user — i.e. Claude Desktop chat / claude.ai. Plan 01 D1 names **Claude Code** as one of the two clients, and in Claude Code the model has `Bash`, `Read`, `Edit`, `Write` as Chad's OS user. Then:
  1. **Channel 2 (OOB code)** — the plan writes "the full diff + code to `<config>/pending/<prepared_id>.txt` (0600)". Mode 0600 is same-user; `cat ~/.config/fantasy-football-mcp/pending/*.txt` returns the code. The sentence "the code never enters the model's context until the human types it" is false in this client.
  2. **Channel 3 (`ff confirm <id>`)** — "the model is not involved" is false when the model can run `printf 'y\n' | ff confirm <id>`; nothing in plan 03 requires a TTY.
  3. **Channel 1 (form elicitation)** — Claude Code's `Elicitation` hook (verified today in the hooks reference) can return `{"action":"accept","content":{"decision":"APPROVE"}}` and is configured in `.claude/settings.local.json`, plugin `hooks/hooks.json`, or **Skill frontmatter** — files the model can write (Edit/Write) and that a Skill edit or a plugin can carry. Research 06 §A.2 already noted "an 'accept' may come from a user-configured hook"; the plan did not carry it forward.
  4. **The gate is beside the point in that client** — `tokens.json` is 0600, same user; the model can `curl -H "Authorization: Bearer …" https://fantasysports.yahooapis.com/…` and PUT a roster without touching the server. Plan 02 §8 #5 admits "same-user malware reads it" but never names the model-with-shell as that malware.
- **Evidence.** Plan 02 §4.2 rows 2–3 (pending file, CLI); plan 02 §3.3 (0600 store); code.claude.com/docs/en/hooks (`Elicitation` hook, `action: accept`, config locations — fetched 2026-09-30); research 06 §A.2 ("hook can answer it"); plan 09 §6 install table (Claude Code is the *primary* client). Bounding fact: HANDOFF 2026-09-30 says read-only is the product and Phase W is conditional and low priority — so the blast radius is Phase W, but the *claim* will be copied into README/SECURITY.md by `docs-writer` as written.
- **Severity.** Blocking — the security architecture's one rule is stated as mechanical and is not, for a primary client, and Chad's non-negotiable ("every roster change needs human confirmation") is what it stands on. It is a cheap blocking: wording and conditions fix most of it.
- **What would satisfy me.** (a) Plan 02 §1/§4.2/§8 rewritten to state the trust boundary honestly: the gate is unforgeable **only** when the model has no OS access as the user; in Claude Code it is defence-in-depth and the real gate is the client's permission prompts on Bash/Edit/Write (and the user's own hooks) — say so in the threat model and in the README sentence. (b) `FF_WRITE_ENABLED` documented as **unsupported** for a Claude Code session with Bash enabled, or paired with a documented `permissions.deny` set (Bash writes to `~/.config/fantasy-football-mcp/**`, `ff confirm`, `.claude/settings*.json`) — pick one and write it down. (c) Remove the plaintext pending *file* (the notification carries the code; the row already holds `sha256(code)`); `ff confirm` and `ff auth` refuse when stdin is not a TTY. (d) Pull the Keychain `SecretSource` trigger forward for the **refresh token** when Claude Code is a target (the plan's own deferrable item, plan 01 §11) — or state plainly that in Claude Code the tokens are readable by the model and that is accepted.

#### OBJ-02 — No date, no gate, no fallback on the one external approval everything depends on; the phase sizing makes the 2026 season a write-off without saying so — **blocking**

- **Target.** Plan 10 §1 (effort column: Phase 1 **L**, Phase 2 **L**, Phase 3 **L**), §3.1 exit gate (A2 `ff smoke` "against the real league", A16 "Chad runs `/onboard` then `/weekly` on the live league"), A1 (golden fixtures, which plan 05 §3.1 says can only be **recorded with credentials**); HANDOFF item 4.
- **Claim.** Today is 2026-09-30, NFL week 4 of 18 (research 04 header). Phase 1 is L = "4–8 weeks of a single senior engineer with agents" → earliest usable read-only MVP around weeks 9–13 **if** Yahoo approval arrives at the start, and HANDOFF's own verified note says "no one in that thread reports having been approved through the new form yet … an open risk, not a formality", with approval latency unknown (03 §F.18). Phase 2 (usage-based waivers — the feature the entire external stack exists for) is another L → after the season. Phase 3 another L. Under denial, A1, A2, A16 and every Yahoo-touching acceptance are unmeetable and the product's value for Chad's league is **zero** — and the plan contains no sentence to that effect, no date by which the branch is decided, and no fallback. Plan 10 §5's ten open decisions do not include the one decision that matters most.
- **Evidence.** Plan 10 §1 table and §6 effort scale; HANDOFF "Things Chad needs to know" #4 (verified 2026-09-29) and the 2026-09-30 resolution ("no existing Yahoo developer app … the application is the only path"); research 03 §F.18; plan 05 §3.1 ("the only credentialed step"); plan 10 §3.1 A1/A2/A16.
- **Severity.** Blocking — not because the architecture is wrong, but because a plan that is silent on its expected value under its dominant risk cannot be approved honestly ("build ⛔ blocked on Chad's plan approval", HANDOFF).
- **What would satisfy me.** (a) A dated decision gate in plan 10 §0/§1: "application submitted <date>; if no read grant by <date>, do X". (b) X named. Two candidates the plan already contains the parts for: **X1** — ship the Yahoo-independent half first (see OBJ-03): store, `ff refresh` for schedules/injuries/`stats_player_week`, the engine over nflverse lines, projections v1, K/DEF streaming by implied totals, weather/lines — a public "NFL fantasy analytics MCP" that is useful to anyone and needs no approval; **X2** — a `SleeperProvider` as the *first* second platform behind `FantasyPlatform` (Sleeper's read API is public, keyless, non-commercial, already a source in plan 01) — the ESPN seam is the wrong first seam because ESPN is ToS-blocked (04 §B5) and Sleeper is not. (c) Phase 1 split into **1a (Yahoo-free)** and **1b (Yahoo)** with 1a's acceptance defined on fixtures and nflverse alone, so work proceeds and is testable while the application is pending. (d) One paragraph in plan 10 §0 stating the honest value of the product under {approved by week 6, approved by week 10, denied} for the 2026 season.

#### OBJ-03 — v1 projections are built from Yahoo stat lines when nflverse has the same lines keyless — significant

- **Target.** Plan 07 E1: "v1 implements steps 1, 8, 9 with trailing **Yahoo stat lines** as the opportunity/efficiency stand-in"; plan 10 §3.1 sources (schedules, injuries, roster_weekly only — `stats_player_week` deferred to Phase 2); 05 §16 ordering (#2 Yahoo stat lines "low complexity").
- **Claim.** nflverse `stats_player_week_2026` carries every stat the engine needs, keyed by `gsis_id`, CC-BY, keyless, 1.49 MB, weeks 1–3 live today (research 04 B1); plan 08 §3.2 already specifies `toStatLine(nflverse)` and `columns.ts`; the crosswalk is in Phase 1 regardless (A5). Choosing Yahoo lines makes projections, start/sit and K/DEF all depend on the approval in OBJ-02 for nothing in return, and forfeits backtests (Yahoo lines exist only for rostered players in *this* league; nflverse has everyone, every season).
- **Evidence.** Research 04 B1 (`stats_player_week` row), 05 §16 #2 vs #6; plan 08 §3.2; plan 10 §3.1 scope and A5.
- **Severity.** Significant.
- **What would satisfy me.** v1 trailing lines from nflverse `stats_player_week` scored by the engine; Yahoo `player_points`/stat lines used for the golden check and `match` only; `stats_player_week` moved into Phase 1 (it is one more `DataSource` of the same shape as `injuries`).

#### OBJ-04 — v1 "distributions by simulation" are a CV lookup around a mean; `pwin` is the default anyway — significant

- **Target.** Plan 07 E1 (`Dist` on every projection; "the position CVs of step 9 as the gamma fallback"), E2 (`objective: pwin` default; `mode: protect|chase`, `swaps[].delta_pwin`, `coin_flip`), plan 10 A7 (soft gate vs "last week's points" only), plan 09 `start-sit` output ("`P(win)` before/after with interval").
- **Claim.** With v1 inputs the p10/p90 are `gamma(mean, CV_position)` — the same relative width for every RB. Then σ_m, σ_o and every ΔP(win) are functions of roster composition and a five-row table, not of the players; protect/chase depends only on the sign of μ_m − μ_o (real) and swaps' variance effects are artefacts. 05 §1 pitfall 10 (goal-line back vs slot WR) is exactly what a position CV cannot see. The Skills will print these intervals as estimates ("A recommendation without an interval is a failed recommendation" — plan 09 §2) and the retrospective will grade them. A7 compares against "start by last week's points", never `pwin` vs `mean`, so the plan cannot learn that the `pwin` machinery adds nothing in v1.
- **Evidence.** Plan 07 E1 method line; 05 §1 step 9 ("a simpler parametric fallback … is acceptable for an MVP") and pitfall 10; plan 07 E2 outputs; plan 10 A7.
- **Severity.** Significant (methodology overclaim; the brief's dimension 5 asks exactly this).
- **What would satisfy me.** (a) `Dist.basis: "position_cv" | "player_sim"` on every distribution and the output template prints it; (b) A7 adds `objective: pwin` vs `objective: mean` regret on the fixture weeks and v1 ships with `mean` as default unless `pwin` wins; (c) in `basis: position_cv` mode, `delta_pwin` is reported as a sign and `coin_flip` widened, not a two-decimal number.

#### OBJ-05 — The P0 calibration loop cannot produce most of its metrics for a single league — significant

- **Target.** Plan 07 E13 (`metrics: { brier: { p_win, p_active, p_role_holds, p_win_given_bid }, crps, pinball, coverage_80, spearman, accuracy_gap }, parameter_changes_proposed[]`, `min_n = 30`), plan 09 `retro` (P0), plan 10 Ph2 and A9.
- **Claim.** One user, one 12-team H2H league: `p_win` has 14 outcomes per regular season; `p_win_given_bid` a handful; `p_role_holds` a few per week. With 05 §12.6's own rule ("refuse to draw conclusions from `n < ~30` calls of a type") the Brier suite is empty until mid-season or later, `parameter_changes_proposed` from such n is decorative, and C7's 200-claim source table is seasons away. What *does* accrue quickly is per-player projection error (dozens of player-weeks per week), swap regret, and `P(active)` Brier. The plan frames E13 as the full metric suite and A9 tests only that the mechanics run.
- **Evidence.** 05 §12.6; plan 07 E13; a 12-team league's schedule; plan 10 A9.
- **Severity.** Significant.
- **What would satisfy me.** E12 stays P0. E13/`retro` reframed around the metrics that reach n in weeks (per-player CRPS/pinball/coverage, swap regret, `P(active)` Brier), with a table in plan 10 saying which metric reaches n ≥ 30 by which week for one league; "parameter changes proposed" moves to Phase 3 where held-out seasons exist.

#### OBJ-06 — The token economy rests on an unmeasured assumption about double serialisation — significant

- **Target.** Plan 01 §4.2 ("returns **both** `structuredContent` … and one `text` block holding the same JSON"); plan 07 C1, §5.1 ("20 000 chars ≈ 5–7k tokens, so no result approaches either limit").
- **Claim.** Whether Claude Code or Desktop forwards `structuredContent` to the model *in addition to* `content` is research 06's **U-2**, explicitly unverified, and 06 §A.6 advised "keep `structuredContent` ≤ the text size" until measured; plan 01 doubled it instead. If both are forwarded, every row of §5.1 is 2×, and key-heavy JSON tokenises nearer 3–3.5 chars/token than 4, so a 20 000-char list is ~6k tokens once and ~12k twice — over Claude Code's 10k warning. The plan's own escape hatch (C1: "Markdown as a second text block") would make it three copies.
- **Evidence.** Plan 01 §4.2; plan 07 §5.1 last paragraph; research 06 §A.6 U-2.
- **Severity.** Significant.
- **What would satisfy me.** A first-week Phase-1 spike: a tool that returns a nonce only in `structuredContent`; ask the model in each client to repeat it; record in HANDOFF. If both are forwarded, list tools omit `structuredContent` (06 §A.6) and §5.1 is re-based on measured tokens per client, not chars.

#### OBJ-07 — Wrapping every player name is expensive, redundant with `meta.untrusted_fields[]`, and unmeasured — significant

- **Target.** Plan 01 §4.2 ("Player names are **also** wrapped"); plan 02 §6.2 ("no code path that returns a bare third-party string"); plan 07 (`name: UT` on every row of A1, A3, B1, C1, C2, D1–D6, E*).
- **Claim.** `{"untrusted_text":{"value":"…","source":"yahoo.player.name","chars":13,"truncated":false}}` is ~75 chars over a bare string; a 25-row `ff_list_players` wraps `name`, `status_full`, `injury_note`, `owner_name` ≈ 250–300 chars/row ≈ 6–7k of a ~15k payload. The envelope **already carries `meta.untrusted_fields: ["data.players[].injury_note", …]`** (plan 01 §4.2 sample) — a JSON-path list gives the model and the Skill the same labelling for a few dozen chars per result. Player names are Yahoo-authored, not manager-authored; the injection exposure is nil and "the matcher uses them" is a server-side reason, not a model-facing one. Finally, whether any wrapper changes model behaviour under injection is unmeasured — the plan spends ~40 % of its list budget on a control it has not tested (the brief's "theatre" question).
- **Evidence.** Plan 01 §4.2 envelope sample (both mechanisms present); plan 07 §5.1 budgets; plan 02 §6.2 caps.
- **Severity.** Significant.
- **What would satisfy me.** One mechanism: path list + bare strings, keeping caps/stripping/NFC; per-field wrappers only for the genuinely manager- or editor-authored classes (news title/blurb, `trade_note`, `injury_note`/`status_full`, manager nickname, team/league name); `tests/mcp/size.test.ts` records the before/after on the fixture league; one injection eval (plan 09 NC-1/AP-4) run with and without wrappers so the control's value is a number.

#### OBJ-08 — The per-turn fixed cost is not in the token economy at all — significant

- **Target.** Plan 07 C3 (34 read tools + 7 conditional), §4.2 (13 prompts), G2 (`ff_get_playbook`), §5 (counts *results* only); plan 01 §4.2 (`outputSchema` mandatory on every tool); plan 09 (13 Skills; descriptions 450–700 chars + `when_to_use`).
- **Claim.** In Claude Desktop — the second named client, with no Tool Search — `tools/list` is sent every turn: 34 tools × (rich zod-derived `inputSchema` + `outputSchema` + a ~400-char description carrying the verbatim §6.3 sentence) is tens of thousands of chars per turn before any result; 13 Skill listings add ~2k tokens per turn; prompts and the playbook tool are the same bodies a second and third time. Research 06 §A.6 said "keep the core catalog near 28 … Desktop/other clients do not [defer]"; the plan went to 34 and defended it with Claude Code's deferral (C3), which does not apply to Desktop. Plan 10 §2's measurement ledger has a row for result sizes and none for definitions.
- **Evidence.** Plan 07 C3, §5.1; research 06 §A.1 ("Thirty tools with rich schemas can eat 3–5k tokens"), §A.6; plan 01 §4.2.
- **Severity.** Significant.
- **What would satisfy me.** A ledger row "per-turn fixed cost: `tools/list` bytes + Skills listing chars" measured in fixture mode with a ceiling; `outputSchema` omitted on large list tools (06 §A.6); the `ff_analyze(kind, …)` dispatcher (C3's own escape hatch) shipped as the Desktop default, or the P1 analytics tools gated behind `FF_TOOLSET=full`; G2 dropped unless a non-Claude client is in use.

#### OBJ-09 — `node:sqlite` on the v22 line is not the release candidate the plan describes — significant

- **Target.** Plan 01 D2 ("Node ≥ 22.13 … `node:sqlite` (unflagged in 22.13.0)"), D4 ("Stability: 1.2 – Release candidate, unflagged since 22.13.0 [V-node]"); plan 03 §5 doctor #1 ("≥ 22.13.0 (`node:sqlite` unflagged)"); plan 04 R2/R5 (CI matrix 22 and 24).
- **Claim.** Verified today: the **v22.x** docs say "Stability: 1.1 – Active development" and "no longer behind `--experimental-sqlite` but still experimental" — and the orchestrator observed the `ExperimentalWarning` on 22.23.2; the **v24.x** docs say "Stability: 1.2 – Release candidate" with history "v24.15.0: SQLite is now a release candidate". The plan cites one line's stability with the other line's version. Consequences: on the admitted floor the module is declared unstable and writes a warning into the client's MCP log on every start; the CI matrix on 22 tests an API the maintainers may still change; even the documented `backup()` signatures differ between lines (v22: `backup(sourceDb, destination[, options])`; v24: `backup(sourceDb, path[, options])` returning a Promise).
- **Evidence.** nodejs.org/docs/latest-v22.x/api/sqlite.html and latest-v24.x (fetched 2026-09-30); HANDOFF "Stack facts".
- **Severity.** Significant.
- **What would satisfy me.** `engines.node >= 24.15` and doctor #1 says so — or, if 22 must stay, the plan states the warning, pins the exact `DatabaseSync`/`StatementSync` surface used, and a process test on 22 asserts the warning is the only stderr line at startup.

#### OBJ-10 — The pre-migration backup is a file copy of a WAL database — significant

- **Target.** Plan 03 §7 ("before the first pending migration, copy `store.sqlite` → `store.sqlite.bak-v<old>`"), L7's rationale ("journal and recommendation log are not rebuildable").
- **Claim.** Under WAL, committed pages live in `store.sqlite-wal` until a checkpoint; a copy of the main file alone is a torn snapshot, and plan 01 §2 allows a second server process to be writing during the copy. The one backup meant to protect the two unrebuildable tables is the one that can be inconsistent. `node:sqlite` has `sqlite.backup()` (v22.16.0 / v23.8.0) and plan 06 §1.2's `store backup` already uses `VACUUM INTO` — plan 03 just did not.
- **Evidence.** Plan 03 §7; plan 06 §1.2; Node docs `backup()` (fetched today).
- **Severity.** Significant.
- **What would satisfy me.** `sqlite.backup()` or `VACUUM INTO` in §7, taken while holding a process-wide lock (the token-lock pattern) so the other process cannot write mid-backup; a test corrupts nothing and restores from the backup.

#### OBJ-11 — "The server only reads" is false, and the synchronous API plus `busy_timeout=5000` blocks the stdio loop — significant

- **Target.** Plan 01 D8 ("the MCP server only reads datasets"), §5.3 (cache writes on every miss), §8.2 (journal, log), §6 (`limiter_state`), plan 08 §9 (`league_settings`, `points_cache`); plan 03 §1.1 step 3 (`busy_timeout=5000`), §1.2 ("never blocked for more than a SQLite statement").
- **Claim.** The server writes `yahoo_cache` on every Yahoo miss, `write_journal` on every prepare, `recommendation_log` on every recommendation, plus `crosswalk`, `limiter_state`, `league_settings`, `points_cache`. WAL allows one writer; `ff refresh` "loads into a staging table; swaps in one transaction" (a 10 MB pbp load can hold the write lock for seconds) and runs **4×/day on game days**; a second client process is a third writer. With a synchronous API, a cache write that meets the lock blocks the event loop for up to 5 s and then throws — inside a tool call, on a Sunday.
- **Evidence.** Plan 01 §5.2 storage column, §5.5; plan 03 §1.1; plan 06 §1.2 triggers.
- **Severity.** Significant.
- **What would satisfy me.** Cache writes are best-effort with `busy_timeout ≤ 100 ms` and failure = a miss, never an error; the refresh loads into an attached staging database and swaps with a millisecond transaction; a test holds a 3-s writer lock and asserts p95 tool latency < 300 ms and zero errors.

#### OBJ-12 — `ignore-scripts=true` will break the Mermaid gate the day `.npmrc` lands — significant

- **Target.** Plan 02 S10/§7 and plan 04 §1 (`.npmrc`: `ignore-scripts=true` at the repo root, Phase 0 per plan 10 Z3) vs plan 04 R7/§4.2 (`npx -y @mermaid-js/mermaid-cli@<pin>`), and `.github/workflows/docs.yml` as `ci-bootstrap` has written it (`npx --yes -p @mermaid-js/mermaid-cli@11.17.0 mmdc …` from the repo root; header: "mermaid-cli's puppeteer downloads its own Chrome for Testing at install").
- **Claim.** Verified today: `@mermaid-js/mermaid-cli@11.17.0` has `peerDependencies: { puppeteer: "^23 || ^24 || ^25" }` (npm ≥ 7 installs peers), and `puppeteer@25.12.0` has `scripts.postinstall: "node install.mjs"` — the Chrome download. `npx` run from the repo root reads the project `.npmrc`; `ignore-scripts=true` skips that postinstall; `mmdc` then fails with no browser. Today there is no `.npmrc`, so `docs.yml` is green; Phase 0's Z3 adds the file and Z1/Z2 turn red.
- **Evidence.** npm registry manifests (fetched 2026-09-30); `.github/workflows/docs.yml` in the tree; plan 04 §1, §4.2; plan 10 Z1–Z3.
- **Severity.** Significant (predictable red at the Phase 0 exit gate; trivial fix).
- **What would satisfy me.** `npx --ignore-scripts=false …` or an explicit `npx puppeteer browsers install chrome` step in `docs.yml`, a sentence in plan 04 §4.2 naming the interaction, and Z3 exercising `docs.yml` with `.npmrc` present. (I am not touching `docs.yml`; it is `ci-bootstrap`'s.)

#### OBJ-13 — Required checks on `main` reject the agent program's direct pushes — significant

- **Target.** Plan 04 R9 / §5 "Now" column ("Require status checks … **without** requiring a PR … a red check blocks the push, which is the protection that matters" [A-4]); plan 10 Z1 ("ruleset on"); plan 06 §4 step 1.
- **Claim.** GitHub's rule, verified today: "After all required status checks pass, any commits must either be pushed to another branch and then merged or pushed directly to the protected branch." A commit that has not yet run the checks anywhere is rejected on a direct push — so with required checks on `main`, every agent's "commit and push to `origin/main` before teardown" fails unless the work first went to a branch and turned green. That is a PR workflow in all but name, and it collides with Chad's "no work lost" rule at the exact moment (usage cutoff) it exists for. `docs.yml`'s own header adds the second trap: it is path-filtered, and "a required check that does not run blocks the push".
- **Evidence.** docs.github.com about-protected-branches (fetched 2026-09-30); plan 04 A-4; `.github/workflows/docs.yml` header.
- **Severity.** Significant.
- **What would satisfy me.** Plan 04 §5 "Now" = block force-push and deletion + secret-scanning push protection, **no required checks** until PRs are required when product code lands; plan 10 Z1 reworded to "ruleset on (no required checks)"; the `ci-vigilance` obligation stated as the docs-phase substitute.

#### OBJ-14 — The runtime allow-list undercounts the tree by more than half, and the XML safety default is stated backwards — significant

- **Target.** Plan 02 §7 ("Runtime allow-list … `fast-xml-parser`, `hyparquet` — **five packages**"), §5 ("`fast-xml-parser` has no DTD/entity expansion by default **[A-9]**"); plan 04 §2 ("That is it: four direct runtime packages (five with `core`)"), §4.1 (`npm ls --omit=dev --depth=0` diff).
- **Claim.** Verified today: `@modelcontextprotocol/server@2.2.0` → `core@2.2.0` → `zod` only (this half is clean). But `fast-xml-parser@5.11.2` has **six** runtime dependencies (`strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`, `@nodable/entities`, `path-expression-matcher`) — so the tree is ≥ 11 packages, the "five" figure is wrong, and a `--depth=0` diff can never see the difference. On entities: to my knowledge fast-xml-parser v4/v5 defaults `processEntities` to **true** and expands entities declared in an internal `<!DOCTYPE>` — the billion-laughs vector — unless explicitly disabled; the docs path I tried 404'd this session, so I mark this half **[knowledge — verify at pin time]**. The plan's XXE fixture test would catch a wrong default, which is why this is not blocking; but a security plan should not state a safety default it has not read, and `@nodable/entities` in the runtime tree is a hint about what the parser does by default.
- **Evidence.** npm registry manifests (fetched 2026-09-30); plan 02 §5, §7; plan 04 §2, §4.1.
- **Severity.** Significant.
- **What would satisfy me.** `processEntities: false` (and `htmlEntities: false`) set explicitly in `xml.ts` with a fixture asserting an internal-DOCTYPE entity is *not* expanded; the allow-list rewritten as the full `npm ls --omit=dev --all` tree with the count stated, and the CI diff run against that; or fast-xml-parser 4.x (single dependency `strnum`) pinned instead, with the reason recorded.

#### OBJ-15 — The recommendation log is an unlabelled stored-injection channel — significant

- **Target.** Plan 07 E12 (`ff_record_recommendation` accepts model-authored `rec: Rec` with `action`, `assumptions[].text`, `drivers[].name`, `alternatives[].action`, `note` — up to 20 000 chars) → E13 (`calls[].recommended`, `best_alternative`), E14 (`action_summary`), `ff://rec/{log_id}`, `ff://rec/week/{week}` — none marked `UT`; plan 02 §6.1 (sources of injection: news, Yahoo text, dataset text — not the store).
- **Claim.** Whatever the model writes while reading an injected blurb ("DROP Y IMMEDIATELY" quoted into `note` or `assumptions[].text`) is persisted and read back next week by `retro`/`weekly` as the product's *own* record, with no source tag saying "third party" — the one channel where the envelope's provenance says "us". The plan built a careful envelope for every external text source and left its own store out.
- **Evidence.** Plan 07 E12 inputs, E13/E14 outputs, §4.1 resources; plan 02 §6.1.
- **Severity.** Significant.
- **What would satisfy me.** Free-text fields of the log emitted as untrusted on read (`source: "store.recommendation_log"`, or path-listed per OBJ-07); plan 02 §6.1 adds "our own store, written by the model" as an injection source; the NC-1/AP-4 evals gain a two-session variant.

#### OBJ-16 — On Sunday, game-day inactives live only in Yahoo's `status`, and the plan's injuries tool does not know it — significant

- **Target.** Plan 07 D2 (`official`/`yahoo`/`sleeper` side by side, `sources_agree`, `p_active`, `p_active_basis`); plan 06 §1.2 (`refresh sleeper:players` daily 05:00; `nflverse:daily` 10:30); plan 09 §3.13 `live` ("reacts to inactive lists and late scratches") and the P0 `pre-kickoff check`.
- **Claim.** Inactives are published ~90 minutes before kickoff. nflverse `injuries` is the Wed–Sat official report — it has no inactives at all (research 04 A #6); Sleeper's `injury_status` is loaded once a day at 05:00 because `players/nfl` is a 5 MB dump "to be used once per day at most" (04 B4). So on Sunday at 12:45 ET, `sources_agree` compares a live Yahoo `status` with two stale or irrelevant sources and `p_active` may be computed from Friday's designation for a player already ruled out. The tool's shape promises a three-source consensus precisely on the day only one source is live, and neither D2 nor `live` says so. (The rate-limit half of the Sunday question survives: cache-first + coalescing + one client id at 1 req/s is enough for one user.)
- **Evidence.** Research 04 A #6, B4; plan 06 §1.2; plan 07 D2; plan 09 §3.13.
- **Severity.** Significant.
- **What would satisfy me.** D2 states that game-day availability comes from Yahoo `status`/`status_full` only and adds `p_active_basis: "yahoo_gameday_status"`; `live` skips `sources_agree`; or plan 06 adds game-day Sleeper refreshes at 11:00/14:30/18:30 ET with the "once per day" etiquette explicitly overridden and justified (3 × 2.6 MB on 17 Sundays).

#### OBJ-17 — A scoring mismatch fails the whole product closed — significant

- **Target.** Plan 08 E6 ("a live mismatch marks the league's settings dirty and **blocks downstream analytics until explained**"), §6.3(c) ("every analytics tool adds a `warnings[]` line until the row clears"); plan 09 §3.1 guardrail ("a mismatch **stops every downstream number** until explained").
- **Claim.** One commissioner enabling `rush_1d` mid-season, one late Yahoo stat correction, or one unresolved [U-1]/[U-6] semantic on one player-week stops lineup advice for the fifteen other players until Chad edits a pattern table. For a single-user tool the right failure is local: degrade the affected number, keep the rest.
- **Evidence.** Plan 08 E6, §6.3; plan 09 §3.1; 03 §D.2 (corrections "can be applied up until the first real life game in the next matchup week").
- **Severity.** Significant.
- **What would satisfy me.** Mismatch → `engine_complete:false` and a `warnings[]` line on the affected players only; analytics fall back to Yahoo's `player_points` for those players where a final week exists; a league-wide block only above a threshold (e.g. > 10 % of rostered player-weeks mismatching).

#### OBJ-18 — `live`'s trigger is a clock the model does not have — significant

- **Target.** Plan 09 §1 (K1: `live` kept separate; fold into `start-sit` rejected for "trigger collision, listing cap"), §3.13 (non-triggers "Tuesday–Friday planning"; trigger negatives "who should I start Thursday (Tuesday timestamp)"), §5.1 item 5 (pairwise *phrase* collision check).
- **Claim.** "Once games have started" is a temporal condition; in Claude Desktop/claude.ai the model is not told the day or time. "Who should I start?" at 12:45 ET on Sunday matches `start-sit` and `live` equally on phrases, and the eval negative that relies on a "Tuesday timestamp" tests information the model will not have in production. The discriminating fact is data the server already returns: `ff_get_roster.lock_schedule` / `is_editable`.
- **Evidence.** Plan 09 §3.13, §3.3, §5.1.
- **Severity.** Significant.
- **What would satisfy me.** `live` folded into `start-sit` as a branch chosen by `lock_schedule` (set `only_unlocked` automatically when any slot is locked), or `live`'s Step 0 reads the server clock via `ff_get_status` and defers to `start-sit` when nothing has kicked off; the trigger-collision eval gains time-blind Sunday prompts.

#### OBJ-19 — `prepare_*` is not read-only — marginal

- **Target.** Plan 01 §4.1 ("Write — prepare … `readOnlyHint: true` (it writes only our journal)"); plan 07 F7 (`ff_cancel_prepared` `readOnlyHint: true`).
- **Claim.** The spec's definition is "the tool does not modify its environment". `prepare_*` inserts a journal row, creates `gate_key` on first use (plan 02 §3.3), and under channel 2 writes a pending file and fires `osascript`. If any client auto-approves read-only tools (06 U-1 — still unresolved; the Claude Code MCP page came back truncated today), `prepare` runs without the user seeing it. Plan 10 T8 already proposes a "local write" family for `ff_record_recommendation`; it stops one tool short.
- **Evidence.** Plan 01 §4.1; plan 02 §3.3, §4.2; research 06 §A.1 (spec definition, U-1).
- **Severity.** Marginal.
- **What would satisfy me.** `prepare_*`/`cancel_*` in the T8 "local write" family: `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:false`.

#### OBJ-20 — hyparquet reads snappy; nobody has checked what nflverse writes — marginal

- **Target.** Plan 01 D7 ("download parquet (`hyparquet`, pure JS)"); research 04 §H.8 ("Parquet files were **not** opened").
- **Claim.** Verified today: hyparquet natively supports "uncompressed and snappy-compressed parquet files"; gzip/brotli/zstd need `hyparquet-compressors`. The codec nflverse writes is unverified (I could not reach the writer's source this session). If it is not snappy, D7 needs a sixth runtime package and the allow-list row changes.
- **Evidence.** hyparam/hyparquet README (fetched 2026-09-30); research 04 §H.8.
- **Severity.** Marginal.
- **What would satisfy me.** Read one 2026 release file's footer on Phase-1 day one and record the codec in plan 01 D7; if not snappy, add `hyparquet-compressors` to plan 04 §2 now.

#### OBJ-21 — Tools a one-league manager never uses — marginal

- **Target.** Plan 07 E15 `ff_analyze_scoring` (P1; "the ESPN-seam demonstration"; answers a plan 05 §6 eval question), E10 `ff_analyze_evidence` at P1 with `rules_v1` priors, G2 `ff_get_playbook`.
- **Claim.** E15's cross-format what-if is a demo of a seam that has no second platform and an eval prop ("how many points is a 45-yard FG here?" is `A2.scoring.rules`). E10 at P1 presents hand-set reliability constants as a prior/evidence/posterior merge whose calibration table (C7: 200 claims) one user will not reach for seasons — the honest P1 is `news-check` reading D6 + D2 + D1 and saying so. G2 is a third delivery of every Skill body alongside Skills and prompts. Each adds to OBJ-08's fixed cost.
- **Evidence.** Plan 07 E15, E10, G2; plan 10 C7.
- **Severity.** Marginal, individually.
- **What would satisfy me.** E15 → `later`; E10 → P2 (or P1 with `calibration_state.note: "priors are hand-set"` on every result and no "posterior" wording in the Skill until n exists); G2 kept only if a non-Claude client is actually configured.

#### OBJ-22 — Doctor and the classifier miss three likely failures — marginal

- **Target.** Plan 03 §5 (18 checks), §6 (recovery table); plan 01 §4.3 (`TOKEN_REFRESH_FAILED` = `invalid_grant`).
- **Claim.** (a) After `git pull` without `npm run build`, the client runs an old `dist/cli.js` — no doctor row compares `dist/` mtime to `src/`/`package.json`. (b) The stderr of a server that died lands in the client's MCP log (Claude Desktop: `~/Library/Logs/Claude/mcp-server-<name>.log`); doctor never reads it, so "what happened last time" stays unanswered — the brief's stdio-disconnect failure mode. (c) A refresh that fails on the network (cold start offline, DNS down) is not a classifier row; it will surface as `INTERNAL` instead of `UPSTREAM_UNAVAILABLE` + stale-served.
- **Evidence.** Plan 03 §5, §6; plan 01 §4.3.
- **Severity.** Marginal.
- **What would satisfy me.** Doctor rows for stale `dist/` and for the tail of the client's MCP log (path per client, `--client-log <path>` override); a classifier row "network error on refresh → `UPSTREAM_UNAVAILABLE`, serve stale within hard limit".

#### OBJ-23 — Unverified or stale items carried as fact — marginal (process)

- **Target and claim.**
  (a) Plan 01 §11: "Skills bundle validation beyond structure — build when `docs/research/06` lands" — it landed (119 KB) before the plan was written.
  (b) Plan 02 S6/§4.2 cites Claude Code form-mode elicitation "CLI 2.1.76+" from a search snippet **[V-web]**; HANDOFF says "relayed, not re-verified". It is load-bearing for channel 1.
  (c) Plan 05 **A-1** (in-memory transport) is now verified **positive** — `InMemoryTransport.createLinkedPair()` in `@modelcontextprotocol/client` per SDK `docs/testing.md` — but `@modelcontextprotocol/client` (and its `jose`, `cross-spawn`, `eventsource`, `pkce-challenge`, `eventsource-parser`) appears in no dependency list in plan 04, although plan 05 §4.3 and plan 09 §5.1 items 3 and 7 both depend on it.
  (d) Plan 04 A-3 (the assumed base64 `2&i=` prefix of Yahoo app ids) gates a gitleaks rule `ci-bootstrap` is writing now; plan 03 A-7 (Node 24 = current LTS) gates doctor #1's warning text.
- **Severity.** Marginal.
- **What would satisfy me.** Fix (a); add `@modelcontextprotocol/client` to devDependencies with a row (c); keep (b) and (d) as [U] with the verification step named in a Phase-1 acceptance line.

### 1.3 The 13 tensions in plan 10 §4

I endorse the proposed resolutions of T1–T7, T9–T13 as written. T5 (never prune `recommendation_log`, `league_settings` rows it references, `write_journal`) should be made explicit in plan 06 §1.2 *and* in the migration comments. T8 ("local write" annotation family) should also cover `ff_prepare_*` and `ff_cancel_prepared` (OBJ-19). T13's clarification (`evidence` optional, channel 2 only) is consistent with OBJ-01's requested rewording; it does not resolve OBJ-01.

### 1.4 What I did not attack, and why

- **Layering and the provider seam.** The domain/provider/source/store split is the right size for a tool whose data model has five sources with different cadences; the seam is an interface, and OBJ-02 argues it should be *used* (Sleeper) rather than removed. Not YAGNI.
- **SQLite over files.** One transactional file with WAL is the right call for datasets that must swap atomically; OBJ-09/10/11 attack how it is used, not the choice.
- **Yahoo XML over JSON, the path builder, the error classifier, the terminal `NOT_PROVISIONED` rule, `oob` as the default auth path, no raw-GET tool, the journal-then-send/never-retry rule.** Each is grounded in research 03/02 and I found no counter-example.
- **The scoring engine (plan 08).** The canonical-name hub, bracket derivation from names, and the property set are the strongest part of the plan; OBJ-17 attacks only the failure policy.
- **Refresh-in-a-separate-process (D8).** Correct given the synchronous API; OBJ-11 is about the server's own writes.

### 1.5 The single objection I would stake the project on

**OBJ-02.** Everything else in this log is fixable by editing a plan file. OBJ-02 is the one where the plan is silent about the thing that decides whether the product exists for Chad this season, and where the cheapest move — split Phase 1 into a Yahoo-free half that ships against nflverse and fixtures now, and name the fallback platform — is also the one that keeps the work valuable under every branch of the approval.

---

_Round 1 ends here. Orchestrator: append `## Round 1 — defence` below this line._
