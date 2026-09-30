// @ts-check
// tool-sequences.mjs — the loader and argument resolver for the Lane 1 fixture dry run (plan 09 §5.1
// item 7; plan 10 A10): reads every Skill's evals/tool_sequence.json (validated by check-skills),
// and turns a step's argument template into concrete tool arguments from the results of the
// earlier steps. The dry run itself (the server in fixture mode) lives with the integration tests.
// Zero dependencies.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateToolSequence, SKILL_RULES } from "./check-skills.mjs";
import {
  REPO_ROOT,
  SKILLS_DIR,
  isRecord,
  listSkillDirs,
  readErrorCodes,
  readManifest,
} from "./_lib.mjs";

/**
 * @typedef {{ id: string, when: string, fixture_variant: string | null,
 *   steps: import("./check-skills.mjs").SeqStep[] }} LoadedSequence
 * @typedef {{ skill: string, fixture: Record<string, unknown>, sequences: LoadedSequence[] }} SkillSequences
 * @typedef {{ tool: string, result: unknown }} StepResult  the step's tool and its full envelope
 */

/**
 * Load and validate every Skill's tool_sequence.json. Throws with every problem listed when any
 * file is invalid — the dry run must never replay a sequence the checker would reject.
 * @param {string} [root]
 * @returns {SkillSequences[]}
 */
export function loadToolSequences(root = REPO_ROOT) {
  const skillsRoot = path.join(root, SKILLS_DIR);
  const manifest = readManifest(skillsRoot);
  const errorCodes = readErrorCodes(root);
  const listed = listSkillDirs(skillsRoot);
  /** @type {string[]} */
  const errors = [...listed.errors];
  /** @type {SkillSequences[]} */
  const out = [];
  for (const skill of listed.skills) {
    const file = path.join(skillsRoot, skill, "evals", "tool_sequence.json");
    const where = `skills/${skill}/evals/tool_sequence.json`;
    if (!existsSync(file)) {
      errors.push(`${where}: missing`);
      continue;
    }
    /** @type {unknown} */
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      errors.push(`${where}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const rule = SKILL_RULES[skill];
    const v = validateToolSequence(raw, {
      skill,
      where,
      tools: manifest.tools,
      writeTools: manifest.write_tools,
      toolContract: manifest.tool_contract,
      errorCodes,
      ...(rule ? { rule } : {}),
    });
    errors.push(...v.errors);
    if (v.errors.length || !isRecord(raw)) continue;
    const rawSeqs = /** @type {Record<string, unknown>[]} */ (raw["sequences"]);
    out.push({
      skill,
      fixture: /** @type {Record<string, unknown>} */ (raw["fixture"]),
      sequences: v.sequences.map((s, i) => {
        const r = rawSeqs[i] ?? {};
        const fv = r["fixture_variant"];
        return {
          id: s.id,
          when: String(r["when"]),
          fixture_variant: typeof fv === "string" ? fv : null,
          steps: s.steps,
        };
      }),
    });
  }
  if (errors.length) throw new Error(`tool sequences are invalid:\n  ${errors.join("\n  ")}`);
  return out;
}

/**
 * Read `a.b.c` (the path after the step id) out of a result envelope.
 * @param {unknown} value
 * @param {string[]} keys
 * @param {string} ref for errors
 * @returns {unknown}
 */
function pick(value, keys, ref) {
  let cur = value;
  for (const k of keys) {
    if (Array.isArray(cur) && /^\d+$/.test(k)) cur = cur[Number(k)];
    else if (isRecord(cur) && Object.hasOwn(cur, k)) cur = cur[k];
    else throw new Error(`$ref "${ref}": no \`${k}\` in the result`);
  }
  if (cur === undefined) throw new Error(`$ref "${ref}" resolved to undefined`);
  return cur;
}

/**
 * Resolve a step's argument template: every `{ $ref: "<step>.<path>" }` becomes the value at that
 * path of that step's result envelope; every `{ $source_calls: [ids] }` becomes
 * `[{ tool, request_id }]` from those steps (`meta.request_id`). Plain values are deep-copied.
 * @param {unknown} template
 * @param {ReadonlyMap<string, StepResult>} results completed steps by id
 * @returns {unknown}
 */
export function resolveArgs(template, results) {
  if (Array.isArray(template)) return template.map((x) => resolveArgs(x, results));
  if (!isRecord(template)) return template;
  if (Object.hasOwn(template, "$ref")) {
    const ref = template["$ref"];
    if (typeof ref !== "string") throw new Error("$ref must be a string");
    const [id = "", ...keys] = ref.split(".");
    const done = results.get(id);
    if (!done) throw new Error(`$ref "${ref}": step ${id} has no result`);
    return structuredClone(pick(done.result, keys, ref));
  }
  if (Object.hasOwn(template, "$source_calls")) {
    const list = template["$source_calls"];
    if (!Array.isArray(list)) throw new Error("$source_calls must be an array of step ids");
    return list.map((id) => {
      const done = results.get(String(id));
      if (!done) throw new Error(`$source_calls: step ${String(id)} has no result`);
      const requestId = pick(done.result, ["meta", "request_id"], `${String(id)}.meta.request_id`);
      return { tool: done.tool, request_id: requestId };
    });
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(template)) out[k] = resolveArgs(v, results);
  return out;
}

/**
 * Whether a step's outcome is one its `expect` list allows: `"ok"` for a success, or the error code.
 * @param {{ expect: readonly string[] }} step
 * @param {string} outcome `"ok"` or a plan 01 §4.3 error code
 */
export function outcomeAllowed(step, outcome) {
  return step.expect.includes(outcome);
}
