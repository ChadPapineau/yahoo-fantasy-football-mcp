# docs/

The research, the plan, the record of how the plan was attacked, and the orchestration state of the
agent program that produced them. **Read [`HANDOFF.md`](HANDOFF.md) first** in any fresh session;
then [`plan/00-index.md`](plan/00-index.md) for the plan in reading order. Everything here describes a
product that is **📋 planned, not built** — the build starts after the owner approves the plan.

| Path | What it is |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | **The single handoff document**: the finding that reshapes the product (Yahoo read-only, application-gated), program status, decisions made with dates, stack facts checked at source, Yahoo terms the plan must honour, the accumulating list of things the owner must know or decide, and the ▶ NEXT STEP |
| [`research/`](#research-00–06) | Seven research documents (waves 1–3), each verified by the orchestrator against at least one load-bearing claim at source |
| [`plan/`](#plan-01–10-plus-the-review-record) | The ten-part refined plan, the adversarial log and the changelog of what the review changed |
| [`scratch/`](#scratch) | Orchestration state — agent rosters, verbatim briefs, per-agent handover notes and WIP patches. Not product documentation |

## Research (00–06)

| Doc | One line |
|---|---|
| [`00-tooling-inventory.md`](research/00-tooling-inventory.md) | Which connectors, skills and agents were available to the orchestrating session, which helped, and which Skills the product itself should ship (finalised in 06) |
| [`01-repo-security-audit.md`](research/01-repo-security-audit.md) | Twenty-one prior-art repositories read statically as untrusted code: per-repo verdicts (*Safe to learn from* · *Learn from with caution* · *Do not use*), the credential leaks found in two public histories (values never reproduced), dependency advisory counts, and the rejected list |
| [`02-prior-art-lessons.md`](research/02-prior-art-lessons.md) | Architecture lessons from the repositories that passed: capability matrices, the choices that work (adopt the idea, not the code), the mistakes to avoid with the symptom each produces, and what the matrix says our design must do differently |
| [`03-yahoo-api.md`](research/03-yahoo-api.md) | The Yahoo Fantasy Sports API capability reference: auth (authorization-code only, no PKCE, `oob` accepted, rotating refresh tokens), the full read and write surface, stat ids for the scoring engine, response-format traps, limits and finalisation, the gaps, the unverified items by name, and the three facts that most constrain the architecture |
| [`04-data-sources.md`](research/04-data-sources.md) | Every NFL data source graded per need (nflverse, ffopportunity, Sleeper, DynastyProcess, lines, weather, news): what was fetched and observed, licences and the non-commercial/share-alike constraints, the id-crosswalk plan, the freshness map, and the do-not-use list |
| [`05-strategy-and-analytics.md`](research/05-strategy-and-analytics.md) | The analytics methodology behind every decision engine — projections, replacement level, start/sit, waivers and FAAB, trades, injury cascades, bye and playoff planning, K/DEF streaming, roster construction, news-vs-stats, win probability, the retrospective and calibration, the scoring-engine spec — each with inputs, method, format sensitivity, pitfalls, output contract and evaluation; plus the data-needs order and the clean negatives |
| [`06-skills-and-mcp-design.md`](research/06-skills-and-mcp-design.md) | What is a tool, a Skill, a prompt, a resource: the MCP mechanisms as specified (revision 2026-07-28), elicitation and its client support, token economics, the split applied to every capability and decision type, vetted Skills prior art (inspiration only), the fourteen candidate Skills, and the repo layout and lifecycle for the bundle |

## Plan (01–10) plus the review record

The plan is **final** after a three-round adversarial review; its reading-order index with one-line summaries is [`plan/00-index.md`](plan/00-index.md). Plans 01–06 are the structural plan (architecture, security, lifecycle, repository and CI, testing, automation); 07–10 are the product plan (tool catalog, scoring engine, Skills bundle, phasing and acceptance). [`plan/adversarial-log.md`](plan/adversarial-log.md) holds every objection, the defence's ruling, and the closing verdict (30 objections: 29 conceded and landed, 1 withdrawn on evidence, 0 pressed). [`plan/changelog.md`](plan/changelog.md) says, one line per objection, what changed and where it landed.

## Scratch

[`scratch/`](scratch/) is the agent program's working memory, committed so that work survives a usage-limit cutoff: [`roster.md`](scratch/roster.md) (every agent, its brief, owned paths, status and last pushed SHA), [`program.md`](scratch/program.md) (waves and file ownership), [`briefs/`](scratch/briefs/) (the verbatim brief each agent was given) and one `<agent>.md` note per agent with a `## RESUME HERE` section. It is orchestration state, not product documentation: nothing in it is a decision unless HANDOFF or a plan file records it.

## Attribution

*Fantasy data provided by [Yahoo Fantasy](https://football.fantasysports.yahoo.com/).* The Yahoo Fantasy logo is not redistributed here; see the README's [Acknowledgements](../README.md#acknowledgements) for where it belongs.

## Licence

The documents in this directory are covered by the repository's [MIT licence](../LICENSE). MIT was chosen for maximal reuse of a small open-source tool, as the norm for MCP servers, with no NOTICE-file overhead; Apache-2.0's patent grant was judged not material here.
