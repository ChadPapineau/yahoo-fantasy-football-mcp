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

// --- the log contract's alternatives (skills/_shared/references/log.md; QA-2-041) ------------------

/** How many K/DEF candidates the stream-kdef Skill shows per position (its Output additions). */
export const SHOWN_CANDIDATES = 3;
/** E12's bound on `alternatives[]` (src/domain/reclog/record.ts RECORD_BOUNDS.alternatives). */
export const MAX_ALTERNATIVES = 10;

/**
 * @typedef {{ player_key: string | null, gsis_id: string | null, nfl_team: string | null }} Ids
 * @typedef {Ids & { role: string, slot: string | null }} Subject
 * @typedef {{ action: string, entrant: Ids, subjects: Subject[] }} Move
 */

/** @param {unknown} env @param {string} what @returns {Record<string, unknown>} */
function dataOf(env, what) {
  if (!isRecord(env) || !isRecord(env["data"])) throw new Error(`${what}: no data in the result`);
  return env["data"];
}

/** @param {unknown} v @returns {Subject[]} */
function subjectsOf(v) {
  return Array.isArray(v) ? /** @type {Subject[]} */ (v.filter(isRecord)) : [];
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === "string" ? v : null);

/** @param {Ids} s @returns {Ids} */
const idsOf = (s) => ({
  player_key: str(s.player_key),
  gsis_id: str(s.gsis_id),
  nfl_team: str(s.nfl_team),
});

/**
 * The moves the log contract offers beside a call (log.md, `alternatives[]`), each shaped like the
 * call so the weekly review compares them player by player (counterpartOf, QA-2-041):
 * - a lineup result (`swaps[]`, `comparisons[]`): one per row with an `out` — the other side of that
 *   swap. A row whose `in` the call starts is not made (start its `out`, sit its `in`); any other
 *   row is made (start its `in` in its `slot`, sit its `out`). The player it sits must be one the
 *   call starts and the one it starts one the call does not, or the row offers nothing comparable
 *   and is skipped.
 * - a K/DEF result (`candidates[]`): every shown candidate (the first SHOWN_CANDIDATES) other than
 *   the one the call streams — stream it, drop the current starter — and, for a stream call,
 *   holding the current starter.
 * `entrant` is the player each move brings in: its numbers are his projection.
 * @param {unknown} analytics an ff_analyze_lineup or ff_analyze_waivers result envelope
 * @returns {Move[]}
 */
export function alternativeMoves(analytics) {
  const d = dataOf(analytics, "$alternatives");
  const rec = isRecord(d["rec"]) ? d["rec"] : {};
  const recSubjects = subjectsOf(rec["subjects"]);
  /** @type {Move[]} */
  const moves = [];
  if (Array.isArray(d["candidates"])) {
    const starter = recSubjects.find((s) => s.role === "start" || s.role === "drop");
    const pick = recSubjects.find((s) => s.role === "stream");
    // a call that brings no one in (no candidate could be projected) has nothing to compare with
    if (pick === undefined && starter?.role !== "start") return [];
    for (const c of d["candidates"].slice(0, SHOWN_CANDIDATES)) {
      if (!isRecord(c)) continue;
      const ids = idsOf(/** @type {Ids} */ (c));
      if (ids.player_key === str(pick?.player_key) || ids.player_key === str(starter?.player_key))
        continue;
      moves.push({
        action: `stream ${String(ids.player_key)}${starter ? `, dropping ${String(starter.player_key)}` : ""}`,
        entrant: ids,
        subjects: [
          { ...ids, role: "stream", slot: null },
          ...(starter ? [{ ...idsOf(starter), role: "drop", slot: null }] : []),
        ],
      });
    }
    if (pick !== undefined && starter !== undefined)
      moves.push({
        action: `hold ${String(starter.player_key)}`,
        entrant: idsOf(starter),
        subjects: [{ ...idsOf(starter), role: "start", slot: null }],
      });
  } else if (Array.isArray(d["swaps"])) {
    const started = recSubjects.filter((s) => s.role === "start");
    const startedAs = (/** @type {unknown} */ key) => started.find((s) => s.player_key === key);
    const rows = [...d["swaps"], ...(Array.isArray(d["comparisons"]) ? d["comparisons"] : [])];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const row of rows) {
      if (!isRecord(row) || str(row["out"]) === null || str(row["in"]) === null) continue;
      if (row["out"] === row["in"]) continue;
      const made = startedAs(row["in"]) === undefined;
      const [inKey, outKey] = made ? [row["in"], row["out"]] : [row["out"], row["in"]];
      const leaver = startedAs(outKey);
      const slot = str(row["slot"]);
      // the player it sits must be one the call starts, and the one it starts one the call does not
      if (leaver === undefined || startedAs(inKey) !== undefined) continue;
      if (seen.has(`${String(inKey)}>${String(outKey)}`)) continue;
      seen.add(`${String(inKey)}>${String(outKey)}`);
      const known = recSubjects.find((s) => s.player_key === inKey);
      const entrant = known
        ? idsOf(known)
        : { player_key: str(inKey), gsis_id: null, nfl_team: null };
      moves.push({
        action: `start ${String(inKey)} at ${String(slot)} instead of ${String(outKey)}`,
        entrant,
        subjects: [
          { ...entrant, role: "start", slot },
          { ...idsOf(leaver), role: "sit", slot: str(leaver.slot) },
        ],
      });
    }
  } else throw new Error("$alternatives: not an ff_analyze_lineup or ff_analyze_waivers result");
  return moves.slice(0, MAX_ALTERNATIVES);
}

/**
 * The log contract's `alternatives[]` for a call: alternativeMoves with each entrant's numbers from
 * `projections` (an ff_project_players result for the week): `distribution` = his projected
 * points, `point_estimate` and `decision_metric_value` = their mean; his `gsis_id` is filled from
 * the projection row when the move did not carry it. Throws when an entrant was not projected.
 * @param {unknown} analytics
 * @param {unknown} projections
 * @returns {Record<string, unknown>[]}
 */
export function alternativesFrom(analytics, projections) {
  const rows = dataOf(projections, "$alternatives projections")["projections"];
  const byKey = new Map(
    (Array.isArray(rows) ? rows.filter(isRecord) : []).map((r) => [r["player_key"], r]),
  );
  return alternativeMoves(analytics).map((m) => {
    const row = byKey.get(m.entrant.player_key);
    const week0 = isRecord(row) && Array.isArray(row["weeks"]) ? row["weeks"][0] : undefined;
    const dist = isRecord(week0) && isRecord(week0["points"]) ? week0["points"] : null;
    if (!isRecord(row) || dist === null || typeof dist["mean"] !== "number")
      throw new Error(`$alternatives: no projection of ${String(m.entrant.player_key)}`);
    const gsis = m.entrant.gsis_id ?? str(row["gsis_id"]);
    return {
      action: m.action,
      subjects: m.subjects.map((s) =>
        s.player_key === m.entrant.player_key ? { ...s, gsis_id: s.gsis_id ?? gsis } : s,
      ),
      point_estimate: dist["mean"],
      distribution: structuredClone(dist),
      decision_metric_value: dist["mean"],
    };
  });
}

/**
 * Resolve a step's argument template: every `{ $ref: "<step>.<path>" }` becomes the value at that
 * path of that step's result envelope; every `{ $source_calls: [ids] }` becomes
 * `[{ tool, request_id }]` from those steps (`meta.request_id`); `{ $alternative_keys: "<step>" }`
 * becomes the player keys the log contract's alternatives bring in (to project them), and
 * `{ $alternatives: { from: "<step>", projections: "<step>" } }` the alternatives themselves
 * (alternativesFrom). Plain values are deep-copied.
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
  if (Object.hasOwn(template, "$alternative_keys")) {
    const id = String(template["$alternative_keys"]);
    const done = results.get(id);
    if (!done) throw new Error(`$alternative_keys: step ${id} has no result`);
    return [
      ...new Set(
        alternativeMoves(done.result)
          .map((m) => m.entrant.player_key)
          .filter((k) => k !== null),
      ),
    ];
  }
  if (Object.hasOwn(template, "$alternatives")) {
    const spec = template["$alternatives"];
    const from = isRecord(spec) ? results.get(String(spec["from"])) : undefined;
    const proj = isRecord(spec) ? results.get(String(spec["projections"])) : undefined;
    if (!from || !proj)
      throw new Error("$alternatives: its `from` and `projections` steps must have results");
    return alternativesFrom(from.result, proj.result);
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
