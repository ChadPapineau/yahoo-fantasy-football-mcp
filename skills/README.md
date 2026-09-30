# Skills bundle

Agent Skills that teach Claude how to use the fantasy-football MCP server (plan 09). Each Skill is a self-contained folder — instructions and reference files only, no scripts — so it can be copied into Claude Code, zipped for claude.ai, or read by the server's prompts.

**Skills N.x need server N.x.** Every `SKILL.md` carries `metadata.version` (the package version) and `metadata.tool_contract`; at the start of a conversation the Skill compares its `tool_contract` with the server's (`ff_get_status`) and stops when they differ.

## Phase 1a Skills

| Skill | Use it for | Tools it calls, in order |
|---|---|---|
| [start-sit](start-sit/SKILL.md) | who to start, sit or flex; Questionable players; conditional lineups; the game-day branch once any slot has locked | status → league → roster → (scoreboard, opponent roster) → injuries → projections → lineup → record |
| [stream-kdef](stream-kdef/SKILL.md) | which kicker or defense to start or stream, two weeks ahead | status → league → roster → schedule → K/DEF pool → waivers (K/DEF) → record |
| [retro](retro/SKILL.md) | how last week's advice did; calibration; decision quality versus luck | status → league → scoreboard → retrospective → (transactions) → record |
| [onboard](onboard/SKILL.md) | writing and checking the private league file (manual-league mode) | status → leagues → interview, or league → roster → player stats → record |

Every Skill is **read-only**: it never changes the team and ends each recommendation with the exact manual steps for the fantasy app. `weekly`, `apply` and the Phase 2 Skills are not in this release.

## Install

- **Claude Code:** copy every folder except `_shared` into `~/.claude/skills/` (for example `cp -R skills/start-sit ~/.claude/skills/`), or start a session with `--add-dir <checkout>/skills`.
- **Claude Desktop / claude.ai chat:** zip one Skill folder and upload it under Settings → Capabilities → Skills. The server itself is configured separately (`ff print-config --client desktop`).
- The server must be registered under the name `fantasy-football-mcp-server`; the Skills name its tools as `fantasy-football-mcp-server:ff_<tool>`.

## Layout and generation

```text
skills/
├── _shared/                 source of the shared text (not a Skill)
│   ├── manifest.json        server name, tool_contract, the 1a tool list, write-tool names
│   └── references/          orient, guardrails, output-template, log, sources, tool-outputs
└── <skill>/
    ├── SKILL.md             frontmatter + body; generated blocks between BEGIN/END markers
    ├── references/          byte-identical copies of _shared/references + <skill>-*.md of its own
    └── evals/               tool_sequence.json, trigger_eval.json, cases.json
```

Shared text is written once, in `_shared/references/`. `node scripts/skills/build-skills.mjs` copies it into every Skill's `references/`, replaces every generated block in each `SKILL.md` (the guardrails and the output contract are stamped into every body) and stamps `metadata.version` and `metadata.tool_contract`. It is idempotent; `--check` writes nothing and fails when anything is stale. Edit the source, never a copy: a Skill's own reference files are named `<skill>-*.md`.

`node scripts/skills/check-skills.mjs` is Lane 1 of the eval plan (zero tokens, every push): the build check, frontmatter rules (name = folder; description ≤ 350 characters with the key use case first; `when_to_use` present; description + `when_to_use` ≤ 1 536), the untrusted-text rule verbatim in every body, the output-contract headings, references that exist and stay inside the Skill, tool names that are real Phase-1a tools, write tools named by no Skill but `apply`, the commit tools in every other Skill's `disallowed-tools`, a consistent `tool_contract`, no file over 200 KB, the secret scanner clean over `skills/`, the eval files well-formed, time-blind trigger prompts, and a pairwise trigger-collision heuristic.

## Tool sequences

`evals/tool_sequence.json` lists the calls a Skill promises, in order, with example arguments on the fixture manual league (`manual.l.example`, team `manual.l.example.t.1`). The integration dry run (plan 09 §5.1 item 7) replays each sequence against the server in fixture mode.

```text
{ schema_version: 1, skill, tool_contract, fixture: { league_key, team_key, week, … },
  sequences: [ { id, when, fixture_variant?, steps: [ { id, tool, args, expect? } ] } ] }
```

- `tool` is a bare Phase-1a tool name; `args` are the tool's input.
- `expect` lists the outcomes a step may have on the fixture league: `"ok"` (default) or error codes such as `"NOT_FOUND"` (for example, no opponent roster under the manual league).
- `{ "$ref": "<step id>.<path>" }` stands for a value from an earlier step's full result envelope, e.g. `"lineup.data.rec"` or `"league.meta.as_of"`.
- `{ "$source_calls": ["<step id>", …] }` stands for `[{ "tool": <that step's tool>, "request_id": <its meta.request_id> }, …]`.
- Every sequence starts with `ff_get_status` and, when it records, ends with `ff_record_recommendation` (log before rendering).

## Trigger evals

`evals/trigger_eval.json` is an array of `{ "query", "should_trigger" }` (at least 6 of each). Every query is **time-blind** — no weekday, clock time, date, "today" or "tonight" — because the model is not told the time in Claude Desktop or claude.ai. The four game-day prompts ("who should I start?", "X is inactive, who goes in?", "what can I still change?", "what are my odds right now?") must be positives of `start-sit` and of no other Skill.

## Lane 2 cases

`evals/cases.json` holds the model-graded cases (plan 09 §5.2), run by hand before a release:

```text
{ schema_version: 1, skill, fixture_league,
  cases: [ { id, phase, prompt, fixture_variant, setup, expectations: [ … ] } ] }
```

Expectation kinds: `tool_used` / `tool_not_used` `{ tool }`, `tool_order` `{ tools: [...] }` (a subsequence of the calls made), `tool_args` `{ tool, args }` (a subset of some call's arguments), `regex` / `regex_absent` `{ pattern, flags }` (on the final answer), `rubric` `{ text }` (graded, pass bar 80 %), and `skill_invoked` `{ value }`. `fixture_variant` names a variant of the fixture league the runner layers on the base (`null` = the base league); `setup` says what it must contain.

## Attribution

NFL data from nflverse (CC BY 4.0); weather from Open-Meteo (CC BY 4.0, non-commercial use) or the National Weather Service (public domain). The Skills print the attribution of whatever data a result actually used.
