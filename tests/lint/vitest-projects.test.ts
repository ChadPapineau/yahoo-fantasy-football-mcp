// vitest-projects.test.ts — the unit/process partition of vitest.config.ts (plan 05 §1, §4.2, §7):
// every test file runs in exactly one project, and the wall-clock budgets (A4a's p95 < 300 ms under a
// 3-s writer lock, A15's analytics share) run in `process`, never in `unit`, which runs under
// coverage (gate round 1: tests/store/contention.test.ts failed p95 at 426–458 ms there, on load).
import { globSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import config, { PROCESS_TESTS, UNIT_TEST_TIMEOUT_MS } from "../../vitest.config.js";
import { ROOT } from "./helpers.js";

interface ProjectTest {
  name: string;
  include: string[];
  exclude?: string[];
  testTimeout?: number;
  fileParallelism?: boolean;
}
const projects = (config.test?.projects ?? []) as { test: ProjectTest }[];
const project = (name: string): ProjectTest => {
  const p = projects.find((x) => x.test.name === name)?.test;
  if (p === undefined) throw new Error(`no ${name} project`);
  return p;
};
const unit = project("unit");
const proc = project("process");

const matches = (file: string, globs: readonly string[]): boolean =>
  globs.some((g) => path.matchesGlob(file, g));
const runsIn = (file: string, p: ProjectTest): boolean =>
  matches(file, p.include) && !matches(file, p.exclude ?? []);
const where = (file: string): string[] =>
  [unit, proc].filter((p) => runsIn(file, p)).map((p) => p.name);

const ALL = globSync("tests/**/*.test.ts", { cwd: ROOT })
  .filter((f) => !f.includes("node_modules"))
  .map((f) => f.split(path.sep).join("/"));

describe("vitest projects partition the test files", () => {
  it("finds the suite (a vacuous glob would pass everything below)", () => {
    expect(ALL.length).toBeGreaterThan(50);
    expect(ALL).toContain("tests/store/contention.perf.test.ts");
  });

  it("every test file runs in exactly one project — none twice, none silently nowhere", () => {
    const wrong = ALL.map((f) => [f, where(f)] as const).filter(([, w]) => w.length !== 1);
    expect(wrong).toEqual([]);
  });

  it("the unit project excludes exactly the process globs", () => {
    for (const g of PROCESS_TESTS) expect(unit.exclude ?? []).toContain(g);
    expect(proc.include).toEqual(PROCESS_TESTS);
  });

  it("wall-clock budgets run in `process`, never under coverage", () => {
    for (const f of [
      "tests/store/contention.perf.test.ts", // A4a p95 < 300 ms under a 3-s foreign writer lock
      "tests/domain/analytics/perf.test.ts", // A15, ff_project_players 32 × 4000 < 3 s
      "tests/process/latency.test.ts", // A15, every P0 tool
    ])
      expect(where(f), f).toEqual(["process"]);
  });

  it("the naming rule, adversarially: *.perf.test.ts anywhere is a process test; look-alikes are not", () => {
    expect(where("tests/a/b/c/x.perf.test.ts")).toEqual(["process"]);
    expect(where("tests/x.perf.test.ts")).toEqual(["process"]);
    expect(where("tests/deep/perf.test.ts")).toEqual(["process"]);
    for (const f of [
      "tests/store/perfect.test.ts",
      "tests/store/superf.test.ts",
      "tests/store/perf.test.tsx",
      "tests/store/contention.test.ts",
      "tests/store/x.perf.spec.ts",
    ])
      expect(where(f), f).not.toEqual(["process"]);
  });

  it("the process project runs one file at a time with a timeout sized for spawned processes", () => {
    expect(proc.fileParallelism).toBe(false);
    expect(proc.testTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it("the unit hang detector sits above every in-test complexity bound, and still catches a hang", () => {
    // gate round 1: CPU-bound tests (1–1.6 s alone under coverage) hit vitest's 5 s default in the
    // loaded coverage run, and retrospective.test.ts's own "< 10 s" bound could never be what failed.
    // The largest in-test bound in `unit` is publish.test.ts's 25 000-row publish < 20 s.
    expect(unit.testTimeout).toBe(UNIT_TEST_TIMEOUT_MS);
    expect(UNIT_TEST_TIMEOUT_MS).toBeGreaterThan(20_000);
    expect(UNIT_TEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});
