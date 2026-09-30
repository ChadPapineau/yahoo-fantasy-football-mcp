// vitest.config.ts — test runner + coverage gate. Implements docs/plan/05 §0 T1, §1 (the pyramid:
// tests/**) and §7 (coverage thresholds, read from scripts/ci/coverage-gate.json so vitest and
// scripts/ci/check-coverage.mjs can never disagree).
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

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    restoreMocks: true,
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
