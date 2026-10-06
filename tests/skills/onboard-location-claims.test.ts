// onboard-location-claims.test.ts — QA-1-044 / QA-1-067: the onboard Skill and its guide tell the
// user and the model which locations the SERVER refuses for the private league file. Users and the
// model rely on that backstop and stop checking, so every such claim must hold against the real
// configuration guard (src/config/schema.ts loadConfig → guardLocation), exercised here with a
// sample path for every location the text names. The Skill may ask the model to refuse MORE than
// the server does (that is the Skill's own guardrail); it may never say the server refuses a
// location the server accepts. QA-2-002: nor may it leave out a folder the server refuses ("the
// server refuses only …" without ~/Dropbox), which the over-claim check cannot see — so every
// folder the guard refuses (src/config/paths.ts syncedFolders, and this checkout) must be named.
// QA-2-007: the converse — a sentence saying what the server does NOT look for may not name a
// folder it does refuse ("It does not look for … folders such as ~/Dropbox"), in any voice — a
// passive "~/Dropbox is not checked by the server" too (reopened QA-2-007). QA-2-008: a generic
// "synced folder" phrase is sampled with a sync app the guard does not know (~/Nextcloud), so "the
// server refuses … the synced folders in the home folder" is an over-claim the test can see.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInside, syncedFolders } from "../../src/config/paths.js";
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
 * Every location phrase a Skill might attribute to the server, with sample paths of that kind
 * (under a temporary home). `checkout` is matched and removed first, so "this project's checkout"
 * is not also read as "a repository". A `generic` phrase ("any synced folder") names no folder in
 * particular, so it never counts as naming one of the server's refusals.
 */
type Samples = (home: string) => readonly string[];
const BUSINESS_ONEDRIVE = "OneDrive - Example Org";
const LOCATIONS: readonly (readonly [string, RegExp, Samples, "generic"?])[] = [
  [
    "this project's checkout",
    /\b(?:this project's|the project's|this) checkout\b/gi,
    () => [path.join(ROOT, "ff-location-probe")],
  ],
  [
    "a git working tree / repository",
    /\b(?:any|a|another|other|every)\s+(?:(?:git|code)\s+)?(?:repository|repositories|working tree)\b|\bgit working tree\b|\binside a repository\b/gi,
    (h) => [path.join(h, "code", "dotfiles", "ff")],
    "generic",
  ],
  ["Dropbox", /\bDropbox\b/g, (h) => [path.join(h, "Dropbox", "ff")]],
  ["Google Drive", /\bGoogle Drive\b/g, (h) => [path.join(h, "Google Drive", "ff")]],
  [
    "OneDrive",
    /\bOneDrive\b/g,
    (h) => [path.join(h, "OneDrive", "ff"), path.join(h, BUSINESS_ONEDRIVE, "ff")],
  ],
  [
    "a synced folder",
    /\b(?:any|a|every)\s+(?:cloud-)?synced folder\b|\bsync(?:ed)? folders\b/gi,
    // a sync app the guard knows, and one it does not (QA-2-008): "any synced folder" means both
    (h) => [path.join(h, "Dropbox", "ff"), path.join(h, "Nextcloud", "ff")],
    "generic",
  ],
  [
    "iCloud Drive",
    /\biCloud\b|\bMobile Documents\b/g,
    (h) => [path.join(h, "Library", "Mobile Documents", "com~apple~CloudDocs", "ff")],
  ],
  [
    "CloudStorage",
    /\bCloudStorage\b/g,
    (h) => [path.join(h, "Library", "CloudStorage", "Box", "ff")],
  ],
  ["Desktop", /\bDesktop\b/g, (h) => [path.join(h, "Desktop", "ff")]],
  ["Documents", /(?<!Mobile )\bDocuments\b/g, (h) => [path.join(h, "Documents", "ff")]],
];

/** The LOCATIONS entries a sentence names, in table order, each match removed before the next. */
function named(sentence: string): (typeof LOCATIONS)[number][] {
  let rest = sentence;
  const out: (typeof LOCATIONS)[number][] = [];
  for (const loc of LOCATIONS) {
    if (new RegExp(loc[1]).test(rest)) out.push(loc);
    rest = rest.replace(new RegExp(loc[1]), " ");
  }
  return out;
}

let base = "";
let home = "";
beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-loc-")));
  home = path.join(base, "home");
  mkdirSync(path.join(home, "code", "dotfiles", ".git"), { recursive: true });
  // a business OneDrive, so the guard's per-home entry ("OneDrive - <org>") is in play
  mkdirSync(path.join(home, BUSINESS_ONEDRIVE), { recursive: true, mode: 0o700 });
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

/** Whether a sentence attributes a refusal to the server (a negated clause is not a claim). */
const isClaim = (s: string): boolean => {
  const m = SERVER_REFUSES.exec(s);
  return m !== null && !NEGATED.test(m[0]);
};

/** The (file, sentence) pairs that attribute a refusal to the server. */
const claims = FILES.flatMap((f) =>
  sentences(readFileSync(path.join(ROOT, f), "utf8"))
    .filter(isClaim)
    .map((s) => ({ file: f, sentence: s })),
);

/** A negation, in any voice ("does not", "isn't", "neither … nor"). */
const NEGATION = /\b(?:not|never|no|none|nothing|neither|nor|cannot)\b|n't\b/i;
/** A checking verb (or noun), in any form: "looks for", "is checked", "caught", "has no check". */
const CHECKING =
  /\b(?:look(?:s|ed|ing)?\s+(?:for|at|in|into)|check(?:s|ed|ing)?|refus(?:e|es|ed|ing)|catch(?:es|ing)?|caught|see(?:s|n|ing)?|block(?:s|ed|ing)?|guard(?:s|ed|ing)?|cover(?:s|ed|ing)?|detect(?:s|ed|ing)?|stop(?:s|ped|ping)?|flag(?:s|ged|ging)?|reject(?:s|ed|ing)?|know(?:s|n)?|recogni[sz](?:e|es|ed|ing))\b/i;
/** A denial with no negation: "the server ignores X", "accepts X", "lets X through", "unchecked". */
const LETS_THROUGH =
  /\bun(?:checked|caught|guarded|detected|refused|noticed)\b|\b(?:ignor(?:e|es|ed|ing)|skip(?:s|ped|ping)?|miss(?:es|ed|ing)?|overlook(?:s|ed|ing)?|accept(?:s|ed|ing)?|allow(?:s|ed|ing)?|permit(?:s|ted|ting)?)\b|\blets?\b[^.;:]*\bthrough\b/i;
/** An elliptic denial whose verb is elsewhere in the sentence: "…; X is not.", "…, but not X". */
const ELLIPTIC =
  /^\s*(?:(?:but|and|or)\s+)?not\b|\b(?:is|are|does|do|will|can)(?:\s+not|n't)\s*\.?$/i;
/** A clause whose explicit subject is not the server: the guide's commands, or the user. */
const OTHER_SUBJECT =
  /^\s*(?:the\s+)?(?:(?:guide's\s+)?(?:save\s+)?commands?(?:\s+above)?|you|the user)\b/i;

/** Paragraphs of a Markdown text (code fences dropped): blank-line blocks and list items. */
const paragraphs = (markdown: string): string[] =>
  markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/)
    .filter((p) => p.trim() !== "");

/** Clauses of a sentence: at every sentence end, colon, semicolon, dash, and "but"/"so"/"while". */
const clauses = (sentence: string): string[] =>
  sentence
    .split(/(?<=[.!?])\s+|\s*[:;]\s+|\s+—\s+|,?\s+(?=(?:but|so|while|whereas|yet)\s)/)
    .filter((c) => c.trim() !== "");

/**
 * QA-2-007: every clause that says what the server does NOT refuse, in any voice — "It does not look
 * for X", "X is not checked by the server", "Nor does it check X", "The server ignores X",
 * "Neither the server nor the commands catch X", "…; X is not". A clause is about the server when
 * it names the server, or when its paragraph does and its own subject is not the guide's commands
 * or the user. (Reopened QA-2-007: only two active forms were recognised, so a passive denial of a
 * refused folder passed.)
 */
const denialsIn = (markdown: string): string[] =>
  paragraphs(markdown).flatMap((para) => {
    const serverParagraph = /\bserver\b/i.test(para);
    return sentences(para).flatMap((sentence) =>
      clauses(sentence).filter((c) => {
        const aboutServer = /\bserver\b/i.test(c) || (serverParagraph && !OTHER_SUBJECT.test(c));
        if (!aboutServer) return false;
        if (LETS_THROUGH.test(c)) return true;
        if (!NEGATION.test(c)) return false;
        return CHECKING.test(c) || (ELLIPTIC.test(c) && CHECKING.test(sentence));
      }),
    );
  });

/** The (file, clause) pairs that say what the server does NOT refuse. */
const denials = FILES.flatMap((f) =>
  denialsIn(readFileSync(path.join(ROOT, f), "utf8")).map((s) => ({ file: f, sentence: s })),
);

/** The non-generic locations a denial names that the real guard refuses. */
const refusedIn = (denial: string): string[] =>
  named(denial)
    .filter(([, , samples, generic]) => generic === undefined && samples(home).some(serverRefuses))
    .map(([label]) => label);

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
      for (const [label, , samples] of named(c.sentence)) {
        if (!samples(home).every(serverRefuses))
          wrong.push(`${c.file}: "${label}" in: ${c.sentence}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a sentence saying what the server does not look for names no folder it refuses [QA-2-007]", () => {
    // the control: the texts do say what the server leaves to the user
    expect([...new Set(denials.map((d) => d.file))].sort()).toEqual([...FILES].sort());
    const wrong = denials.flatMap((d) =>
      refusedIn(d.sentence).map((label) => `${d.file}: "${label}" in: ${d.sentence}`),
    );
    expect(wrong).toEqual([]);
  });

  // Every way of saying "the server does not refuse X", planted in the paragraph where each text
  // says what the server refuses, with X each folder the server does refuse: all must be seen.
  const DENIAL_FORMS = [
    "It does not look for other git working trees, or for folders such as {X}.",
    "Folders such as {X} are not checked by the server.",
    "{X} is not checked by the server.",
    "{X} isn't refused by the server.",
    "Nor does it check {X}.",
    "It never sees {X}.",
    "The server ignores {X}.",
    "The server accepts {X}.",
    "The server lets {X} through.",
    "Neither the server nor the commands catch {X}.",
    "{X} is left unchecked by the server.",
    "The server has no check for {X}.",
    "The server refuses ~/.ssh, but not {X}.",
    "Only ~/.ssh is refused; {X} is not.",
  ] as const;
  const REFUSED_SPELLINGS: readonly (readonly [string, string])[] = [
    ["this project's checkout", "this project's checkout"],
    ["Dropbox", "`~/Dropbox`"],
    ["Google Drive", "`~/Google Drive`"],
    ["OneDrive", "`~/OneDrive - <organisation>`"],
    ["iCloud Drive", "iCloud Drive"],
    ["CloudStorage", "`~/Library/CloudStorage`"],
    ["Desktop", "`~/Desktop`"],
    ["Documents", "`~/Documents`"],
  ];

  it("every form of denial is seen, in either text, for every folder the server refuses (control) [QA-2-007]", () => {
    const missed: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      const claim = claims.find((c) => c.file === file);
      expect(claim, `${file} says what the server refuses`).toBeDefined();
      // the line (paragraph) that holds the first server-refusal claim
      const anchor = text.split("\n").find((l) => sentences(l).includes(claim?.sentence ?? "\0"));
      expect(anchor, `${file}: the claim's line`).toBeDefined();
      for (const [label, spelling] of REFUSED_SPELLINGS) {
        for (const form of DENIAL_FORMS) {
          const planted = form.replaceAll("{X}", spelling);
          const edited = text.replace(anchor ?? "", `${anchor ?? ""} ${planted}`);
          const seen = denialsIn(edited).some((d) => refusedIn(d).includes(label));
          if (!seen) missed.push(`${file}: ${planted}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  it("a true denial passes: what the server does not refuse may be said in any form (control) [QA-2-007]", () => {
    for (const form of DENIAL_FORMS) {
      const planted = form.replaceAll("{X}", "`~/Nextcloud`");
      const found = denialsIn(`The server refuses only \`~/Documents\`. ${planted}`);
      expect(found.length, planted).toBeGreaterThan(0);
      expect(found.flatMap(refusedIn), planted).toEqual([]);
    }
  });

  it("every folder the server refuses is named where the text says what it refuses [QA-2-002]", () => {
    // the guard's own list: this checkout and every synced folder under the home
    const refused = [ROOT, ...syncedFolders(home)];
    expect(refused).toContain(path.join(home, BUSINESS_ONEDRIVE));
    const phraseFor = (root: string) =>
      LOCATIONS.filter(
        ([, , samples, generic]) =>
          generic === undefined && samples(home).some((s) => isInside(s, root)),
      );
    // a folder the guard refuses that no phrase here stands for: extend LOCATIONS (and the text)
    expect(refused.filter((r) => phraseFor(r).length === 0)).toEqual([]);
    for (const r of refused) expect(serverRefuses(path.join(r, "ff-location-probe")), r).toBe(true);
    const missing: string[] = [];
    for (const file of FILES) {
      const said = claims.filter((c) => c.file === file).flatMap((c) => named(c.sentence));
      if (said.length === 0) continue;
      for (const r of refused)
        if (!phraseFor(r).some((loc) => said.includes(loc)))
          missing.push(`${file}: ${r === ROOT ? "this checkout" : `~/${path.relative(home, r)}`}`);
    }
    expect(missing).toEqual([]);
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
  // QA-2-008: the texts say the commands catch these apps' folders wherever they are
  for (const rel of [
    "Dropbox/ff",
    "Google Drive/ff",
    "OneDrive - Example/ff",
    "CloudStorage/Box/ff",
    "Mobile Documents/com~apple~CloudDocs/ff",
  ]) {
    it(`${rel} outside the home folder (another volume) prints STOP too [QA-2-008]`, () => {
      expect(saveAt(`../volume/${rel}`)).toMatch(/^STOP: .*synced folder/m);
    });
  }
  // ... and that neither they nor the server know other sync apps' folders (the texts say so)
  for (const rel of ["Nextcloud/ff", "../volume/Nextcloud/ff"]) {
    it(`${rel} prints no STOP, and the server accepts it: the texts must not say otherwise [QA-2-008]`, () => {
      expect(saveAt(rel)).not.toMatch(/STOP/);
    });
  }
  it("a private folder outside any repository prints no STOP (control)", () => {
    expect(saveAt(".config/fantasy-football-mcp")).not.toMatch(/STOP/);
  });
});
