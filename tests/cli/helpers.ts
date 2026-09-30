// helpers.ts — an in-memory CliIo for the `ff` unit tests: captured stdout/stderr, a temp HOME with
// config/cache dirs, a fixed clock, a recording fake executor (launchctl/osascript are never run),
// and a fetch that fails the test if anything reaches the network.
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fixedClock, type FixedClock } from "../../src/domain/clock.js";
import type { FetchLike } from "../../src/http/client.js";
import type { CliIo, Exec, ExecResult } from "../../src/cli/io.js";

/** The repository root (fixtures live under it). */
export const ROOT = path.resolve(import.meta.dirname, "..", "..");
/** The fixture tree FF_FIXTURE_DIR points at. */
export const FIXTURES = path.join(ROOT, "fixtures");
/** The placeholder fixture league. */
export const FIXTURE_LEAGUE = path.join(FIXTURES, "manual", "league.yaml");

/** A captured writable stream. */
export class Capture extends PassThrough {
  private chunks: string[] = [];
  constructor() {
    super();
    this.on("data", (c: Buffer) => this.chunks.push(c.toString("utf8")));
  }
  get text(): string {
    return this.chunks.join("");
  }
}

/** One recorded exec call. */
export interface ExecCall {
  readonly file: string;
  readonly args: readonly string[];
}

/** A fake executor: records calls; `respond` decides the result (default exit 0). */
export function fakeExec(respond: (c: ExecCall) => Partial<ExecResult> = () => ({})): {
  exec: Exec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: Exec = (file, args) => {
    const c = { file, args: [...args] };
    calls.push(c);
    const r = respond(c);
    return Promise.resolve({
      code: r.code === undefined ? 0 : r.code,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    });
  };
  return { exec, calls };
}

/** A fetch that throws — offline code must never call it. */
export const noNetwork: FetchLike = () => {
  throw new Error("network access in a test");
};

/** A temp sandbox: HOME, config and cache dirs (not created unless asked), cleanup. */
export interface Sandbox {
  readonly dir: string;
  readonly home: string;
  readonly configDir: string;
  readonly cacheDir: string;
  cleanup(): void;
}

/** Creates a sandbox under the OS temp dir (realpath'd; 0700). */
export function sandbox(opts: { create?: boolean } = {}): Sandbox {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-cli-")));
  chmodSync(dir, 0o700);
  const home = path.join(dir, "home");
  mkdirSync(home, { mode: 0o700 });
  const configDir = path.join(dir, "config");
  const cacheDir = path.join(dir, "cache");
  if (opts.create === true) {
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(cacheDir, { mode: 0o700 });
  }
  return {
    dir,
    home,
    configDir,
    cacheDir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fake package root with a built `dist/cli.js` (for print-config/install-launchd). */
let pkgCounter = 0;
export function fakePackage(sb: Sandbox, opts: { built?: boolean } = {}): string {
  pkgCounter++;
  const root = path.join(sb.dir, `pkg${String(pkgCounter)}`);
  mkdirSync(path.join(root, "dist"), { recursive: true });
  if (opts.built !== false)
    writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  return root;
}

/** The io under test. */
export interface TestIo extends CliIo {
  readonly out: Capture;
  readonly err: Capture;
  readonly clock: FixedClock;
}

/** An io over a sandbox. `env` is merged over FF_CONFIG_DIR/FF_CACHE_DIR pointing into it. */
export function makeIo(
  sb: Sandbox,
  over: Partial<Omit<CliIo, "stdout" | "stderr" | "clock">> & { clock?: FixedClock } = {},
): TestIo {
  const out = new Capture();
  const err = new Capture();
  const env = { FF_CONFIG_DIR: sb.configDir, FF_CACHE_DIR: sb.cacheDir, ...(over.env ?? {}) };
  const stdin = new PassThrough();
  return {
    home: sb.home,
    stdin,
    platform: "linux",
    exec: fakeExec().exec,
    fetch: noNetwork,
    packageRoot: ROOT,
    execPath: process.execPath,
    nodeVersion: "24.21.0",
    uid: 501,
    pid: 4242,
    ...over,
    env,
    stdout: out,
    stderr: err,
    out,
    err,
    clock: over.clock ?? fixedClock("2026-09-30T18:00:00.000Z"),
  };
}

/** Env for fixture mode (the in-repo placeholder league + nflverse/weather fixtures). */
export function fixtureEnv(): Record<string, string> {
  return { FF_FIXTURE_DIR: FIXTURES, FF_LEAGUE_FILE: FIXTURE_LEAGUE };
}

/** The instant the fixture refresh runs at: week 5 of 2026 is in the weather fixtures' horizon. */
export const FIXTURE_NOW = "2026-10-01T12:00:00.000Z";

/**
 * Copies a closed cache dir (store + ds files) into `dest`, restoring 0700 on directories and 0600
 * on files (a copy must pass the same mode rules as the original).
 */
export function copyCache(src: string, dest: string): void {
  cpSync(src, dest, { recursive: true });
  const fix = (p: string): void => {
    const st = lstatSync(p);
    if (st.isDirectory()) {
      chmodSync(p, 0o700);
      for (const n of readdirSync(p)) fix(path.join(p, n));
    } else if (st.isFile()) chmodSync(p, 0o600);
  };
  fix(dest);
}
