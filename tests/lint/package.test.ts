// package.test.ts — scaffold invariants that must never silently drift: exact pins, the runtime
// allow-list, no accidental publish, .npmrc supply-chain settings, the version constant
// (docs/plan/04 §1, §2, R11; plan 02 S10; plan 10 §3.0 Z3).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHIPPED_DATA, classify } from "../../scripts/ci/scan-tarball.mjs";
import { VERSION } from "../../src/version.js";
import { ROOT } from "./helpers.js";

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  type?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Lock {
  lockfileVersion: number;
  packages: Record<string, { version?: string; dev?: boolean; devOptional?: boolean }>;
}

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const pkg = JSON.parse(read("package.json")) as Manifest;
const lock = JSON.parse(read("package-lock.json")) as Lock;
const EXACT = /^\d+\.\d+\.\d+$/;

describe("package.json", () => {
  it("is private, ESM, MIT, with the planned bin/engines/files", () => {
    expect(pkg.name).toBe("fantasy-football-mcp");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin).toEqual({ ff: "dist/cli.js" });
    expect(pkg.engines).toEqual({ node: ">=24.15" });
    // the crosswalk overrides file is runtime data (serve loads it): it ships (QA-1-093)
    expect(pkg.files).toEqual([
      "dist",
      "skills",
      "data/crosswalk/overrides.yaml",
      "README.md",
      "LICENSE",
      "CHANGELOG.md",
    ]);
    for (const f of SHIPPED_DATA) expect(classify(f, pkg.files ?? []), f).toBeNull();
  });

  it("pins every dependency to an exact version (no ^ ~ * x ranges, tags, urls)", () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, spec] of Object.entries(all)) {
      expect(spec, `${name}@${spec}`).toMatch(EXACT);
    }
  });

  it("has exactly the four planned runtime dependencies — never fast-xml-parser (Phase 1b)", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@modelcontextprotocol/server",
      "hyparquet",
      "yaml",
      "zod",
    ]);
    const everywhere = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(lock.packages),
    ];
    expect(everywhere.some((k) => k.includes("fast-xml-parser"))).toBe(false);
  });

  it("pins zod to the one version the SDK resolves (a single zod in the tree)", () => {
    const zods = Object.entries(lock.packages).filter(([k]) => /(^|\/)node_modules\/zod$/.test(k));
    expect(zods).toHaveLength(1);
    expect(zods[0]?.[1].version).toBe(pkg.dependencies?.zod);
  });

  it("the lockfile agrees with package.json for every direct dependency", () => {
    expect(lock.lockfileVersion).toBe(3);
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(spec);
    }
  });

  it("defines no lifecycle script that npm would run on install or pack", () => {
    const banned = [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepack",
      "postpack",
      "prepublishOnly",
      "prepublish",
    ];
    for (const s of banned) expect(pkg.scripts?.[s], s).toBeUndefined();
  });

  it("`npm test` and coverage run the unit project; process suites are their own script", () => {
    expect(pkg.scripts?.test).toBe("vitest run --project unit");
    expect(pkg.scripts?.["test:coverage"]).toBe("vitest run --project unit --coverage");
    expect(pkg.scripts?.["test:process"]).toBe("vitest run --project process");
    expect(pkg.scripts?.["check:skills"]).toContain("--check");
  });

  it("defines the scaffold scripts", () => {
    for (const s of [
      "build",
      "typecheck",
      "lint",
      "format",
      "format:check",
      "test",
      "test:coverage",
      "check:no-scripts",
      "check:licenses",
      "check:runtime-tree",
      "check:coverage",
      "pack:scan",
      "test:process",
      "smoke",
      "build:skills",
      "check:skills",
    ]) {
      expect(pkg.scripts?.[s], s).toBeTypeOf("string");
    }
  });
});

describe(".npmrc", () => {
  const settings = Object.fromEntries(
    read(".npmrc")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
  );
  it.each([
    ["save-exact", "true"],
    ["ignore-scripts", "true"],
    ["fund", "false"],
    ["audit", "true"],
    ["engine-strict", "true"],
  ])("%s=%s", (key, value) => {
    expect(settings[key]).toBe(value);
  });
  it("sets no registry override or auth token", () => {
    const text = read(".npmrc");
    expect(text).not.toMatch(/registry\s*=|_authToken|_auth\b|always-auth/i);
  });
});

describe("src/version.ts", () => {
  it("VERSION equals package.json version", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
