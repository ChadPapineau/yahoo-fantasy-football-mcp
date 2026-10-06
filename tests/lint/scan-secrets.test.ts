// scan-secrets.test.ts — scripts/dev/scan-secrets.mjs is the ONLY layer that runs before a value
// reaches the public repo (gitleaks runs in CI, after the push), so it must flag at least what
// gitleaks flags and fail closed on anything it cannot scan (CONTRIBUTING.md Security;
// .gitleaks.toml; QA-1-089). Every well-formed value below is assembled at run time so this file
// stays clean.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
    ["UTF-16-like NULs", "data.csv", Buffer.from(`a\u0000b\u0000\ntoken = ${TOKEN}\n`)],
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
