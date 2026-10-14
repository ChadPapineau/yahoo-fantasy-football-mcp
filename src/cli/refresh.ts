// refresh.ts — `ff refresh <target…>` and `ff refresh due` (plan 01 §5.5 refresh execution model,
// §5.7; plan 06 §1.2 / §2 as amended by the schedule-driven refresh: ONE 15-minute tick decides from
// the loaded NFL schedule what is due — src/config/cadence.ts — and the server may start this
// command as a bounded on-demand child). Builds ONE http client (src/http; in fixture mode its
// transport is the fixture tree), opens the store (refresh_log, job_lock, the schedule the decisions
// read) and a DatasetPublisher, then runs each source through src/sources/runner.ts in order —
// schedules first, so later decisions and weather see this run's calendar. Every run takes the
// source's run-start lock before its first request; after a schedules publish the kickoff changes
// are diffed, stored (schedule_change) and, with --notify, shown as one collapsed notification.
// Exit 0 when every source published, was unchanged or skipped; 1 when any failed; 2 on a usage
// error, a pending migration under --no-migrate, or an --expect-version mismatch (the last two
// before any network and any refresh_log row).
import { randomInt } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  dueDecision,
  DUE_ORDER,
  ON_DEMAND,
  onDemandDecision,
  weatherBucketMs,
  type DueDecision,
  type DueReason,
  type DueSource,
  type SourceState,
} from "../config/cadence.js";
import { freshnessClass, isExpired, SOURCE_REGISTRY } from "../config/freshness.js";
import { fallbackCalendar } from "../config/game-calendar.js";
import type { DatasetSourceId } from "../config/freshness.js";
import {
  datasetDir,
  ensureSecureDir,
  PathSecurityError,
  runTempDir,
  storePath,
} from "../config/paths.js";
import type { Config } from "../config/schema.js";
import type { ScheduleChange } from "../domain/analytics/types.js";
import { MAX_SEED, seededRng, type Clock } from "../domain/clock.js";
import { scheduleView, type ScheduleView } from "../domain/league/calendar.js";
import { diffSchedules, changeNotificationText } from "../domain/league/schedule-changes.js";
import { refreshSeasons, type SeasonPhase } from "../domain/league/season.js";
import { createHttpClient, type FetchLike } from "../http/client.js";
import {
  dueSourceOf,
  sourceStateOf,
  tickDecisionOf,
  type SourceStatePorts,
} from "../mcp/refresh.js";
import { NFLVERSE_SOURCES } from "../sources/nflverse/index.js";
import {
  fsTempArea,
  isRefreshSuccess,
  providerOf,
  runRefresh,
  type RefreshErrorCode,
  type RefreshResult,
  type RetryPolicy,
  type RunGate,
  type SkipReason,
} from "../sources/runner.js";
import type { DataSource } from "../sources/source.js";
import { NWS_PROVIDER, OPEN_METEO_PROVIDER, weatherSourceFor } from "../sources/weather/index.js";
import { createRunLock, storeFactory } from "../store/index.js";
import {
  StoreMigrationPendingError,
  type DatasetPublisher,
  type Store,
  type StoreFactory,
} from "../store/types.js";
import { VERSION } from "../version.js";
import { EXIT, UsageError } from "./exit.js";
import { fixtureDefaultSeasons, fixtureFetch } from "./fixture-fetch.js";
import { writeLine, type CliIo } from "./io.js";
import type { Logger } from "./log.js";
import { createNotifier, type Notifier } from "./notify.js";
import { errorText, openStore } from "./store-access.js";

/** Refresh targets (the source ids, their groups, and `due` — the tick). */
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
  "due",
] as const;
/** A refresh target. */
export type RefreshTarget = (typeof REFRESH_TARGETS)[number];

const S = NFLVERSE_SOURCES;

/** Every source in refresh order (schedules first: later sources read this run's calendar). */
const ORDER: readonly string[] = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
  "weather:open_meteo",
  "weather:nws",
];

/** The sources a target runs, in order; `weather` resolves through FF_WEATHER_SOURCE (null = off). */
export function sourcesFor(
  target: Exclude<RefreshTarget, "due">,
  config: Config,
): (DataSource | null)[] {
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

/**
 * The sources of several targets: de-duplicated, in refresh order (schedules first); `null` (weather
 * off) at most once, last.
 */
export function sourcesForTargets(
  targets: readonly Exclude<RefreshTarget, "due">[],
  config: Config,
): (DataSource | null)[] {
  const byId = new Map<string, DataSource>();
  let off = false;
  for (const t of targets)
    for (const s of sourcesFor(t, config)) {
      if (s === null) off = true;
      else byId.set(s.id, s);
    }
  const list: (DataSource | null)[] = [...byId.values()].sort(
    (a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id),
  );
  if (off) list.push(null);
  return list;
}

/**
 * Parses the target list: 1–9 known targets, de-duplicated; `due` (the tick) stands alone. Throws
 * UsageError naming the targets.
 */
export function parseTargets(targets: readonly string[]): RefreshTarget[] {
  if (targets.length === 0)
    throw new UsageError(`refresh needs a target: ${REFRESH_TARGETS.join(" | ")}`);
  const out: RefreshTarget[] = [];
  for (const t of targets) {
    if (!(REFRESH_TARGETS as readonly string[]).includes(t))
      throw new UsageError(`refresh needs a target: ${REFRESH_TARGETS.join(" | ")}`);
    if (!out.includes(t as RefreshTarget)) out.push(t as RefreshTarget);
  }
  if (out.includes("due") && out.length > 1)
    throw new UsageError("refresh due runs alone (it decides every source itself)");
  return out;
}

/** The job name used for notifications and job_run (plan 06 §1.2 names). */
export function jobNameFor(targets: readonly RefreshTarget[] | RefreshTarget): string {
  const list = typeof targets === "string" ? [targets] : targets;
  const [only] = list;
  if (list.length !== 1 || only === undefined) return "refresh";
  return only === "all" || only === "nflverse" || only === "due"
    ? `refresh-${only}`
    : `refresh-${only.replace(":", "-")}`;
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
      return `${id} skipped    ${r.reason}${r.until === null ? "" : ` until ${r.until}`}`;
    case "failed":
      return `${id} FAILED     ${r.error}: ${r.message}`;
  }
}

/** The `--json` shape of one result (fixed fields only; no upstream text but the server's message). */
export type RefreshResultJson =
  | {
      readonly source: DatasetSourceId;
      readonly status: "published";
      readonly file_version: string;
      readonly rows: number;
      readonly seasons: readonly number[];
      readonly attempts: number;
      readonly warnings: number;
    }
  | {
      readonly source: DatasetSourceId;
      readonly status: "unchanged";
      readonly version: string;
      readonly attempts: number;
    }
  | {
      readonly source: DatasetSourceId;
      readonly status: "skipped";
      readonly reason: SkipReason;
      readonly until: string | null;
    }
  | {
      readonly source: DatasetSourceId;
      readonly status: "failed";
      readonly error: RefreshErrorCode;
      readonly message: string;
      readonly attempts: number;
    };

/** A JSON-safe summary of a result (fixed fields only; no upstream text). */
export function resultJson(r: RefreshResult): RefreshResultJson {
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
      return { source: r.source, status: r.status, reason: r.reason, until: r.until };
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

/** The `--json` shape of one due decision. */
export interface DueDecisionJson {
  readonly source: DueSource;
  readonly due: boolean;
  readonly reason: DueReason;
  readonly next_at: string | null;
}

/** A due decision as JSON. */
export function decisionJson(d: DueDecision): DueDecisionJson {
  return {
    source: d.source,
    due: d.due,
    reason: d.reason,
    next_at: d.next_at_ms === null ? null : new Date(d.next_at_ms).toISOString(),
  };
}

/** One line per decision (`ff refresh due --dry-run`). */
export function describeDecision(d: DueDecision): string {
  const next = d.next_at_ms === null ? "" : ` next ${new Date(d.next_at_ms).toISOString()}`;
  return `${d.source.padEnd(28)} ${d.due ? "due" : "not_due"} ${d.reason}${next}`;
}

/** Options of one `ff refresh` run. */
export interface RefreshOptions {
  readonly targets: readonly string[];
  readonly seasons?: string | undefined;
  readonly force: boolean;
  readonly notify: boolean;
  readonly json: boolean;
  /** The server's answer-time child: short retries, a self-deadline, the due check re-made. */
  readonly onDemand: boolean;
  /** Pending store migrations → exit 2 before any network (the child never migrates). */
  readonly noMigrate: boolean;
  /** The server's version: a different installed `ff` → exit 2 before any network. */
  readonly expectVersion: string | null;
  /** `refresh due` only: print the decisions; no network, no writes. */
  readonly dryRun: boolean;
  /** Test hook for the store factory (never reachable from argv). */
  readonly factory?: StoreFactory;
  /** Test hook for the on-demand self-deadline (never reachable from argv). */
  readonly deadlineMs?: number;
  /**
   * Test hook: the transport under the one http client, in place of the fixture tree or `io.fetch`
   * (a counting spy over the fixtures; never reachable from argv).
   */
  readonly transport?: FetchLike;
}

/** The tick's job lock name and its staleness (a tick never runs this long). */
export const TICK_JOB = "refresh-due";
export const TICK_LOCK_STALE_MS = 15 * 60_000;

/** The dataset source a DueSource refreshes under this configuration (weather off → null). */
export function datasetSourceOf(source: DueSource, config: Config): DatasetSourceId | null {
  if (source !== "weather") return source;
  return config.weatherSource === "open-meteo"
    ? "weather:open_meteo"
    : config.weatherSource === "nws"
      ? "weather:nws"
      : null;
}

/** The weather provider's forecast horizon, in hours. */
function horizonHoursOf(id: DatasetSourceId): number {
  return id === "weather:nws" ? NWS_PROVIDER.horizonHours : OPEN_METEO_PROVIDER.horizonHours;
}

/**
 * The store ports a source's refresh state is read from — the same reading G1 and the answer-time
 * orchestrator use (src/mcp/refresh.ts), so `ff status`, G1 `next_check_at` and the tick agree: a
 * current file the store has not attached at its version is `unreadable`.
 */
function portsOf(store: Store): SourceStatePorts {
  return {
    refreshLog: store.repos.refreshLog,
    providerBackoff: store.repos.providerBackoff,
    seasonChecks: store.repos.seasonChecks,
    storeStats: () => store.stats(),
  };
}

/** The tick's decision for one source now (weather off → never due). */
export function decideDue(
  store: Store,
  source: DueSource,
  config: Config,
  view: ScheduleView,
  nowMs: number,
): DueDecision {
  const id = datasetSourceOf(source, config);
  if (id === null) return { source, due: false, reason: "not_due", next_at_ms: null };
  return (
    tickDecisionOf(portsOf(store), id, view, nowMs, horizonHoursOf(id)) ?? {
      source,
      due: false,
      reason: "not_due",
      next_at_ms: null,
    }
  );
}

/** The on-demand child's re-check (§6.5): run unless the answer-time decision says nothing to do. */
function onDemandGate(
  store: Store,
  config: Config,
  clock: Clock,
  viewNow: () => ScheduleView,
): RunGate {
  return (id) => {
    const source = dueSourceOf(id);
    if (source === null) return { run: true };
    const nowMs = clock.nowMs();
    const view = viewNow();
    const { state, current } = sourceStateOf(portsOf(store), id, nowMs, view.phase.season);
    let expired = false;
    if (state.basis !== null)
      try {
        expired = isExpired(freshnessClass(SOURCE_REGISTRY[id].freshness), state.basis, nowMs);
      } catch {
        expired = true;
      }
    const a = onDemandDecision({
      source,
      nowMs,
      cal: view.calendar,
      state,
      required: true,
      expired,
      ...(source === "weather"
        ? {
            weather: {
              lastBucketMs:
                current?.file_version == null ? null : weatherBucketMs(current.file_version),
              horizonHours: horizonHoursOf(id),
            },
          }
        : {}),
    });
    if (a.kind === "wait" || a.kind === "background") return { run: true };
    if (a.kind === "skip")
      return { run: false, reason: a.reason, until: new Date(a.until_ms).toISOString() };
    return {
      run: false,
      reason: a.reason === "fresh_enough" ? "not_due" : a.reason,
      until: null,
    };
  };
}

/** The tick's re-check under the run lock: still due now (another process may have run it)? */
function tickGate(
  store: Store,
  config: Config,
  clock: Clock,
  viewNow: () => ScheduleView,
): RunGate {
  return (id) => {
    const source = dueSourceOf(id);
    if (source === null) return { run: true };
    const d = decideDue(store, source, config, viewNow(), clock.nowMs());
    if (d.due) return { run: true };
    const reason: SkipReason =
      d.reason === "cadence" || d.reason === "ttl_guard" || d.reason === "repair"
        ? "not_due"
        : d.reason;
    return {
      run: false,
      reason,
      until: d.next_at_ms === null ? null : new Date(d.next_at_ms).toISOString(),
    };
  };
}

const ms = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

/** A manual run honours a provider's Retry-After pause unless `--force`. */
function manualGate(store: Store, clock: Clock): RunGate {
  return (id) => {
    const b = store.repos.providerBackoff.get(providerOf(id));
    const until = ms(b?.until_at);
    if (until !== null && clock.nowMs() < until)
      return { run: false, reason: "provider_backoff", until: new Date(until).toISOString() };
    return { run: true };
  };
}

/** Job locks held by THIS process (job_lock is keyed by pid). */
const tickHeld = new Set<string>();

/**
 * After a schedules publish: re-attach, diff the games of the seasons present in both files
 * (`before` = the view read before the run), store the changes (schedule_change, a required write)
 * and, with `notify`, show one collapsed notification. Returns the new view. Never throws.
 */
export async function recordScheduleChanges(o: {
  readonly store: Store;
  readonly before: ScheduleView;
  readonly result: Extract<RefreshResult, { status: "published" }>;
  readonly clock: Clock;
  readonly log: Logger;
  readonly notifier: Notifier | null;
  readonly job: string;
}): Promise<{ view: ScheduleView; changes: readonly ScheduleChange[] }> {
  const { store, before, clock, log } = o;
  try {
    store.reattachIfChanged();
  } catch {
    log.warn("refresh.reattach_failed", { source: "nflverse:schedules" });
  }
  const nowMs = clock.nowMs();
  const after = scheduleView(store.datasets.schedules, nowMs);
  const afterSeasons = new Set(after.seasons.map((s) => s.season));
  const common = before.seasons.map((s) => s.season).filter((s) => afterSeasons.has(s));
  let changes: ScheduleChange[] = [];
  try {
    changes = diffSchedules(
      common.flatMap((s) => before.games(s)),
      common.flatMap((s) => after.games(s)),
      {
        nowMs,
        detectedAt: clock.nowIso(),
        releaseUpdatedAt: o.result.version.released_at,
      },
    );
  } catch {
    log.warn("refresh.schedule_diff_failed", {});
    return { view: after, changes: [] };
  }
  if (changes.length === 0) return { view: after, changes };
  try {
    const n = await store.repos.scheduleChanges.append(changes);
    log.info("refresh.schedule_changes", { detected: changes.length, recorded: n });
  } catch {
    log.warn("refresh.schedule_changes_not_recorded", { detected: changes.length });
  }
  if (o.notifier !== null) {
    const text = changeNotificationText(changes, nowMs);
    if (text !== null) await o.notifier.notifyInfo(o.job, text);
  }
  return { view: after, changes };
}

/** One line on stderr as a JSON event (the child's exit-2 reasons; read by the server). */
async function stderrEvent(io: CliIo, event: Record<string, unknown>): Promise<void> {
  await writeLine(io.stderr, JSON.stringify(event));
}

const SAFE_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

/** `ff refresh`. */
export async function refresh(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: RefreshOptions,
  signal: AbortSignal,
): Promise<number> {
  const targets = parseTargets(opts.targets);
  const due = targets[0] === "due";
  if (opts.dryRun && !due) throw new UsageError("--dry-run applies to `refresh due` only");
  if (due && opts.seasons !== undefined)
    throw new UsageError("refresh due picks its seasons from the schedule (no --seasons)");
  if (due && opts.onDemand) throw new UsageError("--on-demand names its sources (not due)");
  const seasonsOverride = opts.seasons === undefined ? null : parseSeasons(opts.seasons);

  // the server's child: refuse a binary that is not the server's, before anything is opened
  if (opts.expectVersion !== null && opts.expectVersion !== VERSION) {
    await stderrEvent(io, {
      event: "refresh.version_mismatch",
      expected: SAFE_VERSION_RE.test(opts.expectVersion) ? opts.expectVersion : "?",
      version: VERSION,
    });
    return EXIT.USAGE;
  }

  const notifier = createNotifier({
    platform: io.platform,
    exec: io.exec,
    clock: io.clock,
    cacheDir: config.cacheDir,
  });
  const job = jobNameFor(targets);
  // the on-demand child's failures are reported by the answer; only schedule changes notify
  const notifyFailures = opts.notify && !opts.onDemand;
  const factory = opts.factory ?? storeFactory;

  if (due && opts.dryRun) return dryRunDue(io, config, log, opts, factory);

  let store: Store | undefined;
  let publisher: DatasetPublisher | undefined;
  try {
    if (opts.noMigrate) {
      try {
        lstatSync(storePath(config.cacheDir));
      } catch {
        await stderrEvent(io, { event: "refresh.migration_pending", store_version: 0 });
        return EXIT.USAGE;
      }
    }
    store = openStore(config, io.clock, log, { migrate: !opts.noMigrate, factory });
    publisher = factory.openPublisher({
      storePath: storePath(config.cacheDir),
      datasetDir: datasetDir(config.cacheDir),
      clock: io.clock,
    });
  } catch (e) {
    store?.close();
    if (e instanceof StoreMigrationPendingError) {
      await stderrEvent(io, {
        event: "refresh.migration_pending",
        store_version: e.storeVersion,
        binary_version: e.binaryVersion,
      });
      return EXIT.USAGE;
    }
    await writeLine(io.stderr, `ff refresh: the store could not be opened: ${errorText(e)}`);
    if (notifyFailures) await notifier.notifyFailure(job, "store");
    return EXIT.ERROR;
  }

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
    if (notifyFailures) await notifier.notifyFailure(job, "temp_dir");
    return EXIT.ERROR;
  }

  // the on-demand child bounds itself: a hung download is aborted, the previous file kept
  const deadline = opts.onDemand
    ? AbortSignal.timeout(opts.deadlineMs ?? ON_DEMAND.childDeadlineMs)
    : null;
  const runSignal = deadline === null ? signal : AbortSignal.any([signal, deadline]);

  const ctx: RunContext = {
    io,
    config,
    log,
    store,
    publisher,
    notifier: opts.notify ? notifier : null,
    job,
    signal: runSignal,
    temp: fsTempArea(tmpDir),
    seasonsOverride,
    force: opts.force,
    retry: opts.onDemand ? ON_DEMAND.retry : undefined,
    transport: opts.transport,
  };
  let out: {
    results: RefreshResult[];
    lines: string[];
    decisions: DueDecision[] | null;
    locked: boolean;
  };
  try {
    out = due
      ? await runDue(ctx)
      : await runTargets(ctx, targets as Exclude<RefreshTarget, "due">[], opts.onDemand);
  } finally {
    publisher.close();
    store.close();
  }

  if (opts.json) {
    const doc =
      out.decisions === null
        ? { target: targets.join(" "), results: out.results.map(resultJson) }
        : {
            target: "due",
            decisions: out.decisions.map(decisionJson),
            results: out.results.map(resultJson),
          };
    await writeLine(io.stdout, JSON.stringify(doc, null, 2));
  } else {
    for (const l of out.lines) await writeLine(io.stdout, l);
  }
  const failed = out.results.filter((r) => !isRefreshSuccess(r));
  const first = failed[0];
  if (first?.status === "failed" && notifyFailures) await notifier.notifyFailure(job, first.error);
  return failed.length === 0 && !signal.aborted ? EXIT.OK : EXIT.ERROR;
}

/** What one run of the sources needs. */
interface RunContext {
  readonly io: CliIo;
  readonly config: Config;
  readonly log: Logger;
  readonly store: Store;
  readonly publisher: DatasetPublisher;
  readonly notifier: Notifier | null;
  readonly job: string;
  readonly signal: AbortSignal;
  readonly temp: ReturnType<typeof fsTempArea>;
  readonly seasonsOverride: readonly number[] | null;
  readonly force: boolean;
  readonly retry: RetryPolicy | undefined;
  readonly transport: FetchLike | undefined;
}

/**
 * The seasons a source refreshes: fixture mode's manifest, else the phase's; a manual `--seasons`
 * ADDS to the seasons the current file holds — a publish replaces the whole file, so naming one
 * season never drops the others (a `--seasons <next season>` before its release once left a
 * schedules file with no game).
 */
function seasonsOf(
  ctx: RunContext,
  source: DataSource,
  phase: SeasonPhase,
  fixture: ReadonlyMap<string, readonly number[]>,
): readonly number[] {
  if (ctx.seasonsOverride === null)
    return fixture.get(source.id) ?? refreshSeasons(source.id, phase);
  let held: readonly number[] = [];
  try {
    held =
      ctx.store.repos.refreshLog.current().find((r) => r.source === source.id && r.ok)?.seasons ??
      [];
  } catch {
    held = [];
  }
  return [...new Set([...held, ...ctx.seasonsOverride])].sort((a, b) => a - b);
}

/** Runs one source with the run lock, a gate, the season checks and the backoff store. */
async function runOne(
  ctx: RunContext,
  source: DataSource,
  seasons: readonly number[],
  gate: RunGate | undefined,
  http: ReturnType<typeof createHttpClient>,
  rng: ReturnType<typeof seededRng>,
): Promise<RefreshResult> {
  const { store, io } = ctx;
  return runRefresh(
    {
      source,
      seasons,
      week: null,
      signal: ctx.signal,
      ...(ctx.force ? { force: true } : {}),
    },
    {
      http: http.get,
      download: http.download,
      clock: io.clock,
      rng,
      publisher: ctx.publisher,
      refreshLog: store.repos.refreshLog,
      schedules: store.datasets.schedules,
      temp: ctx.temp,
      log: ctx.log,
      runLock: createRunLock({
        jobLock: store.repos.jobLock,
        clock: io.clock,
        pid: io.pid,
        scope: store.path,
      }),
      seasonChecks: store.repos.seasonChecks,
      providerBackoff: store.repos.providerBackoff,
      ...(gate === undefined ? {} : { gate }),
      ...(ctx.retry === undefined ? {} : { retry: ctx.retry }),
    },
  );
}

function clientFor(ctx: RunContext): ReturnType<typeof createHttpClient> {
  const transport =
    ctx.transport ??
    (ctx.config.fixtureDir !== null ? fixtureFetch(ctx.config.fixtureDir) : ctx.io.fetch);
  return createHttpClient({ ...(transport === null ? {} : { fetch: transport }), log: ctx.log });
}

function fixtureSeasonsOf(config: Config): ReadonlyMap<string, readonly number[]> {
  return config.fixtureDir !== null
    ? fixtureDefaultSeasons(config.fixtureDir)
    : new Map<string, readonly number[]>();
}

/** `ff refresh <target…>` (manual and on-demand): every named source, in refresh order. */
async function runTargets(
  ctx: RunContext,
  targets: readonly Exclude<RefreshTarget, "due">[],
  onDemand: boolean,
): Promise<{ results: RefreshResult[]; lines: string[]; decisions: null; locked: boolean }> {
  const { store, io, config } = ctx;
  const http = clientFor(ctx);
  const rng = seededRng(randomInt(0, MAX_SEED));
  const fixture = fixtureSeasonsOf(config);
  const results: RefreshResult[] = [];
  const lines: string[] = [];
  let view = scheduleView(store.datasets.schedules, io.clock.nowMs());
  const viewNow = (): ScheduleView => view;
  const gate: RunGate | undefined = onDemand
    ? onDemandGate(store, config, io.clock, viewNow)
    : ctx.force
      ? undefined
      : manualGate(store, io.clock);
  for (const source of sourcesForTargets(targets, config)) {
    if (source === null) {
      lines.push(`${"weather".padEnd(28)} skipped    FF_WEATHER_SOURCE=off`);
      continue;
    }
    store.reattachIfChanged();
    view = scheduleView(store.datasets.schedules, io.clock.nowMs());
    const before = view;
    const r = await runOne(
      ctx,
      source,
      seasonsOf(ctx, source, view.phase, fixture),
      gate,
      http,
      rng,
    );
    results.push(r);
    lines.push(describeResult(r), ...describeWarnings(r));
    if (r.status === "published" && r.source === "nflverse:schedules") {
      view = (
        await recordScheduleChanges({
          store,
          before,
          result: r,
          clock: io.clock,
          log: ctx.log,
          notifier: ctx.notifier,
          job: ctx.job,
        })
      ).view;
    }
    if (ctx.signal.aborted) break;
  }
  return { results, lines, decisions: null, locked: false };
}

/** The summary job_run keeps for a tick. */
export function tickSummary(
  decisions: readonly DueDecision[],
  results: readonly RefreshResult[],
): string {
  const n = (s: RefreshResult["status"]): number => results.filter((r) => r.status === s).length;
  return `due=${String(decisions.filter((d) => d.due).length)} published=${String(n("published"))} unchanged=${String(n("unchanged"))} skipped=${String(n("skipped"))} failed=${String(n("failed"))}`;
}

/** Takes the tick's job lock (one tick at a time across processes, and inside this one). */
async function takeTickLock(store: Store, io: CliIo): Promise<boolean> {
  const key = `${store.path}|${TICK_JOB}`;
  if (tickHeld.has(key)) return false;
  tickHeld.add(key);
  let ok = false;
  try {
    ok = await store.repos.jobLock.acquire(TICK_JOB, io.pid, io.clock.nowIso(), TICK_LOCK_STALE_MS);
  } finally {
    if (!ok) tickHeld.delete(key);
  }
  return ok;
}

async function releaseTickLock(store: Store, io: CliIo): Promise<void> {
  tickHeld.delete(`${store.path}|${TICK_JOB}`);
  try {
    await store.repos.jobLock.release(TICK_JOB, io.pid);
  } catch {
    // goes stale after TICK_LOCK_STALE_MS
  }
}

/**
 * `ff refresh due` — one tick: take the tick lock (held → exit 0, "locked"), read the schedule, then
 * for each source in DUE_ORDER decide; run what is due (the decision re-made under the source's run
 * lock); after a schedules publish, diff the kickoffs and re-read the calendar before the next
 * decision; record the heartbeat (job_run). Nothing due → no request at all.
 */
async function runDue(ctx: RunContext): Promise<{
  results: RefreshResult[];
  lines: string[];
  decisions: DueDecision[];
  locked: boolean;
}> {
  const { store, io, config } = ctx;
  const lines: string[] = [];
  if (!(await takeTickLock(store, io))) {
    lines.push("refresh due: locked (another tick is running)");
    return { results: [], lines, decisions: [], locked: true };
  }
  const results: RefreshResult[] = [];
  const decisions: DueDecision[] = [];
  try {
    let http: ReturnType<typeof createHttpClient> | null = null;
    const rng = seededRng(randomInt(0, MAX_SEED));
    const fixture = fixtureSeasonsOf(config);
    let view = scheduleView(store.datasets.schedules, io.clock.nowMs());
    const viewNow = (): ScheduleView => view;
    const gate = tickGate(store, config, io.clock, viewNow);
    for (const due of DUE_ORDER) {
      const d = decideDue(store, due, config, view, io.clock.nowMs());
      decisions.push(d);
      lines.push(describeDecision(d));
      const id = datasetSourceOf(due, config);
      if (!d.due || id === null) continue;
      const source = id.startsWith("weather:")
        ? weatherSourceFor(config.weatherSource)
        : NFLVERSE_SOURCES[id as keyof typeof NFLVERSE_SOURCES];
      if (source === null) continue;
      http ??= clientFor(ctx);
      const before = view;
      const r = await runOne(
        ctx,
        source,
        seasonsOf(ctx, source, view.phase, fixture),
        gate,
        http,
        rng,
      );
      results.push(r);
      lines.push(describeResult(r), ...describeWarnings(r));
      store.reattachIfChanged();
      if (r.status === "published" && r.source === "nflverse:schedules")
        view = (
          await recordScheduleChanges({
            store,
            before,
            result: r,
            clock: io.clock,
            log: ctx.log,
            notifier: ctx.notifier,
            job: ctx.job,
          })
        ).view;
      else view = scheduleView(store.datasets.schedules, io.clock.nowMs());
      if (ctx.signal.aborted) break;
    }
    const failed = results.some((r) => r.status === "failed");
    try {
      await store.repos.jobRuns.record({
        job: TICK_JOB,
        last_run_at: io.clock.nowIso(),
        exit: failed || ctx.signal.aborted ? EXIT.ERROR : EXIT.OK,
        summary: tickSummary(decisions, results),
      });
    } catch {
      ctx.log.warn("refresh.heartbeat_not_recorded", { job: TICK_JOB });
    }
  } finally {
    await releaseTickLock(store, io);
  }
  return { results, lines, decisions, locked: false };
}

/**
 * `ff refresh due --dry-run`: the decisions only — the store is opened without creating or migrating
 * it, no lock is taken, nothing is written and nothing is fetched.
 */
async function dryRunDue(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: RefreshOptions,
  factory: StoreFactory,
): Promise<number> {
  const decisions: DueDecision[] = [];
  let exists = true;
  try {
    lstatSync(storePath(config.cacheDir));
  } catch {
    exists = false;
  }
  if (!exists) {
    // nothing was ever refreshed: every configured source is a repair
    const state: SourceState = {
      file: "never_loaded",
      basis: null,
      lastAttemptMs: null,
      consecutiveFailures: 0,
      backoffUntilMs: null,
    };
    for (const due of DUE_ORDER) {
      const id = datasetSourceOf(due, config);
      decisions.push(
        id === null
          ? { source: due, due: false, reason: "not_due", next_at_ms: null }
          : dueDecision({
              source: due,
              nowMs: io.clock.nowMs(),
              cal: fallbackCalendar("never_loaded"),
              state,
              ...(due === "weather"
                ? { weather: { lastBucketMs: null, horizonHours: horizonHoursOf(id) } }
                : {}),
            }),
      );
    }
  } else {
    let store: Store;
    try {
      store = openStore(config, io.clock, log, { migrate: false, factory });
    } catch (e) {
      await writeLine(
        io.stderr,
        `ff refresh due --dry-run: the store could not be read (${e instanceof StoreMigrationPendingError ? "a migration is pending; the next `ff refresh` runs it" : errorText(e)})`,
      );
      return EXIT.ERROR;
    }
    try {
      const view = scheduleView(store.datasets.schedules, io.clock.nowMs());
      for (const due of DUE_ORDER)
        decisions.push(decideDue(store, due, config, view, io.clock.nowMs()));
    } finally {
      store.close();
    }
  }
  if (opts.json)
    await writeLine(
      io.stdout,
      JSON.stringify(
        { target: "due", decisions: decisions.map(decisionJson), results: [] },
        null,
        2,
      ),
    );
  else for (const d of decisions) await writeLine(io.stdout, describeDecision(d));
  return EXIT.OK;
}
