#!/usr/bin/env node
/**
 * assert-report.mjs — asserts what a gitleaks JSON report contains. Zero dependencies (node:* only).
 *
 * Usage
 *   node scripts/gitleaks-selftest/assert-report.mjs <report.json> --expect-all <expected-rule-ids.txt>
 *       every rule id listed in the file (one per line, `#` comments allowed) must appear in the
 *       report at least once; extra findings (e.g. gitleaks' own generic rules) are printed, not failed
 *   node scripts/gitleaks-selftest/assert-report.mjs <report.json> --expect-none
 *       the report must be absent or empty
 *
 * A missing report file counts as zero findings (gitleaks writes no report when it found nothing).
 * Only RuleID / File / StartLine are printed — never Secret, Match or Line.
 *
 * Exit: 0 assertion holds · 1 assertion fails · 2 usage error
 */
import { readFile } from "node:fs/promises";
import process from "node:process";

const [reportPath, mode, listPath] = process.argv.slice(2);
if (!reportPath || !["--expect-all", "--expect-none"].includes(mode) || (mode === "--expect-all" && !listPath)) {
  console.error("usage: assert-report.mjs <report.json> (--expect-all <expected-rule-ids.txt> | --expect-none)");
  process.exit(2);
}

let findings = [];
try {
  const raw = (await readFile(reportPath, "utf8")).trim();
  findings = raw === "" ? [] : JSON.parse(raw);
  if (!Array.isArray(findings)) throw new Error("report is not a JSON array");
} catch (err) {
  if (err?.code !== "ENOENT") {
    console.error(`assert-report: cannot read ${reportPath}: ${err.message}`);
    process.exit(2);
  }
}

for (const f of findings) console.log(`finding: rule=${f.RuleID} file=${f.File} line=${f.StartLine}`);
const fired = new Set(findings.map((f) => f.RuleID));

if (mode === "--expect-none") {
  if (findings.length === 0) {
    console.log("assert-report: 0 findings, as required");
    process.exit(0);
  }
  console.log(`::error::assert-report: expected no findings, got ${findings.length} (${[...fired].join(", ")})`);
  process.exit(1);
}

const expected = (await readFile(listPath, "utf8"))
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean);
const missing = expected.filter((id) => !fired.has(id));
const extra = [...fired].filter((id) => !expected.includes(id));
console.log(`assert-report: expected ${expected.length} rule ids, fired ${expected.length - missing.length}/${expected.length}` + (extra.length ? `; also fired (not required): ${extra.join(", ")}` : ""));
if (missing.length) {
  console.log(`::error::assert-report: these rules did NOT fire on the fixture: ${missing.join(", ")}`);
  process.exit(1);
}
process.exit(0);
