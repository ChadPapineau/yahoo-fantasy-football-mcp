// refresh.ts — `ff refresh <target>` (plan 01 §5.5 refresh execution model, §5.7; plan 06 §1.2 the
// data-refresh jobs and §2 season awareness / per-job lock / notifications; plan 10 §3.1a "Jobs").
// Builds ONE http client (src/http; in fixture mode its transport is the fixture tree), opens the
// store (refresh_log + the schedules reader the season gate needs) and a DatasetPublisher, then runs
// each source through src/sources/runner.ts in order (schedules first, so weather sees this run's
// schedule). Exit 0 when every source published, was unchanged or skipped; 1 when any failed.
import { randomInt } from "node:crypto";
import {
  datasetDir,
  ensureSecureDir,
  PathSecurityError,
  runTempDir,
  storePath,
} from "../config/paths.js";
import type { Config } from "../config/schema.js";
import { MAX_SEED, seededRng } from "../domain/clock.js";
import { createHttpClient } from "../http/client.js";
import { NFLVERSE_SOURCES } from "../sources/nflverse/index.js";
import { nflSeasonAt } from "../sources/nflverse/release.js";
import { fsTempArea, isRefreshSuccess, runRefresh, type RefreshResult } from "../sources/runner.js";
import type { DataSource } from "../sources/source.js";
import { weatherSourceFor } from "../sources/weather/index.js";
import { storeFactory } from "../store/index.js";
import type { StoreFactory } from "../store/types.js";
import { EXIT, UsageError } from "./exit.js";
import { fixtureDefaultSeasons, fixtureFetch } from "./fixture-fetch.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** Refresh targets (plan 06 §1.2 job names + the individual source ids). */
export const REFRESH_TARGETS = [
  "all",
  "nflverse",
  "nflverse:schedules",
  "nflverse:daily",
  "nflverse:stats",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "weather",
] as const;
/** A refresh target. */
export type RefreshTarget = (typeof REFRESH_TARGETS)[number];

const S = NFLVERSE_SOURCES;

/** The sources a target runs, in order; `weather` resolves through FF_WEATHER_SOURCE (null = off). */
export function sourcesFor(target: RefreshTarget, config: Config): (DataSource | null)[] {
  const weather = (): DataSource | null => weatherSourceFor(config.weatherSource);
  switch (target) {
    case "nflverse:schedules":
      return [S["nflverse:schedules"]];
    case "nflverse:daily":
      return [S["nflverse:injuries"], S["nflverse:roster_weekly"]];
    case "nflverse:stats":
    case "nflverse:stats_player_week":
      return [S["nflverse:stats_player_week"]];
    case "nflverse:injuries":
      return [S["nflverse:injuries"]];
    case "nflverse:roster_weekly":
      return [S["nflverse:roster_weekly"]];
    case "nflverse":
      return [
        S["nflverse:schedules"],
        S["nflverse:injuries"],
        S["nflverse:roster_weekly"],
        S["nflverse:stats_player_week"],
      ];
    case "weather":
      return [weather()];
    case "all":
      return [...sourcesFor("nflverse", config), weather()];
  }
}

/** The job name used for notifications (plan 06 §1.2 names). */
export function jobNameFor(target: RefreshTarget): string {
  return target === "all" || target === "nflverse"
    ? `refresh-${target}`
    : `refresh-${target.replace(":", "-")}`;
}

/**
 * The NFL season in progress at `nowMs`: the calendar year from September, the previous year
 * through August (the Super Bowl is in February; nflverse opens a season's files in September).
 * The one rule the release resolver uses too, so the two can never drift (QA-1-033).
 */
export function currentSeason(nowMs: number): number {
  return nflSeasonAt(nowMs);
}

/**
 * Default seasons per source: stats and schedules carry the previous season too (E1's trailing
 * window reaches back into it, weighted ½ — analytics decision); injuries, weekly rosters and
 * weather only the current one.
 */
export function defaultSeasons(source: DataSource, season: number): number[] {
  return source.id === "nflverse:stats_player_week" || source.id === "nflverse:schedules"
    ? [season - 1, season]
    : [season];
}

/** Parses `--seasons 2025,2026` (1999–2100, ascending, de-duplicated, at most 30). */
export function parseSeasons(spec: string): number[] {
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0 || parts.length > 30)
    throw new UsageError("--seasons takes 1-30 comma-separated years");
  const out = new Set<number>();
  for (const p of parts) {
    if (!/^[0-9]{4}$/.test(p)) throw new UsageError("--seasons: each season is a 4-digit year");
    const n = Number(p);
    if (n < 1999 || n > 2100) throw new UsageError("--seasons: each season must be 1999-2100");
    out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Most warning lines printed under one result; the rest are counted. */
export const MAX_WARNING_LINES = 5;
/** Longest warning line printed (a warning can list many upstream column names). */
export const WARNING_LINE_MAX = 200;
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]+/gu;

/**
 * The schema warnings behind a published result's "(n warnings)", one indented line each (gate
 * round 1: the count alone was unexplained). The text names upstream columns, so it is made
 * terminal-safe: control/format characters (ANSI escapes, bidi overrides) become a space, and each
 * line is capped at WARNING_LINE_MAX UTF-16 units.
 */
export function describeWarnings(r: RefreshResult): string[] {
  if (r.status !== "published") return [];
  const out = r.warnings.slice(0, MAX_WARNING_LINES).map((w) => {
    const clean = w.replace(UNPRINTABLE_RE, " ").trim();
    // capped in UTF-16 units, never splitting a surrogate pair (the text has no lone ones left)
    const capped =
      clean.length > WARNING_LINE_MAX
        ? `${clean.slice(0, WARNING_LINE_MAX - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
        : clean;
    return `  warning: ${capped}`;
  });
  const more = r.warnings.length - MAX_WARNING_LINES;
  if (more > 0) out.push(`  warning: … ${String(more)} more`);
  return out;
}

/** One line per result for the terminal. */
export function describeResult(r: RefreshResult): string {
  const id = r.source.padEnd(28);
  switch (r.status) {
    case "published": {
      const n = r.warnings.length;
      const w = n === 0 ? "" : `  (${String(n)} warning${n === 1 ? "" : "s"}, below)`;
      return `${id} published  version ${r.file_version}  ${String(r.stats.rows)} rows${w}`;
    }
    case "unchanged":
      return `${id} unchanged  version ${r.version.version}`;
    case "skipped":
      return `${id} skipped    ${r.reason}`;
    case "failed":
      return `${id} FAILED     ${r.error}: ${r.message}`;
  }
}

/** A JSON-safe summary of a result (fixed fields only; no upstream text). */
export function resultJson(r: RefreshResult): Record<string, unknown> {
  switch (r.status) {
    case "published":
      return {
        source: r.source,
        status: r.status,
        file_version: r.file_version,
        rows: r.stats.rows,
        seasons: r.stats.seasons,
        attempts: r.attempts,
        warnings: r.warnings.length,
      };
    case "unchanged":
      return {
        source: r.source,
        status: r.status,
        version: r.version.version,
        attempts: r.attempts,
      };
    case "skipped":
      return { source: r.source, status: r.status, reason: r.reason };
    case "failed":
      return {
        source: r.source,
        status: r.status,
        error: r.error,
        message: r.message,
        attempts: r.attempts,
      };
  }
}

/** Options of one `ff refresh` run. */
export interface RefreshOptions {
  readonly target: string | undefined;
  readonly seasons?: string | undefined;
  readonly force: boolean;
  readonly notify: boolean;
  readonly json: boolean;
  /** Test hook for the store factory (never reachable from argv). */
  readonly factory?: StoreFactory;
}

/** `ff refresh`. */
export async function refresh(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: RefreshOptions,
  signal: AbortSignal,
): Promise<number> {
  const target = opts.target;
  if (target === undefined || !(REFRESH_TARGETS as readonly string[]).includes(target))
    throw new UsageError(`refresh needs a target: ${REFRESH_TARGETS.join(" | ")}`);
  const t = target as RefreshTarget;
  const seasonsOverride = opts.seasons === undefined ? null : parseSeasons(opts.seasons);
  const list = sourcesFor(t, config);
  const season = currentSeason(io.clock.nowMs());
  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  const job = jobNameFor(t);

  const factory = opts.factory ?? storeFactory;
  let store;
  let publisher;
  try {
    store = openStore(config, io.clock, log, { migrate: true, factory });
    publisher = factory.openPublisher({
      storePath: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      clock: io.clock,
    });
  } catch (e) {
    store?.close();
    await writeLine(io.stderr, `ff refresh: the store could not be opened: ${errorText(e)}`);
    if (opts.notify) await notifier.notifyFailure(job, "store");
    return EXIT.ERROR;
  }

  const transport = config.fixtureDir !== null ? fixtureFetch(config.fixtureDir) : io.fetch;
  // fixture mode defaults to the seasons the fixture tree records (its manifest says which)
  const fixtureSeasons =
    config.fixtureDir !== null
      ? fixtureDefaultSeasons(config.fixtureDir)
      : new Map<string, readonly number[]>();
  const http = createHttpClient({ ...(transport === null ? {} : { fetch: transport }), log });
  const rng = seededRng(randomInt(0, MAX_SEED));
  // The run temp area must be our own real 0700 directory: a symlinked <cache>/tmp would send every
  // download (and the runner's recursive clean-up) into wherever it points (QA-1-087).
  const tmpDir = runTempDir(config.cacheDir);
  try {
    ensureSecureDir(tmpDir, { create: true, what: "run temp directory" });
  } catch (e) {
    publisher.close();
    store.close();
    await writeLine(
      io.stderr,
      `ff refresh: ${e instanceof PathSecurityError ? `${e.name}: ${e.message}` : errorText(e)}`,
    );
    if (opts.notify) await notifier.notifyFailure(job, "temp_dir");
    return EXIT.ERROR;
  }
  const temp = fsTempArea(tmpDir);
  const results: RefreshResult[] = [];
  const lines: string[] = [];
  try {
    for (const source of list) {
      if (source === null) {
        lines.push(`${"weather".padEnd(28)} skipped    FF_WEATHER_SOURCE=off`);
        continue;
      }
      store.reattachIfChanged();
      const r = await runRefresh(
        {
          source,
          seasons:
            seasonsOverride ?? fixtureSeasons.get(source.id) ?? defaultSeasons(source, season),
          week: null,
          signal,
          ...(opts.force ? { force: true } : {}),
        },
        {
          http: http.get,
          download: http.download,
          clock: io.clock,
          rng,
          publisher,
          refreshLog: store.repos.refreshLog,
          schedules: store.datasets.schedules,
          temp,
          log,
        },
      );
      results.push(r);
      lines.push(describeResult(r), ...describeWarnings(r));
      if (signal.aborted) break;
    }
  } finally {
    publisher.close();
    store.close();
  }

  if (opts.json) {
    await writeLine(
      io.stdout,
      JSON.stringify({ target: t, results: results.map(resultJson) }, null, 2),
    );
  } else {
    for (const l of lines) await writeLine(io.stdout, l);
  }
  const failed = results.filter((r) => !isRefreshSuccess(r));
  const first = failed[0];
  if (first?.status === "failed" && opts.notify) {
    await notifier.notifyFailure(job, first.error);
  }
  return failed.length === 0 && !signal.aborted ? EXIT.OK : EXIT.ERROR;
}
