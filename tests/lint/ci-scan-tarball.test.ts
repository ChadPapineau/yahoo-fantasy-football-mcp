// ci-scan-tarball.test.ts — scripts/ci/scan-tarball.mjs must FAIL when the package would ship a
// fixture, a test, an env file, a database, a yaml outside skills/, or a league key outside the
// placeholder range (docs/plan/04 §4.1 `pack`, R8).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHIPPED_DATA, classify, packedPaths } from "../../scripts/ci/scan-tarball.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "./helpers.js";

const FILES = ["dist", "skills", "README.md", "LICENSE", "CHANGELOG.md"];

describe("classify", () => {
  it.each([
    "dist/cli.js",
    "dist/mcp/server.js.map",
    "skills/start-sit/SKILL.md",
    "skills/start-sit/resources/table.yaml",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "package.json",
  ])("allows %s", (f) => {
    expect(classify(f, FILES)).toBeNull();
  });
  it.each([
    ["dist/fixtures/yahoo/league.xml", "fixtures"],
    ["fixtures/manual/league.yaml", "fixtures"],
    ["dist/tests/x.test.js", "tests"],
    ["dist/.env", "env"],
    ["dist/.env.local", "env"],
    [".npmrc", ".npmrc"],
    ["dist/store.sqlite", "database"],
    ["dist/store.sqlite-wal", "database"],
    ["dist/cache.db", "database"],
    ["dist/league.yaml", "yaml"],
    ["dist/config.yml", "yaml"],
    ["dist/id.pem", "key"],
    ["dist/credentials.json", "credentials"],
    ["dist/yahoo-token.json", "token"],
    ["dist/oauth.json", "token"],
    ["src/cli.ts", "files"],
    ["docs/HANDOFF.md", "files"],
    ["distx/a.js", "files"],
    ["../etc/passwd", "escapes"],
    ["/etc/passwd", "escapes"],
    ["dist/inner.tgz", "tarball"],
  ])("rejects %s (%s)", (f, why) => {
    expect(classify(f, FILES) ?? "").toContain(why);
  });
});

describe("packedPaths", () => {
  it.each([[null], [[]], [[{}, {}]], [[{ files: "x" }]], [[{ files: [{ size: 1 }] }]]])(
    "rejects %j",
    (j) => {
      expect(() => packedPaths(j)).toThrow();
    },
  );
  it("lists paths", () => {
    expect(packedPaths([{ files: [{ path: "a" }, { path: "b" }] }])).toEqual(["a", "b"]);
  });
});

describe("scan-tarball CLI on a fake package", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const pkg = { name: "fake-pack", version: "1.0.0", files: ["dist"] };

  it("exits 1 when dist/ carries an env file and a fixture", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": pkg,
      "dist/index.js": "export {};\n",
      "dist/.env.local": "X=1\n",
      "dist/fixtures/a.json": "{}\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("dist/.env.local: env file");
    expect(r.stderr).toContain("dist/fixtures/a.json: fixtures never ship");
  });

  it("exits 1 when a packed file holds a league key outside the placeholder range", () => {
    tmp = tempDir();
    const key = ["461", "l", "98765"].join("."); // built at runtime: never a literal in the repo
    writeTree(tmp.dir, { "package.json": pkg, "dist/index.js": `export const k = "${key}";\n` });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("yahoo-league-or-team-key");
  });

  it("exits 1 when nothing was built", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "package.json": pkg, "README.md": "# x\n" });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no dist/ files packed");
  });

  it("exits 1 when src/cli.ts exists but the bin target is not packed", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { ...pkg, bin: { ff: "dist/cli.js" } },
      "dist/index.js": "export {};\n",
      "src/cli.ts": "export {};\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bin target dist/cli.js is not packed");
  });

  it("exits 0 on a clean package with a placeholder league key", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": pkg,
      "dist/index.js": `export const k = "${["461", "l", "1000"].join(".")}";\n`,
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

// QA-1-093: the runtime reads <packageRoot>/data/crosswalk/overrides.yaml (src/cli/serve.ts
// loadOverrides, src/providers/crosswalk-overrides.ts). The gate must let exactly that data file ship
// — and still refuse every other YAML outside skills/ (a league.yaml must never ship).
describe("shipped runtime data (QA-1-093)", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());
  const OVERRIDES = "data/crosswalk/overrides.yaml";

  it("lists the overrides file, and the runtime really reads it from the package root", () => {
    expect(SHIPPED_DATA).toEqual([OVERRIDES]);
    const serve = readFileSync(path.join(ROOT, "src/cli/serve.ts"), "utf8");
    expect(serve).toContain('path.join(root, "data", "crosswalk", "overrides.yaml")');
    expect(existsSync(path.join(ROOT, OVERRIDES))).toBe(true);
  });

  it("allows the overrides file when `files` covers it (by path or by its directory)", () => {
    expect(classify(OVERRIDES, [...FILES, OVERRIDES])).toBeNull();
    expect(classify(OVERRIDES, [...FILES, "data"])).toBeNull();
  });

  it.each([
    ["data/league.yaml"],
    ["data/crosswalk/league.yaml"],
    ["data/crosswalk/overrides.yml"],
    ["dist/data/crosswalk/overrides.yaml"],
  ])("still refuses any other yaml: %s", (f) => {
    expect(classify(f, [...FILES, "data"]) ?? "").toContain("yaml");
  });

  it("refuses the overrides file when `files` does not cover it", () => {
    expect(classify(OVERRIDES, FILES) ?? "").toContain("not covered");
  });

  it("exits 0 on a package that ships the overrides file", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { name: "fake-pack", version: "1.0.0", files: ["dist", OVERRIDES] },
      "dist/index.js": "export {};\n",
      [OVERRIDES]: "version: 1\noverrides: []\n",
    });
    const r = runCheck("scan-tarball.mjs", ["--root", tmp.dir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
