// main.ts — the `ff` dispatcher (plan 01 §10 subcommands; plan 03 §1.1 step 1 `node:util.parseArgs`,
// exit 2 on a usage/config error, §1.3 shared exit codes; plan 10 §3.1a "the ff CLI without its
// Yahoo subcommands"). `serve` is handed to src/cli/serve.ts untouched (stdout is the MCP channel);
// every other subcommand prints human output to stdout and JSON log lines to stderr. src/cli.ts is
// only the process entry around `main`.
import { parseArgs, type ParseArgsConfig } from "node:util";
import { resolveAbsolute } from "../config/paths.js";
import { ConfigError } from "../config/schema.js";
import { VERSION } from "../version.js";
import { backup, prune } from "./maintenance.js";
import { doctor } from "./doctor.js";
import { EXIT, UsageError } from "./exit.js";
import { installLaunchd } from "./install-launchd.js";
import {
  bootLevel,
  loadRuntime,
  makeLogger,
  tolerateClosedPipe,
  writeLine,
  type CliIo,
} from "./io.js";
import { printConfig } from "./print-config.js";
import { refresh } from "./refresh.js";
import { status } from "./status.js";
import { uninstall } from "./uninstall.js";

/** The subcommands of this build (Yahoo's `auth`, `confirm`, `smoke`, `snapshot` are Phase 1b/W). */
export const COMMANDS = [
  "serve",
  "status",
  "doctor",
  "refresh",
  "print-config",
  "install-launchd",
  "uninstall",
  "prune",
  "backup",
  "version",
  "help",
] as const;

/** The usage text (stderr for errors, stdout for `ff help`). */
export const USAGE = `usage: ff <command> [options]

  serve                         run the MCP server on stdio (what a client launches)
  status [--json]               data freshness, store, jobs — the dashboard
  doctor [--json] [--online] [--fix --yes] [--client-config <path>] [--client-log <path>]
                                diagnose the install; exit code = worst finding
  refresh <target> [--seasons 2025,2026] [--force] [--notify] [--json]
                                targets: all | nflverse | nflverse:schedules | nflverse:daily |
                                nflverse:stats | nflverse:injuries | nflverse:roster_weekly |
                                nflverse:stats_player_week | weather
  print-config --client desktop|code
                                the launch config with absolute paths (no secrets)
  install-launchd [--jobs a,b] [--dry-run]
                                install the refresh/prune/backup LaunchAgents (macOS)
  uninstall [--dry-run] [--purge [--purge-config] --yes]
                                remove the LaunchAgents; data only with --purge --yes
  prune [--notify]              drop expired cache rows, temp debris, old pre-migration backups
  backup [--to <path>] [--notify]
                                consistent backup of store.sqlite (weekly copies keep 4)
  version                       print the version

exit codes: 0 ok · 1 failure · 2 usage or configuration · 5 serve forced shutdown
environment: FF_CONFIG_DIR, FF_CACHE_DIR, FF_LEAGUE_FILE, FF_LOG_LEVEL, FF_WEATHER_SOURCE,
             FF_TOOLSET, FF_FIXTURE_DIR (see README)`;

type Options = NonNullable<ParseArgsConfig["options"]>;

const SPECS: Readonly<Record<string, { options: Options; positionals: number }>> = {
  status: { options: { json: { type: "boolean" } }, positionals: 0 },
  doctor: {
    options: {
      json: { type: "boolean" },
      online: { type: "boolean" },
      fix: { type: "boolean" },
      yes: { type: "boolean" },
      "client-config": { type: "string" },
      "client-log": { type: "string" },
    },
    positionals: 0,
  },
  refresh: {
    options: {
      seasons: { type: "string" },
      force: { type: "boolean" },
      notify: { type: "boolean" },
      json: { type: "boolean" },
    },
    positionals: 1,
  },
  "print-config": { options: { client: { type: "string" } }, positionals: 0 },
  "install-launchd": {
    options: { jobs: { type: "string" }, "dry-run": { type: "boolean" } },
    positionals: 0,
  },
  uninstall: {
    options: {
      "dry-run": { type: "boolean" },
      purge: { type: "boolean" },
      "purge-config": { type: "boolean" },
      yes: { type: "boolean" },
    },
    positionals: 0,
  },
  prune: { options: { notify: { type: "boolean" } }, positionals: 0 },
  backup: { options: { to: { type: "string" }, notify: { type: "boolean" } }, positionals: 0 },
  version: { options: {}, positionals: 0 },
  help: { options: {}, positionals: 0 },
};

/** Parsed flags of one subcommand. */
export interface Parsed {
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

/** Parses a subcommand's argv strictly; any problem is a UsageError (exit 2). */
export function parseCommand(command: string, argv: readonly string[]): Parsed {
  const spec = Object.hasOwn(SPECS, command) ? SPECS[command] : undefined;
  if (spec === undefined) throw new UsageError(`unknown command '${command.slice(0, 40)}'`);
  let r: { values: Record<string, unknown>; positionals: string[] };
  try {
    r = parseArgs({ args: [...argv], options: spec.options, strict: true, allowPositionals: true });
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    throw new UsageError(
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
        ? `${command}: unknown option`
        : code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
          ? `${command}: an option is missing its value or has the wrong type`
          : `${command}: invalid arguments`,
    );
  }
  if (r.positionals.length > spec.positionals)
    throw new UsageError(`${command}: unexpected argument(s)`);
  const values: Record<string, string | boolean | undefined> = {};
  for (const [k, v] of Object.entries(r.values)) {
    if (typeof v === "string" || typeof v === "boolean") values[k] = v;
  }
  return { values, positionals: r.positionals };
}

const str = (p: Parsed, k: string): string | undefined => {
  const v = p.values[k];
  return typeof v === "string" ? v : undefined;
};
const flag = (p: Parsed, k: string): boolean => p.values[k] === true;

/** An optional path flag: absolute (or `~/…`) only — a relative path would depend on the cwd. */
function absOption(io: CliIo, v: string | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  try {
    return resolveAbsolute(v, io.home, name);
  } catch {
    throw new UsageError(`${name} must be an absolute path (or start with ~/)`);
  }
}

/** The `serve` handler's contract (implemented in src/cli/serve.ts). */
export type ServeFn = (opts: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  clock?: CliIo["clock"];
}) => Promise<number>;

/** Loads `serve` lazily (src/cli/serve.ts), so the other subcommands never load the MCP SDK. */
export async function loadServe(): Promise<ServeFn> {
  const mod = await import("./serve.js");
  const serve: ServeFn = (opts) => mod.serve(opts);
  return serve;
}

/** Extra wiring for tests (never reachable from argv). */
export interface MainDeps {
  readonly loadServe?: () => Promise<ServeFn>;
  /** Aborts a running refresh (the entry wires SIGINT/SIGTERM to it). */
  readonly signal?: AbortSignal;
}

/**
 * Runs `ff <argv>` and returns the exit code. Never throws: usage and configuration errors are 2,
 * anything else 1 with a one-line stderr message (details at debug level on the logger).
 */
export async function main(
  argv: readonly string[],
  io: CliIo,
  deps: MainDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) {
    await writeLine(io.stderr, USAGE);
    return EXIT.USAGE;
  }
  if (command === "--version" || command === "-v") return main(["version", ...rest], io, deps);
  if (command === "--help" || command === "-h") return main(["help", ...rest], io, deps);
  if (command === "serve") {
    const serve = await (deps.loadServe ?? loadServe)();
    return serve({
      argv: rest,
      env: io.env,
      stdin: io.stdin,
      stdout: io.stdout,
      stderr: io.stderr,
      clock: io.clock,
    });
  }
  // `ff status | head -1`: a reader that closes early ends the output, not the process (QA-1-055)
  tolerateClosedPipe(io.stdout);
  tolerateClosedPipe(io.stderr);
  const bootLog = makeLogger(io, bootLevel(io.env));
  try {
    const p = parseCommand(command, rest);
    switch (command) {
      case "version":
        await writeLine(io.stdout, `ff ${VERSION} (node ${io.nodeVersion})`);
        return EXIT.OK;
      case "help":
        await writeLine(io.stdout, USAGE);
        return EXIT.OK;
      case "doctor":
        return await doctor(io, {
          json: flag(p, "json"),
          online: flag(p, "online"),
          fix: flag(p, "fix"),
          yes: flag(p, "yes"),
          clientConfig: absOption(io, str(p, "client-config"), "--client-config"),
          clientLog: absOption(io, str(p, "client-log"), "--client-log"),
        });
      default:
        break;
    }
    const { config, log } = await loadRuntime(io);
    switch (command) {
      case "status":
        return await status(io, config, log, { json: flag(p, "json") });
      case "refresh":
        return await refresh(
          io,
          config,
          log,
          {
            target: p.positionals[0],
            seasons: str(p, "seasons"),
            force: flag(p, "force"),
            notify: flag(p, "notify"),
            json: flag(p, "json"),
          },
          deps.signal ?? new AbortController().signal,
        );
      case "print-config":
        return await printConfig(io, config, str(p, "client"));
      case "install-launchd":
        return await installLaunchd(io, config, {
          jobs: str(p, "jobs"),
          dryRun: flag(p, "dry-run"),
        });
      case "uninstall":
        return await uninstall(io, config, {
          dryRun: flag(p, "dry-run"),
          purge: flag(p, "purge"),
          purgeConfig: flag(p, "purge-config"),
          yes: flag(p, "yes"),
        });
      case "prune":
        return await prune(io, config, log, { notify: flag(p, "notify") });
      case "backup":
        return await backup(io, config, log, { to: str(p, "to"), notify: flag(p, "notify") });
      default:
        throw new UsageError(`unknown command '${command.slice(0, 40)}'`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      await writeLine(io.stderr, `ff: ${e.message} (run \`ff help\`)`);
      return EXIT.USAGE;
    }
    if (e instanceof ConfigError) return EXIT.USAGE;
    bootLog.error("cli.failed", { command, error: e });
    await writeLine(
      io.stderr,
      `ff ${command}: unexpected error: ${e instanceof Error ? e.name : "error"} (run with FF_LOG_LEVEL=debug for detail)`,
    );
    return EXIT.ERROR;
  }
}
