#!/usr/bin/env node
// @ts-check
// check-skills.mjs — Lane 1 of the Skills eval plan (plan 09 §5.1 items 1–6; plan 04 §4.2 `skills`
// job; plan 10 A10): zero tokens, every push. The fixture dry run (item 7) replays each
// evals/tool_sequence.json against the server and lives with the integration tests; this script
// validates those files so the dry run has well-formed input. Zero dependencies.
//
// Usage: node scripts/skills/check-skills.mjs [--root <repo root>] [--no-scan]
// Exit:  0 clean · 1 findings · 2 usage error.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { buildSkills } from "./build-skills.mjs";
import {
  REPO_ROOT,
  SKILLS_DIR,
  beginMarker,
  errMsg,
  isMain,
  isRecord,
  listSkillDirs,
  parseFrontmatter,
  readErrorCodes,
  readExpectedTools,
  readManifest,
  readPackageVersion,
  readRegistryContract,
  readRuleSentence,
  walkFiles,
} from "./_lib.mjs";

/** plan 09 §2 / §5.1 item 1 (round 1, OBJ-08): the listing budget per Skill. */
export const DESCRIPTION_MAX = 350;
/** The platform's hard cap on `description` (research 06 §A.4). */
export const DESCRIPTION_HARD_MAX = 1024;
/** Claude Code truncates description + when_to_use at 1 536 characters. */
export const LISTING_MAX = 1536;
/** research 06 §A.4: SKILL.md body under 500 lines. */
export const BODY_MAX_LINES = 500;
/** plan 04 §4.2: no file over 200 KB. */
export const FILE_MAX_BYTES = 200 * 1024;
/** plan 09 §4: ≥ 6 positives and ≥ 6 negatives per trigger_eval.json. */
export const MIN_TRIGGERS = 6;
/** Near-duplicate threshold for positives of two different Skills (token Jaccard). */
export const NEAR_DUPLICATE_JACCARD = 0.75;
/** Frontmatter keys a SKILL.md may carry (standard + the Claude Code extensions plan 09 §2 uses). */
export const ALLOWED_FRONTMATTER = Object.freeze([
  "name",
  "description",
  "when_to_use",
  "argument-hint",
  "disallowed-tools",
  "allowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "metadata",
  "license",
  "compatibility",
  "model",
]);
/** The output-contract headings every body must carry (plan 09 §2 output-template). */
export const OUTPUT_HEADINGS = Object.freeze([
  "Recommendation",
  "Numbers",
  "Why",
  "What would change my mind",
  "Confidence & freshness",
  "Deadline",
  "Manual steps",
  "Log",
  "Sources",
]);
/** Shared files that must be stamped into every body (plan 09 §2: guardrails verbatim in the body). */
export const REQUIRED_BLOCKS = Object.freeze(["guardrails.md", "output-template.md"]);
/** The time-blind game-day prompts that must route to start-sit and nothing else (plan 09 §3.3). */
export const GAME_DAY_PROMPTS = Object.freeze([
  "who should I start?",
  "X is inactive, who goes in?",
  "what can I still change?",
  "what are my odds right now?",
]);
/** The Skill that owns the game-day prompts. */
export const GAME_DAY_OWNER = "start-sit";

/** @typedef {{ id: string, tool: string, args: Record<string, unknown>, expect: string[] }} SeqStep */
/** @typedef {{ id: string, steps: SeqStep[] }} Sequence */
/**
 * @typedef {{ kinds: string[], requiredCases: RegExp[], body: RegExp[],
 *   sequences: (seqs: Sequence[]) => string[] }} SkillRule
 */

/**
 * @param {Sequence} seq
 * @param {string} tool
 */
const stepsOf = (seq, tool) => seq.steps.filter((s) => s.tool === tool);
/**
 * @param {Sequence} seq
 * @param {string} a
 * @param {string} b
 */
const before = (seq, a, b) => {
  const ia = seq.steps.findIndex((s) => s.tool === a);
  const ib = seq.steps.findIndex((s) => s.tool === b);
  return ia !== -1 && ib !== -1 && ia < ib;
};
/** @param {number} n @param {string} p */
const ids = (p, n) => Array.from({ length: n }, (_, i) => new RegExp(`^${p}-${String(i + 1)}$`));

/** Per-Skill promises (plan 09 §3 "Evals — Lane 1"); a Skill without a row gets the general checks. */
export const SKILL_RULES = /** @type {Readonly<Record<string, SkillRule>>} */ (
  Object.freeze({
    "start-sit": {
      kinds: ["lineup", "matchup"],
      requiredCases: ids("SS", 7),
      body: [/only_unlocked/, /lock_schedule/, /objective: "mean"/, /coin flip/i, /option-value/i],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        if (!seqs.some((s) => before(s, "ff_project_players", "ff_analyze_lineup"))) {
          e.push("no sequence calls ff_project_players before ff_analyze_lineup");
        }
        const pre = seqs.filter((s) =>
          stepsOf(s, "ff_analyze_lineup").some((x) => x.args["only_unlocked"] !== true),
        );
        if (
          !pre.some((s) =>
            stepsOf(s, "ff_analyze_lineup").some((x) => x.args["objective"] === "mean"),
          )
        ) {
          e.push('the pre-game ff_analyze_lineup must default to objective: "mean" (plan 07 C11)');
        }
        const lineups = seqs.flatMap((s) => stepsOf(s, "ff_analyze_lineup"));
        if (
          !lineups.some((x) => Array.isArray(x.args["compare"]) && x.args["compare"].length > 0)
        ) {
          e.push("no ff_analyze_lineup step shows `compare` for a named pair");
        }
        const gd = seqs.find((s) => s.id === "game_day");
        if (!gd) e.push("no `game_day` sequence (the branch selected by lock_schedule)");
        else if (!stepsOf(gd, "ff_analyze_lineup").some((x) => x.args["only_unlocked"] === true)) {
          e.push("the game_day sequence's ff_analyze_lineup must carry only_unlocked: true");
        }
        return e;
      },
    },
    "stream-kdef": {
      kinds: ["stream"],
      requiredCases: ids("KD", 3),
      body: [/look_ahead: 2/, /implied team total/i, /two weeks/i, /availability/i],
      sequences: (seqs) => {
        /** @type {string[]} */
        const e = [];
        const all = seqs.flatMap((s) => stepsOf(s, "ff_analyze_waivers"));
        if (all.length === 0) e.push("no ff_analyze_waivers step");
        for (const s of seqs) {
          if (
            stepsOf(s, "ff_analyze_waivers").length &&
            !before(s, "ff_get_schedule", "ff_analyze_waivers")
          ) {
            e.push(`sequence ${s.id}: ff_get_schedule must come before ff_analyze_waivers`);
          }
        }
        for (const w of all) {
          if (w.args["look_ahead"] !== 2) e.push("ff_analyze_waivers must carry look_ahead: 2");
          const pos = w.args["positions"];
          if (
            !Array.isArray(pos) ||
            pos.length === 0 ||
            !pos.every((p) => p === "K" || p === "DEF")
          ) {
            e.push(
              "ff_analyze_waivers positions must be a non-empty subset of [K, DEF] in Phase 1a",
            );
          }
        }
        return e;
      },
    },
    retro: {
      kinds: ["retro"],
      requiredCases: ids("RT", 3),
      body: [/regret/i, /Brier|CRPS/, /followed/, /provisional/i, /n too small/i],
      sequences: (seqs) =>
        seqs.some((s) => stepsOf(s, "ff_analyze_retrospective").length)
          ? []
          : ["no ff_analyze_retrospective step"],
    },
    onboard: {
      kinds: ["onboarding"],
      requiredCases: [/^ON-M\d+$/],
      body: [/0600|chmod 600/, /league\.yaml/, /match/, /read-only/i, /repositor/i],
      sequences: (seqs) =>
        seqs.some((s) => before(s, "ff_get_league", "ff_get_player_stats"))
          ? []
          : ["no sequence calls ff_get_league before ff_get_player_stats (the engine self-check)"],
    },
  })
);

// --- trigger evals ---------------------------------------------------------------------------------

const WEEKDAYS = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i;
const NIGHT_GAMES = /\b(?:tnf|snf|mnf)\b/i;
const CLOCK = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i;
const DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;
const RELATIVE_DAY = /\b(?:today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening))\b/i;

/**
 * A trigger prompt must not depend on a clock the model is not given (plan 09 K8, §5.1 item 5).
 * @param {string} q
 * @returns {string | null} the reason it is not time-blind, or null
 */
export function timeReference(q) {
  if (WEEKDAYS.test(q)) return "names a weekday";
  if (NIGHT_GAMES.test(q)) return "names a night-game slot";
  if (CLOCK.test(q)) return "names a clock time";
  if (DATE.test(q)) return "names a date";
  if (RELATIVE_DAY.test(q)) return "names a day relative to now";
  return null;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "in",
  "on",
  "at",
  "x",
  "n",
  "s",
  "and",
  "or",
]);

/**
 * Lower-case, drop apostrophes, split on anything else that is not a letter or digit, drop
 * stopwords and placeholders, strip a plural `s` (> 3 chars, not `ss`).
 * @param {string} s
 * @returns {string[]}
 */
export function tokenize(s) {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(/['’ʼ`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "" && !STOPWORDS.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

/**
 * The `when_to_use` phrases as token sets (comma-separated in the frontmatter).
 * @param {string} whenToUse
 * @returns {string[][]}
 */
export function phrases(whenToUse) {
  return whenToUse
    .split(",")
    .map((p) => tokenize(p))
    .filter((t) => t.length > 0);
}

/**
 * How many of a Skill's phrases a prompt contains (every token of the phrase present).
 * @param {string[][]} skillPhrases
 * @param {string} prompt
 */
export function routeScore(skillPhrases, prompt) {
  const toks = new Set(tokenize(prompt));
  return skillPhrases.filter((p) => p.every((t) => toks.has(t))).length;
}

/** @param {string} s */
const norm = (s) => tokenize(s).join(" ");

/**
 * @param {string[]} a
 * @param {string[]} b
 */
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * @typedef {{ query: string, should_trigger: boolean }} TriggerCase
 * @typedef {{ name: string, whenToUse: string, triggers: TriggerCase[] }} TriggerSkill
 */

/**
 * The pairwise trigger-collision heuristic (plan 09 §5.1 item 5). Rules:
 * (a) a prompt listed twice, or as both positive and negative, in one Skill;
 * (b) the same positive (after normalisation) in two Skills;
 * (c) near-duplicate positives across Skills (token Jaccard ≥ NEAR_DUPLICATE_JACCARD);
 * (d) a positive that matches more of another Skill's `when_to_use` phrases than of its own;
 * (e) a negative that matches its own Skill's phrases at least as well as any other Skill's;
 * (f) the same `when_to_use` phrase in two Skills;
 * (g) the game-day prompts: positives of GAME_DAY_OWNER and of no other Skill;
 * (h) a positive that matches none of its own Skill's `when_to_use` phrases (the listing would not
 *     route it: add the phrase, or drop the prompt).
 * @param {TriggerSkill[]} skills
 * @param {{ gameDayPrompts?: readonly string[], gameDayOwner?: string }} [opts]
 * @returns {string[]}
 */
export function triggerCollisions(skills, opts = {}) {
  /** @type {string[]} */
  const errors = [];
  const table = skills.map((s) => ({ ...s, phrases: phrases(s.whenToUse) }));
  for (const s of table) {
    /** @type {Map<string, boolean>} */
    const seen = new Map();
    for (const t of s.triggers) {
      const k = norm(t.query);
      const prev = seen.get(k);
      if (prev === undefined) seen.set(k, t.should_trigger);
      else if (prev === t.should_trigger)
        errors.push(`${s.name}: trigger prompt listed twice: "${t.query}"`);
      else errors.push(`${s.name}: "${t.query}" is both a positive and a negative`);
    }
  }
  for (let i = 0; i < table.length; i++) {
    for (let j = i + 1; j < table.length; j++) {
      const a = /** @type {(typeof table)[number]} */ (table[i]);
      const b = /** @type {(typeof table)[number]} */ (table[j]);
      for (const pa of a.triggers.filter((t) => t.should_trigger)) {
        for (const pb of b.triggers.filter((t) => t.should_trigger)) {
          const ta = tokenize(pa.query);
          const tb = tokenize(pb.query);
          if (ta.join(" ") === tb.join(" ")) {
            errors.push(`collision: "${pa.query}" is a positive of both ${a.name} and ${b.name}`);
          } else if (jaccard(ta, tb) >= NEAR_DUPLICATE_JACCARD) {
            errors.push(
              `collision: near-duplicate positives "${pa.query}" (${a.name}) and "${pb.query}" (${b.name})`,
            );
          }
        }
      }
      const pa = new Set(a.phrases.map((p) => p.join(" ")));
      for (const p of b.phrases) {
        if (pa.has(p.join(" ")))
          errors.push(
            `collision: when_to_use phrase "${p.join(" ")}" is in both ${a.name} and ${b.name}`,
          );
      }
    }
  }
  for (const s of table) {
    for (const t of s.triggers) {
      const own = routeScore(s.phrases, t.query);
      let best = 0;
      let bestName = "";
      for (const o of table) {
        if (o.name === s.name) continue;
        const sc = routeScore(o.phrases, t.query);
        if (sc > best) {
          best = sc;
          bestName = o.name;
        }
      }
      if (t.should_trigger && own === 0) {
        errors.push(
          `collision: positive "${t.query}" of ${s.name} matches none of ${s.name}'s when_to_use phrases`,
        );
      }
      if (t.should_trigger && best > own) {
        errors.push(
          `collision: positive "${t.query}" of ${s.name} matches ${bestName}'s when_to_use (${String(best)}) better than its own (${String(own)})`,
        );
      }
      if (!t.should_trigger && own > 0 && own >= best) {
        errors.push(
          `collision: negative "${t.query}" of ${s.name} matches ${s.name}'s own when_to_use phrases (${String(own)})`,
        );
      }
    }
  }
  const owner = opts.gameDayOwner ?? GAME_DAY_OWNER;
  const prompts = opts.gameDayPrompts ?? GAME_DAY_PROMPTS;
  const ownerSkill = table.find((s) => s.name === owner);
  if (ownerSkill) {
    for (const p of prompts) {
      const k = norm(p);
      if (!ownerSkill.triggers.some((t) => t.should_trigger && norm(t.query) === k)) {
        errors.push(`${owner}: the game-day prompt "${p}" must be a positive (plan 09 §3.3)`);
      }
      for (const o of table) {
        if (o.name !== owner && o.triggers.some((t) => t.should_trigger && norm(t.query) === k)) {
          errors.push(`${o.name}: the game-day prompt "${p}" must route to ${owner} only`);
        }
      }
    }
  }
  return errors;
}

/**
 * Parse and validate one trigger_eval.json.
 * @param {unknown} raw
 * @param {string} where
 * @returns {{ triggers: TriggerCase[], errors: string[] }}
 */
export function validateTriggers(raw, where) {
  /** @type {string[]} */
  const errors = [];
  /** @type {TriggerCase[]} */
  const triggers = [];
  if (!Array.isArray(raw))
    return { triggers, errors: [`${where}: must be an array of { query, should_trigger }`] };
  raw.forEach((t, i) => {
    if (
      !isRecord(t) ||
      typeof t["query"] !== "string" ||
      typeof t["should_trigger"] !== "boolean"
    ) {
      errors.push(
        `${where}[${String(i)}]: needs a string \`query\` and a boolean \`should_trigger\``,
      );
      return;
    }
    const extra = Object.keys(t).filter((k) => k !== "query" && k !== "should_trigger");
    if (extra.length) errors.push(`${where}[${String(i)}]: unknown keys ${extra.join(", ")}`);
    const q = t["query"];
    if (q.trim() === "" || q.length > 500)
      errors.push(`${where}[${String(i)}]: query must be 1–500 chars`);
    const why = timeReference(q);
    if (why) errors.push(`${where}[${String(i)}]: "${q}" is not time-blind (${why}; plan 09 K8)`);
    triggers.push({ query: q, should_trigger: t["should_trigger"] });
  });
  const pos = triggers.filter((t) => t.should_trigger).length;
  const neg = triggers.length - pos;
  if (pos < MIN_TRIGGERS || neg < MIN_TRIGGERS) {
    errors.push(
      `${where}: needs ≥ ${String(MIN_TRIGGERS)} positives and ≥ ${String(MIN_TRIGGERS)} negatives (has ${String(pos)}/${String(neg)})`,
    );
  }
  return { triggers, errors };
}

// --- tool sequences --------------------------------------------------------------------------------

const STEP_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const REF_RE = /^([a-z][a-z0-9_]{0,31})((?:\.[A-Za-z0-9_]+)+)$/;

/**
 * Walk `args` checking every `$`-object: `{ $ref: "<earlier step>.<path>" }` or
 * `{ $source_calls: [earlier step ids] }`; any other `$` key is an error.
 * @param {unknown} v
 * @param {Set<string>} earlier
 * @param {string} where
 * @param {string[]} errors
 */
function checkRefs(v, earlier, where, errors) {
  if (Array.isArray(v)) {
    v.forEach((x) => {
      checkRefs(x, earlier, where, errors);
    });
    return;
  }
  if (!isRecord(v)) return;
  const dollar = Object.keys(v).filter((k) => k.startsWith("$"));
  if (dollar.length) {
    if (dollar.length !== 1 || Object.keys(v).length !== 1) {
      errors.push(`${where}: a $-object must have exactly one key`);
      return;
    }
    const k = dollar[0];
    const val = v[k ?? ""];
    if (k === "$ref") {
      const m = typeof val === "string" ? REF_RE.exec(val) : null;
      if (!m) errors.push(`${where}: $ref must be "<step id>.<path>"`);
      else if (!earlier.has(m[1] ?? ""))
        errors.push(`${where}: $ref "${String(val)}" names no earlier step`);
    } else if (k === "$source_calls") {
      if (!Array.isArray(val) || val.length === 0)
        errors.push(`${where}: $source_calls must list step ids`);
      else {
        for (const id of val) {
          if (typeof id !== "string" || !earlier.has(id)) {
            errors.push(`${where}: $source_calls names no earlier step "${String(id)}"`);
          }
        }
      }
    } else errors.push(`${where}: unknown ${String(k)} (only $ref and $source_calls)`);
    return;
  }
  for (const [k, x] of Object.entries(v)) checkRefs(x, earlier, `${where}.${k}`, errors);
}

/**
 * Validate one tool_sequence.json.
 * @param {unknown} raw
 * @param {{ skill: string, where: string, tools: string[], writeTools: string[],
 *   toolContract: number, errorCodes: string[], rule?: SkillRule }} ctx
 * @returns {{ sequences: Sequence[], errors: string[] }}
 */
export function validateToolSequence(raw, ctx) {
  const { where } = ctx;
  /** @type {string[]} */
  const errors = [];
  /** @type {Sequence[]} */
  const sequences = [];
  if (!isRecord(raw)) return { sequences, errors: [`${where}: must be a JSON object`] };
  if (raw["schema_version"] !== 1) errors.push(`${where}: schema_version must be 1`);
  if (raw["skill"] !== ctx.skill) errors.push(`${where}: skill must be "${ctx.skill}"`);
  if (raw["tool_contract"] !== ctx.toolContract) {
    errors.push(
      `${where}: tool_contract ${String(raw["tool_contract"])} ≠ manifest ${String(ctx.toolContract)}`,
    );
  }
  const fx = raw["fixture"];
  if (!isRecord(fx) || typeof fx["league_key"] !== "string")
    errors.push(`${where}: fixture.league_key is required`);
  const seqs = raw["sequences"];
  if (!Array.isArray(seqs) || seqs.length === 0) {
    errors.push(`${where}: sequences must be a non-empty array`);
    return { sequences, errors };
  }
  const allowed = new Set(["ok", ...ctx.errorCodes]);
  /** @type {Set<string>} */
  const seqIds = new Set();
  seqs.forEach((s, si) => {
    const sw = `${where} sequences[${String(si)}]`;
    if (!isRecord(s)) {
      errors.push(`${sw}: must be an object`);
      return;
    }
    const id = s["id"];
    if (typeof id !== "string" || !STEP_ID_RE.test(id)) errors.push(`${sw}: bad id`);
    else if (seqIds.has(id)) errors.push(`${sw}: duplicate id ${id}`);
    else seqIds.add(id);
    if (typeof s["when"] !== "string" || s["when"].trim() === "")
      errors.push(`${sw}: \`when\` must say when it applies`);
    const fv = s["fixture_variant"];
    if (fv !== undefined && (typeof fv !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fv))) {
      errors.push(`${sw}: fixture_variant must be a slug`);
    }
    const steps = s["steps"];
    if (!Array.isArray(steps) || steps.length === 0) {
      errors.push(`${sw}: steps must be a non-empty array`);
      return;
    }
    /** @type {SeqStep[]} */
    const parsed = [];
    /** @type {Set<string>} */
    const earlier = new Set();
    steps.forEach((st, i) => {
      const w = `${sw}.steps[${String(i)}]`;
      if (!isRecord(st)) {
        errors.push(`${w}: must be an object`);
        return;
      }
      const sid = st["id"];
      const tool = st["tool"];
      const args = st["args"];
      if (typeof sid !== "string" || !STEP_ID_RE.test(sid)) errors.push(`${w}: bad step id`);
      else if (earlier.has(sid)) errors.push(`${w}: duplicate step id ${sid}`);
      if (typeof tool !== "string" || !ctx.tools.includes(tool)) {
        errors.push(
          ctx.writeTools.includes(String(tool))
            ? `${w}: ${String(tool)} is a write tool — only apply may use it, and not in Phase 1a`
            : `${w}: ${String(tool)} is not a Phase-1a tool`,
        );
      }
      if (!isRecord(args)) errors.push(`${w}: args must be an object`);
      else checkRefs(args, earlier, `${w}.args`, errors);
      const exp = st["expect"];
      /** @type {string[]} */
      let expect = ["ok"];
      if (exp !== undefined) {
        if (
          !Array.isArray(exp) ||
          exp.length === 0 ||
          !exp.every((x) => typeof x === "string" && allowed.has(x))
        ) {
          errors.push(`${w}: expect must list "ok" and/or plan 01 §4.3 error codes`);
        } else expect = /** @type {string[]} */ (exp);
      }
      const extra = Object.keys(st).filter(
        (k) => !["id", "tool", "args", "expect", "note"].includes(k),
      );
      if (extra.length) errors.push(`${w}: unknown keys ${extra.join(", ")}`);
      if (typeof sid === "string") earlier.add(sid);
      parsed.push({
        id: String(sid),
        tool: String(tool),
        args: isRecord(args) ? args : {},
        expect,
      });
    });
    if (parsed[0]?.tool !== "ff_get_status")
      errors.push(`${sw}: the first step must be ff_get_status (Step 0)`);
    parsed.forEach((p, i) => {
      if (p.tool !== "ff_record_recommendation") return;
      if (i !== parsed.length - 1)
        errors.push(`${sw}: ff_record_recommendation must be the last step (log before render)`);
      const kind = p.args["kind"];
      if (ctx.rule && !ctx.rule.kinds.includes(String(kind))) {
        errors.push(
          `${sw}: record kind "${String(kind)}" is not one of ${ctx.rule.kinds.join(", ")}`,
        );
      }
      for (const k of ["rec", "source_calls", "week"]) {
        if (!(k in p.args)) errors.push(`${sw}: ff_record_recommendation needs \`${k}\``);
      }
    });
    sequences.push({ id: String(id), steps: parsed });
  });
  if (!sequences.some((s) => s.steps.some((p) => p.tool === "ff_record_recommendation"))) {
    errors.push(`${where}: no sequence records the recommendation (ff_record_recommendation)`);
  }
  if (ctx.rule) for (const e of ctx.rule.sequences(sequences)) errors.push(`${where}: ${e}`);
  return { sequences, errors };
}

// --- Lane 2 cases ----------------------------------------------------------------------------------

const CASE_ID_RE = /^[A-Z]{2}-[A-Z0-9]{1,8}$/;
const EXPECTATION_KINDS = Object.freeze([
  "tool_used",
  "tool_not_used",
  "tool_order",
  "tool_args",
  "regex",
  "regex_absent",
  "rubric",
  "skill_invoked",
]);

/**
 * Validate one cases.json.
 * @param {unknown} raw
 * @param {{ skill: string, where: string, tools: string[], rule?: SkillRule }} ctx
 * @returns {string[]}
 */
export function validateCases(raw, ctx) {
  const { where } = ctx;
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(raw)) return [`${where}: must be a JSON object`];
  if (raw["schema_version"] !== 1) errors.push(`${where}: schema_version must be 1`);
  if (raw["skill"] !== ctx.skill) errors.push(`${where}: skill must be "${ctx.skill}"`);
  if (typeof raw["fixture_league"] !== "string")
    errors.push(`${where}: fixture_league is required`);
  const cases = raw["cases"];
  if (!Array.isArray(cases) || cases.length === 0)
    return [...errors, `${where}: cases must be a non-empty array`];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {unknown} t @param {string} w */
  const tool = (t, w) => {
    if (typeof t !== "string" || !ctx.tools.includes(t))
      errors.push(`${w}: ${String(t)} is not a Phase-1a tool`);
  };
  cases.forEach((c, i) => {
    const w = `${where} cases[${String(i)}]`;
    if (!isRecord(c)) {
      errors.push(`${w}: must be an object`);
      return;
    }
    const id = c["id"];
    if (typeof id !== "string" || !CASE_ID_RE.test(id)) errors.push(`${w}: bad id`);
    else if (seen.has(id)) errors.push(`${w}: duplicate id ${id}`);
    else seen.add(id);
    if (typeof c["phase"] !== "string" || !/^(?:1a|1b|2|3|W)$/.test(c["phase"]))
      errors.push(`${w}: phase must be 1a|1b|2|3|W`);
    const p = c["prompt"];
    if (typeof p !== "string" || p.trim() === "" || p.length > 2000)
      errors.push(`${w}: prompt must be 1–2000 chars`);
    const fv = c["fixture_variant"];
    if (fv !== null && (typeof fv !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(fv))) {
      errors.push(`${w}: fixture_variant must be null or a slug`);
    }
    if (typeof c["setup"] !== "string" || c["setup"].trim() === "")
      errors.push(`${w}: setup must describe the fixture`);
    const exps = c["expectations"];
    if (!Array.isArray(exps) || exps.length === 0) {
      errors.push(`${w}: expectations must be a non-empty array`);
      return;
    }
    exps.forEach((x, k) => {
      const ew = `${w}.expectations[${String(k)}]`;
      if (!isRecord(x) || typeof x["kind"] !== "string" || !EXPECTATION_KINDS.includes(x["kind"])) {
        errors.push(`${ew}: kind must be one of ${EXPECTATION_KINDS.join(", ")}`);
        return;
      }
      switch (x["kind"]) {
        case "tool_used":
        case "tool_not_used":
          tool(x["tool"], ew);
          break;
        case "tool_order": {
          const ts = x["tools"];
          if (!Array.isArray(ts) || ts.length < 2) errors.push(`${ew}: tools must list ≥ 2 tools`);
          else
            ts.forEach((t) => {
              tool(t, ew);
            });
          break;
        }
        case "tool_args":
          tool(x["tool"], ew);
          if (!isRecord(x["args"]) || Object.keys(x["args"]).length === 0)
            errors.push(`${ew}: args must be a non-empty object`);
          break;
        case "regex":
        case "regex_absent": {
          const flags = x["flags"] ?? "";
          if (
            typeof flags !== "string" ||
            !/^[imsu]*$/.test(flags) ||
            new Set(flags).size !== flags.length
          ) {
            errors.push(`${ew}: flags must be a subset of "imsu"`);
            break;
          }
          if (typeof x["pattern"] !== "string" || x["pattern"] === "") {
            errors.push(`${ew}: pattern must be a non-empty string`);
            break;
          }
          try {
            new RegExp(x["pattern"], flags);
          } catch (e) {
            errors.push(`${ew}: pattern does not compile: ${errMsg(e)}`);
          }
          break;
        }
        case "rubric":
          if (typeof x["text"] !== "string" || x["text"].trim().length < 10)
            errors.push(`${ew}: rubric text is required`);
          break;
        default: // skill_invoked
          if (typeof x["value"] !== "boolean") errors.push(`${ew}: value must be a boolean`);
      }
    });
  });
  for (const re of ctx.rule?.requiredCases ?? []) {
    if (![...seen].some((id) => re.test(id)))
      errors.push(`${where}: missing a case matching ${String(re)}`);
  }
  return errors;
}

// --- Markdown: links and tool references --------------------------------------------------------------

/**
 * Strip fenced code blocks and inline code spans (links and tool names inside them are examples).
 * @param {string} text
 */
function stripCode(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
}

/**
 * Local link targets in a Markdown text (inline links and images; external and fragment-only
 * links are skipped).
 * @param {string} text
 * @returns {string[]}
 */
export function localLinks(text) {
  const out = [];
  for (const m of stripCode(text).matchAll(
    /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    const t = m[1] ?? "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//") || t.startsWith("#")) continue;
    out.push(t);
  }
  return out;
}

/**
 * `decodeURI` that returns the input unchanged on a malformed escape.
 * @param {string} s
 */
function safeDecode(s) {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/**
 * Tool names referenced in a text (code spans included — that is where Skills name tools).
 * @param {string} text
 * @returns {{ server: string | null, tool: string, wildcard: boolean }[]}
 */
export function toolRefs(text) {
  /** @type {{ server: string | null, tool: string, wildcard: boolean }[]} */
  const out = [];
  for (const m of text.matchAll(/(?:\b([a-z][a-z0-9-]*):)?\b(ff_[a-z0-9_]*[a-z0-9_])(\*)?/g)) {
    out.push({ server: m[1] ?? null, tool: m[2] ?? "", wildcard: m[3] === "*" });
  }
  return out;
}

// --- the whole check ---------------------------------------------------------------------------------

/**
 * Run every Lane 1 check.
 * @param {{ root?: string, scan?: boolean, scanEnv?: Record<string, string> }} [opts]
 * @returns {{ errors: string[], notes: string[], skills: string[] }}
 */
export function checkSkills(opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const skillsRoot = path.join(root, SKILLS_DIR);
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];
  if (!existsSync(skillsRoot)) return { errors: ["skills/: missing"], notes, skills: [] };

  // 0. generated sections are current (plan 09 §4: check:skills runs the build in dry-run mode)
  const build = buildSkills({ root, check: true });
  errors.push(...build.errors.map((e) => `build: ${e}`));
  for (const c of build.changed)
    errors.push(`stale generated file: ${c} (run npm run build:skills)`);

  /** @type {import("./_lib.mjs").Manifest | null} */
  let manifest = null;
  try {
    manifest = readManifest(skillsRoot);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {string | null} */
  let rule = null;
  try {
    rule = readRuleSentence(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {string[]} */
  let errorCodes = [];
  try {
    errorCodes = readErrorCodes(root);
  } catch (e) {
    errors.push(errMsg(e));
  }
  /** @type {string | null} */
  let version = null;
  try {
    version = readPackageVersion(root);
  } catch (e) {
    errors.push(errMsg(e));
  }

  // registry cross-checks (plan 09 K5): only when the MCP layer has landed
  if (manifest) {
    const reg = readRegistryContract(root);
    if (!reg.found)
      notes.push(
        "src/mcp/registry.ts not found — tool_contract checked against skills/_shared/manifest.json only",
      );
    else if (reg.value === null)
      notes.push(
        "src/mcp/registry.ts exports no TOOL_CONTRACT — tool_contract checked against the manifest only",
      );
    else if (reg.value !== manifest.tool_contract) {
      errors.push(
        `tool_contract: manifest ${String(manifest.tool_contract)} ≠ src/mcp/registry.ts TOOL_CONTRACT ${String(reg.value)}`,
      );
    }
    const exp = readExpectedTools(root);
    if (!exp.found)
      notes.push(
        "tests/smoke/expected-tools.json not found — tool names checked against the manifest only",
      );
    else if (exp.error || !exp.tools)
      errors.push(`tests/smoke/expected-tools.json: ${exp.error ?? "unreadable"}`);
    else {
      const a = new Set(exp.tools);
      const missing = manifest.tools.filter((t) => !a.has(t));
      const extra = exp.tools.filter((t) => !manifest?.tools.includes(t));
      if (missing.length || extra.length) {
        errors.push(
          `manifest tools ≠ tests/smoke/expected-tools.json core list (missing there: ${missing.join(", ") || "none"}; not in manifest: ${extra.join(", ") || "none"})`,
        );
      }
    }
  }

  const listed = listSkillDirs(skillsRoot);
  errors.push(...listed.errors);
  if (manifest) {
    const missing = manifest.skills.filter((s) => !listed.skills.includes(s));
    const extra = listed.skills.filter((s) => !manifest?.skills.includes(s));
    if (missing.length)
      errors.push(`manifest.skills lists Skills with no directory: ${missing.join(", ")}`);
    if (extra.length) errors.push(`Skill directories not in manifest.skills: ${extra.join(", ")}`);
  }

  /** @type {TriggerSkill[]} */
  const triggerSkills = [];
  for (const skill of listed.skills) {
    const dir = path.join(skillsRoot, skill);
    const rel = `skills/${skill}`;
    const skillRule = SKILL_RULES[skill];
    const text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    /** @type {import("./_lib.mjs").Frontmatter | null} */
    let fm = null;
    try {
      fm = parseFrontmatter(text);
    } catch (e) {
      errors.push(`${rel}/SKILL.md: ${errMsg(e)}`);
    }
    const lines = text.split("\n");
    const body = fm ? lines.slice(fm.bodyStart).join("\n") : text;
    let whenToUse = "";
    if (fm) whenToUse = checkFrontmatter(fm.data, { skill, rel, version, manifest, errors });

    // body (plan 09 §5.1 item 2)
    const bodyLines = fm ? lines.length - fm.bodyStart : lines.length;
    if (bodyLines > BODY_MAX_LINES)
      errors.push(
        `${rel}/SKILL.md: body is ${String(bodyLines)} lines (max ${String(BODY_MAX_LINES)})`,
      );
    if (rule && !body.includes(rule))
      errors.push(
        `${rel}/SKILL.md: the plan 02 §6.3 untrusted-text rule is not in the body verbatim`,
      );
    for (const b of REQUIRED_BLOCKS) {
      if (!body.includes(beginMarker(b)))
        errors.push(`${rel}/SKILL.md: the generated block from _shared/references/${b} is missing`);
    }
    for (const h of OUTPUT_HEADINGS) {
      const re = new RegExp(`^#{2,4} ${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
      if (!re.test(body)) errors.push(`${rel}/SKILL.md: output-contract heading "${h}" is missing`);
    }
    if (!body.includes("ff_record_recommendation"))
      errors.push(`${rel}/SKILL.md: no ff_record_recommendation step (log discipline)`);
    for (const re of skillRule?.body ?? []) {
      if (!re.test(body))
        errors.push(`${rel}/SKILL.md: body must mention ${String(re)} (plan 09 §3 Lane 1)`);
    }

    // files: size, symlinks, links, tool references
    const { files, links } = walkFiles(dir, root);
    for (const l of links) errors.push(`${l}: symlinks are not allowed in a Skill`);
    for (const f of files) {
      const abs = path.join(root, f);
      if (statSync(abs).size > FILE_MAX_BYTES) errors.push(`${f}: larger than 200 KB`);
      if (!f.endsWith(".md")) continue;
      const md = readFileSync(abs, "utf8");
      const scanned = f === `${rel}/SKILL.md` ? body : md;
      const inRefs = f.startsWith(`${rel}/references/`);
      for (const target of localLinks(scanned)) {
        const clean = safeDecode(target.split("#")[0] ?? "");
        const resolved = path.resolve(path.dirname(abs), clean);
        const relToSkill = path.relative(dir, resolved).split(path.sep).join("/");
        if (relToSkill.startsWith("..") || path.isAbsolute(relToSkill)) {
          errors.push(
            `${f}: link "${target}" leaves the Skill directory (a Skill must be self-contained)`,
          );
        } else if (!existsSync(resolved)) {
          errors.push(`${f}: link "${target}" points to a missing file`);
        } else if (inRefs && clean !== "") {
          errors.push(
            `${f}: references must not link to other files (one level deep): "${target}"`,
          );
        } else if (relToSkill.startsWith("references/") && relToSkill.split("/").length > 2) {
          errors.push(`${f}: link "${target}" is more than one level deep`);
        }
      }
      if (manifest) checkToolRefs(scanned, f, skill, manifest, errors);
    }

    // evals
    /** @param {string} name */
    const readEval = (name) => {
      const p = path.join(dir, "evals", name);
      if (!existsSync(p)) {
        errors.push(`${rel}/evals/${name}: missing`);
        return undefined;
      }
      try {
        return /** @type {unknown} */ (JSON.parse(readFileSync(p, "utf8")));
      } catch (e) {
        errors.push(`${rel}/evals/${name}: invalid JSON: ${errMsg(e)}`);
        return undefined;
      }
    };
    const seq = readEval("tool_sequence.json");
    if (seq !== undefined && manifest) {
      errors.push(
        ...validateToolSequence(seq, {
          skill,
          where: `${rel}/evals/tool_sequence.json`,
          tools: manifest.tools,
          writeTools: manifest.write_tools,
          toolContract: manifest.tool_contract,
          errorCodes,
          ...(skillRule ? { rule: skillRule } : {}),
        }).errors,
      );
    }
    const cases = readEval("cases.json");
    if (cases !== undefined && manifest) {
      errors.push(
        ...validateCases(cases, {
          skill,
          where: `${rel}/evals/cases.json`,
          tools: manifest.tools,
          ...(skillRule ? { rule: skillRule } : {}),
        }),
      );
    }
    const trig = readEval("trigger_eval.json");
    if (trig !== undefined) {
      const v = validateTriggers(trig, `${rel}/evals/trigger_eval.json`);
      errors.push(...v.errors);
      triggerSkills.push({ name: skill, whenToUse, triggers: v.triggers });
    }
  }
  errors.push(...triggerCollisions(triggerSkills));

  // every file under skills/: size + the secret/identifier scanner (plan 09 §5.1 item 6)
  const all = walkFiles(skillsRoot, root);
  for (const l of all.links)
    if (!errors.some((e) => e.startsWith(l)))
      errors.push(`${l}: symlinks are not allowed under skills/`);
  for (const f of all.files) {
    if (
      statSync(path.join(root, f)).size > FILE_MAX_BYTES &&
      !errors.some((e) => e.startsWith(f))
    ) {
      errors.push(`${f}: larger than 200 KB`);
    }
  }
  if (opts.scan !== false) errors.push(...scanSecrets(root, all.files, opts.scanEnv));
  return { errors, notes, skills: listed.skills };
}

/**
 * Frontmatter rules (plan 09 §2, §5.1 item 1; research 06 §A.4). Returns `when_to_use`.
 * @param {Record<string, import("./_lib.mjs").FmValue>} data
 * @param {{ skill: string, rel: string, version: string | null,
 *   manifest: import("./_lib.mjs").Manifest | null, errors: string[] }} ctx
 * @returns {string}
 */
export function checkFrontmatter(data, ctx) {
  const { skill, errors } = ctx;
  const f = `${ctx.rel}/SKILL.md`;
  for (const k of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER.includes(k)) errors.push(`${f}: unknown frontmatter key \`${k}\``);
  }
  const name = data["name"];
  if (name !== skill)
    errors.push(`${f}: name "${String(name)}" must equal the directory name "${skill}"`);
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    errors.push(`${f}: name must be lowercase letters, digits and hyphens, ≤ 64 chars`);
  } else if (/anthropic|claude/.test(name))
    errors.push(`${f}: name may not contain a reserved word`);
  const d = data["description"];
  if (typeof d !== "string" || d.trim() === "") errors.push(`${f}: description is required`);
  else {
    if (d.length > DESCRIPTION_HARD_MAX)
      errors.push(
        `${f}: description is ${String(d.length)} chars (platform max ${String(DESCRIPTION_HARD_MAX)})`,
      );
    else if (d.length > DESCRIPTION_MAX)
      errors.push(
        `${f}: description is ${String(d.length)} chars (plan 09 cap ${String(DESCRIPTION_MAX)})`,
      );
    if (/<\/?[A-Za-z]/.test(d)) errors.push(`${f}: description may not contain XML tags`);
    if (/\b(?:I|I'm|me|my|mine|we|our|us|you|your|yours)\b/i.test(d)) {
      errors.push(`${f}: description must be third person (no I/me/my/we/our/you/your)`);
    }
  }
  const w = data["when_to_use"];
  let whenToUse = "";
  if (typeof w !== "string" || w.trim() === "")
    errors.push(`${f}: when_to_use is required (the trigger phrases)`);
  else {
    whenToUse = w;
    if (typeof d === "string" && d.length + w.length > LISTING_MAX) {
      errors.push(
        `${f}: description + when_to_use is ${String(d.length + w.length)} chars (max ${String(LISTING_MAX)})`,
      );
    }
  }
  const meta = data["metadata"];
  if (!isRecord(meta)) errors.push(`${f}: metadata { version, tool_contract } is required`);
  else {
    if (ctx.version !== null && meta["version"] !== ctx.version) {
      errors.push(
        `${f}: metadata.version ${String(meta["version"])} ≠ package.json ${ctx.version}`,
      );
    }
    if (ctx.manifest && meta["tool_contract"] !== ctx.manifest.tool_contract) {
      errors.push(
        `${f}: metadata.tool_contract ${String(meta["tool_contract"])} ≠ manifest ${String(ctx.manifest.tool_contract)}`,
      );
    }
  }
  const dis = data["disallowed-tools"];
  if (skill === "apply") {
    if (data["disable-model-invocation"] !== true)
      errors.push(`${f}: apply must set disable-model-invocation: true (plan 09 K3)`);
  } else if (ctx.manifest) {
    const list = Array.isArray(dis) ? dis : [];
    if (dis !== undefined && !Array.isArray(dis))
      errors.push(`${f}: disallowed-tools must be a list`);
    for (const t of ctx.manifest.disallowed_tools) {
      if (!list.includes(t)) errors.push(`${f}: disallowed-tools must list ${t} (plan 09 K3)`);
    }
  }
  return whenToUse;
}

/**
 * Tool-name rules over one Markdown text (plan 09 §5.1 items 3–4).
 * @param {string} text
 * @param {string} file
 * @param {string} skill
 * @param {import("./_lib.mjs").Manifest} manifest
 * @param {string[]} errors
 */
export function checkToolRefs(text, file, skill, manifest, errors) {
  /** @type {Set<string>} */
  const reported = new Set();
  for (const r of toolRefs(text)) {
    const key = `${r.server ?? ""}:${r.tool}:${String(r.wildcard)}`;
    if (reported.has(key)) continue;
    reported.add(key);
    if (r.server !== null && r.server !== manifest.server) {
      errors.push(
        `${file}: tool reference "${r.server}:${r.tool}" must use the server name "${manifest.server}"`,
      );
    }
    if (r.wildcard) {
      if (!r.tool.endsWith("_"))
        errors.push(`${file}: wildcard "${r.tool}*" must end at a name segment`);
      continue;
    }
    if (manifest.tools.includes(r.tool)) continue;
    if (manifest.write_tools.includes(r.tool)) {
      if (skill !== "apply")
        errors.push(
          `${file}: names the write tool ${r.tool} — only the apply Skill may (plan 09 K3)`,
        );
      continue;
    }
    errors.push(`${file}: ${r.tool} is not a Phase-1a tool`);
  }
}

/**
 * Run scripts/dev/scan-secrets.mjs over the given files (repository-relative paths).
 * @param {string} root
 * @param {string[]} files
 * @param {Record<string, string>} [env]
 * @returns {string[]}
 */
export function scanSecrets(root, files, env) {
  const scanner = path.join(root, "scripts", "dev", "scan-secrets.mjs");
  if (!existsSync(scanner)) return ["scripts/dev/scan-secrets.mjs not found — cannot scan skills/"];
  if (files.length === 0) return [];
  try {
    execFileSync(process.execPath, [scanner, "--", ...files], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
      maxBuffer: 16 * 1024 * 1024,
    });
    return [];
  } catch (e) {
    const err = /** @type {{ status?: number, stderr?: string }} */ (e);
    const lines = String(err.stderr ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("scan-secrets:"));
    return [
      `scan-secrets: exit ${String(err.status ?? "?")} over skills/`,
      ...lines.map((l) => `scan-secrets: ${l}`),
    ];
  }
}

/**
 * CLI entry.
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  /** @type {string | undefined} */
  let root;
  let scan = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && argv[i + 1] !== undefined) root = path.resolve(argv[++i] ?? "");
    else if (a === "--no-scan") scan = false;
    else {
      process.stderr.write(
        `check-skills: unexpected argument ${String(a)}\nusage: check-skills.mjs [--root <dir>] [--no-scan]\n`,
      );
      return 2;
    }
  }
  const r = checkSkills({ ...(root ? { root } : {}), scan });
  for (const n of r.notes) process.stdout.write(`check-skills: note: ${n}\n`);
  if (r.errors.length) {
    process.stderr.write(`check-skills: ${String(r.errors.length)} problem(s):\n`);
    for (const e of r.errors) process.stderr.write(`  ${e}\n`);
    return 1;
  }
  process.stdout.write(
    `check-skills: OK — ${String(r.skills.length)} Skill(s): ${r.skills.join(", ")}\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
