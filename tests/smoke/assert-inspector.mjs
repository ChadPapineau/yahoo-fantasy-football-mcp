// @ts-check
// assert-inspector.mjs — checks the JSON the MCP Inspector CLI printed in the CI `smoke` job (plan
// 10 A3a): `node tests/smoke/assert-inspector.mjs <tools.json> <resources.json> <templates.json>
// <prompts.json>`. tools/list must equal tests/smoke/expected-tools.json (+ ff_debug_echo, fixture
// mode) with no ff_prepare_*/ff_commit_* and the pointer on every description; resources, templates
// and prompts must be the 1a sets. Cache hints are checked only when the Inspector negotiated the
// 2026-07-28 era (they are present in its list results). Exit 0 = pass, 1 = fail, 2 = usage.
import { readFileSync } from "node:fs";
import {
  checkDescriptions,
  checkPrompts,
  checkResources,
  checkToolNames,
  inspectorResult,
  readExpectedTools,
} from "./smoke-lib.mjs";

const files = process.argv.slice(2);
if (files.length !== 4) {
  process.stderr.write(
    "usage: assert-inspector.mjs <tools.json> <resources.json> <templates.json> <prompts.json>\n",
  );
  process.exit(2);
}
/** @param {string} f */
const load = (f) => inspectorResult(JSON.parse(readFileSync(f, "utf8")));
const [tools, resources, templates, prompts] = files.map(load);
/** @type {string[]} */
const problems = [];
const toolList = Array.isArray(tools?.tools) ? tools.tools : null;
if (toolList === null) problems.push("tools/list: no `tools` array in the Inspector output");
else {
  problems.push(
    ...checkToolNames(
      toolList.map((t) =>
        typeof t === "object" && t !== null ? /** @type {{ name?: unknown }} */ (t).name : null,
      ),
      readExpectedTools().core,
      { fixtureMode: true },
    ),
    ...checkDescriptions(toolList),
  );
}
problems.push(
  ...checkResources(resources, templates, {
    requireCacheHints: typeof resources?.ttlMs === "number",
  }),
  ...checkPrompts(prompts),
);
for (const p of problems) process.stderr.write(`inspector smoke: FAIL ${p}\n`);
process.stdout.write(
  problems.length === 0
    ? `inspector smoke: PASS (${toolList?.length ?? 0} tools)\n`
    : `inspector smoke: ${problems.length} problem(s)\n`,
);
process.exit(problems.length === 0 ? 0 : 1);
