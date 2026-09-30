// paths.ts — XDG resolution, absolute-path assertions, and 0700/0600 filesystem helpers for the
// config and cache directories (plan 01 §5.1; plan 02 §3.3 "never relative to cwd or inside the
// repo", "refuse to proceed if mode has group/other bits"; plan 03 §1.1 step 1, §3, §5 rows 4/8).
// Symlinks are never followed for the config dir, the cache dir, or any file opened here; files are
// opened O_NONBLOCK (a planted FIFO cannot stall startup) and a directory whose ancestors are
// group/other-writable without the sticky bit is refused (ssh StrictModes; critic C-20).
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The directory name under the XDG config/cache roots. */
export const APP_DIR_NAME = "fantasy-football-mcp";
/** The store file name inside the cache dir (plan 01 §5.1). */
export const STORE_FILE_NAME = "store.sqlite";
/** The per-source dataset directory inside the cache dir (plan 01 §5.5, round 2 OBJ-27). */
export const DATASET_DIR_NAME = "ds";
/** The backups directory inside the cache dir (plan 03 §7). */
export const BACKUP_DIR_NAME = "backups";
/** The optional non-secret config file inside the config dir (plan 03 §3). */
export const CONFIG_FILE_NAME = "config.json";
/** The manual league file inside the config dir (plan 01 §8, round 2 OBJ-29). */
export const LEAGUE_FILE_NAME = "league.yaml";
/** Largest file `readSecureFile` will read (league.yaml, config.json): 1 MiB. */
export const MAX_SECURE_FILE_BYTES = 1024 * 1024;

/** Why a path was refused. */
export type PathRefusal =
  | "empty"
  | "nul_byte"
  | "relative"
  | "home_user_form"
  | "inside_repo"
  | "synced_folder"
  | "symlink"
  | "not_directory"
  | "not_regular_file"
  | "insecure_mode"
  | "wrong_owner"
  | "too_large"
  | "insecure_ancestor"
  | "missing";

/**
 * A path failed a safety rule. `ff doctor` and startup report `reason` + the fixed `message`. Inside
 * a tool call (e.g. league.yaml re-read and found 0644) it maps to INTERNAL, never VALIDATION — the
 * model's arguments are not at fault (critic C-13); startup still exits 2.
 */
export class PathSecurityError extends Error {
  /** Error-contract code (plan 01 §4.3): an operator/environment problem, not the caller's. */
  readonly ffCode = "INTERNAL" as const;
  /** Which rule refused the path. */
  readonly reason: PathRefusal;
  /** The offending path (local diagnostics only; never sent to a tool result). */
  readonly path: string;
  /** The message without the path — safe to show anywhere (`ConfigIssue.reason`). */
  readonly detail: string;
  constructor(reason: PathRefusal, p: string, what: string) {
    super(`${what}: ${REFUSAL_TEXT[reason]} (${p})`);
    this.name = "PathSecurityError";
    this.reason = reason;
    this.path = p;
    this.detail = REFUSAL_TEXT[reason];
  }
}

const REFUSAL_TEXT: Record<PathRefusal, string> = {
  empty: "path is empty",
  nul_byte: "path contains a NUL byte",
  relative: "path must be absolute (or start with ~/)",
  home_user_form: "the ~user form is not supported; use ~/ or an absolute path",
  inside_repo:
    "path is inside the repository checkout; secrets and league data must live outside it",
  synced_folder:
    "path is inside a cloud-synced folder (Documents, Desktop, iCloud Drive, CloudStorage); use ~/.config or ~/.cache",
  symlink: "refusing to follow a symbolic link",
  not_directory: "exists but is not a directory",
  not_regular_file: "exists but is not a regular file",
  insecure_mode:
    "group/other permission bits are set (directories must be 0700, files 0600); run `ff doctor --fix`",
  wrong_owner: "is not owned by the current user",
  too_large: "file is larger than the allowed maximum",
  insecure_ancestor:
    "a parent directory is writable by group/other without the sticky bit, so the directory could be swapped; fix the parent's permissions",
  missing: "does not exist",
};

/** A minimal environment view (process.env shape). */
export type Env = Readonly<Record<string, string | undefined>>;

/** Expands a leading `~` / `~/` against `home`; rejects `~user`. Other strings pass unchanged. */
export function expandHome(p: string, home: string, what = "path"): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  if (p.startsWith("~")) throw new PathSecurityError("home_user_form", p, what);
  return p;
}

/**
 * Resolves a user-supplied path to a normalised absolute path: `~` expanded, `.`/`..` collapsed,
 * trailing separators dropped. Relative paths, empty strings and NUL bytes are refused.
 */
export function resolveAbsolute(p: string, home: string, what = "path"): string {
  if (p.length === 0) throw new PathSecurityError("empty", p, what);
  if (p.includes("\0")) throw new PathSecurityError("nul_byte", p.replaceAll("\0", "\\0"), what);
  const expanded = expandHome(p, home, what);
  if (!path.isAbsolute(expanded)) throw new PathSecurityError("relative", p, what);
  return path.resolve(expanded);
}

/** Reads a non-empty env value, treating empty/whitespace-only as unset. */
function envValue(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

/**
 * An XDG base directory, or `null` when unset/relative — the XDG spec says a relative value is
 * invalid and must be ignored, so it falls back to the default rather than failing.
 */
function xdgBase(env: Env, key: "XDG_CONFIG_HOME" | "XDG_CACHE_HOME"): string | null {
  const v = envValue(env, key);
  if (v === undefined || v.includes("\0") || !path.isAbsolute(v)) return null;
  return path.resolve(v);
}

/**
 * The config dir (plan 02 §3.3): `FF_CONFIG_DIR`, else `$XDG_CONFIG_HOME/fantasy-football-mcp`,
 * else `~/.config/fantasy-football-mcp`. Absolute; not yet checked against the repo or sync rules.
 */
export function resolveConfigDir(env: Env, home: string): string {
  const override = envValue(env, "FF_CONFIG_DIR");
  if (override !== undefined) return resolveAbsolute(override, home, "FF_CONFIG_DIR");
  const base = xdgBase(env, "XDG_CONFIG_HOME") ?? path.join(home, ".config");
  return path.join(base, APP_DIR_NAME);
}

/**
 * The cache dir (plan 01 §5.1): `FF_CACHE_DIR` (env or config.json value passed as `override`),
 * else `$XDG_CACHE_HOME/fantasy-football-mcp`, else `~/.cache/fantasy-football-mcp`.
 */
export function resolveCacheDir(env: Env, home: string, override?: string): string {
  const o = override ?? envValue(env, "FF_CACHE_DIR");
  if (o !== undefined) return resolveAbsolute(o, home, "FF_CACHE_DIR");
  const base = xdgBase(env, "XDG_CACHE_HOME") ?? path.join(home, ".cache");
  return path.join(base, APP_DIR_NAME);
}

/**
 * The root of this package's checkout/installation: two levels above this module in both layouts
 * (`src/config/paths.ts` and `dist/config/paths.js`).
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Whether `child` equals `parent` or lies beneath it (pure path arithmetic, no I/O). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves symlinks in the longest existing prefix of `p` and re-appends the rest, so a path whose
 * parent is a symlink into the repo is still caught. Never throws for a missing path.
 */
export function realpathOfExistingPrefix(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/** Throws `inside_repo` when `p` (or what its existing prefix resolves to) is inside `repoRoot`. */
export function assertOutsideRepo(p: string, repoRoot: string, what = "path"): void {
  const real = realpathOfExistingPrefix(p);
  const roots = [path.resolve(repoRoot), realpathOfExistingPrefix(repoRoot)];
  if (roots.some((r) => isInside(path.resolve(p), r) || isInside(real, r))) {
    throw new PathSecurityError("inside_repo", p, what);
  }
}

/** The cloud-synced folders under a macOS home (iCloud "Desktop & Documents", iCloud Drive, CloudStorage). */
export function syncedFolders(home: string): readonly string[] {
  return [
    path.join(home, "Documents"),
    path.join(home, "Desktop"),
    path.join(home, "Library", "Mobile Documents"),
    path.join(home, "Library", "CloudStorage"),
  ];
}

/** Throws `synced_folder` when `p` lies in a cloud-synced folder (secrets and league data would upload). */
export function assertNotSynced(p: string, home: string, what = "path"): void {
  const real = realpathOfExistingPrefix(p);
  const bases = syncedFolders(home).flatMap((b) => [b, realpathOfExistingPrefix(b)]);
  if (bases.some((b) => isInside(path.resolve(p), b) || isInside(real, b))) {
    throw new PathSecurityError("synced_folder", p, what);
  }
}

// --- derived locations ------------------------------------------------------------------------

/** `<cache>/store.sqlite`. */
export function storePath(cacheDir: string): string {
  return path.join(cacheDir, STORE_FILE_NAME);
}

/** `<cache>/ds/`. */
export function datasetDir(cacheDir: string): string {
  return path.join(cacheDir, DATASET_DIR_NAME);
}

/** `<cache>/backups/`. */
export function backupDir(cacheDir: string): string {
  return path.join(cacheDir, BACKUP_DIR_NAME);
}

/** `<config>/config.json`. */
export function configFilePath(configDir: string): string {
  return path.join(configDir, CONFIG_FILE_NAME);
}

/** `<config>/league.yaml` — the default `FF_LEAGUE_FILE`. */
export function defaultLeagueFilePath(configDir: string): string {
  return path.join(configDir, LEAGUE_FILE_NAME);
}

/** The grammar of a dataset source id: `<provider>:<dataset>`, lowercase ASCII, digits, `_`. */
export const SOURCE_ID_RE = /^[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,47}$/;

function checkSourceId(sourceId: string): void {
  if (!SOURCE_ID_RE.test(sourceId)) throw new RangeError("paths: invalid dataset source id");
}

/** The file stem for a source's dataset: `nflverse:stats_player_week` → `nflverse__stats_player_week`. */
export function datasetFileStem(sourceId: string): string {
  checkSourceId(sourceId);
  return sourceId.replace(":", "__");
}

/** `<cache>/ds/<stem>.sqlite` — the published, immutable dataset file of one source. */
export function datasetFilePath(cacheDir: string, sourceId: string): string {
  return path.join(datasetDir(cacheDir), `${datasetFileStem(sourceId)}.sqlite`);
}

/** `<cache>/ds/<stem>.<version>.<rand>.tmp` — the staging file `ff refresh` writes, fsyncs, renames. */
export function datasetTempPath(cacheDir: string, sourceId: string, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "v";
  return path.join(
    datasetDir(cacheDir),
    `${datasetFileStem(sourceId)}.${safe}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/** The SQLite schema name a dataset file is ATTACHed under: `ds_nflverse__stats_player_week`. */
export function datasetSchemaName(sourceId: string): string {
  return `ds_${datasetFileStem(sourceId)}`;
}

// --- 0700 / 0600 filesystem helpers ------------------------------------------------------------

const GROUP_OTHER = 0o077;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function checkOwnerAndMode(st: Stats, p: string, what: string): void {
  const uid = currentUid();
  if (uid !== null && st.uid !== uid) throw new PathSecurityError("wrong_owner", p, what);
  if ((st.mode & GROUP_OTHER) !== 0) throw new PathSecurityError("insecure_mode", p, what);
}

/**
 * Every existing ancestor of `dir` (nearest first, `dir` itself excluded) that is writable by group
 * or other WITHOUT the sticky bit — a directory in which someone else could rename our directory
 * away and plant their own (ssh StrictModes). `/tmp` (mode 1777) passes: the sticky bit stops that.
 */
export function insecureAncestors(dir: string): string[] {
  const out: string[] = [];
  let cur = path.dirname(path.resolve(dir));
  for (;;) {
    let st: Stats | null = null;
    try {
      st = statSync(cur);
    } catch {
      st = null;
    }
    if (st?.isDirectory() === true && (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)
      out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return out;
    cur = parent;
  }
}

/**
 * Asserts `dir` is a real (non-symlink) directory owned by this user with no group/other bits, and
 * that no ancestor is group/other-writable without the sticky bit (`insecure_ancestor`).
 * With `create`, a missing directory is created 0700 (parents 0700 too, as `mkdir -p`). An
 * existing directory with bad bits is refused, never silently chmod-ed (`ff doctor --fix` repairs
 * with consent — plan 03 §5 row 4).
 */
export function ensureSecureDir(dir: string, opts: { create: boolean; what?: string }): void {
  const what = opts.what ?? "directory";
  let st = lstatOrNull(dir);
  if (st === null) {
    if (!opts.create) throw new PathSecurityError("missing", dir, what);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink()) throw new PathSecurityError("symlink", dir, what);
  if (!st.isDirectory()) throw new PathSecurityError("not_directory", dir, what);
  checkOwnerAndMode(st, dir, what);
  if (insecureAncestors(dir).length > 0)
    throw new PathSecurityError("insecure_ancestor", dir, what);
}

/** Asserts `file` is a real (non-symlink) regular file owned by this user with no group/other bits. */
export function assertSecureFile(file: string, what = "file"): void {
  const st = lstatOrNull(file);
  if (st === null) throw new PathSecurityError("missing", file, what);
  if (st.isSymbolicLink()) throw new PathSecurityError("symlink", file, what);
  if (!st.isFile()) throw new PathSecurityError("not_regular_file", file, what);
  checkOwnerAndMode(st, file, what);
}

/**
 * Reads a file opened with `O_NOFOLLOW | O_NONBLOCK` and checked on the open descriptor (no TOCTOU
 * between the check and the read; a FIFO planted at the path is opened without blocking and then
 * refused as `not_regular_file` instead of stalling the process forever). `requirePrivate` enforces 0600-or-stricter and ownership (league.yaml);
 * config.json passes `false` (plan 03 §3: "0600 not required — no secrets allowed in it").
 * Returns `null` when the file does not exist.
 */
export function readSecureFile(
  file: string,
  opts: { requirePrivate: boolean; maxBytes?: number; what?: string },
): string | null {
  const what = opts.what ?? "file";
  const max = opts.maxBytes ?? MAX_SECURE_FILE_BYTES;
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new PathSecurityError("symlink", file, what);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PathSecurityError("not_regular_file", file, what);
    if (opts.requirePrivate) checkOwnerAndMode(st, file, what);
    if (st.size > max) throw new PathSecurityError("too_large", file, what);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically writes a 0600 file (plan 02 §3.3): `<file>.<pid>.<rand>.tmp` opened `wx` (exclusive,
 * never follows a pre-placed symlink), written, `fsync`ed, renamed over the target, then the
 * directory is fsynced. The parent directory must already pass `ensureSecureDir`. On any failure
 * the temp file is removed and the previous target is untouched.
 */
export function writeSecureFileAtomic(
  file: string,
  data: string | Uint8Array,
  what = "file",
): void {
  const dir = path.dirname(file);
  ensureSecureDir(dir, { create: false, what: `${what} directory` });
  const target = lstatOrNull(file);
  if (target?.isSymbolicLink()) throw new PathSecurityError("symlink", file, what);
  const tmp = `${file}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  const dfd = openSync(dir, fsc.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
