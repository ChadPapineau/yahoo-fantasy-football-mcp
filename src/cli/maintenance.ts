// maintenance.ts — `ff prune` and `ff backup` (plan 06 §1.2 `store prune` weekly Sun 03:00: cache
// rows past their hard limits, ds/*.tmp staging debris, backups beyond two versions; `store backup`
// weekly Sun 03:10: a consistent `VACUUM INTO`/backup-API copy of store.sqlite, keep 4; plan 01 §5.1
// "never pruned": recommendation_log, league_settings, write_journal are not touched here; plan 03 L7
// consistent backups). Only files this program created, matched by exact name patterns, are removed.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  backupDir,
  datasetDir,
  ensureSecureDir,
  PathSecurityError,
  resolveAbsolute,
  runTempDir,
} from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { prunePreMigrationBackups } from "../store/backup.js";
import { PUBLISH_LOCK_STALE_MS } from "../store/index.js";
import type { StoreFactory } from "../store/types.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** The Yahoo cache's hard limit — rows older than this are useless (plan 01 §5.2: 7 d max). */
export const PLATFORM_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Weeks of backups kept (plan 06 §1.2 `store backup`, keep 4): every backup of the newest 4 weeks. */
export const KEEP_WEEKLY_BACKUPS = 4;
/** Temp debris younger than this may belong to a running refresh and is left alone. */
export const DEBRIS_MIN_AGE_MS = PUBLISH_LOCK_STALE_MS;

const WEEKLY_RE = /^store-\d{4}-\d{2}-\d{2}(?:-\d{6})?\.sqlite$/;
const DS_DEBRIS_RE =
  /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*\.[A-Za-z0-9_-]+\.[0-9a-f]{12}\.tmp(?:-journal)?$/;
const RUN_TMP_RE = /^[A-Za-z0-9_]{1,80}-[A-Za-z0-9]{6}$/;

/** What a prune removed. */
export interface PruneReport {
  readonly platform_cache_rows: number;
  readonly dataset_debris: readonly string[];
  readonly run_temp: readonly string[];
  readonly premigration_backups: readonly string[];
}

/**
 * Whether `dir` is one of our own directories to prune in: `false` when it does not exist, `true`
 * when it is a real 0700 directory owned by this user; anything else (a symlink someone pointed
 * elsewhere, loose bits, another owner, an insecure parent) throws — prune never reads through it,
 * let alone deletes in it (QA-1-087).
 */
function ownDirExists(dir: string, what: string): boolean {
  try {
    ensureSecureDir(dir, { create: false, what });
    return true;
  } catch (e) {
    if (e instanceof PathSecurityError && e.reason === "missing") return false;
    throw e;
  }
}

const ownUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

function oldEntries(dir: string, re: RegExp, nowMs: number): { name: string; dir: boolean }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const uid = ownUid();
  const out: { name: string; dir: boolean }[] = [];
  for (const n of names.sort()) {
    if (!re.test(n)) continue;
    const st = lstatSync(path.join(dir, n));
    if (nowMs - st.mtimeMs < DEBRIS_MIN_AGE_MS) continue;
    if (st.isFile() || st.isSymbolicLink()) out.push({ name: n, dir: false });
    // a run temp dir is ours (mkdtemp under our 0700 tmp/); one owned by anyone else is left alone
    else if (st.isDirectory() && (uid === null || st.uid === uid)) out.push({ name: n, dir: true });
  }
  return out;
}

/** Removes what `prune` may remove; pure over the given paths apart from the filesystem. */
export function pruneFiles(
  cacheDir: string,
  nowMs: number,
): Omit<PruneReport, "platform_cache_rows"> {
  const ds = datasetDir(cacheDir);
  const tmp = runTempDir(cacheDir);
  const backups = backupDir(cacheDir);
  // every directory is checked before anything is removed from any of them
  const has = {
    ds: ownDirExists(ds, "dataset directory"),
    tmp: ownDirExists(tmp, "run temp directory"),
    backups: ownDirExists(backups, "backups directory"),
  };
  const debris = has.ds ? oldEntries(ds, DS_DEBRIS_RE, nowMs).filter((e) => !e.dir) : [];
  for (const e of debris) rmSync(path.join(ds, e.name), { force: true });
  const runs = has.tmp ? oldEntries(tmp, RUN_TMP_RE, nowMs) : [];
  for (const e of runs) rmSync(path.join(tmp, e.name), { recursive: e.dir, force: true });
  return {
    dataset_debris: debris.map((e) => e.name),
    run_temp: runs.map((e) => e.name),
    premigration_backups: has.backups ? prunePreMigrationBackups(backups) : [],
  };
}

/** `ff prune`. */
export async function prune(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly notify: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  let report: PruneReport;
  try {
    const store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
    let rows: number;
    try {
      rows = store.repos.platformCache.prune(
        new Date(io.clock.nowMs() - PLATFORM_CACHE_MAX_AGE_MS).toISOString(),
      );
    } finally {
      store.close();
    }
    report = { platform_cache_rows: rows, ...pruneFiles(config.cacheDir, io.clock.nowMs()) };
  } catch (e) {
    // a refused path names which directory (local output: the user's own paths)
    await writeLine(
      io.stderr,
      `ff prune: ${e instanceof PathSecurityError ? `${e.name}: ${e.message}` : errorText(e)}`,
    );
    if (opts.notify) await notifier.notifyFailure("store-prune", "prune");
    return EXIT.ERROR;
  }
  log.info("prune.done", {
    platform_cache_rows: report.platform_cache_rows,
    dataset_debris: report.dataset_debris.length,
    run_temp: report.run_temp.length,
    premigration_backups: report.premigration_backups.length,
  });
  await writeLine(
    io.stdout,
    `pruned: ${String(report.platform_cache_rows)} cache row(s), ${String(report.dataset_debris.length)} dataset temp file(s), ${String(report.run_temp.length)} run temp dir(s), ${String(report.premigration_backups.length)} old pre-migration backup(s). Never pruned: recommendation log, league settings, write journal.`,
  );
  return EXIT.OK;
}

/** `<backups>/store-YYYY-MM-DD.sqlite`, or `…-HHMMSS.sqlite` when today's exists. */
export function weeklyBackupPath(dir: string, nowMs: number): string {
  const iso = new Date(nowMs).toISOString();
  const day = iso.slice(0, 10);
  const base = path.join(dir, `store-${day}.sqlite`);
  try {
    lstatSync(base);
  } catch {
    return base;
  }
  return path.join(dir, `store-${day}-${iso.slice(11, 19).replaceAll(":", "")}.sqlite`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The week a `store-YYYY-MM-DD(-HHMMSS)?.sqlite` name belongs to (Monday-based, UTC — the same
 * calendar the dated name is written in), or `null` for a name whose date is not a real date.
 */
export function backupWeekOf(name: string): number | null {
  if (!WEEKLY_RE.test(name)) return null;
  const day = name.slice("store-".length, "store-".length + 10);
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day) return null;
  // 1970-01-05 was a Monday: day 4 since the epoch starts week 0
  return Math.floor((Math.round(ms / DAY_MS) - 4) / 7);
}

/**
 * Keeps every backup of the newest `keep` WEEKS that have one and deletes the backups of older
 * weeks; returns the names removed. Plan 06 §1.2's "keep 4" is four weekly restore points: extra
 * `ff backup` runs inside one week (a time-suffixed name) add to that week and never push an older
 * week out (QA-1-054). A name whose date is not a real date is never deleted.
 */
export function rotateWeeklyBackups(dir: string, keep = KEEP_WEEKLY_BACKUPS): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const byWeek = new Map<number, string[]>();
  for (const n of names) {
    const w = backupWeekOf(n);
    if (w !== null) byWeek.set(w, [...(byWeek.get(w) ?? []), n]);
  }
  const kept = new Set([...byWeek.keys()].sort((a, b) => b - a).slice(0, Math.max(0, keep)));
  const removed: string[] = [];
  for (const [w, files] of byWeek) {
    if (kept.has(w)) continue;
    for (const n of files) {
      const p = path.join(dir, n);
      if (lstatSync(p).isFile()) {
        rmSync(p, { force: true });
        removed.push(n);
      }
    }
  }
  return removed.sort();
}

/** `ff backup [--to <abs path>]`. */
export async function backup(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: {
    readonly to: string | undefined;
    readonly notify: boolean;
    readonly factory?: StoreFactory;
  },
): Promise<number> {
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  let dest: string;
  let rotated: string[] = [];
  try {
    if (opts.to !== undefined) {
      dest = resolveAbsolute(opts.to, io.home, "--to");
    } else {
      const dir = backupDir(config.cacheDir);
      ensureSecureDir(dir, { create: true, what: "backups directory" });
      dest = weeklyBackupPath(dir, io.clock.nowMs());
    }
    const store = openStore(config, io.clock, log, {
      migrate: true,
      ...(opts.factory ? { factory: opts.factory } : {}),
    });
    try {
      const r = await store.backup(dest);
      await writeLine(
        io.stdout,
        `backup written: ${r.path} (${String(r.bytes)} bytes, ${r.method})`,
      );
    } finally {
      store.close();
    }
    if (opts.to === undefined) rotated = rotateWeeklyBackups(backupDir(config.cacheDir));
  } catch (e) {
    await writeLine(io.stderr, `ff backup: ${errorText(e)}`);
    if (opts.notify) await notifier.notifyFailure("store-backup", "backup");
    return EXIT.ERROR;
  }
  if (rotated.length > 0)
    await writeLine(io.stdout, `removed ${String(rotated.length)} older weekly backup(s)`);
  return EXIT.OK;
}
