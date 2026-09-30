// serve.ts — `ff serve`, the composition root and lifecycle (plan 03 §1: startup with no network,
// shutdown handlers before anything is half-open, store opened + migrated + datasets attached, the
// provider, the stdio transport in dual-era mode; stdin EOF / SIGTERM / SIGINT / SIGHUP / stdout EPIPE
// / reparenting → a single-flight close with the store closed; exit codes 0/1/2/5 — plan 03 §1.3).
// All I/O lives here (src/mcp may not touch the store or the filesystem — plan 01 §1.1).
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import {
  serveStdio,
  StdioServerTransport,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";
import {
  backupDir,
  datasetDir,
  ensureSecureDir,
  isInside,
  packageRoot,
  PathSecurityError,
  readSecureFile,
  storePath,
} from "../config/paths.js";
import { ConfigError, loadConfigFromProcess, secretValues, type Config } from "../config/schema.js";
import { systemClock, type Clock } from "../domain/clock.js";
import type { CrosswalkOverride } from "../domain/crosswalk/types.js";
import { createServer } from "../mcp/server.js";
import type { McpServerOptions, McpServices, ServerTexts } from "../mcp/services.js";
import { loadCrosswalkOverrides } from "../providers/crosswalk-overrides.js";
import { ManualLeagueProvider } from "../providers/manual/index.js";
import { storeFactory } from "../store/index.js";
import type { Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import { createLogger, type Logger } from "./log.js";

/** What `serve` is given (the CLI entry passes the real process streams). */
export interface ServeOptions {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly clock?: Clock;
}

/** Test seams (never set by the CLI). */
export interface ServeInternals {
  readonly factory?: StoreFactory;
  /** Parent-pid watchdog interval (plan 03 §1.3: 5 s). */
  readonly watchdogMs?: number;
  /** Hard close ceiling (plan 03 §1.3: 10 s → exit 5). */
  readonly closeDeadlineMs?: number;
  /** Install process signal handlers (default true; in-process tests pass false). */
  readonly signals?: boolean;
  /** The package root the Skills texts and the overrides file are read from. */
  readonly packageRoot?: string;
}

/** Process exit codes (plan 03 §1.3). */
export const EXIT = Object.freeze({ ok: 0, error: 1, config: 2, forced: 5 });

const TEXT_MAX_BYTES = 256 * 1024;

/** Strips a leading `---` YAML frontmatter block. */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  const after = text.indexOf("\n", end + 4);
  return after === -1 ? "" : text.slice(after + 1);
}

/** Reads a package text file (no symlinks, size-capped); null when absent or unreadable. */
export function readPackageText(file: string): string | null {
  try {
    return readSecureFile(file, {
      requirePrivate: false,
      maxBytes: TEXT_MAX_BYTES,
      what: "package text",
    });
  } catch {
    return null;
  }
}

/** The Skill bodies and the cheat-sheet (plan 07 §4.2 prompts; §4.1 ff://docs/tool-outputs). */
export function loadTexts(root: string): ServerTexts {
  const skill = (name: string): string | null => {
    const t = readPackageText(path.join(root, "skills", name, "SKILL.md"));
    return t === null ? null : stripFrontmatter(t);
  };
  return {
    start_sit: skill("start-sit"),
    stream: skill("stream-kdef"),
    retro: skill("retro"),
    tool_outputs: readPackageText(
      path.join(root, "skills", "_shared", "references", "tool-outputs.md"),
    ),
  };
}

/** The store's weather preference from FF_WEATHER_SOURCE. */
export function storeWeather(c: Config): "weather:open_meteo" | "weather:nws" | undefined {
  if (c.weatherSource === "nws") return "weather:nws";
  if (c.weatherSource === "open-meteo") return "weather:open_meteo";
  return undefined;
}

/** Everything `buildServices` wires (the composition root's product). */
export interface Wiring {
  readonly services: McpServices;
  readonly options: McpServerOptions;
}

/**
 * Wires the services src/mcp is given from an open store, the resolved config and the package
 * texts (exported for the in-process tests, which build the same object over fixture files).
 */
export function buildServices(args: {
  readonly config: Config;
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly texts: ServerTexts;
  readonly overrides: readonly CrosswalkOverride[];
}): Wiring {
  const { config, store, clock, logger } = args;
  const fixtureLeague =
    config.fixtureDir !== null && isInside(config.leagueFile, config.fixtureDir);
  const platform = new ManualLeagueProvider({
    file: config.leagueFile,
    clock,
    logger,
    schedule: store.datasets.schedules,
    rosters: store.rosterWeekly,
    requirePrivate: !fixtureLeague,
  });
  const services: McpServices = {
    clock,
    platform,
    datasets: store.datasets,
    rosterWeekly: store.rosterWeekly,
    recommendationLog: store.repos.recommendationLog,
    projections: store.repos.projections,
    crosswalk: store.repos.crosswalk,
    refreshLog: store.repos.refreshLog,
    writeJournal: store.repos.writeJournal,
    transactionsSeen: store.repos.transactionsSeen,
    crosswalkOverrides: args.overrides,
    storeStats: () => store.stats(),
    beforeCall: () => {
      try {
        store.reattachIfChanged();
      } catch (e) {
        logger.warn("store.reattach_failed", { error: e instanceof Error ? e.name : "unknown" });
      }
    },
    logger,
  };
  const options: McpServerOptions = {
    version: VERSION,
    toolset: config.toolset,
    fixtureMode: config.fixtureDir !== null,
    leagueKeys: config.leagueKeys,
    weatherSource: config.weatherSource,
    writeRequested: config.writeRequested,
    texts: args.texts,
  };
  return { services, options };
}

/** Loads the crosswalk overrides; a broken file is logged and serving continues without it. */
export function loadOverrides(root: string, logger: Logger): readonly CrosswalkOverride[] {
  try {
    return loadCrosswalkOverrides(path.join(root, "data", "crosswalk", "overrides.yaml"));
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    logger.warn("crosswalk.overrides_unavailable", {
      code: typeof code === "string" ? code : "unknown",
    });
    return [];
  }
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  try {
    stream.write(`${line}\n`);
  } catch {
    // a closed stderr must not crash startup
  }
}

/**
 * `ff serve`: resolves the exit code when the server has shut down (never earlier). Startup
 * touches no network; the store is closed on every exit path.
 */
export async function serve(opts: ServeOptions, internals: ServeInternals = {}): Promise<number> {
  const clock = opts.clock ?? systemClock;
  const bootLog = createLogger({
    level: "info",
    sink: (l) => {
      writeLine(opts.stderr, l);
    },
  });
  try {
    parseArgs({ args: [...opts.argv], options: {}, strict: true, allowPositionals: false });
  } catch {
    bootLog.error("serve.usage", { reason: "serve takes no arguments" });
    return EXIT.config;
  }

  let config: Config;
  try {
    config = loadConfigFromProcess({
      env: opts.env,
      home: opts.env.HOME ?? homedir(),
      repoRoot: internals.packageRoot ?? packageRoot(),
    });
  } catch (e) {
    if (e instanceof ConfigError) {
      for (const i of e.issues) bootLog.error("config.invalid", { key: i.key, reason: i.reason });
      return EXIT.config;
    }
    bootLog.error("config.unreadable", {
      reason: e instanceof PathSecurityError ? e.detail : "unknown",
    });
    return EXIT.config;
  }
  const logger = createLogger({
    level: config.logLevel,
    sink: (l) => {
      writeLine(opts.stderr, l);
    },
  });
  for (const s of secretValues(config)) logger.registerSecret(s.kind, s.value);
  for (const w of config.warnings) logger.warn("config.warning", { detail: w });

  // --- shutdown machinery first (plan 03 §1.1 step 2) --------------------------------------------------
  let store: Store | null = null;
  let handle: StdioServerHandle | null = null;
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  let closing: Promise<void> | null = null;
  const cleanups: (() => void)[] = [];
  const shutdown = (reason: string, code: number): Promise<void> => {
    if (closing !== null) return closing;
    logger.info("serve.shutdown", { reason });
    const deadline = setTimeout(() => {
      logger.error("serve.forced_exit", { reason });
      finish(EXIT.forced);
    }, internals.closeDeadlineMs ?? 10_000);
    deadline.unref();
    closing = (async () => {
      try {
        await handle?.close();
      } catch {
        // transport already gone
      }
      try {
        store?.close();
      } catch (e) {
        logger.error("store.close_failed", { error: e instanceof Error ? e.name : "unknown" });
        code = code === EXIT.ok ? EXIT.error : code;
      }
      clearTimeout(deadline);
      finish(code);
    })();
    return closing;
  };
  let finished = false;
  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    for (const c of cleanups.splice(0)) c();
    resolveExit(code);
  };

  const onEnd = (): void => void shutdown("stdin", EXIT.ok);
  opts.stdin.on("end", onEnd);
  opts.stdin.on("close", onEnd);
  cleanups.push(() => {
    opts.stdin.off("end", onEnd);
    opts.stdin.off("close", onEnd);
  });
  const onStdoutError = (e: unknown): void => {
    const code = (e as { code?: unknown }).code;
    void shutdown(code === "EPIPE" ? "epipe" : "stdout_error", EXIT.ok);
  };
  opts.stdout.on("error", onStdoutError);
  cleanups.push(() => opts.stdout.off("error", onStdoutError));
  if (internals.signals !== false) {
    let interrupts = 0;
    const onSignal = (sig: NodeJS.Signals): void => {
      if (sig === "SIGINT" && closing !== null && ++interrupts > 0) {
        logger.error("serve.forced_exit", { reason: "second_sigint" });
        finish(EXIT.forced);
        return;
      }
      void shutdown(sig.toLowerCase(), EXIT.ok);
    };
    const onCrash = (e: unknown): void => {
      logger.error("serve.crash", {
        error: e instanceof Error ? { name: e.name, message: e.message } : typeof e,
      });
      void shutdown("crash", EXIT.error);
    };
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, onSignal);
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    cleanups.push(() => {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(sig, onSignal);
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    });
    const initialPpid = process.ppid;
    const watchdog = setInterval(() => {
      if (process.ppid !== initialPpid) void shutdown("orphaned", EXIT.ok);
    }, internals.watchdogMs ?? 5000);
    watchdog.unref();
    cleanups.push(() => {
      clearInterval(watchdog);
    });
  }

  // --- the store (plan 03 §1.1 step 3) -----------------------------------------------------------------
  try {
    ensureSecureDir(config.cacheDir, { create: true, what: "cache directory" });
    const weather = storeWeather(config);
    store = (internals.factory ?? storeFactory).open({
      path: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      backupDir: backupDir(config.cacheDir),
      clock,
      migrate: true,
      ...(weather === undefined ? {} : { weatherSource: weather }),
      onWarning: (code) => {
        logger.warn("store.warning", { code });
      },
    });
  } catch (e) {
    const exitCode = (e as { exitCode?: unknown }).exitCode;
    const code =
      e instanceof PathSecurityError ? EXIT.config : exitCode === 2 ? EXIT.config : EXIT.error;
    logger.error("store.open_failed", {
      error: e instanceof Error ? e.name : "unknown",
      reason: e instanceof PathSecurityError ? e.detail : undefined,
    });
    finish(code);
    return exited;
  }

  // --- the server (plan 03 §1.1 steps 5–6) ----------------------------------------------------------------
  const root = internals.packageRoot ?? packageRoot();
  try {
    const wiring = buildServices({
      config,
      store,
      clock,
      logger,
      texts: loadTexts(root),
      overrides: loadOverrides(root, logger),
    });
    const transport = new StdioServerTransport(
      opts.stdin as unknown as Readable,
      opts.stdout as unknown as Writable,
    );
    handle = serveStdio(() => createServer(wiring.services, wiring.options), {
      transport,
      onerror: (e) => {
        logger.warn("transport.error", { error: e.name });
      },
    });
    logger.info("serve.ready", {
      version: VERSION,
      node: process.versions.node,
      schema_version: store.schemaVersion,
      toolset: config.toolset,
      fixture_mode: config.fixtureDir !== null,
      auth: "manual",
    });
  } catch (e) {
    logger.error("serve.start_failed", { error: e instanceof Error ? e.name : "unknown" });
    void shutdown("start_failed", EXIT.error);
  }
  return exited;
}
