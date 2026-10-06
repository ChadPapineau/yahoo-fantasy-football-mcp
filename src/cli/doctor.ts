// doctor.ts — `ff doctor [--json] [--online] [--fix --yes] [--client-config <p>] [--client-log <p>]`
// (plan 03 L5, §5 the 22 rows; plan 05 §2 `cli/doctor`: every row has a passing and a failing case,
// a stable `--json` shape, exit code = worst finding, offline mode makes zero network calls). The
// offline rows for Phase 1a are implemented; the Yahoo rows (5, 6, 7, 14, 15, 16, 18) report "not
// applicable (no Yahoo access)" — Phase 1b is deferred. Doctor never creates, migrates or writes the
// store; `--fix` only creates missing 0700 directories and sets our own files and directories back
// to 0600/0700 (group/other bits dropped, the owner's restored), and only after `--yes` (or a y/N
// answer on a terminal).
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statfsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  backupDir,
  datasetDir,
  datasetFilePath,
  ensureSecureDir,
  insecureAncestors,
  PathSecurityError,
  readSecureFile,
  runTempDir,
  storePath,
} from "../config/paths.js";
import { ConfigError, loadConfigFromProcess, type Config } from "../config/schema.js";
import type { DatasetSourceId } from "../config/freshness.js";
import { createHttpClient } from "../http/client.js";
import { ManualLeagueProvider } from "../providers/manual/index.js";
import { LeagueFileError, MANUAL_LEAGUE_MISSING_HINT } from "../providers/platform.js";
import { DS_SCHEMA_VERSION, parseDsSchema } from "../store/attach.js";
import { MIGRATIONS } from "../store/index.js";
import { readDatasetFileMeta } from "../store/publisher.js";
import { storeInternalsOf } from "../store/store.js";
import type { Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import { EXIT } from "./exit.js";
import { fixtureFetch, NFLVERSE_RELEASE_BASE } from "./fixture-fetch.js";
import { bootLevel, distEntry, makeLogger, writeLine, type CliIo } from "./io.js";
import { installedPlists, JOBS, LAUNCHCTL, labelOf, launchctl } from "./launchd.js";
import { redactString, SecretRegistry, truncate, type Logger } from "./log.js";
import { SERVER_NAME, pasteTarget } from "./print-config.js";
import { sourceStatuses, configuredSources, sourceStatus } from "./status.js";
import {
  errorText,
  openExistingStore,
  type ExistingStore,
  type StoreOpenReason,
} from "./store-access.js";

/** The minimum Node (plan 01 D2, plan 03 §5 row 1). */
export const MIN_NODE = [24, 15, 0] as const;
/** Free space below this warns (plan 03 §5 row 8). */
export const MIN_FREE_BYTES = 1024 ** 3;
/** Store + datasets above this warn (plan 01 §5.6). */
export const MAX_STORE_BYTES = 500 * 1024 ** 2;
/** Largest client config read (a Claude Code user config can be several MB). */
export const MAX_CLIENT_CONFIG_BYTES = 16 * 1024 * 1024;
/** How much of a client log's tail is read. */
export const LOG_TAIL_BYTES = 64 * 1024;
/** Lines of the log tail examined (plan 03 §5 row 22). */
export const LOG_TAIL_LINES = 50;

/** A row's verdict. `config` = a configuration problem (exit 2); `na` = not applicable here. */
export type RowStatus = "ok" | "warn" | "fail" | "config" | "na" | "skip";

/** One doctor row (the `--json` shape; stable). */
export interface DoctorRow {
  /** The plan 03 §5 row number. */
  readonly n: number;
  /** Stable id. */
  readonly id: string;
  readonly title: string;
  readonly status: RowStatus;
  /** One line; never contains a secret value or a league/team name. */
  readonly message: string;
  /** What to do, when not ok. */
  readonly fix: string | null;
  readonly details: readonly string[];
}

/** The `--json` document. */
export interface DoctorReport {
  readonly version: string;
  readonly node: string;
  readonly generated_at: string;
  readonly online: boolean;
  readonly exit_code: number;
  readonly rows: readonly DoctorRow[];
}

/** Doctor options (from argv). */
export interface DoctorOptions {
  readonly json: boolean;
  readonly online: boolean;
  readonly fix: boolean;
  readonly yes: boolean;
  readonly clientConfig?: string | undefined;
  readonly clientLog?: string | undefined;
  /** Test hook for the store factory (never reachable from argv). */
  readonly factory?: StoreFactory;
}

const NO_YAHOO = "not applicable (no Yahoo access — Phase 1b is not built)";

const row = (
  n: number,
  id: string,
  title: string,
  status: RowStatus,
  message: string,
  fix: string | null = null,
  details: readonly string[] = [],
): DoctorRow => ({ n, id, title, status, message, fix, details });

/** Exit code for a set of rows: 2 if any `config`, else 1 if any `fail`, else 0. */
export function exitCodeFor(rows: readonly DoctorRow[]): number {
  if (rows.some((r) => r.status === "config")) return EXIT.USAGE;
  if (rows.some((r) => r.status === "fail")) return EXIT.ERROR;
  return EXIT.OK;
}

/** Parses `v24.15.0` / `24.15.0`; null when unparseable. */
export function parseNodeVersion(s: string): [number, number, number] | null {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})/.exec(s.trim());
  return m?.[1] === undefined || m[2] === undefined || m[3] === undefined
    ? null
    : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Whether `v` ≥ MIN_NODE. */
export function nodeAtLeastMin(v: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = v[i] ?? 0;
    const b = MIN_NODE[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const MIN_TEXT = MIN_NODE.join(".");

// --- row 1 -----------------------------------------------------------------------------------------

/** Row 1: the running Node. */
export function checkNode(nodeVersion: string): DoctorRow {
  const v = parseNodeVersion(nodeVersion);
  if (v !== null && nodeAtLeastMin(v))
    return row(1, "node", "Node version", "ok", `${nodeVersion} (≥ ${MIN_TEXT})`);
  return row(
    1,
    "node",
    "Node version",
    "fail",
    `${nodeVersion} is below ${MIN_TEXT} (node:sqlite is a release candidate from 24.15; Node 24 is the LTS line per nodejs.org at build time [plan 03 A-7])`,
    "fnm install 24 && fnm use 24, then re-run `ff print-config` so the client launches the 24 binary",
  );
}

// --- rows 2, 3, 13: client configs ------------------------------------------------------------------

/** A parsed client config and our entries in it. */
export interface ClientConfigScan {
  readonly client: "desktop" | "code";
  readonly file: string;
  /** `missing` = no file; `invalid` = unreadable or not JSON. */
  readonly state: "ok" | "missing" | "invalid";
  readonly mode: number | null;
  readonly entries: readonly { readonly name: string; readonly spec: Record<string, unknown> }[];
  /** How many OTHER mcpServers entries it lists (names are never printed). */
  readonly others: number;
}

function isOurs(name: string, spec: Record<string, unknown>): boolean {
  if (name === SERVER_NAME) return true;
  const args = spec.args;
  return (
    Array.isArray(args) &&
    args.some((a) => typeof a === "string" && /[/\\]dist[/\\]cli\.js$/.test(a)) &&
    args.includes("serve")
  );
}

/** Reads a client config's `mcpServers` (Desktop: top level; Claude Code user config: top level [A-6]). */
export function scanClientConfig(client: "desktop" | "code", file: string): ClientConfigScan {
  const empty = { client, file, mode: null, entries: [], others: 0 } as const;
  let text: string | null;
  let mode: number | null = null;
  try {
    text = readSecureFile(file, {
      requirePrivate: false,
      maxBytes: MAX_CLIENT_CONFIG_BYTES,
      what: "client config",
    });
    if (text !== null) mode = statSync(file).mode & 0o777;
  } catch {
    return { ...empty, state: "invalid" };
  }
  if (text === null) return { ...empty, state: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...empty, mode, state: "invalid" };
  }
  const servers =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
  const entries: { name: string; spec: Record<string, unknown> }[] = [];
  let others = 0;
  if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
    for (const [name, spec] of Object.entries(servers as Record<string, unknown>)) {
      if (
        typeof spec === "object" &&
        spec !== null &&
        !Array.isArray(spec) &&
        isOurs(name, spec as Record<string, unknown>)
      )
        entries.push({ name, spec: spec as Record<string, unknown> });
      else others++;
    }
  }
  return { client, file, state: "ok", mode, entries, others };
}

/** Default client config locations (plan 03 A-5, A-6 — verified on the machine by this row). */
export function defaultClientConfigs(home: string): { desktop: string; code: string } {
  return { desktop: pasteTarget("desktop", home), code: path.join(home, ".claude.json") };
}

async function nodeVersionOf(io: CliIo, command: string): Promise<string | null> {
  if (command === io.execPath) return io.nodeVersion;
  const r = await io.exec(command, ["--version"], { timeoutMs: 5_000 });
  return r.code === 0 ? r.stdout.trim().slice(0, 32) : null;
}

/** Checks one of our entries; returns its problems (value-free). */
export async function entryProblems(io: CliIo, spec: Record<string, unknown>): Promise<string[]> {
  const problems: string[] = [];
  const command = spec.command;
  const args = Array.isArray(spec.args) ? (spec.args as unknown[]) : [];
  if (typeof command !== "string" || !path.isAbsolute(command)) {
    problems.push("`command` is not an absolute path (GUI clients have no shell PATH)");
  } else {
    try {
      accessSync(command, fsc.X_OK);
      const v = await nodeVersionOf(io, command);
      const parsed = v === null ? null : parseNodeVersion(v);
      if (parsed === null) problems.push("`command` did not report a Node version");
      else if (!nodeAtLeastMin(parsed))
        problems.push(`\`command\` is Node ${v ?? "?"}, below ${MIN_TEXT}`);
    } catch {
      problems.push("`command` does not exist or is not executable");
    }
  }
  const entry = args[0];
  if (typeof entry !== "string" || !path.isAbsolute(entry)) {
    problems.push("`args[0]` is not an absolute path to dist/cli.js");
  } else {
    try {
      lstatSync(entry);
    } catch {
      problems.push("`args[0]` does not exist (run `npm run build`?)");
    }
  }
  if (!args.includes("serve")) problems.push("`args` does not contain `serve`");
  return problems;
}

/** Row 2: launch configuration paths in every client config found. */
export async function checkLaunchConfig(
  io: CliIo,
  scans: readonly ClientConfigScan[],
): Promise<DoctorRow> {
  const title = "Launch config paths";
  const details: string[] = [];
  let bad = false;
  let found = 0;
  for (const s of scans) {
    if (s.state === "missing") {
      details.push(`${s.client}: no config at ${s.file}`);
      continue;
    }
    if (s.state === "invalid") {
      details.push(`${s.client}: ${s.file} could not be read as JSON`);
      continue;
    }
    if (s.entries.length === 0) {
      details.push(`${s.client}: ${s.file} has no ${SERVER_NAME} entry`);
      continue;
    }
    for (const e of s.entries) {
      found++;
      const p = await entryProblems(io, e.spec);
      if (p.length === 0)
        details.push(`${s.client}: entry "${e.name === SERVER_NAME ? e.name : "(ours)"}" ok`);
      else {
        bad = true;
        for (const x of p) details.push(`${s.client}: ${x}`);
      }
    }
  }
  if (bad)
    return row(
      2,
      "launch_config",
      title,
      "fail",
      "a client launches the server with a bad path or Node",
      `replace the entry with the output of \`ff print-config --client desktop\` (or --client code)`,
      details,
    );
  if (found === 0)
    return row(
      2,
      "launch_config",
      title,
      "warn",
      "no client is configured to launch this server",
      "`ff print-config --client desktop` or `--client code`",
      details,
    );
  return row(
    2,
    "launch_config",
    title,
    "ok",
    `${String(found)} client entr${found === 1 ? "y" : "ies"} with absolute, existing paths`,
    null,
    details,
  );
}

const SECRET_ENV_RE = /SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL/i;

/** Row 3: no secret value in a group/other-readable client config. */
export function checkClientSecrecy(scans: readonly ClientConfigScan[]): DoctorRow {
  const title = "Client config secrecy";
  const details: string[] = [];
  let status: RowStatus = "ok";
  let any = false;
  for (const s of scans) {
    for (const e of s.entries) {
      any = true;
      const env = e.spec.env;
      const keys =
        typeof env === "object" && env !== null && !Array.isArray(env)
          ? Object.entries(env as Record<string, unknown>)
              .filter(([k, v]) => SECRET_ENV_RE.test(k) && typeof v === "string" && v.trim() !== "")
              .map(([k]) => k.slice(0, 64))
          : [];
      if (keys.length === 0) continue;
      const readable = s.mode !== null && (s.mode & 0o044) !== 0;
      details.push(
        `${s.client}: secret-looking env key(s) ${keys.join(", ")} with a value${readable ? " in a group/other-readable file" : ""}`,
      );
      status = readable ? "fail" : status === "fail" ? "fail" : "warn";
    }
  }
  if (!any) return row(3, "client_secrecy", title, "skip", "no client entry to check");
  if (status === "ok")
    return row(3, "client_secrecy", title, "ok", "no secret values in client configs");
  return row(
    3,
    "client_secrecy",
    title,
    status,
    "a client config holds a secret value",
    "remove the value (this build needs no secrets); chmod 600 the file",
    details,
  );
}

/** Row 13: writes are unsupported; the reach-session heuristic is reported (plan 02 S12, A-10/A-11). */
export function checkWriteFlag(
  config: Config | null,
  env: CliIo["env"],
  scans: readonly ClientConfigScan[],
): DoctorRow {
  const title = "Write flag / reach session";
  const signals: string[] = [];
  if (env.CLAUDECODE !== undefined && env.CLAUDECODE !== "")
    signals.push("running under Claude Code (CLAUDECODE is set)");
  for (const s of scans) {
    if (s.entries.length > 0 && s.others > 0)
      signals.push(
        `${s.client} config lists ${String(s.others)} other MCP server(s) — another server may give the model file or shell access (heuristic)`,
      );
  }
  const base =
    "writes are not supported in this build (read-only by design; Phase W is conditional)";
  if (config?.writeRequested === true)
    return row(
      13,
      "write_flag",
      title,
      "warn",
      `FF_WRITE_ENABLED=1 is ignored: ${base}`,
      "unset FF_WRITE_ENABLED",
      signals,
    );
  return row(
    13,
    "write_flag",
    title,
    "ok",
    signals.length > 0 ? `reach session detected; ${base}, so there is nothing to disable` : base,
    null,
    signals,
  );
}

// --- row 4: config dir + league file -----------------------------------------------------------------

function refusal(e: unknown): string {
  return e instanceof PathSecurityError ? e.detail : errorText(e);
}

/**
 * Whether the league file is the package's in-repo fixture league (fixture mode: 0600 not
 * required) — decided once by the config (QA-1-094), never by FF_FIXTURE_DIR alone.
 */
export function isFixtureLeague(config: Config): boolean {
  return config.fixtureLeague;
}

/** Row 4: config dir 0700 + owner; league.yaml 0600 if present. */
export function checkConfigDir(config: Config): DoctorRow {
  const title = "Config dir";
  const details: string[] = [];
  try {
    ensureSecureDir(config.configDir, { create: false, what: "config dir" });
  } catch (e) {
    const missing = e instanceof PathSecurityError && e.reason === "missing";
    return row(
      4,
      "config_dir",
      title,
      "fail",
      `${config.configDir}: ${refusal(e)}`,
      missing
        ? "`ff doctor --fix --yes` creates it 0700"
        : "`ff doctor --fix --yes` tightens our own directory's mode; fix ownership/ancestors by hand",
    );
  }
  if (!isFixtureLeague(config)) {
    try {
      const st = lstatSync(config.leagueFile);
      if (st.isSymbolicLink())
        return row(
          4,
          "config_dir",
          title,
          "fail",
          "league.yaml is a symbolic link",
          "replace it with a regular 0600 file",
        );
      const mode = `0${(st.mode & 0o777).toString(8).padStart(3, "0")}`;
      if ((st.mode & 0o077) !== 0)
        return row(
          4,
          "config_dir",
          title,
          "fail",
          `league.yaml is ${mode}: group/other-accessible`,
          "`ff doctor --fix --yes` (chmod 600)",
        );
      // the owner must be able to read it — a 0000/0200 file is not "0600" (QA-1-056)
      if ((st.mode & 0o400) === 0)
        return row(
          4,
          "config_dir",
          title,
          "fail",
          `league.yaml is ${mode} — you cannot read it`,
          "`ff doctor --fix --yes` (chmod 600)",
        );
      details.push(`league.yaml is ${mode}`);
    } catch {
      details.push("no league.yaml yet");
    }
  } else details.push("fixture league (FF_FIXTURE_DIR): 0600 not required");
  return row(4, "config_dir", title, "ok", `${config.configDir} is 0700 and ours`, null, details);
}

/** Row 4 (league file): league.yaml parses and validates; issues are path + fixed reason only. */
export function checkLeagueFile(
  io: CliIo,
  config: Config,
  log: Logger,
): { row: DoctorRow; leagueKey: string | null } {
  const title = "League file";
  const provider = new ManualLeagueProvider({
    file: config.leagueFile,
    clock: io.clock,
    logger: log,
    requirePrivate: !isFixtureLeague(config),
  });
  try {
    const l = provider.load();
    return {
      row: row(
        4,
        "league_file",
        title,
        "ok",
        `league.yaml is valid (season ${String(l.data.season)}, ${String(l.data.num_teams)} teams)`,
      ),
      leagueKey: l.data.ref.league_key,
    };
  } catch (e) {
    if (e instanceof LeagueFileError) {
      if (e.kind === "missing")
        return {
          row: row(
            4,
            "league_file",
            title,
            "fail",
            `no league file at ${config.leagueFile}`,
            MANUAL_LEAGUE_MISSING_HINT,
          ),
          leagueKey: null,
        };
      return {
        row: row(
          4,
          "league_file",
          title,
          "fail",
          `league.yaml is invalid (${String(e.issues.length)} issue(s))`,
          "fix each named location, then re-run `ff doctor`",
          e.issues.slice(0, 20).map((i) => `${i.path}: ${i.reason}`),
        ),
        leagueKey: null,
      };
    }
    return {
      row: row(4, "league_file", title, "fail", errorText(e), "re-run `ff doctor`"),
      leagueKey: null,
    };
  }
}

// --- row 8: cache dir + store ------------------------------------------------------------------------

function existingAncestor(p: string): string {
  let cur = path.resolve(p);
  for (;;) {
    try {
      statSync(cur);
      return cur;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

function freeBytes(p: string): number | null {
  try {
    const s = statfsSync(existingAncestor(p));
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** `PRAGMA quick_check` of a dataset file opened read-only on its own connection. */
export function quickCheckFile(file: string): string {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
    const first = rows[0]?.quick_check;
    return rows.length === 1 && first === "ok" ? "ok" : "corrupt";
  } catch {
    return "unreadable";
  } finally {
    db?.close();
  }
}

/** What row 8 says for each store-open failure (`message: null` = the error text itself). */
const STORE_OPEN_FAILURE: Readonly<
  Record<StoreOpenReason, { readonly message: string | null; readonly fix: string }>
> = {
  not_a_database: {
    message: "store.sqlite is not a SQLite database (overwritten or truncated)",
    fix: "move it aside and restore a backup from <cache>/backups (or run `ff refresh all` to start a new store)",
  },
  corrupt: {
    message: "store.sqlite is corrupt",
    fix: "move it aside and restore a backup from <cache>/backups (or run `ff refresh all` to start a new store)",
  },
  readonly: {
    message: "store.sqlite (or its -wal/-shm file) is read-only",
    fix: "chmod 600 the store files in the cache dir (and `ff doctor --fix --yes` for the directory)",
  },
  busy: {
    message: "store.sqlite is locked by another process",
    fix: "wait for the running `ff` job or server, then re-run `ff doctor`",
  },
  cannot_open: {
    message: "store.sqlite could not be opened by SQLite",
    fix: "check the cache dir's permissions and free space, then re-run `ff doctor`",
  },
  unsupported_node: {
    message: "this Node lacks the node:sqlite API the store needs",
    fix: "use Node ≥ 24.15 (row 1)",
  },
  other: {
    message: null,
    fix: "move it aside and run `ff refresh all`; restore a backup if needed",
  },
};

/**
 * What a refresh, backup or prune writes in place inside the cache dir: store.sqlite, and the ds/,
 * backups/ and tmp/ directories (plan 03 §5 row 8 "writable"). A read-only -wal/-shm file is not
 * listed: SQLite replaces it with the store's own mode when it opens the store.
 */
export function writtenPaths(cacheDir: string): readonly { path: string; dir: boolean }[] {
  return [
    { path: storePath(cacheDir), dir: false },
    ...[datasetDir(cacheDir), backupDir(cacheDir), runTempDir(cacheDir)].map((p) => ({
      path: p,
      dir: true,
    })),
  ];
}

/** Whether an EXISTING written path cannot be written (or, for a directory, entered) by us. */
function readOnly(w: { path: string; dir: boolean }): boolean {
  try {
    lstatSync(w.path);
  } catch {
    return false; // not there yet: created by the next refresh
  }
  try {
    accessSync(w.path, w.dir ? fsc.W_OK | fsc.X_OK : fsc.W_OK);
    return false;
  } catch {
    return true;
  }
}

/** Row 8: cache dir, free space, store integrity + schema, dataset files. */
export function checkStore(config: Config, ex: ExistingStore): DoctorRow {
  const title = "Cache dir + store";
  const details: string[] = [];
  const acc: { status: RowStatus } = { status: "ok" };
  const worse = (s: RowStatus): void => {
    if (s === "fail" || (s === "warn" && acc.status === "ok")) acc.status = s;
  };
  try {
    ensureSecureDir(config.cacheDir, { create: false, what: "cache dir" });
  } catch (e) {
    if (e instanceof PathSecurityError && e.reason === "missing") {
      return row(
        8,
        "store",
        title,
        "warn",
        `${config.cacheDir} does not exist yet`,
        "`ff refresh all` (or `ff doctor --fix --yes`) creates it 0700",
      );
    }
    return row(
      8,
      "store",
      title,
      "fail",
      `${config.cacheDir}: ${refusal(e)}`,
      "`ff doctor --fix --yes` tightens our own directory's mode",
    );
  }
  // plan 03 §5 row 8 "writable": the store, its WAL/-shm files, ds/ and backups/ are written here
  // (QA-1-053: a 0500 cache dir was misreported as a store that could not be opened)
  try {
    accessSync(config.cacheDir, fsc.W_OK | fsc.X_OK);
  } catch {
    return row(
      8,
      "store",
      title,
      "fail",
      `${config.cacheDir} is not writable by you`,
      `\`ff doctor --fix --yes\` restores 0700 on our own directory (chmod 700 ${config.cacheDir})`,
    );
  }
  // ... and so must the store files and subdirectories themselves: node:sqlite opens a 0400 store
  // read-only WITHOUT an error, so the open alone passes and the next refresh fails to publish
  // (QA-1-053)
  const blocked = writtenPaths(config.cacheDir).filter(readOnly);
  if (blocked.length > 0)
    return row(
      8,
      "store",
      title,
      "fail",
      `read-only, so a refresh cannot publish: ${blocked.map((w) => w.path).join(", ")}`,
      "`ff doctor --fix --yes` restores 0600 on our own store files and 0700 on our own directories (or chmod them yourself)",
    );
  const free = freeBytes(config.cacheDir);
  if (free !== null && free < MIN_FREE_BYTES) {
    worse("warn");
    details.push(`free space ${String(Math.round(free / 1024 ** 2))} MB < 1 GB`);
  }
  const bin = MIGRATIONS.length;
  switch (ex.kind) {
    case "missing":
      return row(
        8,
        "store",
        title,
        "warn",
        "store.sqlite not created yet",
        "`ff refresh all`",
        details,
      );
    case "newer":
      return row(
        8,
        "store",
        title,
        "fail",
        `store.sqlite was written by a newer version (v${String(ex.storeVersion)}); this binary supports v${String(bin)}`,
        "upgrade the package or restore a backup from <cache>/backups",
        details,
      );
    case "pending":
      return row(
        8,
        "store",
        title,
        "warn",
        `schema v${String(ex.storeVersion)}; this binary migrates it to v${String(bin)} on the next start (a consistent backup is taken first)`,
        null,
        details,
      );
    case "error": {
      const d = STORE_OPEN_FAILURE[ex.reason ?? "other"];
      return row(
        8,
        "store",
        title,
        "fail",
        d.message ?? `store.sqlite could not be opened: ${ex.message}`,
        d.fix,
        details,
      );
    }
    case "open":
      break;
  }
  const store = ex.store;
  const db = storeInternalsOf(store)?.db;
  let qc = "unknown";
  try {
    const rows = db?.prepare("PRAGMA main.quick_check").all() as
      { quick_check?: unknown }[] | undefined;
    qc = rows?.length === 1 && rows[0]?.quick_check === "ok" ? "ok" : "corrupt";
  } catch {
    qc = "unreadable";
  }
  if (qc !== "ok") {
    worse("fail");
    details.push(`store quick_check: ${qc}`);
  }
  const stats = store.stats();
  let total = stats.size_bytes;
  details.push(
    `schema v${String(stats.schema_version)} (binary v${String(bin)}), ${String(Math.round(stats.size_bytes / 1024))} KB`,
  );
  for (const r of store.repos.refreshLog.current()) {
    const file = datasetFilePath(config.cacheDir, r.source);
    let st;
    try {
      st = lstatSync(file);
    } catch {
      worse("fail");
      details.push(
        `${r.source}: listed as current but its dataset file is missing — \`ff refresh\``,
      );
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) {
      worse("fail");
      details.push(`${r.source}: dataset file is not a regular file`);
      continue;
    }
    total += st.size;
    const c = quickCheckFile(file);
    if (c !== "ok") {
      worse("fail");
      // a plain refresh republishes a damaged current file (e689740): --force is not needed
      details.push(`${r.source}: dataset file quick_check ${c} — \`ff refresh ${r.source}\``);
      continue;
    }
    // another dataset layout (plan 03 §7 ds_schema): never served; the next refresh rewrites it
    const layout = parseDsSchema(readDatasetFileMeta(file)?.ds_schema);
    if (layout !== DS_SCHEMA_VERSION) {
      worse("fail");
      details.push(
        `${r.source}: dataset file layout ${layout === null ? "unknown" : `v${String(layout)}`}, this binary reads v${String(DS_SCHEMA_VERSION)} — \`ff refresh ${r.source}\``,
      );
    }
  }
  if (total > MAX_STORE_BYTES) {
    worse("warn");
    details.push(`store + datasets ${String(Math.round(total / 1024 ** 2))} MB > 500 MB`);
  }
  const ok = acc.status === "ok";
  const msg = ok ? "store and dataset files pass quick_check" : "store or dataset problems";
  return row(8, "store", title, acc.status, msg, ok ? null : "see details", details);
}

/** Row 9: every configured source's age against its hard limit. */
export function checkDatasets(io: CliIo, config: Config, ex: ExistingStore): DoctorRow {
  // a store that exists but is not open says nothing about the datasets (QA-1-053: an unreadable
  // store listed every fresh dataset as never_loaded); a missing store means none was ever loaded
  if (ex.kind !== "open" && ex.kind !== "missing")
    return row(9, "datasets", "Datasets", "skip", "store not open");
  const now = io.clock.nowMs();
  const list =
    ex.kind === "open"
      ? sourceStatuses(ex.store, config, now)
      : configuredSources(config).map((s) => sourceStatus(s, null, null, 0, config.cacheDir, now));
  let status: RowStatus = "ok";
  const details: string[] = [];
  const failing: DatasetSourceId[] = [];
  for (const s of list) {
    const omit = s.beyond_hard === "omit";
    let st: RowStatus = "ok";
    if (s.state === "never_loaded" || s.state === "expired") st = omit ? "warn" : "fail";
    else if (s.state === "stale") st = "warn";
    if (st !== "ok") failing.push(s.source);
    if (st === "fail" || (st === "warn" && status === "ok")) status = st;
    details.push(
      `${s.source}: ${s.state}${s.age_s === null ? "" : ` (${String(s.age_s)} s)`}${s.consecutive_failures > 0 ? `, ${String(s.consecutive_failures)} consecutive failure(s)` : ""}`,
    );
  }
  if (status === "ok")
    return row(
      9,
      "datasets",
      "Datasets",
      "ok",
      "every dataset is within its freshness limits",
      null,
      details,
    );
  return row(
    9,
    "datasets",
    "Datasets",
    status,
    `${String(failing.length)} dataset(s) stale, expired or never loaded`,
    `\`ff refresh all\` (or \`ff refresh <source>\`)`,
    details,
  );
}

/** Row 10: pending journal rows (none can exist in a read-only build). */
export function checkJournal(io: CliIo, ex: ExistingStore): DoctorRow {
  if (ex.kind !== "open") return row(10, "journal", "Pending journal", "skip", "store not open");
  const counts = ex.store.repos.writeJournal.countByStatus();
  const pending = (counts.prepared ?? 0) + (counts.sent ?? 0) + (counts.sent_unknown ?? 0);
  if (pending === 0)
    return row(
      10,
      "journal",
      "Pending journal",
      "ok",
      "no pending writes (writes are not supported in this build)",
    );
  const age = ex.store.repos.writeJournal.oldestPendingAgeSeconds(io.clock.nowIso());
  return row(
    10,
    "journal",
    "Pending journal",
    "warn",
    `${String(pending)} pending journal row(s), oldest ${String(age ?? 0)} s`,
    "no reconciler ships in this build; report it",
  );
}

/** Row 11: launchd jobs installed, loaded, and their last run from refresh_log. */
export async function checkLaunchd(io: CliIo, store: Store | null): Promise<DoctorRow> {
  const title = "launchd jobs";
  if (io.platform !== "darwin")
    return row(
      11,
      "launchd",
      title,
      "na",
      "launchd is macOS-only; schedule `ff refresh` with your platform's scheduler",
    );
  if (io.uid === null) return row(11, "launchd", title, "skip", "no user id");
  const installed = installedPlists(io.home);
  if (installed.length === 0)
    return row(11, "launchd", title, "warn", "no jobs installed", "`ff install-launchd`");
  const details: string[] = [];
  let status: RowStatus = "ok";
  for (const { job } of installed) {
    const r = await io.exec(LAUNCHCTL, launchctl.print(io.uid, labelOf(job)));
    const loaded = r.code === 0;
    if (!loaded) status = "warn";
    const spec = JOBS.find((j) => j.name === job);
    const runs = (spec?.sources ?? [])
      .map((s) => (store === null ? null : store.repos.refreshLog.latest(s as DatasetSourceId)))
      .filter((x) => x !== null)
      .map((x) => `${x.source} ${x.ok ? "ok" : `failed (${x.error ?? "?"})`} at ${x.finished_at}`);
    details.push(
      `${job}: ${loaded ? "loaded" : "NOT loaded"}${runs.length > 0 ? `; last run ${runs.join("; ")}` : ""}`,
    );
  }
  const missing = JOBS.map((j) => j.name).filter((n) => !installed.some((i) => i.job === n));
  if (missing.length > 0) {
    status = "warn";
    details.push(`not installed: ${missing.join(", ")}`);
  }
  return row(
    11,
    "launchd",
    title,
    status,
    status === "ok"
      ? `${String(installed.length)} job(s) installed and loaded`
      : "some jobs are missing or not loaded",
    status === "ok" ? null : "`ff install-launchd` (re-running is safe)",
    details,
  );
}

/** Row 12: `.npmrc` hardening when run from a checkout. */
export function checkNpmrc(root: string): DoctorRow {
  const title = ".npmrc";
  if (!isCheckout(root)) return row(12, "npmrc", title, "na", "not a checkout (installed package)");
  const text = readSecureFile(path.join(root, ".npmrc"), {
    requirePrivate: false,
    maxBytes: 64 * 1024,
    what: ".npmrc",
  });
  const kv = new Map(
    (text ?? "")
      .split("\n")
      .map((l) => l.replace(/[#;].*$/, "").trim())
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()] as const),
  );
  const missing = ["ignore-scripts", "save-exact"].filter((k) => kv.get(k) !== "true");
  if (missing.length === 0)
    return row(12, "npmrc", title, "ok", "ignore-scripts=true, save-exact=true");
  return row(
    12,
    "npmrc",
    title,
    "warn",
    `missing: ${missing.map((k) => `${k}=true`).join(", ")}`,
    "restore the repository's .npmrc",
  );
}

/** Rows 19 and 20: open settings flags for the league. */
export function checkSettingsFlags(store: Store | null, leagueKey: string | null): DoctorRow[] {
  if (store === null || leagueKey === null) {
    const why = store === null ? "store not open" : "no valid league file";
    return [
      row(19, "scoring_mismatch", "Scoring mismatch", "skip", why),
      row(20, "settings_changed", "Settings changed", "skip", why),
    ];
  }
  const flags = store.repos.leagueSettings.openFlags(leagueKey);
  const league = flags.some((f) => f.kind === "scoring_mismatch_league");
  const player = flags.filter((f) => f.kind === "scoring_mismatch");
  const changed = flags.filter((f) => f.kind === "settings_changed");
  const r19 = league
    ? row(
        19,
        "scoring_mismatch",
        "Scoring mismatch",
        "fail",
        "league-wide scoring mismatch (> 10 % of player-weeks)",
        "re-run onboard's self-check; add a pattern row or fixture (plan 08 §6)",
      )
    : player.length > 0
      ? row(
          19,
          "scoring_mismatch",
          "Scoring mismatch",
          "warn",
          `${String(player.length)} open scoring mismatch flag(s)`,
          "compare the named player-weeks against your app",
          player.flatMap((f) => f.detail).slice(0, 20),
        )
      : row(
          19,
          "scoring_mismatch",
          "Scoring mismatch",
          "ok",
          "no open scoring mismatch (the manual league has no platform points to compare in 1a)",
        );
  const r20 =
    changed.length > 0
      ? row(
          20,
          "settings_changed",
          "Settings changed",
          "warn",
          "league settings changed since the last analytics call",
          "re-run an analytics tool; projections re-score on read",
        )
      : row(20, "settings_changed", "Settings changed", "ok", "no unacknowledged settings change");
  return [r19, r20];
}

/** Whether `root` is a git checkout with sources (rows 12 and 21 apply). */
export function isCheckout(root: string): boolean {
  try {
    lstatSync(path.join(root, ".git"));
    return lstatSync(path.join(root, "src")).isDirectory();
  } catch {
    return false;
  }
}

/** Newest mtime under `dir` for files ending in `.ts` (symlinks not followed; bounded walk). */
export function newestSourceMtime(dir: string, budget = { left: 20_000 }): number {
  let newest = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    if (budget.left-- <= 0) break;
    const p = path.join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) newest = Math.max(newest, newestSourceMtime(p, budget));
    else if (st.isFile() && n.endsWith(".ts")) newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

/** Row 21: dist/cli.js newer than every src/**.ts and package.json (plan 03 OBJ-22). */
export function checkStaleBuild(root: string): DoctorRow {
  const title = "Stale build";
  if (!isCheckout(root))
    return row(21, "stale_build", title, "na", "not a checkout (installed package)");
  let dist: number;
  try {
    dist = statSync(distEntry(root)).mtimeMs;
  } catch {
    return row(
      21,
      "stale_build",
      title,
      "warn",
      "dist/cli.js does not exist — the package is not built",
      "`npm run build`",
    );
  }
  let pkg = 0;
  try {
    pkg = statSync(path.join(root, "package.json")).mtimeMs;
  } catch {
    pkg = 0;
  }
  const newest = Math.max(newestSourceMtime(path.join(root, "src")), pkg);
  if (dist >= newest)
    return row(21, "stale_build", title, "ok", "dist/ is newer than every source file");
  return row(
    21,
    "stale_build",
    title,
    "fail",
    "dist/ is older than the sources — the client is launching an old server",
    "`npm run build`",
  );
}

/** Reads the last `LOG_TAIL_BYTES` of a file (no symlink), as lines. */
export function tailLines(file: string, maxLines = LOG_TAIL_LINES): string[] | null {
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const len = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, st.size - len);
    const lines = buf
      .subarray(0, n)
      .toString("utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "");
    if (st.size > len) lines.shift();
    return lines.slice(-maxLines);
  } finally {
    closeSync(fd);
  }
}

const LOG_SIGNAL_RE =
  /error|exception|fail|exit|disconnect|terminated|signal|EACCES|ENOENT|not found/i;
const LOG_BAD_RE = /error|exception|fail|EACCES|ENOENT|not found/i;

/** The default Claude Desktop per-server log (plan 03 A-8). */
export function defaultClientLog(home: string): string {
  return path.join(home, "Library", "Logs", "Claude", `mcp-server-${SERVER_NAME}.log`);
}

/** Row 22: the last exit reason / error lines of the client's log for this server (redacted). */
export function checkClientLog(io: CliIo, file: string): DoctorRow {
  const title = "Client MCP log tail";
  const lines = tailLines(file);
  if (lines === null)
    return row(
      22,
      "client_log",
      title,
      "skip",
      `no client log at ${file}`,
      "pass --client-log <path> if your client logs elsewhere",
    );
  const secrets = new SecretRegistry();
  const hits = lines
    .filter((l) => LOG_SIGNAL_RE.test(l))
    .slice(-5)
    .map((l) => truncate(redactString(l, secrets), 200));
  if (hits.length === 0)
    return row(
      22,
      "client_log",
      title,
      "ok",
      `last ${String(lines.length)} line(s) show no errors or exits`,
    );
  const bad = hits.some((l) => LOG_BAD_RE.test(l));
  return row(
    22,
    "client_log",
    title,
    bad ? "warn" : "ok",
    bad ? "the client log shows errors for this server" : "the client log shows exits only",
    bad
      ? "the lines name the fix (`npm run build`, an absolute path, `ff doctor` rows above)"
      : null,
    hits,
  );
}

/** Row 17 (online): nflverse release reachability (timestamp.txt only). */
export async function checkSourcesOnline(
  io: CliIo,
  config: Config,
  log: Logger,
): Promise<DoctorRow> {
  const transport = config.fixtureDir !== null ? fixtureFetch(config.fixtureDir) : io.fetch;
  const http = createHttpClient({ ...(transport === null ? {} : { fetch: transport }), log });
  const details: string[] = [];
  let bad = 0;
  for (const tag of ["schedules", "injuries", "weekly_rosters", "stats_player"]) {
    try {
      const r = await http.get(`${NFLVERSE_RELEASE_BASE}/${tag}/timestamp.txt`, {
        signal: AbortSignal.timeout(20_000),
        maxBytes: 256,
      });
      details.push(`nflverse ${tag}: HTTP ${String(r.status)}`);
      if (r.status !== 200) bad++;
    } catch (e) {
      bad++;
      details.push(`nflverse ${tag}: ${errorText(e)}`);
    }
  }
  return bad === 0
    ? row(
        17,
        "sources_online",
        "Sources (online)",
        "ok",
        "every nflverse release answers",
        null,
        details,
      )
    : row(
        17,
        "sources_online",
        "Sources (online)",
        "fail",
        `${String(bad)} release(s) unreachable`,
        "check the network; `ff refresh` keeps the previous data meanwhile",
        details,
      );
}

// --- --fix -------------------------------------------------------------------------------------------

/** One repair `--fix` may apply. */
export interface Fix {
  readonly description: string;
  apply(): void;
}

function dirFix(dir: string, what: string, create = true): Fix | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    if (!create || insecureAncestors(dir).length > 0) return null;
    return {
      description: `create ${what} ${dir} (0700)`,
      apply: () => {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      },
    };
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (st.isSymbolicLink() || !st.isDirectory() || (uid !== null && st.uid !== uid)) return null;
  // loose group/other bits, or an owner who cannot write/enter it (QA-1-053: a 0500 cache dir)
  if ((st.mode & 0o077) === 0 && (st.mode & 0o700) === 0o700) return null;
  return {
    description: `chmod 700 ${dir}`,
    apply: () => {
      chmodSync(dir, 0o700);
    },
  };
}

/** The repairs `--fix` would make for this config (never on a symlink or a file we do not own). */
export function plannedFixes(config: Config): Fix[] {
  const fixes: Fix[] = [];
  const c = dirFix(config.configDir, "config dir");
  if (c !== null) fixes.push(c);
  if (!isFixtureLeague(config)) {
    try {
      const st = lstatSync(config.leagueFile);
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      // loose group/other bits, or an owner who cannot read it (QA-1-056)
      if (
        st.isFile() &&
        (uid === null || st.uid === uid) &&
        ((st.mode & 0o077) !== 0 || (st.mode & 0o400) === 0)
      )
        fixes.push({
          description: `chmod 600 ${config.leagueFile}`,
          apply: () => {
            chmodSync(config.leagueFile, 0o600);
          },
        });
    } catch {
      // no league file: nothing to fix (the onboard Skill writes it)
    }
  }
  const k = dirFix(config.cacheDir, "cache dir");
  if (k !== null) fixes.push(k);
  // the store files and subdirectories a refresh writes, when they are ours (QA-1-053)
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  for (const w of writtenPaths(config.cacheDir)) {
    if (w.dir) {
      const d = dirFix(w.path, "directory", false);
      if (d !== null) fixes.push(d);
      continue;
    }
    try {
      const st = lstatSync(w.path);
      if (
        st.isFile() &&
        (uid === null || st.uid === uid) &&
        ((st.mode & 0o077) !== 0 || (st.mode & 0o600) !== 0o600)
      )
        fixes.push({
          description: `chmod 600 ${w.path}`,
          apply: () => {
            chmodSync(w.path, 0o600);
          },
        });
    } catch {
      // not there: nothing to fix
    }
  }
  return fixes;
}

/** Asks y/N on a terminal; anything else (or no terminal) is "no". */
export async function confirm(io: CliIo, question: string): Promise<boolean> {
  if ((io.stdin as { isTTY?: boolean }).isTTY !== true) return false;
  const rl = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// --- the run -----------------------------------------------------------------------------------------

/** Runs every row; the store (if opened) is closed before returning. */
export async function runDoctor(io: CliIo, opts: DoctorOptions): Promise<DoctorReport> {
  const rows: DoctorRow[] = [];
  let config: Config | null = null;
  let log = makeLogger(io, bootLevel(io.env));
  try {
    config = loadConfigFromProcess({ env: io.env, home: io.home, repoRoot: io.packageRoot });
    log = makeLogger(io, config.logLevel);
  } catch (e) {
    const issues =
      e instanceof ConfigError ? e.issues.map((i) => `${i.key}: ${i.reason}`) : [errorText(e)];
    rows.push(
      row(
        0,
        "config",
        "Configuration",
        "config",
        "the configuration is invalid",
        "fix the named keys (env or <config>/config.json)",
        issues,
      ),
    );
  }
  if (config !== null)
    rows.push(
      row(0, "config", "Configuration", "ok", "configuration resolves", null, [...config.warnings]),
    );

  if (config !== null && opts.fix) {
    const fixes = plannedFixes(config);
    if (fixes.length > 0) {
      const go =
        opts.yes ||
        (await confirm(
          io,
          `Apply ${String(fixes.length)} fix(es): ${fixes.map((f) => f.description).join("; ")}?`,
        ));
      for (const f of fixes) {
        if (!go) {
          await writeLine(io.stderr, `ff doctor: not applied (add --yes): ${f.description}`);
          continue;
        }
        try {
          f.apply();
          await writeLine(io.stderr, `ff doctor: fixed: ${f.description}`);
        } catch (e) {
          await writeLine(io.stderr, `ff doctor: could not ${f.description}: ${errorText(e)}`);
        }
      }
    }
  }

  rows.push(checkNode(io.nodeVersion));
  const defaults = defaultClientConfigs(io.home);
  const scans = [
    scanClientConfig("desktop", opts.clientConfig ?? defaults.desktop),
    scanClientConfig("code", defaults.code),
  ];
  rows.push(await checkLaunchConfig(io, scans));
  rows.push(checkClientSecrecy(scans));

  let ex: ExistingStore = { kind: "missing" };
  let leagueKey: string | null = null;
  try {
    if (config !== null) {
      rows.push(checkConfigDir(config));
      const lf = checkLeagueFile(io, config, log);
      rows.push(lf.row);
      leagueKey = lf.leagueKey;
    } else {
      rows.push(row(4, "config_dir", "Config dir", "skip", "configuration invalid"));
      rows.push(row(4, "league_file", "League file", "skip", "configuration invalid"));
    }
    rows.push(row(5, "token_file", "Token file", "na", NO_YAHOO));
    rows.push(row(6, "client_secret", "Client secret", "na", NO_YAHOO));
    rows.push(
      row(7, "gate_key", "Gate key", "na", "not applicable (no write gate in a read-only build)"),
    );
    if (config !== null) {
      ex = openExistingStore(config, io.clock, log, opts.factory);
      rows.push(checkStore(config, ex));
      rows.push(checkDatasets(io, config, ex));
    } else {
      rows.push(row(8, "store", "Cache dir + store", "skip", "configuration invalid"));
      rows.push(row(9, "datasets", "Datasets", "skip", "configuration invalid"));
    }
    const store = ex.kind === "open" ? ex.store : null;
    rows.push(checkJournal(io, ex));
    rows.push(await checkLaunchd(io, store));
    rows.push(checkNpmrc(io.packageRoot));
    rows.push(checkWriteFlag(config, io.env, scans));
    rows.push(row(14, "clock_skew", "Clock skew (online)", "na", NO_YAHOO));
    rows.push(row(15, "token_validity", "Token validity (online)", "na", NO_YAHOO));
    rows.push(row(16, "provisioning", "Provisioning (online)", "na", NO_YAHOO));
    if (!opts.online)
      rows.push(row(17, "sources_online", "Sources (online)", "skip", "offline (use --online)"));
    else if (config === null)
      rows.push(row(17, "sources_online", "Sources (online)", "skip", "configuration invalid"));
    else rows.push(await checkSourcesOnline(io, config, log));
    rows.push(row(18, "listener", "Auth listener", "na", NO_YAHOO));
    rows.push(...checkSettingsFlags(store, leagueKey));
    rows.push(checkStaleBuild(io.packageRoot));
    rows.push(checkClientLog(io, opts.clientLog ?? defaultClientLog(io.home)));
  } finally {
    if (ex.kind === "open") ex.store.close();
  }
  return {
    version: VERSION,
    node: io.nodeVersion,
    generated_at: io.clock.nowIso(),
    online: opts.online,
    exit_code: exitCodeFor(rows),
    rows,
  };
}

const MARK: Record<RowStatus, string> = {
  ok: " ok ",
  warn: "warn",
  fail: "FAIL",
  config: "CONF",
  na: " -- ",
  skip: "skip",
};

/** The terminal rendering. */
export function renderDoctor(r: DoctorReport): string[] {
  const out: string[] = [
    `ff doctor — fantasy-football-mcp ${r.version}, node ${r.node}${r.online ? " (online)" : ""}`,
  ];
  for (const x of r.rows) {
    out.push(
      `[${MARK[x.status]}] ${x.n === 0 ? "  " : String(x.n).padStart(2)} ${x.title} — ${x.message}`,
    );
    for (const d of x.details) out.push(`           ${d}`);
    if (x.fix !== null && x.status !== "ok") out.push(`           → ${x.fix}`);
  }
  const worst =
    r.exit_code === 0
      ? "no failures"
      : r.exit_code === 2
        ? "configuration problem"
        : "failures above";
  out.push(`exit ${String(r.exit_code)}: ${worst}`);
  return out;
}

/** `ff doctor`. */
export async function doctor(io: CliIo, opts: DoctorOptions): Promise<number> {
  const report = await runDoctor(io, opts);
  if (opts.json) await writeLine(io.stdout, JSON.stringify(report, null, 2));
  else for (const l of renderDoctor(report)) await writeLine(io.stdout, l);
  return report.exit_code;
}
