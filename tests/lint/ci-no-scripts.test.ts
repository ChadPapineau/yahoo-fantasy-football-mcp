// ci-no-scripts.test.ts — scripts/ci/check-no-scripts.mjs must FAIL on an install hook or a native
// build anywhere in the runtime tree (docs/plan/04 §4.1 `supply-chain`; plan 02 S10).
import { afterEach, describe, expect, it } from "vitest";
import { inspectPackage, lockfileInstallScripts } from "../../scripts/ci/check-no-scripts.mjs";
import { fakeProject, runCheck, tempDir, writeTree } from "./helpers.js";

const REG = "https://registry.npmjs.org/x/-/x-1.0.0.tgz";

describe("inspectPackage", () => {
  const base = { id: "x@1.0.0", dir: "/nonexistent-ff-dir" };
  it.each(["preinstall", "install", "postinstall"])("fails on a %s script", (hook) => {
    const r = inspectPackage({
      ...base,
      manifest: { scripts: { [hook]: "node evil.js" } },
      resolved: REG,
    });
    expect(r.errors.join()).toContain(hook);
  });
  it("warns (not fails) on `prepare` for a registry tarball — npm never runs it there", () => {
    const r = inspectPackage({ ...base, manifest: { scripts: { prepare: "tsc" } }, resolved: REG });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toContain("prepare");
  });
  it.each([
    undefined,
    "git+ssh://git@github.com/x/x.git#abc",
    "file:../x",
    "https://evil.example/x.tgz",
  ])("fails on `prepare` when resolved from %s", (resolved) => {
    const r = inspectPackage({ ...base, manifest: { scripts: { prepare: "tsc" } }, resolved });
    expect(r.errors.join()).toContain("prepare");
  });
  it("fails on gypfile: true", () => {
    expect(inspectPackage({ ...base, manifest: { gypfile: true } }).errors).toHaveLength(1);
  });
  it.each(["prebuild-install", "node-gyp-build", "@mapbox/node-pre-gyp", "napi-postinstall"])(
    "fails on a dependency on %s",
    (helper) => {
      const r = inspectPackage({
        ...base,
        manifest: { optionalDependencies: { [helper]: "1.0.0" } },
      });
      expect(r.errors.join()).toContain(helper);
    },
  );
  it("fails on a non-object manifest", () => {
    expect(inspectPackage({ ...base, manifest: "nope" }).errors).toHaveLength(1);
    expect(inspectPackage({ ...base, manifest: null }).errors).toHaveLength(1);
  });
  it("ignores harmless scripts (test, build, prestart)", () => {
    const r = inspectPackage({
      ...base,
      manifest: { scripts: { test: "x", build: "y", prestart: "z" } },
    });
    expect(r).toEqual({ errors: [], warnings: [] });
  });
});

describe("lockfileInstallScripts", () => {
  it("reports runtime entries with hasInstallScript, ignores dev ones", () => {
    const lock = {
      packages: {
        "": { name: "root" },
        "node_modules/a": { hasInstallScript: true },
        "node_modules/b": { hasInstallScript: true, dev: true },
        "node_modules/c": { hasInstallScript: true, devOptional: true },
        "node_modules/d": {},
      },
    };
    expect(lockfileInstallScripts(lock)).toEqual(["node_modules/a"]);
  });
  it.each([null, 1, "x", {}, { packages: [] }])("tolerates a malformed lockfile: %j", (lock) => {
    expect(lockfileInstallScripts(lock)).toEqual([]);
  });
});

describe("check-no-scripts CLI on a fake project", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("exits 1 and names the package with a postinstall (nested one level down)", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { good: { dependencies: { evil: "1.0.0" } } });
    writeTree(tmp.dir, {
      "node_modules/evil/package.json": {
        name: "evil",
        version: "1.0.0",
        scripts: { postinstall: "curl x | sh" },
      },
    });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('evil@1.0.0: has a "postinstall" script');
  });

  it("exits 1 on a shipped binding.gyp", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { native: {} }, { "node_modules/native/binding.gyp": "{}" });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("binding.gyp");
  });

  it("exits 1 when a declared dependency is missing from node_modules", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "package.json": { name: "p", version: "1.0.0", dependencies: { ghost: "1.0.0" } },
    });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing/i);
  });

  it("exits 0 on a clean tree", () => {
    tmp = tempDir();
    fakeProject(tmp.dir, { clean: { scripts: { test: "vitest" } } });
    const r = runCheck("check-no-scripts.mjs", ["--root", tmp.dir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 0 on this repository's real runtime tree", () => {
    expect(runCheck("check-no-scripts.mjs", []).status).toBe(0);
  });
});
