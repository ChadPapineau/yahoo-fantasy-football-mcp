// print-config.ts — `ff print-config --client desktop|code` (plan 03 L4, §4.1–§4.3; plan 05 §2
// `cli/print-config`): the launch configuration with ABSOLUTE paths — `command` = the exact node
// binary running `ff` (process.execPath, which survives version managers and GUI clients' minimal
// PATH), `args[0]` = the absolute `dist/cli.js` — plus the non-secret FF_* settings the client needs.
// No secret value is ever printed: secrets are env-only and are never copied into a snippet.
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config, ConfigKey } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { distEntry, write, writeLine, type CliIo } from "./io.js";

/**
 * The name the server is registered under in a client config. The Skills qualify tool names with
 * it (`fantasy-football-mcp-server:ff_get_status`, skills/_shared/manifest.json), so it is fixed.
 */
export const SERVER_NAME = "fantasy-football-mcp-server";
/** The clients `print-config` knows. */
export const CLIENTS = ["desktop", "code"] as const;
/** A client. */
export type Client = (typeof CLIENTS)[number];

/** A launch configuration: an absolute command, absolute args, and non-secret env. */
export interface LaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Non-secret keys copied into the snippet when they came from the ENVIRONMENT (a GUI client does
 * not inherit the shell's env; values from config.json are read by the server itself). Secrets
 * (YAHOO_CLIENT_SECRET, ODDS_API_KEY), unused Phase-1b keys and FF_WRITE_ENABLED (ignored in this
 * build) are never copied.
 */
const COPIED_KEYS: readonly ConfigKey[] = [
  "FF_CONFIG_DIR",
  "FF_CACHE_DIR",
  "FF_LEAGUE_FILE",
  "FF_TOOLSET",
  "FF_WEATHER_SOURCE",
  "FF_FIXTURE_DIR",
  "FF_LEAGUE_KEYS",
];

function resolvedValue(config: Config, key: ConfigKey): string | null {
  switch (key) {
    case "FF_CONFIG_DIR":
      return config.configDir;
    case "FF_CACHE_DIR":
      return config.cacheDir;
    case "FF_LEAGUE_FILE":
      return config.leagueFile;
    case "FF_TOOLSET":
      return config.toolset;
    case "FF_WEATHER_SOURCE":
      return config.weatherSource;
    case "FF_FIXTURE_DIR":
      return config.fixtureDir;
    case "FF_LEAGUE_KEYS":
      return config.leagueKeys.length > 0 ? config.leagueKeys.join(",") : null;
    default:
      return null;
  }
}

/** The env block: FF_LOG_LEVEL always, plus every copied key that was set in the environment. */
export function launchEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of COPIED_KEYS) {
    if (config.origins[key] !== "env") continue;
    const v = resolvedValue(config, key);
    if (v !== null) env[key] = v;
  }
  env.FF_LOG_LEVEL = config.logLevel;
  return env;
}

/**
 * The launch spec for `serve`. Throws when the entry does not exist (an unbuilt checkout): a config
 * naming a missing file is exactly the "relative/missing path" failure plan 03 L4 exists to stop.
 */
export function launchSpec(
  io: Pick<CliIo, "execPath" | "packageRoot">,
  config: Config,
  subcommand: readonly string[] = ["serve"],
): LaunchSpec {
  const entry = distEntry(io.packageRoot);
  if (!path.isAbsolute(io.execPath) || !path.isAbsolute(entry))
    throw new Error("print-config: node and dist/cli.js paths must be absolute");
  if (!existsSync(entry)) throw new MissingBuildError(entry);
  return { command: io.execPath, args: [entry, ...subcommand], env: launchEnv(config) };
}

/** `dist/cli.js` is missing: the package has not been built. */
export class MissingBuildError extends Error {
  readonly entry: string;
  constructor(entry: string) {
    super("dist/cli.js does not exist — run `npm run build` first");
    this.name = "MissingBuildError";
    this.entry = entry;
  }
}

/** The Claude Desktop `mcpServers` snippet (plan 03 §4.1). */
export function desktopSnippet(spec: LaunchSpec): string {
  const snippet = {
    mcpServers: {
      [SERVER_NAME]: { command: spec.command, args: [...spec.args], env: { ...spec.env } },
    },
  };
  return JSON.stringify(snippet, null, 2);
}

const SHELL_SAFE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** Quotes one word for a POSIX shell (single quotes; `'` → `'\''`). */
export function shellQuote(word: string): string {
  if (word !== "" && SHELL_SAFE.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `claude mcp add` command line (plan 03 §4.2): user scope, so no absolute user path lands in a
 * project's `.mcp.json`. Flag syntax is plan 03 A-6 (verify against the Claude Code docs).
 */
export function codeCommand(spec: LaunchSpec): string {
  const words = ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", SERVER_NAME];
  for (const [k, v] of Object.entries(spec.env)) words.push("--env", `${k}=${v}`);
  words.push("--", spec.command, ...spec.args);
  return words.map(shellQuote).join(" ");
}

/** Where each client's config lives (plan 03 §4.1 A-5, §4.2 A-6 — verify on the machine). */
export function pasteTarget(client: Client, home: string): string {
  return client === "desktop"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : "run the command above in a terminal (user scope)";
}

/** `ff print-config`: the snippet on stdout; where to paste it on stderr. */
export async function printConfig(
  io: CliIo,
  config: Config,
  client: string | undefined,
): Promise<number> {
  if (client === undefined || !(CLIENTS as readonly string[]).includes(client))
    throw new UsageError("print-config needs --client desktop or --client code");
  let spec: LaunchSpec;
  try {
    spec = launchSpec(io, config);
  } catch (e) {
    if (e instanceof MissingBuildError) {
      await writeLine(io.stderr, `ff print-config: ${e.message} (expected ${e.entry})`);
      return EXIT.ERROR;
    }
    throw e;
  }
  const text = client === "desktop" ? desktopSnippet(spec) : codeCommand(spec);
  await write(io.stdout, `${text}\n`);
  await writeLine(
    io.stderr,
    client === "desktop"
      ? `ff print-config: merge the mcpServers entry into ${pasteTarget("desktop", io.home)}, then restart Claude Desktop.`
      : "ff print-config: run the command above in a terminal (user scope, so nothing lands in a repository).",
  );
  return EXIT.OK;
}
