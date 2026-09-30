// vitest.config.ts — test runner + coverage gate. Implements docs/plan/05 §0 T1, §1 (the pyramid:
// tests/**) and §7 (coverage thresholds, read from scripts/ci/coverage-gate.json so vitest and
// scripts/ci/check-coverage.mjs can never disagree). Two projects: `unit` (everything in-process —
// `npm test` / `npm run test:coverage`) and `process` (tests/process + tests/e2e: real child
// processes, the built dist/, wall-clock latency — `npm run test:process`, the CI `process` job,
// plan 05 §4.2). Child processes add no coverage, so the gate is measured on `unit` alone.
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

interface Gate {
  global: { lines: number; branches: number; functions: number; statements: number };
  perFile100: string[];
  exclude: string[];
}

const gate = JSON.parse(
  readFileSync(new URL("./scripts/ci/coverage-gate.json", import.meta.url), "utf8"),
) as Gate;

// The seven plan-05 modules must be 100 % lines + branches. A glob's aggregate reaching 100 %
// implies every file under it does; check-coverage.mjs re-checks per file from the summary.
const perFile = Object.fromEntries(gate.perFile100.map((g) => [g, { lines: 100, branches: 100 }]));

/**
 * The process-level suites (plan 05 §4.2): spawned servers, the built package, and the wall-clock
 * budgets — `perf.test.ts` (A15's analytics share) and any `*.perf.test.ts` (e.g. A4a's p95 < 300 ms
 * under a 3-s foreign writer lock, `tests/store/contention.perf.test.ts`). Coverage instrumentation
 * slows code ~3× and the parallel unit run adds load on top, so a budget measured there fails on
 * load, not on the code: a test asserting a latency budget is named `*.perf.test.ts` and runs here,
 * never under `test:coverage` (tests/lint/vitest-projects.test.ts holds the partition).
 */
export const PROCESS_TESTS = [
  "tests/process/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "tests/**/perf.test.ts",
  "tests/**/*.perf.test.ts",
];

/** The unit project's per-test hang detector (see the `unit` project below). */
export const UNIT_TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    restoreMocks: true,
    projects: [
      {
        extends: true,
        // `unit` is the run the gate instruments (`test:coverage`, ~3× slower) with every fork busy:
        // CPU-bound property/scale tests that take 1–1.6 s alone took 5–7 s there (load 22–45 on
        // 12 cores), past vitest's 5 s default. A timeout here is a hang detector, not a budget —
        // budgets are explicit assertions, and latency budgets live in `process` (above).
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [...PROCESS_TESTS, "**/node_modules/**"],
          testTimeout: UNIT_TEST_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        // one file at a time (wall-clock latency is measured here); every test spawns processes,
        // so the default 5 s per test is too short under load (tests/process/cli.test.ts)
        test: {
          name: "process",
          include: PROCESS_TESTS,
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: gate.exclude,
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
      thresholds: { ...gate.global, ...perFile },
    },
  },
});
