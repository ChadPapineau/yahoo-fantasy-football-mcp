// onboard-location-claims.test.ts — QA-1-044 / QA-1-067: the onboard Skill and its guide tell the
// user and the model which locations the SERVER refuses for the private league file. Users and the
// model rely on that backstop and stop checking, so every such claim must hold against the real
// configuration guard (src/config/schema.ts loadConfig → guardLocation), exercised here with a
// sample path for every location the text names. The Skill may ask the model to refuse MORE than
// the server does (that is the Skill's own guardrail); it may never say the server refuses a
// location the server accepts.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/schema.js";
import { ROOT, runSaveSteps } from "./helpers.js";
import { sentences } from "./world.js";

const FILES = ["skills/onboard/SKILL.md", "skills/onboard/references/onboard-league-yaml.md"];

/**
 * A sentence that attributes a refusal to the server. The negation test applies to the matched
 * clause only ("the server does not refuse X" is not a claim; "never save it in X: the server
 * refuses those paths" is).
 */
const SERVER_REFUSES = /\bserver\b[^.:;]*?\brefus(?:es|e)\b|\brefused\b[^.:;]*?\bby the server\b/i;
const NEGATED = /\b(?:not|never|cannot|can't|doesn't|won't)\b/i;
/** Anaphora that hides which locations are meant ("the server refuses those too"). */
const ANAPHORA = /\b(?:those|these|them|such (?:paths|folders|locations))\b/i;

/**
 * Every location phrase a Skill might attribute to the server, with a sample path of that kind
 * (under a temporary home). `checkout` is matched and removed first, so "this project's checkout"
 * is not also read as "a repository".
 */
type Sample = (home: string) => string;
const LOCATIONS: readonly (readonly [string, RegExp, Sample])[] = [
  [
    "this project's checkout",
    /\b(?:this project's|the project's|this) checkout\b/gi,
    () => path.join(ROOT, "ff-location-probe"),
  ],
  [
    "a git working tree / repository",
    /\b(?:any|a|another|other|every)\s+(?:(?:git|code)\s+)?(?:repository|repositories|working tree)\b|\bgit working tree\b|\binside a repository\b/gi,
    (h) => path.join(h, "code", "dotfiles", "ff"),
  ],
  ["Dropbox", /\bDropbox\b/g, (h) => path.join(h, "Dropbox", "ff")],
  ["Google Drive", /\bGoogle Drive\b/g, (h) => path.join(h, "Google Drive", "ff")],
  ["OneDrive", /\bOneDrive\b/g, (h) => path.join(h, "OneDrive", "ff")],
  [
    "a synced folder",
    /\b(?:any|a|every)\s+(?:cloud-)?synced folder\b|\bsync(?:ed)? folders\b/gi,
    (h) => path.join(h, "Dropbox", "ff"),
  ],
  [
    "iCloud Drive",
    /\biCloud\b|\bMobile Documents\b/g,
    (h) => path.join(h, "Library", "Mobile Documents", "com~apple~CloudDocs", "ff"),
  ],
  [
    "CloudStorage",
    /\bCloudStorage\b/g,
    (h) => path.join(h, "Library", "CloudStorage", "Box", "ff"),
  ],
  ["Desktop", /\bDesktop\b/g, (h) => path.join(h, "Desktop", "ff")],
  ["Documents", /(?<!Mobile )\bDocuments\b/g, (h) => path.join(h, "Documents", "ff")],
];

let base = "";
let home = "";
beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-loc-")));
  home = path.join(base, "home");
  mkdirSync(path.join(home, "code", "dotfiles", ".git"), { recursive: true });
  mkdirSync(path.join(base, "cache"), { recursive: true, mode: 0o700 });
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Whether the real guard refuses `dir` as the config directory. */
function serverRefuses(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    loadConfig({
      env: { FF_CONFIG_DIR: dir, FF_CACHE_DIR: path.join(base, "cache") },
      home,
      repoRoot: ROOT,
      file: undefined,
    });
    return false;
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.issues.some((i) => i.key === "FF_CONFIG_DIR");
  } finally {
    if (dir.startsWith(ROOT)) rmSync(dir, { recursive: true, force: true });
  }
}

/** The (file, sentence) pairs that attribute a refusal to the server. */
const claims = FILES.flatMap((f) =>
  sentences(readFileSync(path.join(ROOT, f), "utf8"))
    .filter((s) => {
      const m = SERVER_REFUSES.exec(s);
      return m !== null && !NEGATED.test(m[0]);
    })
    .map((s) => ({ file: f, sentence: s })),
);

describe("QA-1-044/QA-1-067: the onboard Skill claims only the location refusals the server makes", () => {
  it("the guard itself: sanity of the samples (control)", () => {
    expect(serverRefuses(path.join(home, "Documents", "ff"))).toBe(true);
    expect(serverRefuses(path.join(ROOT, "ff-location-probe"))).toBe(true);
    expect(serverRefuses(path.join(home, ".config", "fantasy-football-mcp"))).toBe(false);
  });

  it("some sentence says what the server refuses (the claim under test exists)", () => {
    expect(claims.length).toBeGreaterThan(0);
  });

  it("every server-refusal sentence names its locations (no 'the server refuses those too')", () => {
    const bad = claims.filter(
      (c) =>
        ANAPHORA.test(c.sentence) && !LOCATIONS.some(([, re]) => new RegExp(re).test(c.sentence)),
    );
    expect(bad).toEqual([]);
  });

  it("every location a server-refusal sentence names is refused by the real guard", () => {
    const wrong: string[] = [];
    for (const c of claims) {
      let rest = c.sentence;
      for (const [label, re, sample] of LOCATIONS) {
        const hit = new RegExp(re).test(rest);
        rest = rest.replace(new RegExp(re), " ");
        if (hit && !serverRefuses(sample(home)))
          wrong.push(`${c.file}: "${label}" in: ${c.sentence}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("QA-1-044/QA-1-067: the guide's save commands catch what the server's guard does not", () => {
  /** Runs the save commands with FF_CONFIG_DIR = `rel` under a fresh home; returns stdout. */
  const saveAt = (rel: string, gitDirAt?: string): string => {
    const b = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-stop-")));
    try {
      const h = path.join(b, "home");
      mkdirSync(h, { mode: 0o700 });
      if (gitDirAt !== undefined) mkdirSync(path.join(h, gitDirAt, ".git"), { recursive: true });
      const r = runSaveSteps({ FF_CONFIG_DIR: path.join(h, rel) }, h);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  };

  it("a config dir inside a git working tree (a dotfiles ~/.config) prints STOP", () => {
    expect(saveAt(".config/fantasy-football-mcp", ".config")).toMatch(/^STOP: .*git repository/m);
  });
  it("a .git FILE (a worktree or submodule) counts too", () => {
    const b = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-stop-")));
    try {
      const h = path.join(b, "home");
      mkdirSync(path.join(h, "wt"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(h, "wt", ".git"), "gitdir: /elsewhere\n");
      const r = runSaveSteps({ FF_CONFIG_DIR: path.join(h, "wt", "ff") }, h);
      expect(r.stdout).toMatch(/^STOP: .*git repository/m);
    } finally {
      rmSync(b, { recursive: true, force: true });
    }
  });
  for (const rel of [
    "Dropbox/ff",
    "Google Drive/ff",
    "OneDrive - Example/ff",
    "Library/CloudStorage/Box/ff",
    "Library/Mobile Documents/com~apple~CloudDocs/ff",
    "Documents/ff",
    "Desktop/ff",
  ]) {
    it(`~/${rel} prints STOP (synced folder)`, () => {
      expect(saveAt(rel)).toMatch(/^STOP: .*synced folder/m);
    });
  }
  it("a private folder outside any repository prints no STOP (control)", () => {
    expect(saveAt(".config/fantasy-football-mcp")).not.toMatch(/STOP/);
  });
});
