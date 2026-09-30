// ci-runtime-tree.test.ts — scripts/ci/check-runtime-tree.mjs must FAIL on any addition, removal or
// version drift at any depth of the runtime tree, and on non-registry provenance (docs/plan/04 §2,
// §4.1, R11).
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkLockProvenance,
  compareTree,
  parseAllowlist,
} from "../../scripts/ci/check-runtime-tree.mjs";
import { flattenTree } from "../../scripts/ci/_lib.mjs";
import { ROOT, runCheck, tempDir, writeTree } from "./helpers.js";

const allow = { count: 2, packages: ["a@1.0.0", "b@2.0.0"] };

describe("compareTree", () => {
  it("passes on an exact match", () => {
    expect(compareTree(["b@2.0.0", "a@1.0.0"], allow)).toEqual([]);
  });
  it("fails on a transitive addition", () => {
    expect(compareTree(["a@1.0.0", "b@2.0.0", "sneaky@0.0.1"], allow).join()).toContain(
      "not on the allow-list: sneaky@0.0.1",
    );
  });
  it("fails on a removal", () => {
    expect(compareTree(["a@1.0.0"], allow).join()).toContain("not installed: b@2.0.0");
  });
  it("fails on version drift (both directions reported)", () => {
    const e = compareTree(["a@1.0.0", "b@2.0.1"], allow).join("\n");
    expect(e).toContain("not on the allow-list: b@2.0.1");
    expect(e).toContain("not installed: b@2.0.0");
  });
});

describe("parseAllowlist", () => {
  it.each([
    [null, /object/],
    [{ count: 1, packages: ["a@1.0.0", "a@1.0.0"] }, /count|duplicate/],
    [{ count: 2, packages: ["a@1.0.0", "a@1.0.0"] }, /duplicate/],
    [{ count: 3, packages: ["a@1.0.0"] }, /count/],
    [{ count: -1, packages: [] }, /count/],
    [{ count: 1.5, packages: [] }, /count/],
    [{ count: 1, packages: ["a@^1.0.0"] }, /exact/],
    [{ count: 1, packages: ["a"] }, /exact/],
    [{ count: 1, packages: [7] }, /strings/],
    [{ count: 1, packages: ["a@1.0.0\n"] }, /exact/],
  ])("rejects %j", (raw, why) => {
    expect(() => parseAllowlist(raw)).toThrow(why);
  });
  it("accepts scoped names and prereleases", () => {
    expect(parseAllowlist({ count: 2, packages: ["@s/p@1.2.3", "q@1.0.0-rc.1"] }).count).toBe(2);
  });
  it("the committed allow-list parses and matches the documented count", () => {
    const raw = JSON.parse(
      readFileSync(path.join(ROOT, "scripts/ci/runtime-allowlist.json"), "utf8"),
    ) as unknown;
    expect(parseAllowlist(raw).packages).toContain("yaml@2.9.1");
  });
});

describe("checkLockProvenance", () => {
  const good = { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", integrity: "sha512-AAAA" };
  it("passes registry + sha512 entries and ignores dev entries", () => {
    const lock = {
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/a": good,
        "node_modules/d": { dev: true, resolved: "git+x" },
      },
    };
    expect(checkLockProvenance(lock)).toEqual([]);
  });
  it.each([
    [{ ...good, resolved: "https://evil.example/a.tgz" }, /resolved from/],
    [{ ...good, resolved: "git+https://github.com/x/a.git" }, /resolved from/],
    [{ ...good, resolved: "https://registry.npmjs.org.evil.example/a.tgz" }, /resolved from/],
    [{ ...good, integrity: "sha1-AAAA" }, /sha512/],
    [{ resolved: good.resolved }, /sha512/],
    [{ link: true }, /link/],
  ])("fails on %j", (entry, why) => {
    const lock = { lockfileVersion: 3, packages: { "node_modules/a": entry } };
    expect(checkLockProvenance(lock).join()).toMatch(why);
  });
  it("fails on a non-v3 or malformed lockfile", () => {
    expect(checkLockProvenance({ lockfileVersion: 2, packages: {} })).toHaveLength(1);
    expect(checkLockProvenance({})).toHaveLength(1);
    expect(checkLockProvenance(null)).toHaveLength(1);
  });
});

describe("flattenTree", () => {
  it("dedupes and records missing/invalid/extraneous problems", () => {
    const t = flattenTree({
      dependencies: {
        a: {
          version: "1.0.0",
          path: "/x/a",
          dependencies: { c: { version: "3.0.0", path: "/x/c" } },
        },
        b: { version: "2.0.0", dependencies: { c: { version: "3.0.0" } } },
        m: { missing: true },
        e: { version: "1.0.0", extraneous: true },
        i: { version: "1.0.0", invalid: true },
      },
      problems: ["missing: m@1"],
    });
    expect([...t.nodes.keys()].sort()).toEqual([
      "a@1.0.0",
      "b@2.0.0",
      "c@3.0.0",
      "e@1.0.0",
      "i@1.0.0",
    ]);
    expect(t.nodes.get("c@3.0.0")?.path).toBe("/x/c");
    expect(t.problems.join("\n")).toMatch(/missing: m[\s\S]*extraneous: e[\s\S]*invalid: i/);
  });
  it("rejects non-object output", () => {
    expect(() => flattenTree("x")).toThrow();
    expect(() => flattenTree([])).toThrow();
  });
});

describe("check-runtime-tree CLI", () => {
  let tmp: ReturnType<typeof tempDir> | undefined;
  afterEach(() => tmp?.cleanup());

  it("exits 0 on this repository against the committed allow-list", () => {
    const r = runCheck("check-runtime-tree.mjs", []);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("exits 1 and names the package when the allow-list lacks one (a transitive addition)", () => {
    tmp = tempDir();
    writeTree(tmp.dir, {
      "allow.json": {
        count: 4,
        packages: [
          "@modelcontextprotocol/server@2.2.0",
          "hyparquet@1.31.2",
          "yaml@2.9.1",
          "zod@4.6.5",
        ],
      },
    });
    const r = runCheck("check-runtime-tree.mjs", ["--allowlist", path.join(tmp.dir, "allow.json")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not on the allow-list: @modelcontextprotocol/core@2.2.0");
  });

  it("exits 2 on a malformed allow-list", () => {
    tmp = tempDir();
    writeTree(tmp.dir, { "allow.json": "{ not json" });
    expect(
      runCheck("check-runtime-tree.mjs", ["--allowlist", path.join(tmp.dir, "allow.json")]).status,
    ).toBe(2);
  });

  it("--print emits a valid allow-list for the current tree", () => {
    const r = runCheck("check-runtime-tree.mjs", ["--print"]);
    expect(r.status).toBe(0);
    expect(parseAllowlist(JSON.parse(r.stdout)).count).toBe(5);
  });
});
