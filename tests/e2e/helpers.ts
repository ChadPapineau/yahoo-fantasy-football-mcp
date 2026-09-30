// helpers.ts — the end-to-end harness (plan 05 §4.2; plan 10 A3a/A6/A13/A15): the BUILT package
// (`node dist/cli.js`) as a real child process over real stdio. A private temp home with a copy of
// the fixture league at <config>/league.yaml (0600, outside the fixture dir — so the provider's
// privacy checks run as in production), a temp cache whose dataset files are published by
// `node dist/cli.js refresh` in fixture mode (FF_FIXTURE_DIR: the fixture transport, no socket), and
// the SDK Client over StdioClientTransport. No network, no ~/.config, no ~/.cache.
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const DIST_ENTRY = path.join(ROOT, "dist", "cli.js");

/** Fails loudly (never skips) when the package is not built. */
export function requireDist(): void {
  if (!existsSync(DIST_ENTRY))
    throw new Error("dist/cli.js is missing — run `npm run build` before the process suites");
}

/** A private home for one server. */
export interface E2eHome {
  readonly root: string;
  readonly env: Record<string, string>;
  cleanup(): void;
}

/** Builds the temp home; `league: false` leaves the league file absent. */
export function makeHome(opts: { league?: boolean; logLevel?: string } = {}): E2eHome {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ff-e2e-")));
  chmodSync(root, 0o700);
  for (const d of ["home", "config", "cache"]) mkdirSync(path.join(root, d), { mode: 0o700 });
  const league = path.join(root, "config", "league.yaml");
  if (opts.league !== false) {
    copyFileSync(path.join(ROOT, "fixtures", "manual", "league.yaml"), league);
    chmodSync(league, 0o600);
  }
  return {
    root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: path.join(root, "home"),
      FF_CONFIG_DIR: path.join(root, "config"),
      FF_CACHE_DIR: path.join(root, "cache"),
      FF_FIXTURE_DIR: path.join(ROOT, "fixtures"),
      FF_TOOLSET: "core",
      FF_LOG_LEVEL: opts.logLevel ?? "info",
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One CLI run's result. */
export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `node dist/cli.js <args>` with `env` (never a shell). */
export function runCli(env: Record<string, string>, args: readonly string[]): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [DIST_ENTRY, ...args],
      { cwd: ROOT, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" ? err.code : err.killed ? 124 : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/**
 * The fixture datasets through the real CLI (plan 06 §1.2 job targets): schedules for 2025–2026
 * (E1's trailing window), the daily pair and stats for 2026 (the fixtures hold 2026 stats only).
 */
export const REFRESH_RUNS: readonly (readonly string[])[] = [
  ["refresh", "nflverse:schedules", "--seasons", "2025,2026"],
  ["refresh", "nflverse:daily", "--seasons", "2026"],
  ["refresh", "nflverse:stats", "--seasons", "2026"],
];

/** Publishes the fixture datasets into `home`'s cache; throws with the output on any failure. */
export async function publishFixtures(home: E2eHome): Promise<CliRun[]> {
  const runs: CliRun[] = [];
  for (const args of REFRESH_RUNS) {
    const r = await runCli(home.env, args);
    if (r.code !== 0) throw new Error(`ff ${args.join(" ")} → ${String(r.code)}\n${r.stderr}`);
    runs.push(r);
  }
  return runs;
}

/** A connected client over a spawned `node dist/cli.js serve`. */
export interface Served {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  /** Every stderr line so far (JSON log lines). */
  readonly stderr: string[];
  /** Milliseconds from spawn to a completed handshake. */
  readonly connectMs: number;
  close(): Promise<void>;
}

/** Spawns the built server and connects (legacy `initialize`, or the 2026-07-28 era). */
export async function serve(
  env: Record<string, string>,
  opts: { modern?: boolean } = {},
): Promise<Served> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_ENTRY, "serve"],
    env,
    cwd: ROOT,
    stderr: "pipe",
  });
  const stderr: string[] = [];
  let buf = "";
  transport.stderr?.on("data", (b: Buffer) => {
    buf += b.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    stderr.push(...lines.filter(Boolean));
  });
  const client = new Client(
    { name: "ff-e2e", version: "0.0.0" },
    opts.modern === true ? { versionNegotiation: { mode: "auto" } } : {},
  );
  const t0 = performance.now();
  await client.connect(transport);
  const connectMs = performance.now() - t0;
  return {
    client,
    transport,
    stderr,
    connectMs,
    close: async () => {
      await client.close();
    },
  };
}

/** The parsed JSON log records of a stderr capture (a non-JSON line is kept as `{ raw }`). */
export function logRecords(lines: readonly string[]): Record<string, unknown>[] {
  return lines.map((l) => {
    try {
      return JSON.parse(l) as Record<string, unknown>;
    } catch {
      return { raw: l };
    }
  });
}

/** Waits until `pred` holds or `ms` passes (then throws). */
export async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Whether a pid is still alive. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
