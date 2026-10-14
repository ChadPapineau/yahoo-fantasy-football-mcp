// launchd.ts — the launchd jobs and their plists (plan 06 J1, §2 launchd design, amended by the
// schedule-driven refresh: one 15-minute tick; plan 03 L4 absolute paths). One LaunchAgent per job, generated
// here (the "templates in src/cli/launchd/" of plan 06 §2 are this module's data: the job table plus
// one XML renderer, so every path is resolved, never hand-typed). ProgramArguments =
// [process.execPath, <abs dist/cli.js>, <subcommand…>]; EnvironmentVariables = non-secret config
// only; logs under ~/Library/Logs/fantasy-football-mcp/<job>.log. `launchctl` is reached only via
// the injected executor, and never on --dry-run.
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "../config/schema.js";
import type { Exec } from "./io.js";

/** The LaunchAgent label prefix. Generic on purpose: no owner/user identifier in a label. */
export const LABEL_PREFIX = "io.github.fantasy-football-mcp.ff";
/** Log directory name under ~/Library/Logs. */
export const LOG_DIR_NAME = "fantasy-football-mcp";

/** One StartCalendarInterval entry; an omitted key is launchd's wildcard (plan 06 §2). */
export interface CalendarEntry {
  readonly Minute?: number;
  readonly Hour?: number;
  /** 0 = Sunday … 6 = Saturday (launchd.plist(5)). */
  readonly Weekday?: number;
}

/** One launchd job. */
export interface LaunchdJob {
  /** Short name (`--jobs` value, label suffix, log file name). */
  readonly name: string;
  /** The `ff` subcommand and its arguments. */
  readonly argv: readonly string[];
  /** What it does, for `--dry-run` and doctor output. */
  readonly description: string;
  /** Local-time schedule. */
  readonly calendar: readonly CalendarEntry[];
  /** The dataset sources whose refresh_log rows report this job's last run (doctor #11). */
  readonly sources: readonly string[];
  /** launchd `RunAtLoad`: run once when the job is loaded (login, install, wake from a reboot). */
  readonly runAtLoad: boolean;
}

const SUN = 0;

const at = (Hour: number, Minute: number, Weekday?: number): CalendarEntry =>
  Weekday === undefined ? { Hour, Minute } : { Weekday, Hour, Minute };

/** The minutes of every hour the refresh tick fires (UTC quarter-hours in every real time zone). */
export const TICK_MINUTES: readonly number[] = Object.freeze([0, 15, 30, 45]);

/** The job that keeps every dataset current (`ff refresh due`). */
export const REFRESH_DUE_JOB = "refresh-due";

/**
 * The jobs (plan 06 J1 as amended by the schedule-driven refresh). Data refreshes run from ONE tick,
 * `refresh-due`: every quarter-hour of every hour, plus once at load. Each tick decides from the
 * loaded NFL schedule what is due (src/config/cadence.ts) and exits in well under a second, with no
 * network, when nothing is — so no plist names a weekday or a game time, and a flexed, Saturday,
 * Wednesday, holiday or international game is followed without a new plist. Every real UTC offset
 * is a multiple of 15 minutes, so the local minutes 0/15/30/45 are UTC quarter-hours everywhere;
 * launchd's StartCalendarInterval coalesces the ticks missed while asleep into one run at wake
 * (StartInterval would drop them). Prune and backup stay weekly.
 */
export const JOBS: readonly LaunchdJob[] = Object.freeze([
  {
    name: REFRESH_DUE_JOB,
    argv: ["refresh", "due", "--notify"],
    description:
      "the refresh tick — every 15 min and at load; refreshes only what the NFL schedule makes due (schedules first)",
    calendar: TICK_MINUTES.map((Minute) => ({ Minute })),
    sources: [
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
      "weather:open_meteo",
      "weather:nws",
    ],
    runAtLoad: true,
  },
  {
    name: "store-prune",
    argv: ["prune", "--notify"],
    description:
      "store prune — weekly Sun 03:00 (cache rows past their hard limit, old schedule history, temp debris, old backups)",
    calendar: [at(3, 0, SUN)],
    sources: [],
    runAtLoad: false,
  },
  {
    name: "store-backup",
    argv: ["backup", "--notify"],
    description: "store backup — weekly Sun 03:10 (consistent backup of store.sqlite; keeps 4)",
    calendar: [at(3, 10, SUN)],
    sources: [],
    runAtLoad: false,
  },
]);

/** Every job name. */
export const JOB_NAMES: readonly string[] = JOBS.map((j) => j.name);

/**
 * Job names an earlier version installed and this one replaced (by `refresh-due`). Never reused:
 * `ff install-launchd` boots out and removes their plists, `ff uninstall` removes them too, and
 * `ff doctor` row 11 warns while one is installed.
 */
export const RETIRED_JOB_NAMES: readonly string[] = Object.freeze([
  "nflverse-schedules",
  "nflverse-daily",
  "nflverse-stats",
  "weather",
]);

/** The label of a job. */
export function labelOf(job: LaunchdJob | string): string {
  return `${LABEL_PREFIX}.${typeof job === "string" ? job : job.name}`;
}

/** `~/Library/LaunchAgents`. */
export function launchAgentsDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

/** `~/Library/Logs/fantasy-football-mcp`. */
export function logDir(home: string): string {
  return path.join(home, "Library", "Logs", LOG_DIR_NAME);
}

/** `~/Library/LaunchAgents/<label>.plist`. */
export function plistPath(home: string, job: LaunchdJob | string): string {
  return path.join(launchAgentsDir(home), `${labelOf(job)}.plist`);
}

/**
 * Selects jobs from a comma-separated `--jobs` value; unknown names throw RangeError, and a retired
 * name throws one naming the job that replaced it.
 */
export function selectJobs(spec: string | undefined): LaunchdJob[] {
  if (spec === undefined || spec.trim() === "" || spec.trim() === "all") return [...JOBS];
  const names = [
    ...new Set(
      spec
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    ),
  ];
  const retired = names.filter((n) => RETIRED_JOB_NAMES.includes(n));
  if (retired.length > 0)
    throw new RangeError(
      `job(s) retired: ${retired.join(", ")} — \`${REFRESH_DUE_JOB}\` now runs every data refresh (use --jobs ${REFRESH_DUE_JOB})`,
    );
  const unknown = names.filter((n) => !JOB_NAMES.includes(n));
  if (unknown.length > 0)
    throw new RangeError(`unknown job(s): ${unknown.map((n) => n.slice(0, 40)).join(", ")}`);
  return JOBS.filter((j) => names.includes(j.name));
}

/** Escapes text for an XML element body or attribute. Control characters are refused. */
export function xmlEscape(s: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s))
    throw new RangeError("plist: control characters are not allowed in a value");
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The EnvironmentVariables of every plist: resolved, non-secret, absolute (plan 06 §2). */
export function jobEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {
    FF_CONFIG_DIR: config.configDir,
    FF_CACHE_DIR: config.cacheDir,
    FF_LEAGUE_FILE: config.leagueFile,
    FF_WEATHER_SOURCE: config.weatherSource,
    FF_LOG_LEVEL: config.logLevel,
  };
  if (config.fixtureDir !== null) env.FF_FIXTURE_DIR = config.fixtureDir;
  return env;
}

/** What a plist is built from. */
export interface PlistInput {
  readonly job: LaunchdJob;
  /** Absolute node binary (process.execPath). */
  readonly node: string;
  /** Absolute dist/cli.js. */
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly home: string;
}

const ind = (n: number): string => "  ".repeat(n);

/** Renders one LaunchAgent plist (XML 1.0, Apple PLIST 1.0 DTD). Every path must be absolute. */
export function renderPlist(p: PlistInput): string {
  for (const [what, v] of [
    ["node", p.node],
    ["entry", p.entry],
    ["home", p.home],
  ] as const) {
    if (!path.isAbsolute(v)) throw new RangeError(`plist: ${what} path must be absolute`);
  }
  const str = (v: string): string => `<string>${xmlEscape(v)}</string>`;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `${ind(1)}<key>Label</key>`,
    `${ind(1)}${str(labelOf(p.job))}`,
    `${ind(1)}<key>ProgramArguments</key>`,
    `${ind(1)}<array>`,
    ...[p.node, p.entry, ...p.job.argv].map((a) => `${ind(2)}${str(a)}`),
    `${ind(1)}</array>`,
    `${ind(1)}<key>EnvironmentVariables</key>`,
    `${ind(1)}<dict>`,
    ...Object.entries(p.env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([k, v]) => [`${ind(2)}<key>${xmlEscape(k)}</key>`, `${ind(2)}${str(v)}`]),
    `${ind(1)}</dict>`,
    `${ind(1)}<key>StandardOutPath</key>`,
    `${ind(1)}${str(path.join(logDir(p.home), `${p.job.name}.log`))}`,
    `${ind(1)}<key>StandardErrorPath</key>`,
    `${ind(1)}${str(path.join(logDir(p.home), `${p.job.name}.log`))}`,
    `${ind(1)}<key>ProcessType</key>`,
    `${ind(1)}<string>Background</string>`,
    `${ind(1)}<key>LowPriorityIO</key>`,
    `${ind(1)}<true/>`,
    `${ind(1)}<key>RunAtLoad</key>`,
    `${ind(1)}${p.job.runAtLoad ? "<true/>" : "<false/>"}`,
    `${ind(1)}<key>StartCalendarInterval</key>`,
    `${ind(1)}<array>`,
    ...p.job.calendar.flatMap((c) => [
      `${ind(2)}<dict>`,
      ...(["Weekday", "Hour", "Minute"] as const).flatMap((k) =>
        c[k] === undefined
          ? []
          : [`${ind(3)}<key>${k}</key>`, `${ind(3)}<integer>${String(c[k])}</integer>`],
      ),
      `${ind(2)}</dict>`,
    ]),
    `${ind(1)}</array>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

/** `launchctl` argument vectors (plan 06 §2). */
export const launchctl = Object.freeze({
  bootstrap: (uid: number, plist: string): string[] => ["bootstrap", `gui/${String(uid)}`, plist],
  bootout: (uid: number, label: string): string[] => ["bootout", `gui/${String(uid)}/${label}`],
  print: (uid: number, label: string): string[] => ["print", `gui/${String(uid)}/${label}`],
});

/** The launchctl binary (absolute: never resolved through PATH). */
export const LAUNCHCTL = "/bin/launchctl";

/** Refuses a symlinked or non-directory LaunchAgents/Logs directory; creates it when missing. */
function ensurePlainDir(dir: string, mode: number): void {
  let st;
  try {
    st = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    mkdirSync(dir, { recursive: true, mode });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new Error(`launchd: ${dir} is not a plain directory`);
}

/** Writes a plist atomically (temp + rename), 0644 (launchd refuses group/world-writable plists). */
export function writePlist(file: string, xml: string): void {
  ensurePlainDir(path.dirname(file), 0o755);
  let st = null;
  try {
    st = lstatSync(file);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink() === true)
    throw new Error(`launchd: refusing to replace a symlink at ${file}`);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, xml, { mode: 0o644, flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** One step of an install/uninstall, for printing and for tests. */
export interface LaunchdStep {
  readonly kind: "write" | "launchctl" | "remove" | "mkdir" | "retire";
  readonly detail: string;
  readonly ok: boolean;
  /** Only for failed launchctl calls: its exit code. */
  readonly code?: number | null;
}

/** Installs jobs: writes plists, then bootout (ignored if not loaded) + bootstrap each. */
export async function installJobs(opts: {
  readonly jobs: readonly LaunchdJob[];
  readonly home: string;
  readonly node: string;
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly exec: Exec;
}): Promise<LaunchdStep[]> {
  const steps: LaunchdStep[] = [];
  ensurePlainDir(logDir(opts.home), 0o700);
  steps.push({ kind: "mkdir", detail: logDir(opts.home), ok: true });
  for (const job of opts.jobs) {
    const file = plistPath(opts.home, job);
    writePlist(
      file,
      renderPlist({ job, node: opts.node, entry: opts.entry, env: opts.env, home: opts.home }),
    );
    steps.push({ kind: "write", detail: file, ok: true });
    await opts.exec(LAUNCHCTL, launchctl.bootout(opts.uid, labelOf(job)));
    const r = await opts.exec(LAUNCHCTL, launchctl.bootstrap(opts.uid, file));
    steps.push({
      kind: "launchctl",
      detail: `bootstrap ${labelOf(job)}`,
      ok: r.code === 0,
      code: r.code,
    });
  }
  return steps;
}

/** One plist of ours in LaunchAgents: a current job's, or a retired job's (`retired`). */
export interface InstalledPlist {
  readonly job: string;
  readonly file: string;
  readonly retired: boolean;
}

/** The plists of ours present in LaunchAgents (current and retired job names only). */
export function installedPlists(home: string): InstalledPlist[] {
  let names: string[];
  try {
    names = readdirSync(launchAgentsDir(home));
  } catch {
    return [];
  }
  return [...JOB_NAMES, ...RETIRED_JOB_NAMES]
    .filter((j) => names.includes(`${labelOf(j)}.plist`))
    .map((j) => ({ job: j, file: plistPath(home, j), retired: RETIRED_JOB_NAMES.includes(j) }));
}

/**
 * Retires the plists of RETIRED_JOB_NAMES (run by `ff install-launchd` once the new jobs are
 * loaded): `bootout` each (a "not loaded" result is ignored), then remove its plist — never a
 * symlink, which is refused and left for the user (a failed step). `dryRun` changes nothing and
 * reports what would happen.
 */
export async function retireJobs(opts: {
  readonly home: string;
  readonly uid: number;
  readonly exec: Exec;
  readonly dryRun: boolean;
}): Promise<LaunchdStep[]> {
  const steps: LaunchdStep[] = [];
  for (const p of installedPlists(opts.home).filter((x) => x.retired)) {
    const label = labelOf(p.job);
    let link = false;
    try {
      link = lstatSync(p.file).isSymbolicLink();
    } catch {
      continue; // gone meanwhile
    }
    if (opts.dryRun) {
      steps.push({ kind: "retire", detail: label, ok: !link });
      continue;
    }
    await opts.exec(LAUNCHCTL, launchctl.bootout(opts.uid, label));
    if (link) {
      steps.push({
        kind: "retire",
        detail: `${label}: refusing to remove a symlink at ${p.file}`,
        ok: false,
      });
      continue;
    }
    rmSync(p.file, { force: true });
    steps.push({ kind: "retire", detail: label, ok: true });
  }
  return steps;
}

/** Boots out and removes every installed plist of ours, current and retired (plan 03 §8 step 1). */
export async function removeJobs(opts: {
  readonly home: string;
  readonly uid: number;
  readonly exec: Exec;
  readonly dryRun: boolean;
}): Promise<LaunchdStep[]> {
  const steps: LaunchdStep[] = [];
  for (const { job, file } of installedPlists(opts.home)) {
    if (opts.dryRun) {
      steps.push({ kind: "launchctl", detail: `bootout ${labelOf(job)}`, ok: true });
      steps.push({ kind: "remove", detail: file, ok: true });
      continue;
    }
    const r = await opts.exec(LAUNCHCTL, launchctl.bootout(opts.uid, labelOf(job)));
    // 0 = booted out; anything else usually means "not loaded" — the plist is removed either way.
    steps.push({ kind: "launchctl", detail: `bootout ${labelOf(job)}`, ok: true, code: r.code });
    const st = lstatSync(file);
    if (st.isFile() || st.isSymbolicLink()) rmSync(file, { force: true });
    steps.push({ kind: "remove", detail: file, ok: true });
  }
  return steps;
}
