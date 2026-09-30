// @ts-check
// check-coverage.mjs — independent re-check of the coverage gate from coverage/coverage-summary.json
// (docs/plan/05 §7, plan 04 §4.1 `test`). Global thresholds and the per-file 100 % modules come from
// scripts/ci/coverage-gate.json — the same file vitest.config.ts reads. A summary with zero lines is
// a failure (a gate over nothing is vacuous). Writes a table to $GITHUB_STEP_SUMMARY when set.
// Node built-ins only.
//
// Usage: node scripts/ci/check-coverage.mjs [--summary <file>] [--gate <file>] [--root <dir>]
import { appendFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, isMain, isRecord, parseArgs, readJson, reporter } from "./_lib.mjs";

export const METRICS = /** @type {const} */ (["lines", "branches", "functions", "statements"]);

/**
 * @typedef {{ lines: number, branches: number, functions: number, statements: number }} Thresholds
 * @typedef {{ global: Thresholds, perFile100: string[] }} Gate
 * @typedef {{ total: number, covered: number, pct: number }} Metric
 */

/**
 * Minimal glob -> RegExp: `**` any depth, `*` one segment, everything else literal.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? "";
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * @param {unknown} raw
 * @returns {Gate}
 */
export function parseGate(raw) {
  if (!isRecord(raw) || !isRecord(raw.global) || !Array.isArray(raw.perFile100)) {
    throw new Error("coverage gate must have `global` and `perFile100`");
  }
  const g = raw.global;
  /** @type {Record<string, number>} */
  const t = {};
  for (const m of METRICS) {
    const v = g[m];
    if (typeof v !== "number" || !(v >= 0 && v <= 100)) {
      throw new Error(`coverage gate global.${m} must be a number in [0, 100]`);
    }
    t[m] = v;
  }
  const globs = raw.perFile100.filter((x) => typeof x === "string");
  if (globs.length !== raw.perFile100.length) throw new Error("perFile100 must be strings");
  return {
    global: {
      lines: t.lines ?? 0,
      branches: t.branches ?? 0,
      functions: t.functions ?? 0,
      statements: t.statements ?? 0,
    },
    perFile100: globs,
  };
}

/**
 * @param {unknown} m
 * @param {string} where
 * @returns {Metric}
 */
function metric(m, where) {
  if (!isRecord(m) || typeof m.total !== "number" || typeof m.covered !== "number") {
    throw new Error(`malformed coverage metric at ${where}`);
  }
  if (!(m.total >= 0) || !(m.covered >= 0) || m.covered > m.total) {
    throw new Error(`impossible coverage numbers at ${where}`);
  }
  // recompute rather than trust `pct` (v8 reports 100 for an empty total, and "Unknown" is possible)
  const pct = m.total === 0 ? 100 : (m.covered / m.total) * 100;
  return { total: m.total, covered: m.covered, pct };
}

/**
 * @param {unknown} summary parsed coverage-summary.json
 * @param {Gate} gate
 * @param {string} root absolute repo root, to relativise file keys
 * @returns {{ errors: string[], rows: string[] }}
 */
export function evaluate(summary, gate, root) {
  if (!isRecord(summary) || !isRecord(summary.total)) {
    throw new Error("coverage summary has no `total` entry");
  }
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const rows = [];
  const total = summary.total;
  const lines = metric(total.lines, "total.lines");
  if (lines.total === 0)
    errors.push("coverage summary covers zero lines — the gate would be vacuous");
  for (const m of METRICS) {
    const got = metric(total[m], `total.${m}`);
    const need = gate.global[m];
    const ok = got.pct + 1e-9 >= need;
    rows.push(
      `| total | ${m} | ${got.pct.toFixed(2)} % | ${String(need)} % | ${ok ? "ok" : "FAIL"} |`,
    );
    if (!ok) errors.push(`global ${m} ${got.pct.toFixed(2)} % < ${String(need)} %`);
  }
  const res = gate.perFile100.map(globToRegExp);
  for (const [file, entry] of Object.entries(summary)) {
    if (file === "total") continue;
    const rel = path.isAbsolute(file) ? path.relative(root, file).split(path.sep).join("/") : file;
    if (!res.some((re) => re.test(rel))) continue;
    if (!isRecord(entry)) throw new Error(`malformed coverage entry for ${rel}`);
    for (const m of /** @type {const} */ (["lines", "branches"])) {
      const got = metric(entry[m], `${rel}.${m}`);
      const ok = got.covered === got.total;
      rows.push(`| ${rel} | ${m} | ${got.pct.toFixed(2)} % | 100 % | ${ok ? "ok" : "FAIL"} |`);
      if (!ok)
        errors.push(`${rel} ${m} ${got.pct.toFixed(2)} % — this module must be 100 % (plan 05 §7)`);
    }
  }
  return { errors, rows };
}

/**
 * @param {{ summary: string, gate: string, root: string }} opts
 * @returns {number} exit code
 */
export function main(opts) {
  const r = reporter("check-coverage");
  const gate = parseGate(readJson(opts.gate));
  const { errors, rows } = evaluate(readJson(opts.summary), gate, opts.root);
  errors.forEach(r.error);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    const table = [
      "### Coverage gate (plan 05 §7)",
      "",
      "| file | metric | actual | gate | |",
      "|---|---|---|---|---|",
      ...rows,
      "",
    ];
    appendFileSync(stepSummary, `${table.join("\n")}\n`);
  }
  return r.finish(`${String(rows.length)} threshold(s) met`);
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const root = typeof args.root === "string" ? path.resolve(args.root) : REPO_ROOT;
  try {
    process.exitCode = main({
      root,
      summary:
        typeof args.summary === "string"
          ? path.resolve(args.summary)
          : path.join(root, "coverage", "coverage-summary.json"),
      gate:
        typeof args.gate === "string"
          ? path.resolve(args.gate)
          : path.join(REPO_ROOT, "scripts", "ci", "coverage-gate.json"),
    });
  } catch (e) {
    process.stderr.write(`check-coverage: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}
