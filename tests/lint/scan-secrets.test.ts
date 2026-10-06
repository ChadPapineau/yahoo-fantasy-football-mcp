// scan-secrets.test.ts — scripts/dev/scan-secrets.mjs is the ONLY layer that runs before a value
// reaches the public repo (gitleaks runs in CI, after the push), so it must flag at least what
// gitleaks flags and fail closed on anything it cannot scan (CONTRIBUTING.md Security;
// .gitleaks.toml; QA-1-089). Every well-formed value below is assembled at run time so this file
// stays clean.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, tempDir } from "./helpers.js";

const SCANNER = path.join(ROOT, "scripts", "dev", "scan-secrets.mjs");
/** A well-formed (fake) GitHub token, split so no literal in this file matches. */
const TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const at = (local: string, domain: string) => `${local}@${domain}`;
const key = (...parts: string[]) => parts.join(".");

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

function scan(dir: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [SCANNER, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, FF_SCAN_DENYLIST: "/dev/null", HOME: dir, ...env },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Scan one file holding `lines`; returns the 1-based line numbers reported and the exit code. */
function scanLines(lines: string[]) {
  tmp ??= tempDir("ff-scan-");
  const file = path.join(tmp.dir, "probe.txt");
  writeFileSync(file, `${lines.join("\n")}\n`);
  const r = scan(tmp.dir, ["--", "probe.txt"]);
  const flagged = [...r.out.matchAll(/probe\.txt:(\d+) {2}\[([a-z-]+)\]/g)].map((m) => ({
    line: Number(m[1]),
    rule: m[2] ?? "",
  }));
  return { ...r, flagged };
}

describe("Yahoo league and team keys — never narrower than .gitleaks.toml (QA-1-089 a)", () => {
  const toml = readFileSync(path.join(ROOT, ".gitleaks.toml"), "utf8");
  /** The regex and allowlist regex of one gitleaks rule, translated to JS (RE2 `\b` is ASCII, as in JS). */
  function gitleaksRule(id: string): { re: RegExp; allow: RegExp } {
    const block = toml.split("[[rules]]").find((b) => b.includes(`id = "${id}"`)) ?? "";
    const res = [...block.matchAll(/'''(.*?)'''/g)].map((m) => m[1] ?? "");
    expect(res, `${id} regex + allowlist`).toHaveLength(2);
    return { re: new RegExp(res[0] ?? "", "g"), allow: new RegExp(res[1] ?? "") };
  }
  const league = gitleaksRule("yahoo-league-key");
  const team = gitleaksRule("yahoo-team-key");
  const gitleaksFlags = (line: string) =>
    [league, team].some((r) => [...line.matchAll(r.re)].some((m) => !r.allow.test(m[0])));

  const games = ["461", "79", "nfl", "mlb", "nba", "nhl", "4", "1234"];
  const leagues = ["424242", "1000", "10009", "10012", "12345678", "123", "123456789"];
  const lines: string[] = [];
  for (const g of games)
    for (const l of leagues) {
      lines.push(`league: ${key(g, "l", l)}`);
      lines.push(`team: ${key(g, "l", l, "t", "3")}`);
    }

  it("flags every line gitleaks flags (league and team keys in every game form)", () => {
    const r = scanLines(lines);
    const local = new Set(r.flagged.map((f) => f.line));
    const missed = lines.filter((l, i) => gitleaksFlags(l) && !local.has(i + 1));
    expect(missed).toEqual([]);
    // non-vacuous: 6 game forms x 3 non-placeholder league ids x (league, team) reach gitleaks
    expect(lines.filter(gitleaksFlags)).toHaveLength(36);
  });

  it("flags the game-code, 2-digit and team forms from the finding", () => {
    for (const v of [
      key("nfl", "l", "424242"),
      key("79", "l", "424242"),
      key("nfl", "l", "424242", "t", "3"),
    ]) {
      const r = scanLines([`league: ${v}`]);
      expect(r.status, v).toBe(1);
      expect(r.flagged).toEqual([{ line: 1, rule: "yahoo-league-or-team-key" }]);
    }
  });

  it("stays quiet on the documentation placeholders (1000, 10000–10009) in every game form", () => {
    const ok = ["461", "nfl", "79"].flatMap((g) => [
      key(g, "l", "1000"),
      key(g, "l", "10009", "t", "12"),
      key(g, "l", "1000", "w", "c", "2_6461"),
    ]);
    const r = scanLines(ok);
    expect(r.flagged).toEqual([]);
    expect(r.status).toBe(0);
  });

  it("agrees with the gitleaks self-test fixtures (must-flag lines flag, must-pass stays clean)", () => {
    const mustFlag = readFileSync(
      path.join(ROOT, "scripts/gitleaks-selftest/must-flag.txt"),
      "utf8",
    )
      .split("\n")
      .filter((l) => gitleaksFlags(l));
    expect(mustFlag.length).toBeGreaterThan(0);
    const flagged = scanLines(mustFlag);
    expect(new Set(flagged.flagged.map((f) => f.line)).size).toBe(mustFlag.length);
    const mustPass = readFileSync(
      path.join(ROOT, "scripts/gitleaks-selftest/must-pass.txt"),
      "utf8",
    ).split("\n");
    expect(scanLines(mustPass).flagged).toEqual([]);
  });
});

describe("email addresses — any real mailbox, not a fixed list of free-mail domains (QA-1-089 b)", () => {
  it.each([
    at("jane.doe", "gmail.com"),
    at("jane.doe", "acme-corp.io"),
    at("owner", "mail.example-isp.net"),
    at("first+tag", "sub.company.co.uk"),
    at("dev", "build-host.lan"),
  ])("flags %s", (addr) => {
    const r = scanLines([`contact: ${addr}`]);
    expect(r.status).toBe(1);
    expect(r.flagged).toEqual([{ line: 1, rule: "email-address" }]);
  });

  it.each([
    at("noreply", "mail.service.io"),
    at("123456+someone", "users.noreply.github.com"),
    at("no-reply", "service.io"),
    at("probe", "example.invalid"),
    at("you", "example.com"),
    at("a", "example.org"),
    at("dev", "host.test"),
    at("ci", "runner.localhost"),
    at("x", "team.example"),
  ])("allows the reserved or no-reply address %s", (addr) => {
    expect(scanLines([`contact: ${addr}`]).flagged).toEqual([]);
  });

  it("does not treat a mailbox that merely contains 'example' as a placeholder", () => {
    expect(scanLines([`contact: ${at("example.person", "acme-corp.io")}`]).status).toBe(1);
  });

  it("ignores version pins and scoped package specifiers", () => {
    expect(
      scanLines([
        "@modelcontextprotocol/server@2.2.0",
        "npx @mermaid-js/mermaid-cli@11.4.0",
        "x@1.2.3",
      ]).flagged,
    ).toEqual([]);
  });
});

describe("fails closed on content it used to skip as 'clean' (QA-1-089 c, d)", () => {
  it("scans a text file over 8 MB instead of skipping it", () => {
    tmp = tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, "big.txt"), `token = ${TOKEN}\n${"a".repeat(9_000_000)}\n`);
    const r = scan(tmp.dir, ["--", "big.txt"]);
    expect(r.out).toContain("big.txt:1  [github-token]");
    expect(r.status).toBe(1);
  });

  it("exits 2 (never 0) on a file larger than it will read", () => {
    tmp = tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, "huge.txt"), "a".repeat(4096));
    const r = scan(tmp.dir, ["--", "huge.txt"], { FF_SCAN_MAX_BYTES: "1024" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("huge.txt");
    expect(r.out).not.toContain("clean");
  });

  it.each([
    [
      "a leading NUL",
      "nul.txt",
      Buffer.concat([Buffer.from([0, 10]), Buffer.from(`token = ${TOKEN}\n`)]),
    ],
    ["a NUL mid-file", "notes.md", Buffer.from(`intro\n\u0000\u0000\ntoken = ${TOKEN}\n`)],
    [
      "NULs on a line of their own (real UTF-16 is tested below)",
      "data.csv",
      Buffer.from(`a\u0000b\u0000\ntoken = ${TOKEN}\n`),
    ],
    [
      "no extension",
      "LICENSE-x",
      Buffer.concat([Buffer.from([0]), Buffer.from(`\ntoken = ${TOKEN}\n`)]),
    ],
  ])("scans a text file with %s", (_why, name, body) => {
    tmp = tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, name), body);
    const r = scan(tmp.dir, ["--", name]);
    expect(r.out).toContain(`${name}:`);
    expect(r.status).toBe(1);
  });

  it("still skips a genuine binary format, and says so", () => {
    tmp = tempDir("ff-scan-");
    writeFileSync(
      path.join(tmp.dir, "a.parquet"),
      Buffer.from([0x50, 0x41, 0x52, 0x31, 0, 0, 1, 2]),
    );
    const r = scan(tmp.dir, ["--", "a.parquet"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/1 binary file\(s\) skipped/);
  });

  it("a binary extension does not hide text: a .png without NUL bytes is scanned", () => {
    tmp = tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, "shot.png"), `token = ${TOKEN}\n`);
    expect(scan(tmp.dir, ["--", "shot.png"]).status).toBe(1);
  });
});

describe("email rule — what is not a mailbox", () => {
  it("allows the git SSH transport user and URL userinfo, but not mailto: or a bare address", () => {
    const r = scanLines([
      `remote: ${at("git", "github.com")}:owner/repo.git`,
      `dep: git+ssh://${at("git", "github.com")}/x/x.git#abc`,
      `url: https://${at("u", "github.com")}/`,
      `url: https://user:${at("pw", "github.com")}/x`,
      `mail: mailto:${at("jane", "acme-corp.io")}`,
      `see ${at("jane", "acme-corp.io")} or //path ${at("bob", "acme-corp.io")}`,
    ]);
    expect(r.flagged.map((f) => f.line)).toEqual([5, 6, 6]);
  });
});

// ---------------------------------------------------------------------------------------------
// The deny-list (QA-2-027), the scanner's own file (QA-2-030), other text encodings (QA-1-089 d)
// and commit messages (QA-2-026). Every case writes its own files and its own deny-list.
// ---------------------------------------------------------------------------------------------

/**
 * Scan `files` (relative path -> contents) in one run, with `deny` as the local deny-list.
 * Returns every finding as `{file, line, rule}`, the exit code and the whole output.
 */
function scanFiles(
  files: Record<string, string | Buffer>,
  deny: string[] = [],
  args: string[] = [],
  env: Record<string, string> = {},
) {
  tmp ??= tempDir("ff-scan-");
  const dir = tmp.dir;
  const list = path.join(dir, "deny-list.txt");
  writeFileSync(list, deny.map((d) => `${d}\n`).join(""));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  const r = scan(dir, [...args, "--", ...Object.keys(files)], { FF_SCAN_DENYLIST: list, ...env });
  const findings = [...r.out.matchAll(/^ {2}(.+):(\d+) {2}\[([a-z-]+)\]$/gm)].map((m) => ({
    file: m[1] ?? "",
    line: Number(m[2]),
    rule: m[3] ?? "",
  }));
  return { ...r, findings };
}

describe("the deny-list finds a name however the space between its words is written (QA-2-027)", () => {
  // assembled at run time: the list holds the name, the files hold its variants
  const WORDS = ["Example", "Gridiron", "Gurus"] as const;
  const DENY = WORDS.join(" ").toLowerCase();
  /** What can stand between two words of a name in prose, code, wrapped text or copied text. */
  const SEPARATORS: [string, string][] = [
    ["one space", " "],
    ["two spaces", "  "],
    ["a tab", "\t"],
    ["a no-break space (U+00A0)", " "],
    ["a narrow no-break space (U+202F)", " "],
    ["an ideographic space (U+3000)", "　"],
    ["a zero-width space and a space", "​ "],
    ["a line break", "\n"],
    ["a CRLF line break", "\r\n"],
    ["a line break and indentation", "\n      "],
    ["a wrapped // comment", "\n  // "],
    ["a wrapped # comment", "\n# "],
    ["a wrapped JSDoc line", "\n   * "],
    ["a wrapped Markdown quote", "\n> "],
    ["a hyphen", "-"],
    ["an underscore", "_"],
    ["nothing (one CamelCase word)", ""],
  ];

  it("flags every separator, in either gap or both, at the line where the name starts", () => {
    const files: Record<string, string> = {};
    const expected: Record<string, number> = {};
    SEPARATORS.forEach(([, sep], i) => {
      for (const gaps of [
        [sep, " "],
        [" ", sep],
        [sep, sep],
      ] as const) {
        const name = `${WORDS[0]}${gaps[0]}${WORDS[1]}${gaps[1]}${WORDS[2]}`;
        const file = `case-${String(i)}-${String(Object.keys(files).length)}.md`;
        files[file] = `# Notes\n\nThe league notes for ${name} are below.\nLast line.\n`;
        expected[file] = 3;
      }
    });
    const r = scanFiles(files, [DENY]);
    const got = Object.fromEntries(
      r.findings.filter((f) => f.rule === "personal-identifier").map((f) => [f.file, f.line]),
    );
    expect(got).toEqual(expected);
    expect(r.status).toBe(1);
    expect(r.out).not.toMatch(/gridiron/i); // the name itself is never printed
  });

  it("flags every case and compatibility form, and a list term written with irregular spacing", () => {
    const files = {
      "upper.md": "EXAMPLE GRIDIRON GURUS\n",
      "mixed.md": "eXaMpLe gRiDiRoN gUrUs\n",
      "fullwidth.md": "Ｅｘａｍｐｌｅ Gridiron Gurus\n",
      "slug.yaml": "id: example-gridiron-gurus\n",
      "camel.ts": "const ExampleGridironGurus = 1;\n",
    };
    for (const listed of [DENY, "  EXAMPLE   Gridiron\tgurus  ", "Example-Gridiron-Gurus"]) {
      const r = scanFiles(files, [listed]);
      expect(r.findings.map((f) => f.file).sort(), JSON.stringify(listed)).toEqual(
        Object.keys(files).sort(),
      );
    }
  });

  it("is never narrower than a plain per-line substring match, punctuation and apostrophes included", () => {
    // (a list line starting with `#` is a comment, so no term below starts with one)
    const terms = [
      "fan club #1",
      "o'brien's crew",
      "j.r. league",
      "a+b dynasty",
      "zqxv-private-league-name",
    ];
    const lines = [
      "We are Fan Club #1.",
      "Welcome to O’Brien’s Crew!",
      "See J.R. League for details",
      "the A+B Dynasty standings",
      "League: ZQXV-Private-League-Name",
    ];
    const r = scanFiles({ "p.md": `${lines.join("\n")}\n` }, terms);
    expect(r.findings.map((f) => f.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it("applies to a line carrying the `scan-secrets: allow` marker (a real name is never a placeholder)", () => {
    const r = scanFiles({ "a.md": "league: Example Gridiron Gurus  # scan-secrets: allow\n" }, [
      DENY,
    ]);
    expect(r.findings).toEqual([{ file: "a.md", line: 1, rule: "personal-identifier" }]);
  });

  it("does not glue words: separate words, a partial name and a split single-word term stay clean", () => {
    const r = scanFiles(
      {
        "apart.md": "An Example of the Gridiron Gurus style.\n",
        "partial.md": "Example Gridiron\n\nThe end.\n",
        "other.md": "Example Gridiron Guru\n",
        // a gap between the term's words may be missing, but no gap is ever moved inside a word
        "moved.md": "Exam pleGridiron Gurus and ExampleGrid ironGurus\n",
      },
      [DENY],
    );
    expect(r.findings).toEqual([]);
    expect(r.status).toBe(0);
    // a one-word term is never matched across a separator ("gu rus" is not "gurus")
    const split = scanFiles({ "split.md": "the gu rus of old\nthe gu\nrus of old\ngu-rus\n" }, [
      "gurus",
    ]);
    expect(split.findings).toEqual([]);
    expect(scanFiles({ "whole.md": "the Gurus of old\n" }, ["gurus"]).status).toBe(1);
    // the same for a short term: "at end" is not found in "a tendency"
    expect(scanFiles({ "short.md": "a tendency to wander\n" }, ["at end"]).findings).toEqual([]);
  });
});

describe("the scanner's own file is scanned like any other (QA-2-030)", () => {
  const LINE = `// e.g. ${at("someone", "Someones-MacBook.lan")} is refused; league: Example Gridiron Gurus; ${TOKEN}`;
  const DENY = ["example gridiron gurus"];
  const PATHS = ["scripts/dev/scan-secrets.mjs", "scripts/dev/notes.mjs", "scan-secrets.mjs"];

  it("the same line gives the same findings at every path, the scanner's own included", () => {
    const own = readFileSync(SCANNER, "utf8");
    const files = Object.fromEntries(PATHS.map((p) => [p, `${own}\n${LINE}\n`]));
    const r = scanFiles(files, DENY);
    const line = own.split("\n").length + 1;
    for (const p of PATHS)
      expect(
        r.findings.filter((f) => f.file === p),
        p,
      ).toEqual([
        { file: p, line, rule: "github-token" },
        { file: p, line, rule: "email-address" },
        { file: p, line, rule: "personal-identifier" },
      ]);
  });

  it("the same holds through --index (the pre-commit path)", () => {
    tmp = tempDir("ff-scan-");
    const own = readFileSync(SCANNER, "utf8");
    const genv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tmp?.dir, env: { ...process.env, ...genv } });
    expect(git(["init", "-q"]).status).toBe(0);
    for (const p of PATHS) {
      mkdirSync(path.dirname(path.join(tmp.dir, p)), { recursive: true });
      writeFileSync(path.join(tmp.dir, p), `${own}\n${LINE}\n`);
    }
    expect(git(["add", "--", ...PATHS]).status).toBe(0);
    writeFileSync(path.join(tmp.dir, "deny.txt"), `${DENY.join("\n")}\n`);
    const r = scan(tmp.dir, ["--index"], {
      ...genv,
      FF_SCAN_DENYLIST: path.join(tmp.dir, "deny.txt"),
    });
    expect(r.status).toBe(1);
    for (const p of PATHS)
      expect(r.out, p).toContain(`${p}:${String(own.split("\n").length + 1)}  [email-address]`);
  });

  it("the scanner's own source scans clean as itself — it is read, not skipped", () => {
    const r = scan(ROOT, ["--", "scripts/dev/scan-secrets.mjs"]);
    expect(r.out).toMatch(/clean \(1 text file\(s\) scanned/);
    expect(r.status).toBe(0);
  });

  it("the gitleaks fixture keeps its credential exemption but not the address rule or the deny-list", () => {
    const fixture = readFileSync(
      path.join(ROOT, "scripts/gitleaks-selftest/must-flag.txt"),
      "utf8",
    );
    const rel = "scripts/gitleaks-selftest/must-flag.txt";
    expect(scanFiles({ [rel]: fixture }, DENY).status).toBe(0);
    const n = fixture.split("\n").length + 1;
    const r = scanFiles({ [rel]: `${fixture}\n${LINE}\n` }, DENY);
    expect(r.findings).toEqual([
      { file: rel, line: n, rule: "email-address" },
      { file: rel, line: n, rule: "personal-identifier" },
    ]);
  });
});

describe("a text file in another encoding is decoded before matching, never passed as clean (QA-1-089 d)", () => {
  const DENY = ["café gridiron gurus"];
  const PAYLOADS: [string, string][] = [
    ["github-token", `token = ${TOKEN}`],
    ["email-address", `contact: ${at("jane.doe", "acme-corp.io")}`],
    ["yahoo-league-or-team-key", `league: ${key("461", "l", "424242")}`],
    ["personal-identifier", "league: Café Gridiron Gurus"],
  ];
  const le16 = (s: string) => Buffer.from(s, "utf16le");
  const be16 = (s: string) => Buffer.from(le16(s)).swap16();
  const le32 = (s: string) => {
    const cps = Array.from(s, (c) => c.codePointAt(0) ?? 0);
    const b = Buffer.alloc(cps.length * 4);
    cps.forEach((cp, i) => b.writeUInt32LE(cp, i * 4));
    return b;
  };
  const be32 = (s: string) => {
    const b = Buffer.from(le32(s));
    return b.swap32();
  };
  const bom = (bytes: number[], body: Buffer) => Buffer.concat([Buffer.from(bytes), body]);
  const ENCODINGS: [string, (s: string) => Buffer][] = [
    ["UTF-16LE with a BOM", (s) => bom([0xff, 0xfe], le16(s))],
    ["UTF-16LE without a BOM", le16],
    ["UTF-16BE with a BOM", (s) => bom([0xfe, 0xff], be16(s))],
    ["UTF-16BE without a BOM", be16],
    ["UTF-16LE after a stray byte (odd offset)", (s) => bom([0x41], le16(s))],
    ["UTF-32LE with a BOM", (s) => bom([0xff, 0xfe, 0, 0], le32(s))],
    ["UTF-32BE with a BOM", (s) => bom([0, 0, 0xfe, 0xff], be32(s))],
    ["UTF-32LE without a BOM", le32],
    [
      "UTF-16LE after 9 KB of UTF-8 text",
      (s) => Buffer.concat([Buffer.from("x\n".repeat(4608)), le16(s)]),
    ],
    ["Latin-1", (s) => Buffer.from(s, "latin1")],
  ];
  const NAMES = ["notes.txt", "data.csv", "README", "page.md"];

  it.each(ENCODINGS)("%s: every rule and the deny-list still fire", (_enc, encode) => {
    const files: Record<string, Buffer> = {};
    const want: string[] = [];
    PAYLOADS.forEach(([rule, line], i) => {
      const name = `${String(i)}-${NAMES[i % NAMES.length] ?? "x"}`;
      files[name] = encode(`intro\r\n${line}\r\nend\r\n`);
      want.push(`${name} ${rule}`);
    });
    const r = scanFiles(files, DENY);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("clean");
    const got = new Set(r.findings.map((f) => `${f.file} ${f.rule}`));
    expect(want.filter((w) => !got.has(w))).toEqual([]);
  });

  it("Windows-1252: a curly apostrophe (0x92) still matches a deny-listed name written with '", () => {
    const body = Buffer.concat([
      Buffer.from("Welcome to O"),
      Buffer.from([0x92]),
      Buffer.from("Brien"),
      Buffer.from([0x92]),
      Buffer.from("s Crew\r\n"),
    ]);
    const r = scanFiles({ "cp1252.txt": body }, ["o'brien's crew"]);
    expect(r.findings).toEqual([{ file: "cp1252.txt", line: 1, rule: "personal-identifier" }]);
  });

  it.each(ENCODINGS)(
    "%s: clean text stays clean (the extra decodings add no findings)",
    (_enc, encode) => {
      const r = scanFiles(
        { "clean.txt": encode("Nothing secret here.\r\nCafé notes, week 3: 461.l.1000\r\n") },
        DENY,
      );
      expect(r.findings).toEqual([]);
      expect(r.status).toBe(0);
    },
  );
});

describe("--message and --editmsg scan a commit message (QA-2-026)", () => {
  const DENY = ["example gridiron gurus"];
  const BAD: [string, string][] = [
    ["github-token", `token ${TOKEN}`],
    ["email-address", `Reviewed-by: Someone <${at("someone", "Someones-MacBook.lan")}>`],
    ["personal-identifier", "notes for Example Gridiron\nGurus"],
    ["yahoo-league-or-team-key", `league ${key("nfl", "l", "424242")}`],
  ];

  /** Scan `msg` as a commit message with `flag`, the deny-list above active. */
  function scanMessage(msg: string, flag = "--message") {
    tmp ??= tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, "deny-list.txt"), `${DENY.join("\n")}\n`);
    writeFileSync(path.join(tmp.dir, "m"), msg);
    return scan(tmp.dir, [flag, "m"], { FF_SCAN_DENYLIST: path.join(tmp.dir, "deny-list.txt") });
  }

  it("a missing or unreadable message file is an error (exit 2), never clean", () => {
    tmp ??= tempDir("ff-scan-");
    for (const flag of ["--message", "--editmsg"]) {
      const r = scan(tmp.dir, [flag, "no-such-file"]);
      expect(r.status, flag).toBe(2);
      expect(r.out).not.toContain("clean");
      expect(scan(tmp.dir, [flag]).status, `${flag} without a file`).toBe(2);
    }
  });

  it.each(BAD)(
    "--message and --editmsg flag %s in the subject, the body or a trailer",
    (rule, text) => {
      for (const [flag, msg] of [
        `docs: ${text}\n`,
        `docs: notes\n\n${text}\n`,
        `docs: notes\n\nbody\n\n${text}\n`,
      ].flatMap(
        (m) =>
          [
            ["--message", m],
            ["--editmsg", m],
          ] as const,
      )) {
        const s = scanMessage(msg, flag);
        expect(s.status, `${flag} ${msg}`).toBe(1);
        expect(s.out).toContain(`[${rule}]`);
        expect(s.out).toMatch(/commit message:\d+ {2}\[/);
        expect(s.out).not.toContain(TOKEN);
        expect(s.out).not.toContain("Someones-MacBook");
      }
    },
  );

  it("--message - reads the message from standard input", () => {
    tmp ??= tempDir("ff-scan-");
    const r = spawnSync(process.execPath, [SCANNER, "--message", "-"], {
      cwd: tmp.dir,
      input: `fix: x\n\ntoken ${TOKEN}\n`,
      encoding: "utf8",
      env: { ...process.env, FF_SCAN_DENYLIST: "/dev/null" },
    });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("commit message:3  [github-token]");
  });

  it("--message does not honour the allow marker: a message never needs a secret-shaped value", () => {
    tmp ??= tempDir("ff-scan-");
    writeFileSync(path.join(tmp.dir, "m"), `fix: x\n\ntoken ${TOKEN} scan-secrets: allow\n`);
    expect(scan(tmp.dir, ["--message", "m"]).status).toBe(1);
  });

  it("--message passes a clean message with placeholder addresses, version pins and finding ids", () => {
    tmp ??= tempDir("ff-scan-");
    writeFileSync(
      path.join(tmp.dir, "m"),
      `fix(tooling): scan messages (QA-2-026)\n\nPins x@1.2.3; league ${key("461", "l", "1000")}.\n\nReviewed-by: Probe <${at("1+probe", "users.noreply.github.com")}>\n`,
    );
    const r = scan(tmp.dir, ["--message", "m"]);
    expect(r.out).toContain("commit message");
    expect(r.status).toBe(0);
  });

  it("--editmsg scans the template comments but not the diff `git commit -v` adds below the scissors", () => {
    tmp ??= tempDir("ff-scan-");
    const scissors = "# ------------------------ >8 ------------------------";
    const verbose = [
      scissors,
      "# Do not modify or remove the line above.",
      "# Everything below it will be ignored.",
      "diff --git a/a.txt b/a.txt",
      "index de98044..d68dd40 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,1 @@",
      ` keep ${at("ctx", "acme-corp.io")}`,
      `-token = ${TOKEN}`,
      `+league ${key("461", "l", "424242")} scan-secrets: allow`,
      "\\ No newline at end of file",
    ];
    writeFileSync(
      path.join(tmp.dir, "clean"),
      `fix: remove a token\n\n# On branch build/x\n${verbose.join("\n")}\n`,
    );
    expect(scan(tmp.dir, ["--editmsg", "clean"]).status).toBe(0);
    // above the scissors, comment lines are scanned (with -m they are kept in the commit)
    writeFileSync(
      path.join(tmp.dir, "comment"),
      `fix: x\n# token ${TOKEN}\n${verbose.join("\n")}\n`,
    );
    expect(scan(tmp.dir, ["--editmsg", "comment"]).out).toContain(
      "commit message:2  [github-token]",
    );
    // a line after a typed scissors line that is not part of a diff is kept by git without -v
    writeFileSync(path.join(tmp.dir, "typed"), `fix: x\n${scissors}\ntoken ${TOKEN}\n`);
    const t = scan(tmp.dir, ["--editmsg", "typed"]);
    expect(t.out).toContain("commit message:3  [github-token]");
    expect(t.status).toBe(1);
    // --message is verbatim: commit-tree keeps every byte, so nothing below a scissors line is dropped
    expect(scan(tmp.dir, ["--message", "clean"]).status).toBe(1);
  });
});
