// ci-coverage.test.ts — scripts/ci/check-coverage.mjs must FAIL below the plan 05 §7 gate, on a
// per-file 100 % module below 100 %, and on a vacuous (zero-line) summary.
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, globToRegExp, parseGate } from "../../scripts/ci/check-coverage.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "./helpers.js";

const gate = parseGate(
  JSON.parse(readFileSync(path.join(ROOT, "scripts/ci/coverage-gate.json"), "utf8")),
);
const m = (covered: number, total: number) => ({
  covered,
  total,
  pct: total ? (covered / total) * 100 : 100,
});
const entry = (c: number, t: number) => ({
  lines: m(c, t),
  branches: m(c, t),
  functions: m(c, t),
  statements: m(c, t),
});
const summary = (files: Record<string, ReturnType<typeof entry>>, total = entry(100, 100)) => ({
  total,
  ...files,
});

describe("the committed gate is plan 05 §7", () => {
  it("global 90/85/90/90 and the seven 100 % modules", () => {
    expect(gate.global).toEqual({ lines: 90, branches: 85, functions: 90, statements: 90 });
    expect(gate.perFile100).toHaveLength(7);
    expect(gate.perFile100).toContain("src/domain/reclog/metrics.ts");
  });
});

describe("evaluate", () => {
  it("passes a summary at the gate", () => {
    expect(
      evaluate(
        summary(
          {},
          { lines: m(90, 100), branches: m(85, 100), functions: m(9, 10), statements: m(90, 100) },
        ),
        gate,
        ROOT,
      ).errors,
    ).toEqual([]);
  });
  it.each(["lines", "branches", "functions", "statements"] as const)(
    "fails when global %s is below",
    (metric) => {
      const total = entry(100, 100);
      total[metric] = m(80, 100);
      expect(evaluate(summary({}, total), gate, ROOT).errors.join()).toContain(`global ${metric}`);
    },
  );
  it("fails a per-file 100 % module at 99 %, keyed by absolute path", () => {
    const file = path.join(ROOT, "src/domain/scoring/engine.ts");
    const r = evaluate(summary({ [file]: entry(99, 100) }), gate, ROOT);
    expect(r.errors.join()).toContain("src/domain/scoring/engine.ts lines");
  });
  it("does not hold ordinary files to 100 %", () => {
    const file = path.join(ROOT, "src/domain/league/model.ts");
    expect(evaluate(summary({ [file]: entry(95, 100) }), gate, ROOT).errors).toEqual([]);
  });
  it("fails a zero-line summary as vacuous", () => {
    expect(evaluate(summary({}, entry(0, 0)), gate, ROOT).errors.join()).toContain("vacuous");
  });
  it("recomputes pct instead of trusting it", () => {
    const lying = { ...entry(100, 100), lines: { covered: 1, total: 100, pct: 100 } };
    expect(evaluate(summary({}, lying), gate, ROOT).errors.join()).toContain("global lines");
  });
  it.each([
    [null],
    [{}],
    [{ total: { lines: { covered: 5, total: 4 } } }],
    [{ total: { lines: { covered: -1, total: 4 } } }],
    [{ total: { lines: "x" } }],
  ])("throws on a malformed summary %j", (s) => {
    expect(() => evaluate(s, gate, ROOT)).toThrow();
  });
});

describe("parseGate", () => {
  it.each([
    [null],
    [{ global: {} }],
    [{ global: { lines: 101, branches: 1, functions: 1, statements: 1 }, perFile100: [] }],
    [{ global: { lines: 1, branches: 1, functions: 1, statements: 1 }, perFile100: [3] }],
  ])("rejects %j", (g) => {
    expect(() => parseGate(g)).toThrow();
  });
});

describe("globToRegExp", () => {
  it.each([
    ["src/domain/scoring/**", "src/domain/scoring/a/b.ts", true],
    ["src/domain/scoring/**", "src/domain/scoringx/a.ts", false],
    ["src/cli/log.ts", "src/cli/log.ts", true],
    ["src/cli/log.ts", "src/cli/logXts", false],
    ["src/*/x.ts", "src/a/x.ts", true],
    ["src/*/x.ts", "src/a/b/x.ts", false],
  ])("%s ~ %s -> %s", (glob, file, want) => {
    expect(globToRegExp(glob).test(file)).toBe(want);
  });
});

describe("check-coverage CLI", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const run = (s: unknown, env: Record<string, string> = {}) => {
    tmp = tempDir();
    writeTree(tmp.dir, { "summary.json": s as object });
    return runCheck("check-coverage.mjs", ["--summary", path.join(tmp.dir, "summary.json")], env);
  };

  it("exits 1 below the gate and writes the step summary", () => {
    const out = tempDir();
    try {
      const stepFile = path.join(out.dir, "step.md");
      const r = run(summary({}, entry(50, 100)), { GITHUB_STEP_SUMMARY: stepFile });
      expect(r.status).toBe(1);
      expect(readFileSync(stepFile, "utf8")).toContain("| total | lines | 50.00 % | 90 % | FAIL |");
    } finally {
      out.cleanup();
    }
  });
  it("exits 0 at 100 %", () => {
    expect(run(summary({})).status).toBe(0);
  });
  it("exits 2 when the summary file is missing", () => {
    expect(
      runCheck("check-coverage.mjs", ["--summary", "/nonexistent-ff/summary.json"]).status,
    ).toBe(2);
  });
});
