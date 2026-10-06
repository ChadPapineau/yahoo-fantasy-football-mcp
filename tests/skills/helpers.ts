// helpers.ts — temporary repository trees for the Skills tooling tests (plan 09 §4, §5.1; plan 05 §2
// "adversarial by default"): a copy of the real skills/ bundle plus the four source files the
// scripts read, so every failure case mutates a private copy and never the working tree.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** A scanner deny-list path that never exists, so tests never read the developer's real one. */
export const NO_DENYLIST = path.join(tmpdir(), "ff-skills-tests-no-denylist-does-not-exist.txt");

/** A fresh temporary repository: `cleanup()` removes it. */
export interface TempRepo {
  readonly root: string;
  readonly cleanup: () => void;
  /** Absolute path of a repository-relative file. */
  readonly p: (rel: string) => string;
  readonly read: (rel: string) => string;
  readonly write: (rel: string, body: string | object) => void;
  /** Replace `from` (must occur) with `to` in a file. */
  readonly edit: (rel: string, from: string | RegExp, to: string) => void;
  readonly readJson: (rel: string) => unknown;
}

/**
 * Copy the real skills/ bundle and the files the scripts read (package.json, src/mcp/envelope.ts,
 * src/mcp/errors.ts, scripts/dev/scan-secrets.mjs) into a temp directory.
 */
export function tempRepo(opts: { skills?: boolean } = {}): TempRepo {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-skills-")));
  const copy = (rel: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    cpSync(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  };
  copy("package.json");
  copy("src/mcp/envelope.ts");
  copy("src/mcp/errors.ts");
  copy("scripts/dev/scan-secrets.mjs");
  if (opts.skills !== false) copy("skills");
  const p = (rel: string) => path.join(root, rel);
  const read = (rel: string) => readFileSync(p(rel), "utf8");
  const write = (rel: string, body: string | object) => {
    mkdirSync(path.dirname(p(rel)), { recursive: true });
    writeFileSync(p(rel), typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
  };
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
    p,
    read,
    write,
    edit: (rel, from, to) => {
      const cur = read(rel);
      const next = cur.replace(from, to);
      if (next === cur) throw new Error(`edit: pattern not found in ${rel}: ${String(from)}`);
      write(rel, next);
    },
    readJson: (rel) => JSON.parse(read(rel)) as unknown,
  };
}

/** Run one of scripts/skills/*.mjs as a child process (argument array, no shell). */
export function runScript(
  script: "build-skills.mjs" | "check-skills.mjs",
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "skills", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FF_SCAN_DENYLIST: NO_DENYLIST, ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The four Phase-1a Skills. */
export const SKILLS = ["onboard", "retro", "start-sit", "stream-kdef"] as const;

/** The onboard guide's save commands (its ```sh blocks; there is exactly one). */
export const saveBlocks = [
  ...readFileSync(
    path.join(ROOT, "skills/onboard/references/onboard-league-yaml.md"),
    "utf8",
  ).matchAll(/^```sh\n([\s\S]*?)^```/gm),
].map((m) => m[1] ?? "");

/**
 * The shells a user may paste the save commands into, as installed here: `sh` (dash on Linux, bash
 * in POSIX mode on macOS), and dash, bash and zsh themselves (macOS's default interactive shell).
 */
export const SHELLS: readonly string[] = [
  "/bin/sh",
  "/bin/dash",
  "/bin/bash",
  existsSync("/bin/zsh") ? "/bin/zsh" : "/usr/bin/zsh",
].filter((s) => existsSync(s));

/**
 * Runs the onboard guide's save commands in a shell (`/bin/sh` unless `opts.using` names another)
 * as a user would paste them, under `home` and the given environment (PATH is /usr/bin:/bin), from
 * `opts.cwd` (default: the folder holding `home`, so a relative path never lands in the checkout).
 * The "save the YAML … with any editor" comment line stands for the user's editor: it is replaced
 * by a copy of the fixture league to the very path the `chmod 600` line names (so the test follows
 * the guide's path, whatever it is) unless the commands left no folder to save in (a `STOP:` on
 * FF_CONFIG_DIR), and `ff` is a stub that logs its arguments. zsh runs with `-f` (no startup files).
 */
export function runSaveSteps(
  env: Record<string, string>,
  home: string,
  opts: { using?: string; cwd?: string } = {},
): { status: number | null; stdout: string; stderr: string; ffLog: string } {
  const block = saveBlocks[0] ?? "";
  const target = /^chmod 600 (.+)$/m.exec(block)?.[1];
  if (target === undefined) throw new Error("the save commands have no `chmod 600 <file>` line");
  const script = block
    .split("\n")
    .map((l) =>
      l.startsWith("# save the YAML")
        ? `[ ${target} = /league.yaml ] || cp "$FF_TEST_YAML" ${target}`
        : l,
    )
    .join("\n");
  const log = path.join(home, "..", "ff.log");
  const shell = opts.using ?? "/bin/sh";
  const flags = shell.endsWith("/zsh") ? ["-f", "-c"] : ["-c"];
  const r = spawnSync(shell, [...flags, `ff() { echo "ff $*" >> "$FF_TEST_LOG"; }\n${script}`], {
    cwd: opts.cwd ?? path.dirname(home),
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      FF_TEST_YAML: path.join(ROOT, "fixtures", "manual", "league.yaml"),
      FF_TEST_LOG: log,
      ...env,
    },
    timeout: 30_000,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    ffLog: existsSync(log) ? readFileSync(log, "utf8") : "",
  };
}
