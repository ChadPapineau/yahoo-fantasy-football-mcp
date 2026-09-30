# Scratch: skills-mcp-researcher

Working notes for the Skills + MCP-design research (brief:
`docs/scratch/briefs/skills-mcp-researcher.md`). Deliverable:
`docs/research/06-skills-and-mcp-design.md`.

## RESUME HERE

- **Status:** COMPLETE 2026-09-29. `docs/research/06-skills-and-mcp-design.md` sections A–G written and pushed (A+B `3002963`, C+D `07dd3a1`, E+F+G in the final commit). No `.wip.patch` was ever needed (each section was pushed as it landed). Nothing left in flight.
- **If resumed:** only follow-ups remain — the 15 unverified items in 06 §F (U-1…U-15), each a one-test question for the build phase; and the product planner may rename tools/Skills in `docs/plan/07`/`09`.
- **Owned paths:** `docs/research/06-skills-and-mcp-design.md`,
  `docs/scratch/skills-mcp-researcher.md` (+ `.wip.patch` while in flight).
- **Do not touch:** README.md, .gitignore, .env.example, docs/research/00–05,
  docs/scratch/roster.md, docs/scratch/program.md, docs/scratch/briefs/.
- **Plan (sections of the deliverable):**
  - A. Mechanisms (tools/annotations/elicitation, resources, prompts, Skills,
    plugins, token economics) — with spec revision date + sources.
  - B. Split criteria, applied to every decision type in docs/research/05 §Output
    shapes and every capability in docs/research/03.
  - C. Prior art (fantasy-football Skills/plugins/prompt sets; 2–3 exemplary
    non-sports Skills). Static read only; never run scripts.
  - D. Candidate Skills catalog (purpose, triggers + non-triggers, tools in
    order, inputs, outputs, guardrails, evals, gaps).
  - E. Repo layout + lifecycle (versioning, install paths, evals in CI).
- **Next step:** none for this agent. Hand-off: orchestrator reads 06 §"The answer in one paragraph", §B.1 criteria, §D catalog, §F unverified.
- **Constraint to design around:** Yahoo API is read-only by default and write
  access is "not available at this time" — confirmation mechanism applies to a
  conditional write capability; every Skill must be fully useful read-only.

## Log

- 2026-09-29: created scratch doc (first action per the brief).

## Evidence log (2026-09-29, all fetched this session unless marked local)

### MCP spec — current revision is 2026-07-28 (sitemap lists 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28, draft)
- tools (2026-07-28): Tool = name/title/description/icons/inputSchema/outputSchema/annotations; names 1–128 chars [A-Za-z0-9_.-]; deterministic tools/list order "improves LLM prompt cache hit rates"; tools/list carries `ttlMs` + `cacheScope`; `structuredContent` any JSON conforming to outputSchema, SHOULD also serialise into a TextContent block; two error classes (protocol JSON-RPC vs `isError:true` execution errors — "Clients SHOULD provide tool execution errors to language models to enable self-correction"); "Stateful Tools" non-normative section: explicit server-minted opaque handles as ordinary args, validate authz per call, bounded lifetime, expiry → tool error; annotations untrusted unless trusted server; human-in-the-loop SHOULD (deny + confirmation prompts).
- elicitation (2026-07-28): form + url modes; delivered as `InputRequiredResult` (`resultType:"input_required"`, `inputRequests`, `requestState`) under the MRTR pattern — client retries the same call with `inputResponses`; client caps declared per request in `_meta.io.modelcontextprotocol/clientCapabilities.elicitation {form:{}, url:{}}`; form schema = flat object, primitives + enum (single/multi, `oneOf` const/title), defaults; actions accept/decline/cancel; servers MUST bind elicitation to client+user identity; MUST NOT request secrets in form mode.
- changelog 2026-07-28: sessions removed (no Mcp-Session-Id), stateless (`_meta` protocolVersion/clientCapabilities per request), `server/discover`, `subscriptions/listen` replaces resources/subscribe + GET stream, ping/logging/setLevel removed, tasks → extension `io.modelcontextprotocol/tasks`, MRTR replaces server-initiated requests, `resultType` required, `-32002`→`-32602`, Roots/Sampling/Logging DEPRECATED, DCR deprecated for CIMD, inputSchema/outputSchema any 2020-12.
- resources (2025-06-18 page; 2026-07-28 differs only in subscriptions): "application-driven"; uri/name/title/description/mimeType/size; templates RFC 6570 + completion; annotations audience/priority/lastModified.
- prompts: "user-controlled" (slash commands); name/title/description/arguments[{name,description,required}]; arguments string-only; messages[] can embed resources.
- pagination: opaque cursor, server-chosen page size, `nextCursor`; applies to the four list ops only (NOT to tool results — tool-level paging is our own args).
- client matrix page (`/extensions/client-matrix`) covers only extensions (Apps, OAuth CC, Enterprise auth, Skills-over-MCP); Claude web/Desktop: Apps only. The core-feature matrix (elicitation) is NOT on that page.

### Claude Code (code.claude.com, fetched via curl)
- Elicitation: supported ("form" dialog + "url" browser consent); declares `elicitation: {form:{}, url:{}}` on 2026-07-28 connections; `Elicitation`/`ElicitationResult` hooks can auto-respond; changelog: added in v2.1.76 (form + URL), URL-mode on 2026-07-28 connections added later; SDK/print mode: fixed auto-cancel bug.
- Resources: `@server:scheme://path` mentions, "automatically fetched and included as attachments when referenced"; "Claude Code automatically provides tools to list and read MCP resources when servers support them" (so the model CAN pull a resource via a tool).
- Prompts: `/servername:promptname (MCP)` or `/mcp__server__prompt`, whitespace-split args, "Prompt results are injected directly into the conversation".
- Tool output: warning > 10,000 tokens; default max 25,000 (`MAX_MCP_OUTPUT_TOKENS`); per-tool `_meta["anthropic/maxResultSizeChars"]` up to 500,000 chars; oversize results saved to a file and replaced by a path. Tool Search deferred loading is default for MCP tools.
- Skills: frontmatter table lines 348–375 of skills.md (name, description, when_to_use, argument-hint, disable-model-invocation, user-invocable, allowed-tools, model, effort, context: fork, agent, background, hooks, paths, version, license, compatibility, metadata); description+when_to_use truncated at 1,536 chars in the listing; listing budget = 1% of context window; keep SKILL.md < 500 lines; Agent Skills open standard (agentskills.io) + Claude Code extensions; claude.ai-synced skills land in `~/.claude/skills/synced/`; Cowork/cloud sessions do NOT read `~/.claude/skills/`.
- Plugins: manifest `.claude-plugin/plugin.json` (only `name` required; version/description/author/homepage/repository/license/keywords/skills/commands/agents/hooks/mcpServers/lspServers/userConfig[sensitive]/dependencies/experimental.evals); `mcpServers` inline map or `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (persists across updates), `${user_config.KEY}`; components namespaced `plugin:skill`; `claude plugin validate`; marketplace.json (name/owner/plugins[]; sources: relative, github{repo,ref,sha}, url, git-subdir, npm, archive{sha256}, command); `version` pins; `metadata.pluginRoot`.
- claude.com platform-support table: Skills load in Chat/Cowork/Claude Code; LOCAL (stdio) MCP servers "Ignored" in Chat, load in Cowork only when the session runs on your computer, load in Claude Code; remote http MCP listed as a Connector; `bin/` makes chat/Cowork refuse the plugin; plugins installed on claude.ai sync into Claude Code as `synced`.
- plugin evals: `claude plugin eval` — cases = dir with prompt.md + graders/*.md; six grader types: regex, tool_used, tool_order, file_exists (free, transcript-computed) + llm, baseline (judge model, costs); runs 3× with and 3× without plugin; `--ablation none`, `--json`, `--max-cost-usd`, `--trust-plugin`, `--model`/`--judge-model` pin; mock MCP servers per case with `.replay/` recordings ("later runs answer the identical call from it with no model call"); every eval run is a real model call. skill-creator's evals.json is a separate format; neither reads the other.
- Agent SDK: skills from `settingSources: ["user","project"]`, `skills: "all" | [names] | []`, `plugins` option to load a plugin path; `/name` dispatch works regardless.

### Anthropic Skills platform docs
- name ≤ 64 chars lowercase/digits/hyphens, no "anthropic"/"claude"; description ≤ 1,024 chars, non-empty; third person; L1 metadata ~100 tokens/skill, L2 body < 5k tokens, L3 on demand; keep body < 500 lines; references one level deep; TOC for files > 100 lines; "Custom Skills do not sync across surfaces" (claude.ai upload ≠ API upload ≠ Claude Code filesystem); API skills have no network; claude.ai varies; Claude Code full network; MCP tool refs `ServerName:tool_name`; eval-first authoring, ≥ 3 evals, test on Haiku/Sonnet/Opus.
- Token economics: writing-tools post — `response_format` concise vs detailed (206 → 72 tokens, −65%); prefer names over UUIDs; paginate/filter/truncate with defaults; Claude Code 25k token cap. code-execution post — tool definitions and intermediate results consume context; 150,000 → 2,000 tokens (−98.7%) example. Prompt caching — prefix order tools → system → messages; changing any tool definition invalidates the whole cache; min 512 tokens (Fable 5.1 family) up to 4,096 (older); reads 0.1× (0.025× Fable 5.1), 5-min writes 1.25×, 1-h 2×.

### TypeScript SDK (v2, implements 2026-07-28)
- `registerTool(name, {title, description, inputSchema (zod), outputSchema, annotations}, handler)`; return `content[] + structuredContent`; invalid args → `isError` result without running the handler.
- Elicitation server side: `ctx.mcpReq.elicitInput({...})`; "only works against a client that declared the elicitation capability — per mode"; if missing, "elicitInput throws before anything reaches the wire, and the thrown message comes back as an ordinary isError tool result".

### Client support for elicitation (the decision-critical fact)
- Claude Code: YES (form + url), v2.1.76+. Claude Desktop: NO — anthropics/claude-code#41110 (opened 2026-03-30, closed as `invalid`/out of scope, no maintainer response); mcp-server-dev official skill: "Claude Desktop: Unconfirmed — likely not yet"; claude.ai: "Unknown". No Desktop/claude.ai release note found stating elicitation support.

### Prior art (static reads only; nothing run)
- derekrbreese/fantasy-football-skills (marketplace v1.2.0, 6 plugins: fantasy-league-setup, draft-strategy, lineup-strategy, waiver-wire, trade-analyzer, roster-ops; no server; browser-driven UI ops "confirmation-gated"; MIT; 4 stars). Same author as fantasy-football-mcp-public = Do-not-use in docs/01 (credentials in history).
- TheClaudeFather/ff-advisor (Sleeper, read-only, Python CLI + scoring engine `scoring.score_line`/`valuation.replacement_points`; MIT).
- nmiller0113/fantasy-copilot (Draft Sharks subscription required; 11 Python scripts; Chrome; MIT).
- jdguggs10/flaim (remote MCP gateway on Cloudflare Workers, Yahoo via OAuth, Supabase; "skill = judgment logic, tool mechanics stay in tool descriptions"; MIT).
- eponerine/espn-fantasy-football-mcp-node: `how_to_answer` zero-arg tool returning a playbook (tool-as-playbook pattern), 18 read tools.
- HamCops/dodi (ESPN, Python): `apply=false` preview default; `ESPN_REQUIRE_APPROVAL=1` → out-of-band ntfy approval with per-proposal one-shot token; lineup changes bypass approval.
- FantasyPros MCP (commercial, remote HTTP + OAuth): free rankings/projections/research/league tools; premium start_sit_assistant, trade_analyzer, trade_finder, waiver_finder, waiver_analyzer.
- jasonbhorne/claude-code-skills fantasy-football (4 modes, 5 parallel WebSearch agents, .docx output; MIT). michaelfromyeg/fantasy-sports-toolkit (Weft-compiled multi-harness skills + Sleeper/Yahoo MCPs; Reddit sentiment). jbaros/sleeper-ffb-worker (read-only Sleeper, 10 workflow tools, Workers). ruchirpipalia-spec/fantasy-football-agent (Sleeper MCP + skill; nflverse + Sleeper + ESPN RSS + optional FantasyPros; MIT). machina-sports/sports-skills (30+ data skills, no fantasy-football; ESPN undocumented endpoints; record/replay env var). mcpmarket fantasy-football-analytics-ml (zazu-22; ML projection guidance; references + template). skills.sh search: not searchable via fetch (homepage only). curtisawe-cmd/FF-Site: 404.
- Exemplary non-sports (local, official marketplace): skill-creator (evals/evals.json + grader/analyzer agents + eval-viewer), math-olympiad (evals/trigger_eval.json should_trigger true/false ×20; references/ by concern; scripts/), mcp-server-dev/build-mcp-server (references/ per topic incl. elicitation.md canonical capability-check + fallback, tool-design.md Directory hard requirements: readOnlyHint/destructiveHint/title mandatory, read/write in separate tools, descriptions must not instruct behaviour).

- 2026-09-29: evidence log pushed (`2a34e8d`); A+B pushed (`3002963`); C+D pushed (`07dd3a1`); E+F+G + this status in the final commit.
- Note for the orchestrator: one classifier denial occurred (reading a persisted tool-result file under `~/.claude/projects/…`); the source `SKILL.md` was read directly instead. Two WebFetch pages (Claude Code `skills.md`, `plugin-evals.md`) exceeded the summariser and were pulled with `curl` + `grep` into the session scratchpad instead — same content, no workaround of any denial.
