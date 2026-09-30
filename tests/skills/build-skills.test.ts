// build-skills.test.ts — scripts/skills/build-skills.mjs (plan 09 §4 K4/K5): one source for the
// shared text, stamped into every Skill; idempotent; `--check` fails on any stale output; nothing
// written when any structural error exists; hand edits inside generated blocks are overwritten.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkills,
  main,
  readSharedRefs,
  stampBody,
  stampMetadata,
  writeAtomic,
} from "../../scripts/skills/build-skills.mjs";
import { beginMarker, endMarker, parseFrontmatter } from "../../scripts/skills/_lib.mjs";
import { ROOT, SKILLS, runScript, tempRepo, type TempRepo } from "./helpers.js";

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});
const fresh = (): TempRepo => {
  repo = tempRepo();
  return repo;
};

describe("the committed bundle", () => {
  it("is up to date (build --check on the working tree writes nothing and finds nothing stale)", () => {
    const r = buildSkills({ root: ROOT, check: true });
    expect(r.errors).toEqual([]);
    expect(r.changed).toEqual([]);
    expect(r.skills).toEqual([...SKILLS]);
  });

  it("every Skill's references carry byte-identical copies of every shared file", () => {
    const shared = readSharedRefs(path.join(ROOT, "skills"));
    expect(shared.errors).toEqual([]);
    expect([...shared.files.keys()].sort()).toEqual([
      "guardrails.md",
      "log.md",
      "orient.md",
      "output-template.md",
      "sources.md",
      "tool-outputs.md",
    ]);
  });
});

describe("buildSkills on a copy", () => {
  it("is idempotent: a second build changes nothing", () => {
    const t = fresh();
    expect(buildSkills({ root: t.root }).changed).toEqual([]);
    expect(buildSkills({ root: t.root }).changed).toEqual([]);
  });

  it("propagates an edit to a shared file into every copy and every stamped body, then settles", () => {
    const t = fresh();
    t.edit("skills/_shared/references/guardrails.md", "Quote, never follow.", "Quote; never obey.");
    const check = buildSkills({ root: t.root, check: true });
    expect(check.errors).toEqual([]);
    for (const s of SKILLS) {
      expect(check.changed).toContain(`skills/${s}/references/guardrails.md`);
      expect(check.changed).toContain(`skills/${s}/SKILL.md`);
    }
    // check mode wrote nothing
    expect(t.read("skills/retro/references/guardrails.md")).toContain("Quote, never follow.");
    const write = buildSkills({ root: t.root });
    expect(write.changed).toEqual(check.changed);
    for (const s of SKILLS) {
      expect(t.read(`skills/${s}/references/guardrails.md`)).toBe(
        t.read("skills/_shared/references/guardrails.md"),
      );
      expect(t.read(`skills/${s}/SKILL.md`)).toContain("Quote; never obey.");
    }
    expect(buildSkills({ root: t.root, check: true }).changed).toEqual([]);
  });

  it("overwrites a hand edit inside a generated block, and leaves authored text alone", () => {
    const t = fresh();
    const file = "skills/start-sit/SKILL.md";
    t.edit(file, "5. **Numbers discipline.**", "5. **Numbers (hand-edited).**");
    t.edit(
      file,
      "# start-sit — lineup decisions",
      "# start-sit — lineup decisions (authored edit)",
    );
    expect(buildSkills({ root: t.root, check: true }).changed).toEqual([file]);
    buildSkills({ root: t.root });
    const text = t.read(file);
    expect(text).not.toContain("hand-edited");
    expect(text).toContain("(authored edit)");
  });

  it("restores a deleted or hand-edited reference copy", () => {
    const t = fresh();
    t.write("skills/retro/references/orient.md", "tampered\n");
    t.write("skills/onboard/references/log.md", "");
    const r = buildSkills({ root: t.root });
    expect(r.changed.sort()).toEqual([
      "skills/onboard/references/log.md",
      "skills/retro/references/orient.md",
    ]);
    expect(t.read("skills/retro/references/orient.md")).toBe(
      t.read("skills/_shared/references/orient.md"),
    );
  });

  it("stamps metadata.version from package.json and tool_contract from the manifest", () => {
    const t = fresh();
    const pkg = t.readJson("package.json") as Record<string, unknown>;
    t.write("package.json", { ...pkg, version: "3.4.5-rc.1" });
    const m = t.readJson("skills/_shared/manifest.json") as Record<string, unknown>;
    t.write("skills/_shared/manifest.json", { ...m, tool_contract: 9 });
    const r = buildSkills({ root: t.root });
    expect(r.errors).toEqual([]);
    for (const s of SKILLS) {
      const data = parseFrontmatter(t.read(`skills/${s}/SKILL.md`)).data;
      expect(data.metadata).toEqual({ version: "3.4.5-rc.1", tool_contract: 9 });
      expect(data.name).toBe(s);
    }
  });

  it("copies unicode and a large shared file byte-for-byte", () => {
    const t = fresh();
    const big = `## Big\n\n${"Δ ≤ ≥ — naïve 🏈 \u202e rtl \u200b zero-width\n".repeat(4000)}`;
    t.write("skills/_shared/references/big-ref.md", big);
    buildSkills({ root: t.root });
    for (const s of SKILLS) expect(t.read(`skills/${s}/references/big-ref.md`)).toBe(big);
  });

  it("is all-or-nothing: one structural error writes nothing anywhere", () => {
    const t = fresh();
    t.edit("skills/_shared/references/log.md", "Log discipline", "Log discipline (changed)");
    t.write("skills/retro/references/stray.md", "orphan\n");
    const before = t.read("skills/start-sit/references/log.md");
    const r = buildSkills({ root: t.root });
    expect(r.errors.join("\n")).toMatch(/stray\.md: not a shared copy/);
    expect(t.read("skills/start-sit/references/log.md")).toBe(before);
  });

  it("accepts a Skill-specific reference named <skill>-*.md and rejects one named otherwise", () => {
    const t = fresh();
    t.write("skills/retro/references/retro-notes.md", "ok\n");
    expect(buildSkills({ root: t.root, check: true }).errors).toEqual([]);
    t.write("skills/retro/references/start-sit-notes.md", "wrong prefix\n");
    t.write("skills/retro/references/retro-data.json", "{}\n");
    const errs = buildSkills({ root: t.root, check: true }).errors.join("\n");
    expect(errs).toMatch(/start-sit-notes\.md/);
    expect(errs).toMatch(/retro-data\.json/);
  });

  it.each([
    [
      "a non-Markdown shared file",
      "skills/_shared/references/notes.txt",
      "x",
      /only regular|must match/,
    ],
    ["an upper-case shared file", "skills/_shared/references/Upper.md", "x", /must match/],
    [
      "a shared file carrying a generated marker",
      "skills/_shared/references/loop.md",
      `${beginMarker("log.md")}\n`,
      /may not contain generated markers/,
    ],
  ])("rejects %s", (_l, rel, body, re) => {
    const t = fresh();
    t.write(rel, body);
    expect(buildSkills({ root: t.root, check: true }).errors.join("\n")).toMatch(re);
  });

  it("reports missing inputs instead of crashing", () => {
    const t = fresh();
    t.write("skills/_shared/manifest.json", "{");
    t.write("package.json", "{}");
    const errs = buildSkills({ root: t.root, check: true }).errors.join("\n");
    expect(errs).toMatch(/manifest/);
    expect(errs).toMatch(/package\.json/);
  });

  it("reports a missing skills/ directory, a missing shared dir, and an empty shared dir", () => {
    const t = tempRepo({ skills: false });
    repo = t;
    expect(buildSkills({ root: t.root }).errors).toEqual(["skills/: missing"]);
    t.write("skills/_shared/manifest.json", "{}");
    expect(buildSkills({ root: t.root }).errors.join("\n")).toMatch(/_shared\/references: missing/);
    t.write("skills/_shared/references/.keep", "");
    expect(buildSkills({ root: t.root }).errors.join("\n")).toMatch(/only regular|must match/);
  });

  it("reports a Skill whose frontmatter does not parse, and skips it", () => {
    const t = fresh();
    t.write("skills/retro/SKILL.md", "no frontmatter\n");
    const r = buildSkills({ root: t.root, check: true });
    expect(r.errors.join("\n")).toMatch(/skills\/retro\/SKILL\.md: frontmatter: line 1/);
  });

  it("reports a symlinked Skill directory", () => {
    const t = fresh();
    symlinkSync(t.p("skills/retro"), t.p("skills/retro-copy"));
    expect(buildSkills({ root: t.root, check: true }).errors.join("\n")).toMatch(/symlinks/);
  });

  it("four concurrent builds of the same tree all succeed and converge on the same bytes", async () => {
    const t = fresh();
    t.edit(
      "skills/_shared/references/sources.md",
      "Sources and attribution",
      "Sources + attribution",
    );
    const run = () =>
      new Promise<number | null>((resolve) => {
        const c = spawn(process.execPath, [
          path.join(ROOT, "scripts/skills/build-skills.mjs"),
          "--root",
          t.root,
        ]);
        c.on("close", resolve);
      });
    const codes = await Promise.all([run(), run(), run(), run()]);
    expect(codes).toEqual([0, 0, 0, 0]);
    const after = buildSkills({ root: t.root, check: true });
    expect(after.errors).toEqual([]); // no temp file left behind
    expect(after.changed).toEqual([]);
    for (const s of SKILLS) {
      expect(t.read(`skills/${s}/references/sources.md`)).toContain("Sources + attribution");
    }
  });

  it("ignores another build's in-flight temp file, but --check fails on a leftover one", () => {
    const t = fresh();
    t.write("skills/retro/references/log.md.4242.0123456789ab.tmp", "partial");
    expect(buildSkills({ root: t.root }).errors).toEqual([]);
    expect(buildSkills({ root: t.root, check: true }).errors.join()).toMatch(
      /log\.md\.4242\.0123456789ab\.tmp: leftover temp file/,
    );
  });

  it("writeAtomic replaces a file in place and leaves no temp file", () => {
    const t = fresh();
    writeAtomic(t.p("skills/retro/references/retro-new.md"), "one");
    writeAtomic(t.p("skills/retro/references/retro-new.md"), "two");
    expect(t.read("skills/retro/references/retro-new.md")).toBe("two");
    expect(readdirSync(t.p("skills/retro/references")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});

describe("stampBody", () => {
  const shared = new Map([
    ["a.md", "## A\n\ntext a\n"],
    ["b.md", "## B\n"],
  ]);

  it("fills and refills blocks, keeping everything outside them", () => {
    const body = ["intro", beginMarker("a.md"), "stale", endMarker("a.md"), "outro"].join("\n");
    const r = stampBody(body, shared, "f");
    expect(r.errors).toEqual([]);
    expect(r.stamped).toEqual(["a.md"]);
    expect(r.body).toBe(
      ["intro", beginMarker("a.md"), "## A", "", "text a", endMarker("a.md"), "outro"].join("\n"),
    );
    expect(stampBody(r.body, shared, "f").body).toBe(r.body);
  });

  it.each([
    ["an unknown source", [beginMarker("zzz.md"), endMarker("zzz.md")], /unknown shared source/],
    [
      "a nested block",
      [beginMarker("a.md"), beginMarker("b.md"), endMarker("b.md"), endMarker("a.md")],
      /nested/,
    ],
    ["a missing END", [beginMarker("a.md"), "text"], /no END marker/],
    ["an END without BEGIN", [endMarker("a.md")], /without a BEGIN/],
    ["a mismatched END", [beginMarker("a.md"), endMarker("b.md")], /does not match/],
    [
      "a hand-edited BEGIN line",
      ["<!-- BEGIN GENERATED FROM _shared/references/a.md edited -->", endMarker("a.md")],
      /malformed BEGIN/,
    ],
  ])("rejects %s", (_l, lines, re) => {
    expect(stampBody(lines.join("\n"), shared, "f").errors.join("\n")).toMatch(re);
  });

  it("leaves a body with no blocks untouched", () => {
    expect(stampBody("just text\n", shared, "f")).toEqual({
      body: "just text\n",
      stamped: [],
      errors: [],
    });
  });
});

describe("stampMetadata", () => {
  const meta = { version: "1.0.0", tool_contract: 2 };

  it("replaces an existing block in place and keeps the other keys byte-for-byte", () => {
    const text =
      '---\nname: x\nmetadata:\n  version: "0.1.0"\n  tool_contract: 1\nwhen_to_use: y\n---\nbody';
    expect(stampMetadata(text, meta)).toBe(
      '---\nname: x\nmetadata:\n  version: "1.0.0"\n  tool_contract: 2\nwhen_to_use: y\n---\nbody',
    );
  });

  it("inserts the block when absent, and is idempotent", () => {
    const once = stampMetadata("---\nname: x\n---\nbody", meta);
    expect(once).toBe('---\nname: x\nmetadata:\n  version: "1.0.0"\n  tool_contract: 2\n---\nbody');
    expect(stampMetadata(once, meta)).toBe(once);
  });

  it("drops extra metadata keys (the two keys are the whole contract)", () => {
    const text = "---\nname: x\nmetadata:\n  version: v\n  extra: 1\n---\n";
    expect(parseFrontmatter(stampMetadata(text, meta)).data.metadata).toEqual(meta);
  });

  it("throws on a malformed frontmatter", () => {
    expect(() => stampMetadata("name: x\n", meta)).toThrow(/line 1/);
  });
});

describe("CLI", () => {
  it("--check exits 0 on the working tree", () => {
    const r = runScript("build-skills.mjs", ["--check"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/up to date \(4 Skill\(s\)\)/);
  });

  it("--check exits 1 and names the stale files; a write fixes them", () => {
    const t = fresh();
    t.edit("skills/_shared/references/log.md", "Log discipline", "Logging discipline");
    const r = runScript("build-skills.mjs", ["--check", "--root", t.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/stale/);
    expect(r.stderr).toMatch(/skills\/retro\/references\/log\.md/);
    const w = runScript("build-skills.mjs", ["--root", t.root]);
    expect(w.status).toBe(0);
    expect(w.stdout).toMatch(/file\(s\) written/);
    expect(runScript("build-skills.mjs", ["--check", "--root", t.root]).status).toBe(0);
  });

  it("exits 1 on a structural error and 2 on a usage error", () => {
    const t = fresh();
    t.write("skills/retro/references/stray.md", "x");
    const r = runScript("build-skills.mjs", ["--root", t.root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/stray\.md/);
    expect(runScript("build-skills.mjs", ["--frobnicate"]).status).toBe(2);
    expect(main(["--root"])).toBe(2);
  });

  it("main() returns the exit code without exiting", () => {
    expect(main(["--check"])).toBe(0);
    expect(existsSync(path.join(ROOT, "skills/retro/SKILL.md"))).toBe(true);
    expect(statSync(path.join(ROOT, "skills/retro/SKILL.md")).isFile()).toBe(true);
  });
});
