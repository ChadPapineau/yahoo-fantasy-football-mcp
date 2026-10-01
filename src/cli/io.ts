// io.ts — what every `ff` subcommand is given (plan 03 §1.1 step 1: args, env, paths; plan 01 §2
// "protocol on stdout, everything else on stderr" — human output of the non-serve subcommands goes
// to stdout, JSON log lines to stderr), the injected process executor (launchctl, osascript, node
// --version: `execFile` with an argument array only, plan 02 §7), and the package layout plan 03 §4
// prints (absolute `process.execPath` + absolute `dist/cli.js`). Nothing here reads ambient state
// except `defaultIo`, which the entry point calls once.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { packageRoot, type Env } from "../config/paths.js";
import {
  ConfigError,
  loadConfigFromProcess,
  secretValues,
  type Config,
  type LogLevel,
  LOG_LEVELS,
} from "../config/schema.js";
import { systemClock, type Clock } from "../domain/clock.js";
import type { FetchLike } from "../http/client.js";
import { createLogger, type Logger } from "./log.js";

/** The result of running a program. `code` is null when it was killed (timeout, signal). */
export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a program with an argument array (never a shell). Never rejects: failures are results. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<ExecResult>;

/** Longest a child program may run before it is killed. */
export const EXEC_TIMEOUT_MS = 10_000;
/** Most output kept from a child program (per stream). */
export const EXEC_MAX_BUFFER = 1024 * 1024;

/** The real executor: `execFile` (no shell), bounded time and output. */
export const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        shell: false,
        timeout: opts?.timeoutMs ?? EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code =
          err === null ? 0 : typeof err.code === "number" && err.killed !== true ? err.code : null;
        resolve({ code, stdout, stderr });
      },
    );
  });

/** Everything a subcommand may touch, injected so tests never reach the real machine. */
export interface CliIo {
  /** The environment (FF_*, XDG_*, CLAUDECODE). */
  readonly env: Env;
  /** The user's home (resolves ~/.config, ~/.cache, ~/Library/LaunchAgents). */
  readonly home: string;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  /** Time source (default: the wall clock). */
  readonly clock: Clock;
  /** `process.platform` (launchd is darwin-only). */
  readonly platform: NodeJS.Platform;
  /** Program executor (launchctl, osascript, `node --version`). */
  readonly exec: Exec;
  /**
   * The transport under the one HTTP client (src/http). Default: the global fetch. In fixture mode
   * (FF_FIXTURE_DIR) `ff refresh` replaces it with the fixture server regardless of this value.
   */
  readonly fetch: FetchLike | null;
  /** The package root (checkout or install): `dist/cli.js` lives under it. */
  readonly packageRoot: string;
  /** The node binary that runs `ff` (plan 03 L4: printed, never a bare `node`). */
  readonly execPath: string;
  /** The running Node version (`process.versions.node`). */
  readonly nodeVersion: string;
  /** This process's user id (launchctl's gui/<uid> domain); null where unsupported. */
  readonly uid: number | null;
  /** This process's pid. */
  readonly pid: number;
}

/** The real process's io (the entry point's only use of ambient state). */
export function defaultIo(): CliIo {
  return {
    env: process.env,
    home: homedir(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    clock: systemClock,
    platform: process.platform,
    exec: defaultExec,
    fetch: null,
    packageRoot: packageRoot(),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    pid: process.pid,
  };
}

const pipeGuarded = new WeakSet<NodeJS.WritableStream>();

/**
 * Makes a reader that closes early (`ff status | head -1`, `| less` then q) end the command's output
 * quietly instead of crashing it: the write fails with EPIPE, which a stream reports as an 'error'
 * EVENT — with no listener that is an unhandled exception, a Node stack and exit 1 (QA-1-055). The
 * command keeps running to its own end and exit code with nowhere to print (a refresh still
 * publishes, never killed mid-write). Any other output error is rethrown as before. `serve` never
 * gets this: there a closed stdout is the plan 03 §1.3 shutdown path. Idempotent per stream.
 */
export function tolerateClosedPipe(stream: NodeJS.WritableStream): void {
  if (pipeGuarded.has(stream)) return;
  pipeGuarded.add(stream);
  stream.on("error", (e: unknown) => {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") return;
    throw e;
  });
}

/** Writes `text` and resolves once the stream accepted it (so `process.exit` cannot truncate it). */
export function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve) => {
    // a closed reader: nothing more can be delivered, and writing again only re-raises the error
    if ((stream as { destroyed?: boolean }).destroyed === true) {
      resolve();
      return;
    }
    try {
      stream.write(text, () => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** Writes one line (newline appended). */
export function writeLine(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return write(stream, `${text}\n`);
}

/** `<package>/dist/cli.js` — the absolute entry a client config and launchd plist must name. */
export function distEntry(root: string): string {
  return path.join(root, "dist", "cli.js");
}

/** A resolved configuration plus a logger that already knows every secret the config holds. */
export interface Runtime {
  readonly config: Config;
  readonly log: Logger;
}

/** The level for the CLI logger before the config is known (FF_LOG_LEVEL if valid, else warn). */
export function bootLevel(env: Env): LogLevel {
  const v = env.FF_LOG_LEVEL?.trim();
  return v !== undefined && (LOG_LEVELS as readonly string[]).includes(v)
    ? (v as LogLevel)
    : "warn";
}

/** A stderr logger bound to the io's stderr and clock. */
export function makeLogger(io: CliIo, level: LogLevel): Logger {
  return createLogger({
    level,
    sink: (line) => {
      io.stderr.write(`${line}\n`);
    },
    now: () => io.clock.nowIso(),
  });
}

/**
 * Loads the configuration (plan 03 §3 precedence) and a logger with its secrets registered. A
 * `ConfigError` is reported as one stderr line per issue (never a value) and rethrown for exit 2.
 */
export async function loadRuntime(io: CliIo): Promise<Runtime> {
  let config: Config;
  try {
    config = loadConfigFromProcess({ env: io.env, home: io.home, repoRoot: io.packageRoot });
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const i of e.issues) await writeLine(io.stderr, `ff: config: ${i.key}: ${i.reason}`);
    }
    throw e;
  }
  const log = makeLogger(io, config.logLevel);
  for (const s of secretValues(config)) log.registerSecret(s.kind, s.value);
  for (const w of config.warnings) log.warn("config.warning", { msg: w });
  return { config, log };
}
