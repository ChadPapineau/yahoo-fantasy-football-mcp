// on-demand-refresh.ts — answer-time revalidation (season-fresh spec §6.3; plan 01 §5.4 answer-time
// tiers, §5.5 "the server spawns, never fetches"). Before a tool reads its datasets, `ensureFresh`
// judges each source with `onDemandDecision` (src/config/cadence.ts) and either leaves it, waits for a
// refresh within a budget (6 s fast, 15 s repair, 15 s per call), starts one in the background, joins
// a refresh already running (this server's child, or another process's run lock), or reports why it
// does not (backoff, throttled). The refresh itself is a child `ff refresh --on-demand <targets…>`:
// every download, limiter, schema check, run lock and atomic publish stays in that child, so the
// server process opens no socket and builds no HTTP client (plan 02 §1). The child's argv is fixed —
// its targets come only from the DueSource enum, never from a tool argument — its environment is an
// allow-list (no Yahoo or Odds credential), and it is spawned with `shell: false`.
import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod/v4";
import {
  DUE_ORDER,
  ON_DEMAND,
  onDemandDecision,
  weatherBucketMs,
  type DueSource,
  type OnDemandAction,
} from "../config/cadence.js";
import {
  SOURCE_REGISTRY,
  freshnessClass,
  isExpired,
  type DatasetSourceId,
} from "../config/freshness.js";
import type { OnDemandMode, WeatherSource } from "../config/schema.js";
import type {
  ProviderBackoffRepository,
  RefreshLogRepository,
  RefreshLogRow,
  RunLockReader,
  SeasonCheckRepository,
  StoreStats,
} from "../domain/analytics/types.js";
import type { Clock } from "../domain/clock.js";
import type { ScheduleView } from "../domain/league/calendar.js";
import { abortableSleep, type Sleep } from "../http/sleep.js";
import { sourceStateOf } from "../mcp/refresh.js";
import type {
  McpLogger,
  OnDemandState,
  RefreshOutcome,
  RefreshOutcomeCode,
  RefreshReport,
  RefreshSourceReport,
} from "../mcp/services.js";
import { NWS_PROVIDER } from "../sources/weather/nws.js";
import { OPEN_METEO_PROVIDER } from "../sources/weather/open-meteo.js";

// --- the child process seam --------------------------------------------------------------------------

/** Starts one child. `args` never pass through a shell; `env` is the whole environment. */
export type Spawner = (
  cmd: string,
  args: readonly string[],
  opts: { env: Readonly<Record<string, string>> },
) => ChildHandle;

/** A started child. `done` rejects (with the spawn error) when the process could not start. */
export interface ChildHandle {
  readonly pid: number | null;
  readonly done: Promise<{ code: number | null; stdout: string }>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

/** What `createOnDemandRefresher` is given by the composition root (`ff serve`). */
export interface OnDemandOptions {
  /** FF_ON_DEMAND_REFRESH (`off` disables everything). */
  readonly mode: OnDemandMode;
  /** Absolute path of the package's built CLI entry (`<packageRoot>/dist/cli.js`). */
  readonly entry: string;
  /** The Node binary (process.execPath). */
  readonly execPath: string;
  /** Node flags before the entry (tests: `--import tsx`); empty in production. */
  readonly execArgv?: readonly string[];
  /** The server's environment; only CHILD_ENV_KEYS reach the child. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The server's version: the child refuses to run when its own differs (`--expect-version`). */
  readonly version: string;
  readonly weatherSource: WeatherSource;
  readonly clock: Clock;
  readonly logger: McpLogger;
  readonly spawn?: Spawner;
  readonly sleep?: Sleep;
}

/** McpServices.ensureFresh: never throws; null when nothing was attempted. */
export type EnsureFresh = (
  sources: readonly DueSource[],
  opts: { readonly requestId: string },
) => Promise<RefreshReport | null>;

/** The orchestrator `ff serve` wires into McpServices (`ensureFresh`). */
export interface OnDemandRefresher {
  ensureFresh: EnsureFresh;
  /** SIGTERM to every live child (serve's shutdown); never waits. */
  shutdown(): void;
  state(): OnDemandState;
}

/** The read-only store ports the decisions read (no writes). */
export interface OnDemandPorts {
  readonly refreshLog: Pick<RefreshLogRepository, "current" | "latest" | "consecutiveFailures">;
  readonly providerBackoff: Pick<ProviderBackoffRepository, "get">;
  /** A run that found its seasons unpublished upstream writes only these (the floor counts them). */
  readonly seasonChecks: Pick<SeasonCheckRepository, "all">;
  readonly runLocks: RunLockReader;
  readonly storeStats: () => StoreStats;
  readonly scheduleView: (nowMs: number) => ScheduleView;
}

/**
 * The environment a child inherits (§6.3): where the config, cache, league file and fixtures are,
 * the weather source, the log level and the zone. No `YAHOO_*`, no `ODDS_API_KEY`, nothing else.
 */
export const CHILD_ENV_KEYS: readonly string[] = Object.freeze([
  "HOME",
  "FF_CONFIG_DIR",
  "FF_CACHE_DIR",
  "FF_LEAGUE_FILE",
  "FF_FIXTURE_DIR",
  "FF_WEATHER_SOURCE",
  "FF_LOG_LEVEL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "TZ",
]);

/** The child's environment: the allow-listed keys the server has, nothing else. */
export function childEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_KEYS) {
    const v = env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** The child's argv after the Node binary: `[...execArgv, entry, "refresh", <fixed flags>, ...targets]`. */
export function childArgs(
  o: Pick<OnDemandOptions, "entry" | "execArgv" | "version">,
  targets: readonly DueSource[],
): string[] {
  return [
    ...(o.execArgv ?? []),
    o.entry,
    "refresh",
    "--on-demand",
    "--no-migrate",
    "--expect-version",
    o.version,
    "--json",
    "--notify",
    ...DUE_ORDER.filter((s) => targets.includes(s)),
  ];
}

/** Bytes kept of a child's stdout (the `--json` result) and of its stderr (forwarded as debug lines). */
export const CHILD_OUTPUT_MAX_BYTES = 64 * 1024;

/** The production spawner: `shell: false`, stdin ignored, stdout collected, stderr logged per line. */
export function nodeSpawner(logger: McpLogger): Spawner {
  return (cmd, args, opts) => {
    const child = nodeSpawn(cmd, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...opts.env },
      windowsHide: true,
    });
    let stdout = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes <= CHILD_OUTPUT_MAX_BYTES) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > CHILD_OUTPUT_MAX_BYTES) return;
      pending += chunk;
      let i = pending.indexOf("\n");
      while (i >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        i = pending.indexOf("\n");
        if (line !== "") logger.debug("refresh.child", { line });
      }
    });
    const done = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      let started = false;
      child.once("spawn", () => {
        started = true;
      });
      child.once("error", (e) => {
        if (!started) reject(e);
      });
      child.once("close", (code) => {
        if (pending.trim() !== "") logger.debug("refresh.child", { line: pending.trim() });
        resolve({ code, stdout: stdoutBytes <= CHILD_OUTPUT_MAX_BYTES ? stdout : "" });
      });
    });
    return {
      pid: child.pid ?? null,
      done,
      kill: (signal) => {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      },
    };
  };
}

// --- the child's result (the `ff refresh --json` contract, src/cli/refresh.ts) ----------------------------

const sourceId = z.string().regex(/^[a-z_]+:[a-z_]+$/);
const childResult = z.discriminatedUnion("status", [
  z.object({ source: sourceId, status: z.literal("published") }),
  z.object({ source: sourceId, status: z.literal("unchanged") }),
  z.object({
    source: sourceId,
    status: z.literal("skipped"),
    reason: z.string().regex(/^[a-z_]{1,40}$/),
    until: z.string().max(40).nullable().optional(),
  }),
  z.object({
    source: sourceId,
    status: z.literal("failed"),
    error: z.string().regex(/^[a-z_]{1,40}$/),
  }),
]);
const childOutput = z.object({ results: z.array(childResult).max(16) });
type ChildResult = z.infer<typeof childResult>;

/** Parses the child's stdout; null when it is not the `--json` contract. Never throws. */
export function parseChildOutput(stdout: string): ChildResult[] | null {
  try {
    const r = childOutput.safeParse(JSON.parse(stdout));
    return r.success ? r.data.results : null;
  } catch {
    return null;
  }
}

/** The child's failure code as a report code (fixed vocabulary; anything else is `internal`). */
export function failureCode(error: string): RefreshOutcomeCode {
  switch (error) {
    case "network":
    case "rate_limited":
    case "not_found":
    case "schema":
    case "aborted":
      return error;
    default:
      return "internal";
  }
}

/** One child result as an outcome + code (+ the instant a skip lasts until). */
export function outcomeOf(r: ChildResult): {
  outcome: RefreshOutcome;
  code: RefreshOutcomeCode;
  until: string | null;
} {
  switch (r.status) {
    case "published":
      return { outcome: "updated", code: null, until: null };
    case "unchanged":
      return { outcome: "revalidated", code: null, until: null };
    case "failed":
      return { outcome: "failed", code: failureCode(r.error), until: null };
    case "skipped": {
      const until = r.until ?? null;
      switch (r.reason) {
        case "locked":
          return { outcome: "joined", code: "locked", until };
        case "provider_backoff":
          return { outcome: "backoff", code: "rate_limited", until };
        case "failure_backoff":
          return { outcome: "backoff", code: null, until };
        case "not_published":
        case "off_season":
        case "no_games":
          return { outcome: "skipped", code: r.reason, until };
        default:
          return { outcome: "skipped", code: null, until };
      }
    }
  }
}

// --- per-source state ---------------------------------------------------------------------------------

/** The configured weather provider's forecast horizon (hours; 0 when weather is off). */
export function weatherHorizonHours(weather: WeatherSource): number {
  if (weather === "nws") return NWS_PROVIDER.horizonHours;
  if (weather === "open-meteo") return OPEN_METEO_PROVIDER.horizonHours;
  return 0;
}

/** Sources a tool cannot answer without (requiredSource); injuries and weather are optional (§6.2). */
export const REQUIRED_SOURCES: ReadonlySet<DueSource> = new Set([
  "nflverse:schedules",
  "nflverse:stats_player_week",
  "nflverse:roster_weekly",
]);

/** The dataset source a due source reads under FF_WEATHER_SOURCE (null: weather is off). */
export function datasetIdOf(due: DueSource, weather: WeatherSource): DatasetSourceId | null {
  if (due !== "weather") return due;
  if (weather === "open-meteo") return "weather:open_meteo";
  if (weather === "nws") return "weather:nws";
  return null;
}

const msOrNull = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

interface Judged {
  readonly due: DueSource;
  readonly id: DatasetSourceId;
  readonly action: OnDemandAction;
  readonly current: RefreshLogRow | null;
}

/** A refresh this server started: the sources it carries and its completion. */
interface Flight {
  readonly sources: ReadonlySet<DatasetSourceId>;
  readonly startedAt: number;
  readonly before: ReadonlyMap<DatasetSourceId, RefreshLogRow | null>;
  readonly child: ChildHandle;
  /** Resolves with each carried source's outcome once the child exits (never rejects). */
  readonly settled: Promise<ReadonlyMap<DatasetSourceId, SourceOutcome>>;
  finished: boolean;
}

interface SourceOutcome {
  readonly outcome: RefreshOutcome;
  readonly code: RefreshOutcomeCode;
  readonly at: number;
  readonly until: string | null;
}

const HOUR_MS = 3_600_000;
/** How often a join on another process's run lock re-reads refresh_log (§6.3). */
export const JOIN_POLL_MS = 250;

/**
 * Spawn errors that last as long as this server: the binary is missing or not executable, or a
 * sandbox or Node's permission model refuses child processes. They turn answer-time refresh off for
 * the process; any other spawn error (EAGAIN — the per-user process limit —, EMFILE, ENOMEM, …)
 * fails that call only and holds new children back for SPAWN_RETRY_MS.
 */
export const PERMANENT_SPAWN_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ERR_ACCESS_DENIED",
]);
/** How long a transient spawn failure holds new answer-time children back. */
export const SPAWN_RETRY_MS = 15 * 60_000;

/** Whether a spawn error is permanent for this process (PERMANENT_SPAWN_CODES). */
export function isPermanentSpawnError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && PERMANENT_SPAWN_CODES.has(code);
}

/** A child that could not be started: when a new one may be tried (null: never, in this process). */
interface SpawnFailure {
  readonly spawn: true;
  readonly retryAt: number | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Builds the orchestrator. `mode: "off"` gives one that never spawns and reports nothing. */
export function createOnDemandRefresher(
  o: OnDemandOptions,
  ports: OnDemandPorts,
): OnDemandRefresher {
  let state: ReturnType<OnDemandRefresher["state"]> = o.mode;
  const spawner = o.spawn ?? nodeSpawner(o.logger);
  const sleep = o.sleep ?? abortableSleep;
  const flights = new Map<DatasetSourceId, Flight>();
  const live = new Set<Flight>();
  const spawnTimes: number[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  /** Until when a transient spawn failure holds new children back (0: it does not). */
  let spawnRetryAt = 0;

  const now = (): number => o.clock.nowMs();

  const judge = (due: DueSource, nowMs: number, view: ScheduleView): Judged | null => {
    const id = datasetIdOf(due, o.weatherSource);
    if (id === null) return null;
    const { state: s, current } = sourceStateOf(ports, id, nowMs, view.phase.season);
    const cls = freshnessClass(SOURCE_REGISTRY[id].freshness);
    const expired = s.basis !== null && isExpired(cls, s.basis, nowMs);
    const horizonHours = weatherHorizonHours(o.weatherSource);
    const action = onDemandDecision({
      source: due,
      nowMs,
      cal: view.calendar,
      state: s,
      required: REQUIRED_SOURCES.has(due),
      expired,
      ...(due === "weather"
        ? {
            weather: {
              lastBucketMs:
                current?.file_version == null ? null : weatherBucketMs(current.file_version),
              horizonHours,
            },
          }
        : {}),
    });
    if (state === "background" && action.kind === "wait")
      return { due, id, current, action: { kind: "background", reason: "revalidate" } };
    return { due, id, current, action };
  };

  /** What refresh_log says happened to `id` since `before` (a new version, a moved check, a failure). */
  const fromLog = (
    id: DatasetSourceId,
    before: RefreshLogRow | null,
    since: number,
  ): { outcome: RefreshOutcome; code: RefreshOutcomeCode } | null => {
    const cur = ports.refreshLog.current().find((r) => r.source === id) ?? null;
    if (cur !== null && cur.file_version !== (before?.file_version ?? null)) {
      return { outcome: "updated", code: null };
    }
    const moved = msOrNull(cur?.checked_at);
    const was = msOrNull(before?.checked_at);
    if (cur !== null && moved !== null && (was === null || moved > was))
      return { outcome: "revalidated", code: null };
    const latest = ports.refreshLog.latest(id);
    const started = msOrNull(latest?.started_at);
    if (latest !== null && !latest.ok && started !== null && started >= since - 1000)
      return { outcome: "failed", code: failureCode(latest.error ?? "internal") };
    return null;
  };

  const settle = (
    sources: ReadonlySet<DatasetSourceId>,
    before: ReadonlyMap<DatasetSourceId, RefreshLogRow | null>,
    startedAt: number,
    result: { code: number | null; stdout: string } | SpawnFailure,
  ): Map<DatasetSourceId, SourceOutcome> => {
    const at = now();
    const out = new Map<DatasetSourceId, SourceOutcome>();
    const all = (outcome: RefreshOutcome, code: RefreshOutcomeCode, until: string | null): void => {
      for (const id of sources) out.set(id, { outcome, code, at, until });
    };
    if ("spawn" in result) {
      all("failed", "spawn", result.retryAt === null ? null : iso(result.retryAt));
      return out;
    }
    if (result.code === 2) {
      all("failed", "version", null);
      return out;
    }
    const parsed = parseChildOutput(result.stdout) ?? [];
    for (const id of sources) {
      const r = parsed.find((x) => x.source === id);
      const log = fromLog(id, before.get(id) ?? null, startedAt);
      if (r === undefined) {
        out.set(id, { ...(log ?? { outcome: "failed", code: "internal" }), at, until: null });
        continue;
      }
      const v = outcomeOf(r);
      // the child's word is checked against the log it wrote: "published" needs a new current
      // version and "unchanged" a moved check, or the answer would claim a refresh that did not land
      if (
        (v.outcome === "updated" && log?.outcome !== "updated") ||
        (v.outcome === "revalidated" &&
          log?.outcome !== "revalidated" &&
          log?.outcome !== "updated")
      ) {
        o.logger.warn("refresh.child_mismatch", { source: id, status: r.status });
        out.set(id, { outcome: "failed", code: "internal", at, until: null });
        continue;
      }
      out.set(id, { ...v, at });
    }
    return out;
  };

  /**
   * `settle`, never throwing: a child that outlives the server's store (shutdown) or a store read
   * that fails reads `failed:aborted` / `failed:internal` instead of an unhandled rejection.
   */
  const safeSettle = (
    sources: ReadonlySet<DatasetSourceId>,
    before: ReadonlyMap<DatasetSourceId, RefreshLogRow | null>,
    startedAt: number,
    result: { code: number | null; stdout: string } | SpawnFailure,
  ): Map<DatasetSourceId, SourceOutcome> => {
    const fallback = (code: RefreshOutcomeCode): Map<DatasetSourceId, SourceOutcome> =>
      new Map([...sources].map((id) => [id, { outcome: "failed", code, at: now(), until: null }]));
    if (closed) return fallback("aborted");
    try {
      return settle(sources, before, startedAt, result);
    } catch (e) {
      o.logger.warn("refresh.settle_failed", { error: e instanceof Error ? e.name : "unknown" });
      return fallback("internal");
    }
  };

  /**
   * A child that could not be started: a permanent error turns answer-time refresh off for the
   * process (once, with one warning); any other holds new children back for SPAWN_RETRY_MS.
   */
  const spawnFailed = (e: unknown): SpawnFailure => {
    const code = (e as { code?: unknown } | null)?.code;
    o.logger.warn("refresh.spawn_failed", { code: typeof code === "string" ? code : "unknown" });
    if (isPermanentSpawnError(e)) {
      if (state === "wait" || state === "background") {
        state = "disabled_spawn";
        o.logger.warn("refresh.on_demand_disabled", { reason: "spawn" });
      }
      return { spawn: true, retryAt: null };
    }
    spawnRetryAt = Math.max(spawnRetryAt, now() + SPAWN_RETRY_MS);
    o.logger.warn("refresh.spawn_backoff", { until: iso(spawnRetryAt) });
    return { spawn: true, retryAt: spawnRetryAt };
  };

  const start = (judged: readonly Judged[], nowMs: number): Flight | SpawnFailure | "throttled" => {
    while (spawnTimes.length > 0 && (spawnTimes[0] ?? 0) <= nowMs - HOUR_MS) spawnTimes.shift();
    if (live.size >= ON_DEMAND.maxChildren || spawnTimes.length >= ON_DEMAND.maxSpawnsPerHour)
      return "throttled";
    const sources = new Set(judged.map((j) => j.id));
    const before = new Map(judged.map((j) => [j.id, j.current]));
    let child: ChildHandle;
    try {
      child = spawner(
        o.execPath,
        childArgs(
          o,
          judged.map((j) => j.due),
        ),
        { env: childEnv(o.env) },
      );
    } catch (e) {
      return spawnFailed(e);
    }
    spawnTimes.push(nowMs);
    o.logger.info("refresh.child_started", { sources: [...sources], pid: child.pid });
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
    }, ON_DEMAND.killAfterMs);
    kill.unref();
    timers.add(kill);
    const flight: Flight = {
      sources,
      startedAt: nowMs,
      before,
      child,
      finished: false,
      settled: child.done.then(
        (r) => safeSettle(sources, before, nowMs, r),
        (e: unknown) => safeSettle(sources, before, nowMs, spawnFailed(e)),
      ),
    };
    live.add(flight);
    for (const id of sources) flights.set(id, flight);
    void flight.settled.then((m) => {
      flight.finished = true;
      clearTimeout(kill);
      timers.delete(kill);
      live.delete(flight);
      for (const id of sources) if (flights.get(id) === flight) flights.delete(id);
      const codes = new Set([...m.values()].map((x) => x.code));
      if (codes.has("version") && (state === "wait" || state === "background")) {
        state = "disabled_version";
        o.logger.warn("refresh.on_demand_disabled", { reason: "version" });
      }
      o.logger.info("refresh.child_finished", {
        outcomes: [...m.entries()].map(([s, x]) => `${s}=${x.outcome}`),
      });
    });
    return flight;
  };

  const ensureFresh: OnDemandRefresher["ensureFresh"] = async (sources, opts) => {
    try {
      if (closed || (state !== "wait" && state !== "background")) return null;
      const t0 = now();
      const view = ports.scheduleView(t0);
      const judged: Judged[] = [];
      for (const due of DUE_ORDER) {
        if (!sources.includes(due)) continue;
        const j = judge(due, t0, view);
        if (j !== null && j.action.kind !== "none") judged.push(j);
      }
      if (judged.length === 0) return null;
      const rows = new Map<DatasetSourceId, RefreshSourceReport>();
      const set = (id: DatasetSourceId, r: Omit<RefreshSourceReport, "source">): void => {
        rows.set(id, { source: id, ...r });
      };
      // budgets: the longest wait asked for, never past the per-call cap
      let budget = 0;
      for (const j of judged)
        if (j.action.kind === "wait") budget = Math.max(budget, j.action.budget_ms);
      budget = Math.min(budget, ON_DEMAND.callCapMs);
      const waits: { readonly id: DatasetSourceId; readonly flight: Flight }[] = [];
      const joined: { id: DatasetSourceId; flight: Flight; waited: boolean }[] = [];
      const external: {
        id: DatasetSourceId;
        since: number;
        lockAt: string;
        waited: boolean;
        before: RefreshLogRow | null;
      }[] = [];
      const toStart: Judged[] = [];
      for (const j of judged) {
        const a = j.action;
        if (a.kind === "skip") {
          set(j.id, {
            outcome: "backoff",
            code: a.reason === "provider_backoff" ? "rate_limited" : null,
            started_at: null,
            at: iso(t0),
            next_retry_at: iso(a.until_ms),
          });
          continue;
        }
        if (a.kind === "none") continue;
        const waited = a.kind === "wait";
        const mine = flights.get(j.id);
        if (mine !== undefined && !mine.finished) {
          joined.push({ id: j.id, flight: mine, waited });
          if (waited) waits.push({ id: j.id, flight: mine });
          continue;
        }
        const lock = ports.runLocks.held(j.id);
        if (lock !== null) {
          external.push({
            id: j.id,
            since: t0,
            lockAt: lock.acquired_at,
            waited,
            before: j.current,
          });
          continue;
        }
        toStart.push(j);
      }
      if (toStart.length > 0 && t0 < spawnRetryAt) {
        // a transient spawn failure holds new children back: say when they are tried again
        for (const j of toStart)
          set(j.id, {
            outcome: "backoff",
            code: "spawn",
            started_at: null,
            at: iso(t0),
            next_retry_at: iso(spawnRetryAt),
          });
      } else if (toStart.length > 0) {
        const f = start(toStart, t0);
        if (f === "throttled" || "spawn" in f) {
          for (const j of toStart)
            set(j.id, {
              outcome: f === "throttled" ? "throttled" : "failed",
              code: f === "throttled" ? null : "spawn",
              started_at: null,
              at: iso(t0),
              next_retry_at: f === "throttled" || f.retryAt === null ? null : iso(f.retryAt),
            });
        } else {
          for (const j of toStart) {
            const waited = j.action.kind === "wait";
            joined.push({ id: j.id, flight: f, waited });
            if (waited) waits.push({ id: j.id, flight: f });
          }
        }
      }
      // wait: this server's children, and other processes' run locks polled through refresh_log —
      // also when a child found the run lock taken (the tick took it between this decision and the
      // child's start): that run is joined like another process's, within the same budget
      const deadline = t0 + budget;
      if (budget > 0 && (waits.length > 0 || external.some((e) => e.waited))) {
        const abort = new AbortController();
        const timeout = (ms: number): Promise<void> =>
          sleep(Math.max(0, ms), abort.signal).catch(() => undefined);
        const pollLock = async (id: DatasetSourceId): Promise<void> => {
          while (now() < deadline && ports.runLocks.held(id) !== null)
            await timeout(Math.min(JOIN_POLL_MS, deadline - now()));
        };
        const children = waits.map(async ({ id, flight }) => {
          const x = (await flight.settled).get(id);
          if (x?.outcome === "joined" && x.code === "locked") await pollLock(id);
        });
        const polls = external.filter((e) => e.waited).map((e) => pollLock(e.id));
        await Promise.race([Promise.all([...children, ...polls]), timeout(deadline - now())]);
        abort.abort();
      }
      const t1 = now();
      for (const j of joined) {
        if (j.flight.finished) {
          const m = await j.flight.settled;
          const x = m.get(j.id);
          // a child that found the run lock taken: what that run did, once its lock is gone
          const other =
            x?.outcome === "joined" && x.code === "locked" && ports.runLocks.held(j.id) === null
              ? fromLog(j.id, j.flight.before.get(j.id) ?? null, j.flight.startedAt)
              : null;
          if (x !== undefined) {
            set(j.id, {
              outcome: other?.outcome ?? x.outcome,
              code: other === null ? x.code : other.code,
              started_at: iso(j.flight.startedAt),
              at: iso(other === null ? x.at : t1),
              next_retry_at: other === null ? x.until : null,
            });
            continue;
          }
        }
        set(j.id, {
          outcome: "in_progress",
          code: null,
          started_at: iso(j.flight.startedAt),
          at: iso(t1),
          next_retry_at: null,
        });
      }
      for (const e of external) {
        const still = ports.runLocks.held(e.id);
        const log = still === null ? fromLog(e.id, e.before, e.since) : null;
        set(e.id, {
          outcome: log === null ? "joined" : log.outcome,
          code: log === null ? "locked" : log.code,
          started_at: msOrNull(e.lockAt) === null ? null : iso(msOrNull(e.lockAt) ?? t1),
          at: iso(t1),
          next_retry_at: null,
        });
      }
      const ordered = DUE_ORDER.flatMap((d) => {
        const id = datasetIdOf(d, o.weatherSource);
        const r = id === null ? undefined : rows.get(id);
        return r === undefined ? [] : [r];
      }).slice(0, 8);
      if (ordered.length === 0) return null;
      o.logger.debug("refresh.on_demand", {
        request_id: opts.requestId,
        outcomes: ordered.map((r) => `${r.source}=${r.outcome}`),
      });
      return { mode: o.mode === "background" ? "background" : "wait", sources: ordered };
    } catch (e) {
      o.logger.warn("refresh.on_demand_error", {
        request_id: opts.requestId,
        error: e instanceof Error ? e.name : "unknown",
      });
      return null;
    }
  };

  return {
    ensureFresh,
    shutdown: () => {
      closed = true;
      for (const f of live) f.child.kill("SIGTERM");
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
    state: () => state,
  };
}
