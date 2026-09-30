// boundaries.test.ts — proves the lint gate can FAIL (docs/plan/10 §3.0 Z3; plan 04 A-5, §3): the
// plan 01 §1.1 layer table, the child_process/eval bans (plan 02 §7) and stdout discipline (plan 01
// §2), linted with the real eslint.config.js through the ESLint API on virtual files.
import path from "node:path";
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boundaryZones, layerOf } from "../../eslint.config.js";
import { ROOT, tempDir, writeTree } from "./helpers.js";

// Virtual files have no tsconfig program; boundary rules need no type information.
const noTypes: Linter.Config[] = [
  tseslint.configs.disableTypeChecked,
  { languageOptions: { parserOptions: { projectService: false, project: null } } },
];

const eslint = new ESLint({ cwd: ROOT, overrideConfig: noTypes });

async function lint(rel: string, code: string): Promise<Linter.LintMessage[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, rel) });
  if (!result) throw new Error("no lint result");
  return result.messages;
}

const rules = (msgs: Linter.LintMessage[]): (string | null)[] => msgs.map((m) => m.ruleId);

const BOUNDARY_RULES = new Set([
  "ff/layer-boundaries",
  "import-x/no-restricted-paths",
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-properties",
  "no-restricted-syntax",
  "no-console",
  "no-eval",
  "no-new-func",
]);
const boundaryHits = (msgs: Linter.LintMessage[]) =>
  msgs.filter((m) => m.ruleId === null || BOUNDARY_RULES.has(m.ruleId));

describe("Z3: a src/domain file importing the store fails lint", () => {
  it("fails on `import … from '../store/x.js'` and names the layer rule", async () => {
    const msgs = await lint(
      "src/domain/probe.ts",
      `import { x } from "../store/x.js";\nexport const y = x;\n`,
    );
    expect(msgs.filter((m) => m.severity === 2).length).toBeGreaterThan(0);
    expect(rules(msgs)).toContain("ff/layer-boundaries");
  });

  it("passes on a legal import (domain -> domain, domain -> root)", async () => {
    const msgs = await lint(
      "src/domain/probe.ts",
      `import { x } from "./league/model.js";\nimport { VERSION } from "../version.js";\nexport const y = [x, VERSION];\n`,
    );
    expect(boundaryHits(msgs)).toEqual([]);
  });
});

describe("layer table (plan 01 §1.1), every import form", () => {
  const illegal: [string, string][] = [
    [
      "src/domain/league/probe.ts",
      `import { x } from "../../store/repos/x.js"; export const y = x;`,
    ],
    ["src/domain/probe.ts", `import { x } from "../mcp/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../providers/yahoo/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../sources/nflverse/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../auth/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../http/client.js"; export const y = x;`],
    ["src/domain/probe.ts", `export * from "../store/x.js";`],
    ["src/domain/probe.ts", `export { x } from "../store/x.js";`],
    ["src/domain/probe.ts", `import type { T } from "../store/x.js"; export type U = T;`],
    ["src/domain/probe.ts", `export type U = import("../store/x.js").T;`],
    ["src/domain/probe.ts", `export const m = () => import("../store/x.js");`],
    ["src/domain/probe.ts", `import "../store/x.js";`],
    ["src/mcp/probe.ts", `import { x } from "../store/db.js"; export const y = x;`],
    ["src/mcp/tools/probe.ts", `import { x } from "../../store/db.js"; export const y = x;`],
    ["src/providers/yahoo/probe.ts", `import { x } from "../../mcp/x.js"; export const y = x;`],
    ["src/sources/nflverse/probe.ts", `import { x } from "../../mcp/x.js"; export const y = x;`],
    [
      "src/sources/nflverse/probe.ts",
      `import { x } from "../../providers/x.js"; export const y = x;`,
    ],
    ["src/store/probe.ts", `import { x } from "../mcp/x.js"; export const y = x;`],
    ["src/store/probe.ts", `import { x } from "../sources/x.js"; export const y = x;`],
    ["src/auth/probe.ts", `import { x } from "../domain/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../cli/log.js"; export const y = x;`],
    ["src/version.ts", `import { x } from "./cli/log.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../cli.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../../tests/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../../fixtures/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "../domain/../store/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "#store/x.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { x } from "/abs/src/store/x.js"; export const y = x;`],
  ];
  it.each(illegal)("%s: %s -> ff/layer-boundaries", async (file, code) => {
    expect(rules(await lint(file, code))).toContain("ff/layer-boundaries");
  });

  const legal: [string, string][] = [
    ["src/mcp/probe.ts", `import { x } from "../domain/x.js"; export const y = x;`],
    ["src/mcp/probe.ts", `import { x } from "../providers/platform.js"; export const y = x;`],
    ["src/store/probe.ts", `import type { T } from "../domain/x.js"; export type U = T;`],
    ["src/cli.ts", `import { x } from "./cli/serve.js"; export const y = x;`],
    ["src/cli/serve.ts", `import { x } from "../mcp/server.js"; export const y = x;`],
    ["src/providers/yahoo/probe.ts", `import { x } from "../platform.js"; export const y = x;`],
    ["src/domain/probe.ts", `import { z } from "zod"; export const y = z;`],
    ["tests/domain/probe.test.ts", `import { x } from "../../src/store/x.js"; export const y = x;`],
  ];
  it.each(legal)("%s: %s -> no boundary error", async (file, code) => {
    expect(boundaryHits(await lint(file, code))).toEqual([]);
  });
});

describe("module bans per layer", () => {
  const cases: [string, string, string][] = [
    [
      "src/domain/probe.ts",
      `import { readFileSync } from "node:fs"; export const r = readFileSync;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { readFile } from "fs/promises"; export const r = readFile;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { DatabaseSync } from "node:sqlite"; export const d = DatabaseSync;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { request } from "node:https"; export const r = request;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import { McpServer } from "@modelcontextprotocol/server"; export const s = McpServer;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `import type { X } from "@modelcontextprotocol/core/types"; export type Y = X;`,
      "no-restricted-imports",
    ],
    [
      "src/domain/probe.ts",
      `export const f = () => fetch("https://example.com");`,
      "no-restricted-globals",
    ],
    [
      "src/mcp/probe.ts",
      `import { writeFileSync } from "node:fs"; export const w = writeFileSync;`,
      "no-restricted-imports",
    ],
    [
      "src/mcp/probe.ts",
      `export const f = () => globalThis.fetch("https://example.com");`,
      "no-restricted-properties",
    ],
    [
      "src/mcp/probe.ts",
      `export const w = () => process.stdout.write("x");`,
      "no-restricted-properties",
    ],
    ["src/domain/probe.ts", `console.log("x");`, "no-console"],
    ["src/store/probe.ts", `console.error("x");`, "no-console"],
  ];
  it.each(cases)("%s: %s -> %s", async (file, code, rule) => {
    expect(rules(await lint(file, code))).toContain(rule);
  });

  it("allows console and process.stdout in the CLI layer and in tests", async () => {
    expect(
      boundaryHits(await lint("src/cli/probe.ts", `console.log("x"); process.stdout.write("y");`)),
    ).toEqual([]);
    expect(boundaryHits(await lint("src/cli.ts", `console.log("x");`))).toEqual([]);
    expect(boundaryHits(await lint("tests/probe.test.ts", `console.log("x");`))).toEqual([]);
  });

  it("allows fs in the store and sources layers", async () => {
    const code = `import { readFileSync } from "node:fs"; export const r = readFileSync;`;
    expect(boundaryHits(await lint("src/store/probe.ts", code))).toEqual([]);
    expect(boundaryHits(await lint("src/sources/probe.ts", code))).toEqual([]);
  });
});

describe("child_process / eval bans apply everywhere, including the CLI and scripts", () => {
  const banned: [string, string][] = [
    [`import { exec } from "node:child_process"; export const e = exec;`, "no-restricted-imports"],
    [
      `import { execSync as run } from "child_process"; export const e = run;`,
      "no-restricted-imports",
    ],
    [`import * as cp from "node:child_process"; export const e = cp;`, "no-restricted-syntax"],
    [`import cp from "child_process"; export const e = cp;`, "no-restricted-syntax"],
    [`export const m = () => import("node:child_process");`, "no-restricted-syntax"],
    [`declare const cp: { execSync(c: string): void }; cp.execSync("ls");`, "no-restricted-syntax"],
    [`declare function exec(c: string): void; exec("ls");`, "no-restricted-syntax"],
    [
      `import { spawn } from "node:child_process"; spawn("ls", [], { shell: true });`,
      "no-restricted-syntax",
    ],
    [
      `import { spawn } from "node:child_process"; spawn("ls", [], { shell: "/bin/sh" });`,
      "no-restricted-syntax",
    ],
    [`export const v = eval("1 + 1");`, "no-eval"],
    [`export const f = new Function("return 1");`, "no-new-func"],
    [
      `import { runInThisContext } from "node:vm"; export const r = runInThisContext;`,
      "no-restricted-imports",
    ],
  ];
  for (const file of ["src/cli/probe.ts", "src/sources/probe.ts", "scripts/probe.mjs"]) {
    it.each(banned)(`${file}: %s -> %s`, async (code, rule) => {
      // type-only syntax cannot appear in a .mjs file
      if (file.endsWith(".mjs") && /declare |: \{/.test(code)) return;
      expect(rules(await lint(file, code))).toContain(rule);
    });
  }

  it("allows argument-array execFile/spawn with shell: false", async () => {
    const code = `import { execFile, spawn } from "node:child_process";\nexecFile("ls", ["-l"], () => undefined);\nspawn("ls", ["-l"], { shell: false });\n`;
    expect(boundaryHits(await lint("src/cli/probe.ts", code))).toEqual([]);
  });
});

describe("layerOf", () => {
  it.each([
    ["src/domain/x.ts", "domain"],
    ["src/cli.ts", "cli-entry"],
    ["src/cli/x.ts", "cli"],
    ["src/version.ts", "root"],
    ["tests/x.ts", null],
    ["srcx/y.ts", null],
    ["../src/domain/x.ts", null],
  ])("%s -> %s", (rel, layer) => {
    expect(layerOf(rel)).toBe(layer);
  });
});

// import-x/no-restricted-paths resolves through the filesystem, so it is exercised on a real
// temporary tree with the same zone table; it also pins WHY the lexical rule exists.
describe("import-x/no-restricted-paths on a real tree (same zone table)", () => {
  let tmp: { dir: string; cleanup: () => void };
  let linter: ESLint;
  beforeAll(() => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "src/store/x.ts": "export const x = 1;\n",
      "src/domain/league/model.ts": "export const m = 1;\n",
      "src/version.ts": 'export const VERSION = "0.0.0";\n',
    });
    linter = new ESLint({
      cwd: tmp.dir,
      overrideConfigFile: path.join(ROOT, "eslint.config.js"),
      overrideConfig: [
        ...noTypes,
        {
          files: ["**/*.ts"],
          rules: {
            "import-x/no-restricted-paths": [
              "error",
              { basePath: tmp.dir, zones: boundaryZones() },
            ],
            "ff/layer-boundaries": ["error", { root: tmp.dir }],
          },
        },
      ],
    });
  });
  afterAll(() => {
    tmp.cleanup();
  });

  const lintTmp = async (code: string) => {
    const [r] = await linter.lintText(code, {
      filePath: path.join(tmp.dir, "src/domain/probe.ts"),
    });
    return rules(r?.messages ?? []);
  };

  it("fires on a domain -> store import whose .js specifier resolves to a .ts file", async () => {
    const hit = await lintTmp(`import { x } from "../store/x.js";\nexport const y = x;\n`);
    expect(hit).toContain("import-x/no-restricted-paths");
    expect(hit).toContain("ff/layer-boundaries");
  });

  it("stays quiet on legal imports", async () => {
    const hit = await lintTmp(
      `import { m } from "./league/model.js";\nimport { VERSION } from "../version.js";\nexport const y = [m, VERSION];\n`,
    );
    expect(hit).not.toContain("import-x/no-restricted-paths");
    expect(hit).not.toContain("ff/layer-boundaries");
  });

  it("silently skips an unresolvable target — the lexical rule still fires", async () => {
    const hit = await lintTmp(`import { x } from "../store/missing.js";\nexport const y = x;\n`);
    expect(hit).not.toContain("import-x/no-restricted-paths");
    expect(hit).toContain("ff/layer-boundaries");
  });

  it("zone table mirrors FORBIDDEN_LAYERS (every zone has targets and sources)", () => {
    for (const z of boundaryZones()) {
      expect(z.target.length).toBeGreaterThan(0);
      expect(z.from.length).toBeGreaterThan(0);
      expect(z.from.every((f) => f.startsWith("./src/"))).toBe(true);
    }
  });
});
