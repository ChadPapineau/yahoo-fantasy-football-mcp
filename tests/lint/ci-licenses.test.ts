// ci-licenses.test.ts — scripts/ci/check-licenses.mjs must FAIL, naming the package, on any runtime
// license outside the allow-list (docs/plan/04 §4.1 `supply-chain`).
import { afterEach, describe, expect, it } from "vitest";
import { checkManifest, declaredLicense, isAllowed } from "../../scripts/ci/check-licenses.mjs";
import { fakeProject, runCheck, tempDir } from "./helpers.js";

describe("isAllowed (SPDX)", () => {
  it.each([
    ["MIT", true],
    ["mit", true],
    ["ISC", true],
    ["Apache-2.0", true],
    ["BSD-3-Clause", true],
    ["0BSD", true],
    ["(MIT OR GPL-3.0-only)", true],
    ["GPL-3.0-only OR MIT", true],
    ["(MIT AND Apache-2.0)", true],
    ["(MIT AND GPL-3.0-only)", false],
    ["MIT AND (GPL-2.0 OR Apache-2.0)", true],
    ["GPL-3.0-only", false],
    ["AGPL-3.0", false],
    ["UNLICENSED", false],
    ["BUSL-1.1", false],
    ["MITX", false],
  ])("%s -> %s", (expr, want) => {
    expect(isAllowed(expr)).toBe(want);
  });

  it.each([
    "GPL-2.0 WITH Classpath-exception-2.0",
    "Apache 2.0",
    "SEE LICENSE IN LICENSE.md",
    "MIT OR",
    "(MIT",
    "MIT)",
    "()",
    "AND MIT",
    "",
  ])("throws on unparseable %j", (expr) => {
    expect(() => isAllowed(expr)).toThrow();
  });
});

describe("declaredLicense", () => {
  it.each([
    [{ license: "MIT" }, "MIT"],
    [{ license: "  ISC  " }, "ISC"],
    [{ license: { type: "BSD-2-Clause" } }, "BSD-2-Clause"],
    [{ licenses: [{ type: "MIT" }] }, "MIT"],
    [{ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }, "(MIT OR Apache-2.0)"],
    [{ license: "" }, null],
    [{ license: 7 }, null],
    [{}, null],
    [null, null],
    ["MIT", null],
  ])("%j -> %j", (m, want) => {
    expect(declaredLicense(m)).toBe(want);
  });
});

describe("checkManifest", () => {
  it("names the package on a disallowed license", () => {
    expect(checkManifest("bad@1.0.0", { license: "GPL-3.0-only" })).toContain("bad@1.0.0");
  });
  it("names the package when no license is declared", () => {
    expect(checkManifest("none@1.0.0", {})).toContain("none@1.0.0");
  });
  it("survives a hostile, deeply nested expression without crashing", () => {
    const deep = `${"(".repeat(20000)}MIT${")".repeat(20000)}`;
    const r = checkManifest("deep@1.0.0", { license: deep });
    expect(r === null || r.includes("deep@1.0.0")).toBe(true);
  });
  it("returns null on an allowed license", () => {
    expect(checkManifest("ok@1.0.0", { license: "MIT" })).toBeNull();
  });
});

describe("check-licenses CLI on a fake project", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("exits 1 and names a GPL runtime package", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { ok: { license: "MIT" }, copyleft: { license: "GPL-3.0-only" } });
    const r = runCheck("check-licenses.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('copyleft@1.0.0: license "GPL-3.0-only"');
    expect(r.stderr).not.toContain("ok@1.0.0");
  });

  it("exits 1 on a package with no license", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { anon: {} });
    const r = runCheck("check-licenses.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("anon@1.0.0: no license declared");
  });

  it("exits 0 when every license is allowed", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { a: { license: "MIT" }, b: { license: "(ISC OR GPL-3.0-only)" } });
    expect(runCheck("check-licenses.mjs", ["--root", tmp.dir]).status).toBe(0);
  });

  it("exits 0 on this repository's real runtime tree", () => {
    expect(runCheck("check-licenses.mjs", []).status).toBe(0);
  });
});
