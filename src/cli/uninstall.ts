// uninstall.ts — `ff uninstall [--dry-run] [--purge [--purge-config] --yes]` (plan 03 L8, §8): boot
// out and delete our LaunchAgents; delete user data ONLY with --purge AND the explicit --yes; print —
// never edit — the client-config entry, the `claude mcp remove` command and the global npm uninstall.
// Deletion is by exact known name inside the cache/config dirs (store, its -wal/-shm/lock, ds/,
// backups/, tmp/, the notify state; league.yaml, config.json), never a recursive delete of a
// directory a user might have pointed FF_CACHE_DIR at, and the directory itself is removed only
// when empty afterwards. The only recursive delete is of a run directory under tmp/, and only one
// that passes prune's own rule (QA-1-087): ds/, backups/ and tmp/ are entered only when each is our
// private 0700 directory, and a tmp/ entry is removed only when it is a 0700 directory of ours, as
// mkdtemp creates it. Anything else is left alone and named, with the reason (QA-2-029).
import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  BACKUP_DIR_NAME,
  CONFIG_FILE_NAME,
  DATASET_DIR_NAME,
  ensureSecureDir,
  LEAGUE_FILE_NAME,
  PathSecurityError,
  RUN_TEMP_DIR_NAME,
  STORE_FILE_NAME,
} from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { EXIT, UsageError } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { removeJobs } from "./launchd.js";
import { isOwnRunTempDir, RUN_TMP_RE } from "./maintenance.js";
import { NOTIFY_STATE_FILE } from "./notify.js";
import { SERVER_NAME, pasteTarget } from "./print-config.js";

/** Plain files of ours directly inside the cache dir. */
const CACHE_FILES = [
  STORE_FILE_NAME,
  `${STORE_FILE_NAME}-wal`,
  `${STORE_FILE_NAME}-shm`,
  `${STORE_FILE_NAME}-journal`,
  `${STORE_FILE_NAME}.lock`,
  NOTIFY_STATE_FILE,
];
/** Directories of ours inside the cache dir, emptied by pattern. */
const CACHE_DIRS: readonly { readonly name: string; readonly re: RegExp }[] = [
  {
    name: DATASET_DIR_NAME,
    re: /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*(?:\.sqlite|\..*\.tmp(?:-journal)?)$/,
  },
  {
    name: BACKUP_DIR_NAME,
    re: /^(?:store-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.sqlite|store\.sqlite\.bak-v\d+(?:-\d+)?)$/,
  },
  { name: RUN_TEMP_DIR_NAME, re: RUN_TMP_RE },
];
/** Plain files of ours inside the config dir. */
const CONFIG_FILES = [LEAGUE_FILE_NAME, CONFIG_FILE_NAME];

function kind(p: string): "file" | "dir" | "symlink" | "other" | null {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return "symlink";
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return "other";
  } catch {
    return null;
  }
}

/**
 * One step: unlink a file/symlink, remove one of our run-temp trees, rmdir if empty — or `keep` a
 * path that is not ours, with a value-free `reason` to show the user.
 */
export type PurgeStep =
  | { readonly path: string; readonly action: "unlink" | "rmtree" | "rmdir" }
  | { readonly path: string; readonly action: "keep"; readonly reason: string };

/** Why a pattern directory is not entered (it is not our own 0700 directory), or null. */
function notOurDir(sub: string): string | null {
  try {
    ensureSecureDir(sub, { create: false, what: "directory" });
    return null;
  } catch (e) {
    if (!(e instanceof PathSecurityError)) return "it could not be checked";
    if (e.reason === "wrong_owner") return "it belongs to another user";
    if (e.reason === "insecure_ancestor") return "a parent directory is writable by others";
    return "group/other permission bits are set; ours are always 0700";
  }
}

/** What a purge of `dir` would delete (existing entries only), in deletion order. */
export function purgePlan(
  dir: string,
  files: readonly string[],
  dirs: readonly { readonly name: string; readonly re: RegExp }[],
): PurgeStep[] {
  const out: PurgeStep[] = [];
  if (kind(dir) !== "dir") return out;
  for (const d of dirs) {
    const sub = path.join(dir, d.name);
    if (kind(sub) !== "dir") continue;
    // the same rule as prune: a directory that is not our private 0700 one is never entered
    const refused = notOurDir(sub);
    if (refused !== null) {
      out.push({ path: sub, action: "keep", reason: `not our private directory: ${refused}` });
      continue;
    }
    const runDirs = d.name === RUN_TEMP_DIR_NAME;
    for (const n of readdirSync(sub).sort()) {
      if (!d.re.test(n)) continue;
      const p = path.join(sub, n);
      const k = kind(p);
      if (!runDirs) {
        if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
      } else if (k === "dir" && isOwnRunTempDir(lstatSync(p))) {
        out.push({ path: p, action: "rmtree" });
      } else {
        out.push({ path: p, action: "keep", reason: "not a run directory this program made" });
      }
    }
    out.push({ path: sub, action: "rmdir" });
  }
  for (const f of files) {
    const p = path.join(dir, f);
    const k = kind(p);
    if (k === "file" || k === "symlink") out.push({ path: p, action: "unlink" });
  }
  out.push({ path: dir, action: "rmdir" });
  return out;
}

/** Executes a plan; a non-empty directory (someone else's files) is kept, never forced. */
export function executePurge(plan: readonly PurgeStep[]): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const s of plan) {
    if (s.action === "keep") continue;
    try {
      if (s.action === "rmdir") rmdirSync(s.path);
      else rmSync(s.path, { recursive: s.action === "rmtree", force: true });
      removed.push(s.path);
    } catch {
      kept.push(s.path);
    }
  }
  return { removed, kept };
}

/** The manual steps uninstall prints and never performs (plan 03 §8 step 4–5). */
export function manualSteps(home: string): string[] {
  return [
    `Remove the "${SERVER_NAME}" entry from ${pasteTarget("desktop", home)} (Claude Desktop), then restart it.`,
    `Claude Code: claude mcp remove --scope user ${SERVER_NAME}`,
    "If installed globally: npm uninstall -g fantasy-football-mcp",
    "Time Machine or other backups may still hold copies of league.yaml and the store.",
  ];
}

/** `ff uninstall`. */
export async function uninstall(
  io: CliIo,
  config: Config,
  opts: {
    readonly dryRun: boolean;
    readonly purge: boolean;
    readonly purgeConfig: boolean;
    readonly yes: boolean;
  },
): Promise<number> {
  if (opts.purgeConfig && !opts.purge) throw new UsageError("--purge-config requires --purge");
  const out = (l: string): Promise<void> => writeLine(io.stdout, l);
  const cachePlan = opts.purge ? purgePlan(config.cacheDir, CACHE_FILES, CACHE_DIRS) : [];
  const configPlan = opts.purgeConfig ? purgePlan(config.configDir, CONFIG_FILES, []) : [];
  const plan = [...cachePlan, ...configPlan];
  const deleting = plan.filter((p) => p.action !== "keep");
  const leaving = plan.flatMap((p) => (p.action === "keep" ? [p] : []));

  if (opts.purge && !opts.yes && !opts.dryRun) {
    await writeLine(
      io.stderr,
      "ff uninstall: --purge deletes your data and needs the explicit --yes. It would delete:",
    );
    for (const p of deleting) await writeLine(io.stderr, `  ${p.path}`);
    if (leaving.length > 0) {
      await writeLine(io.stderr, "It would leave alone (not created by this program):");
      for (const p of leaving) await writeLine(io.stderr, `  ${p.path} (${p.reason})`);
    }
    await writeLine(
      io.stderr,
      "The store holds your recommendation log; keep a copy first with `ff backup --to <path>`.",
    );
    await writeLine(io.stderr, "Nothing was changed (launchd jobs included).");
    return EXIT.USAGE;
  }

  const prefix = opts.dryRun ? "would " : "";
  if (io.platform === "darwin" && io.uid !== null) {
    const steps = await removeJobs({
      home: io.home,
      uid: io.uid,
      exec: io.exec,
      dryRun: opts.dryRun,
    });
    for (const s of steps)
      await out(`${prefix}${s.kind === "remove" ? "remove" : "launchctl"} ${s.detail}`);
    if (steps.length === 0) await out("no launchd jobs of ours are installed");
  } else {
    await out("launchd: not available on this platform — nothing to boot out");
  }

  if (opts.purge) {
    if (opts.dryRun) {
      for (const p of deleting) await out(`would delete ${p.path}`);
    } else {
      const r = executePurge(deleting);
      for (const p of r.removed) await out(`deleted ${p}`);
      for (const p of r.kept) await out(`kept (not empty or not removable) ${p}`);
    }
    for (const p of leaving) await out(`kept (not ours: ${p.reason}) ${p.path}`);
  } else {
    await out(
      `kept your data: ${config.cacheDir} (store, datasets, backups) — \`ff uninstall --purge --yes\` deletes it`,
    );
  }
  if (!opts.purgeConfig)
    await out(
      `kept your config: ${config.configDir} (league.yaml) — add --purge-config to delete it`,
    );
  await out("");
  await out("Not done automatically (do these yourself):");
  for (const s of manualSteps(io.home)) await out(`  - ${s}`);
  return EXIT.OK;
}
