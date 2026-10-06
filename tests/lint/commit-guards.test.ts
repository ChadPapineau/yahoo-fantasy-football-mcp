// commit-guards.test.ts — the two local commit paths (.githooks/pre-commit for a plain `git commit`,
// scripts/dev/commit-paths.sh for agents) must scan EVERY staged blob whatever its name or previous
// type (QA-1-088), and must refuse an author/committer address that is not a no-reply or reserved
// placeholder (QA-1-095): CLAUDE.md Security — never commit a credential, token or email address.
// Each test builds a throwaway repository (and a bare `origin` for commit-paths.sh) in a temp dir,
// with git's global/system config isolated, so nothing here touches the real clone or its config.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT, tempDir } from "./helpers.js";

/** A well-formed (fake) GitHub token, split so no literal in this file matches. */
const TOKEN = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_");
const PROBE_EMAIL = "probe@example.invalid";
/** A machine-derived style address (local user name, then host and router domain): what git invents with no user.email. */
const MACHINE_EMAIL = ["dev", "build-host.lan"].join("@");
const HAS_ZSH = existsSync("/bin/zsh") || spawnSync("zsh", ["-c", "true"]).status === 0;

let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

/** The environment every git/hook call runs in: no inherited GIT_* state, no global/system config. */
function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    FF_SCAN_DENYLIST: "/dev/null",
    // the hook runs `scripts/dev/with-node.sh node …`; the stub below execs `node` from PATH
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra,
  };
}

interface Repo {
  dir: string;
  git: (args: string[], extra?: Record<string, string>) => { status: number | null; out: string };
  write: (rel: string, body: string) => void;
}

function makeRepo(): Repo {
  tmp = tempDir("ff-guard-");
  const home = path.join(tmp.dir, "home");
  const dir = path.join(tmp.dir, "repo");
  mkdirSync(home);
  mkdirSync(dir);
  const git: Repo["git"] = (args, extra = {}) => {
    const r = spawnSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: isolatedEnv(home, extra),
      timeout: 60_000,
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const write: Repo["write"] = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  };
  for (const rel of [
    ".githooks/pre-commit",
    "scripts/dev/scan-secrets.mjs",
    "scripts/dev/commit-paths.sh",
  ]) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  write("scripts/dev/with-node.sh", '#!/bin/sh\nexec "$@"\n');
  chmodSync(path.join(dir, "scripts/dev/with-node.sh"), 0o755);
  write(".nvmrc", "24\n");
  expect(git(["init", "-q", "-b", "build/probe"]).status).toBe(0);
  git(["config", "user.name", "probe"]);
  git(["config", "user.email", PROBE_EMAIL]);
  git(["config", "core.hooksPath", ".githooks"]);
  git(["add", "-A"]);
  const init = git(["commit", "-qm", "init"]);
  expect(init.status, init.out).toBe(0);
  return { dir, git, write };
}

const head = (repo: Repo) => repo.git(["rev-parse", "HEAD"]).out.trim();

describe(".githooks/pre-commit scans every staged blob (QA-1-088)", () => {
  it("blocks a plain file holding a token (baseline)", () => {
    const repo = makeRepo();
    repo.write("plain.txt", `token = ${TOKEN}\n`);
    repo.git(["add", "plain.txt"]);
    const r = repo.git(["commit", "-qm", "plain"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("plain.txt:1  [github-token]");
  });

  it.each([
    ["notes-é.txt"],
    ["tab\there.txt"],
    ['quote"d.txt'],
    ["back\\slash.txt"],
    ["日本語/メモ.txt"],
  ])("blocks a token in a file git would C-quote: %j", (name) => {
    const repo = makeRepo();
    const before = head(repo);
    repo.write(name, `token = ${TOKEN}\n`);
    repo.git(["add", "--", name]);
    const r = repo.git(["commit", "-qm", "quoted"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("[github-token]");
    expect(head(repo)).toBe(before);
  });

  it("blocks a token in a tracked symlink replaced by a regular file (type change)", () => {
    const repo = makeRepo();
    symlinkSync(".nvmrc", path.join(repo.dir, "link.txt"));
    repo.git(["add", "link.txt"]);
    expect(repo.git(["commit", "-qm", "link"]).status).toBe(0);
    const before = head(repo);
    unlinkSync(path.join(repo.dir, "link.txt"));
    repo.write("link.txt", `token = ${TOKEN}\n`);
    repo.git(["add", "link.txt"]);
    const r = repo.git(["commit", "-qm", "typechange"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain("link.txt:1  [github-token]");
    expect(head(repo)).toBe(before);
  });

  it("still lets a clean non-ASCII-named file through (no blanket refusal)", () => {
    const repo = makeRepo();
    repo.write("notes-é.txt", "nothing secret here\n");
    repo.git(["add", "notes-é.txt"]);
    const r = repo.git(["commit", "-qm", "clean"]);
    expect(r.status, r.out).toBe(0);
  });

  it("--staged fails closed (exit 2) on a path that is not in the index, never 'clean'", () => {
    const repo = makeRepo();
    const r = spawnSync(
      process.execPath,
      [
        path.join(repo.dir, "scripts/dev/scan-secrets.mjs"),
        "--staged",
        "--",
        '"notes-\\303\\251.txt"',
      ],
      { cwd: repo.dir, encoding: "utf8", env: isolatedEnv(repo.dir) },
    );
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).not.toContain("clean");
  });
});

describe(".githooks/pre-commit refuses iCloud/Finder conflict-copy names", () => {
  // iCloud and Finder name a conflict copy "name 2.ext" (or a directory "name 2"); in an
  // iCloud-synced checkout they reappear on their own, and a stray `git add -A` would commit e.g.
  // ".github/workflows/ci 2.yml" — a second CI workflow. Only ADDED names are refused, so deleting
  // a copy that slipped in is never blocked.
  it.each([
    [".github/workflows/ci 2.yml"],
    ["scripts/dev/scan-secrets 2.mjs"],
    ["src/foo.test 3.ts"],
    ["src/cli 2/serve.ts"],
    ["coverage 2"],
  ])("refuses to add %j and commits nothing", (name) => {
    const repo = makeRepo();
    const before = head(repo);
    repo.write(name, "nothing secret here\n");
    repo.git(["add", "--", name]);
    const r = repo.git(["commit", "-qm", "conflict copy"]);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toContain(`${name}  [conflict-copy-name]`);
    expect(head(repo)).toBe(before);
  });

  it.each([
    ["v2.ts"],
    ["round-2.md"],
    ["Season 2026 notes.md"],
    ["fixture2.json"],
    ["src/x2/y.ts"],
  ])("lets an ordinary name through: %j", (name) => {
    const repo = makeRepo();
    repo.write(name, "nothing secret here\n");
    repo.git(["add", "--", name]);
    const r = repo.git(["commit", "-qm", "ordinary"]);
    expect(r.status, r.out).toBe(0);
  });

  it("never blocks deleting a conflict copy that is already tracked (the cleanup path)", () => {
    const repo = makeRepo();
    repo.write("ci 2.yml", "name: copy\n");
    repo.git(["add", "ci 2.yml"]);
    // the copy got in some other way (hook disabled for this one setup commit)
    expect(repo.git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "slipped in"]).status).toBe(
      0,
    );
    repo.git(["rm", "-q", "ci 2.yml"]);
    const r = repo.git(["commit", "-qm", "remove the copy"]);
    expect(r.status, r.out).toBe(0);
  });
});

describe("commit identity guard (QA-1-095)", () => {
  it("pre-commit refuses a machine-derived author address", () => {
    const repo = makeRepo();
    repo.git(["config", "user.email", MACHINE_EMAIL]);
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", "a"]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/identity/i);
    expect(r.out).not.toContain(MACHINE_EMAIL); // the guard never prints the address itself
    expect(head(repo)).toBe(before);
  });

  it("pre-commit refuses when only the author (env) is not a placeholder", () => {
    const repo = makeRepo();
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    const r = repo.git(["commit", "-qm", "a"], { GIT_AUTHOR_EMAIL: MACHINE_EMAIL });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/identity/i);
  });

  it("pre-commit accepts a GitHub no-reply address", () => {
    const repo = makeRepo();
    repo.git(["config", "user.email", "1234567+probe@users.noreply.github.com"]);
    repo.write("a.txt", "hello\n");
    repo.git(["add", "a.txt"]);
    expect(repo.git(["commit", "-qm", "a"]).status).toBe(0);
  });
});

describe.skipIf(!HAS_ZSH)("scripts/dev/commit-paths.sh (macOS dev tool; zsh)", () => {
  function withOrigin(repo: Repo) {
    const bare = path.join(path.dirname(repo.dir), "origin.git");
    expect(spawnSync("git", ["init", "-q", "--bare", bare]).status).toBe(0);
    repo.git(["remote", "add", "origin", bare]);
    expect(repo.git(["push", "-q", "origin", "build/probe"]).status).toBe(0);
    return bare;
  }
  const commitPaths = (repo: Repo, args: string[], extra: Record<string, string> = {}) =>
    spawnSync("zsh", [path.join(repo.dir, "scripts/dev/commit-paths.sh"), ...args], {
      cwd: repo.dir,
      encoding: "utf8",
      env: isolatedEnv(path.join(path.dirname(repo.dir), "home"), {
        TMPDIR: path.dirname(repo.dir),
        ...extra,
      }),
      timeout: 120_000,
    });

  it("refuses a machine-derived identity and commits nothing (QA-1-095)", () => {
    const repo = makeRepo();
    withOrigin(repo);
    repo.git(["config", "user.email", MACHINE_EMAIL]);
    const before = head(repo);
    repo.write("a.txt", "hello\n");
    const r = commitPaths(repo, ["fix: a", "a.txt"]);
    expect(r.status).toBe(10);
    expect(`${r.stdout}${r.stderr}`).toMatch(/identity/i);
    expect(head(repo)).toBe(before);
  });

  it("commits and pushes a clean non-ASCII-named file (QA-1-088: names are NUL-separated, not C-quoted)", () => {
    const repo = makeRepo();
    const bare = withOrigin(repo);
    repo.write("docs/notes-é.txt", "nothing secret\n");
    const r = commitPaths(repo, ["docs: notes", "docs"]);
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const files = spawnSync(
      "git",
      ["--git-dir", bare, "ls-tree", "-r", "-z", "--name-only", "build/probe"],
      {
        encoding: "utf8",
      },
    ).stdout.split("\0");
    expect(files).toContain("docs/notes-é.txt");
  });

  it("refuses a token in a non-ASCII-named file and commits nothing (QA-1-088)", () => {
    const repo = makeRepo();
    withOrigin(repo);
    const before = head(repo);
    repo.write("docs/notes-é.txt", `token = ${TOKEN}\n`);
    const r = commitPaths(repo, ["docs: notes", "docs"]);
    expect(r.status).toBe(9);
    expect(`${r.stdout}${r.stderr}`).toContain("[github-token]");
    expect(head(repo)).toBe(before);
  });
});
