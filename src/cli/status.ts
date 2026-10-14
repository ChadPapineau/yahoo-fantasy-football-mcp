// status.ts — `ff status [--json]`, the terminal dashboard (plan 01 §7 `ff status` snapshot; plan 06
// J2 "`ff status` is the dashboard", §3 "any source past its hard limit; pending journal rows; jobs
// not loaded"). Reads only: the store is opened without creating or migrating it. Per source: last
// success, last error, age judged by the class's basis (stampState), consecutive failures, the
// attached file, the tick's next check and a provider pause; the season and schedule blocks G1 prints
// (src/domain/league/status-blocks.ts — the same builders, so the two agree). Exit 0 whenever the
// report was produced; 1 only when the store cannot be read.
import { lstatSync } from "node:fs";
import {
  freshnessClass,
  SOURCE_REGISTRY,
  stampState,
  type DatasetSourceId,
  type FreshnessState,
} from "../config/freshness.js";
import { fallbackCalendar, type GameCalendar } from "../config/game-calendar.js";
import { TOOL_INPUT_WEEK_MAX } from "../config/weeks.js";
import { scheduleView, type ScheduleView } from "../domain/league/calendar.js";
import { datasetCoverage } from "../domain/league/coverage.js";
import {
  scheduleBlock,
  seasonBlock,
  type ScheduleBlock,
  type SeasonBlock,
} from "../domain/league/status-blocks.js";
import { nextTickAt, providerOf, tickDecisionOf } from "../mcp/refresh.js";
import { ManualLeagueProvider } from "../providers/manual/index.js";
import { NWS_PROVIDER, OPEN_METEO_PROVIDER } from "../sources/weather/index.js";
import { datasetFilePath, storePath } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import type { RefreshLogRow } from "../domain/analytics/types.js";
import {
  checkDatasetFile,
  type DatasetCheck,
  type DatasetHealth,
} from "../sources/dataset-health.js";
import { MIGRATIONS } from "../store/index.js";
import type { Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { installedPlists, JOBS, REFRESH_DUE_JOB } from "./launchd.js";
import type { Logger } from "./log.js";
import { openExistingStore, type ExistingStore } from "./store-access.js";

/** The Phase-1a nflverse sources, in refresh order. */
export const NFLVERSE_1A: readonly DatasetSourceId[] = [
  "nflverse:schedules",
  "nflverse:injuries",
  "nflverse:roster_weekly",
  "nflverse:stats_player_week",
];

/** The sources this configuration refreshes (the weather source follows FF_WEATHER_SOURCE). */
export function configuredSources(config: Config): DatasetSourceId[] {
  const out = [...NFLVERSE_1A];
  if (config.weatherSource === "open-meteo") out.push("weather:open_meteo");
  if (config.weatherSource === "nws") out.push("weather:nws");
  return out;
}

/** One source's line on the dashboard. */
export interface SourceStatus {
  readonly source: DatasetSourceId;
  readonly freshness_class: string;
  /**
   * `never_loaded` when no successful refresh exists; `unreadable` when a successful refresh recorded
   * a current file the server cannot attach — missing, not a regular file, damaged, or another
   * source's, version's or layout's — as G1 `ff_get_status` reads it (QA-1-038); `not_published`
   * when the season in progress is not published upstream yet (a recent season_check) — upstream's
   * state, never an outage (G1 freshness `not_published`).
   */
  readonly state: FreshnessState | "never_loaded" | "unreadable" | "not_published";
  /** What the class does past its hard limit (`STALE_ONLY` error, or the driver is omitted). */
  readonly beyond_hard: string | null;
  readonly age_s: number | null;
  readonly basis_at: string | null;
  readonly file_version: string | null;
  readonly rows: number | null;
  readonly seasons: readonly number[];
  readonly last_success_at: string | null;
  readonly last_error: { readonly at: string; readonly error: string | null } | null;
  readonly consecutive_failures: number;
  readonly file_present: boolean;
  readonly file_bytes: number | null;
  /** The current file's health (src/sources/dataset-health.ts); null when there is none to check. */
  readonly file_health: DatasetHealth | null;
  /** When the refresh tick next checks this source (a UTC quarter-hour), as G1 says; null = never. */
  readonly next_check_at: string | null;
  /** The provider's 429 / Retry-After pause end, while it lasts. */
  readonly backoff_until: string | null;
  /** The season in progress that upstream has not published yet, and when that was checked. */
  readonly not_published: { readonly season: number; readonly checked_at: string } | null;
}

/** What `sourceStatus` judges against besides refresh_log (all optional: absent = unknown). */
export interface SourceJudgement {
  /**
   * The game calendar the TTL is judged by (the schedule-driven rule); absent (no schedule to read)
   * = the fallback calendar, every instant hot — the never-under-refresh judgment.
   */
  readonly cal?: GameCalendar;
  /** A recent season_check saying the season in progress is not published upstream. */
  readonly notPublished?: { readonly season: number; readonly checked_at: string } | null;
  readonly nextCheckAt?: string | null;
  readonly backoffUntil?: string | null;
}

/** Judges one source from its refresh_log rows. */
export function sourceStatus(
  source: DatasetSourceId,
  current: RefreshLogRow | null,
  latest: RefreshLogRow | null,
  failures: number,
  cacheDir: string,
  nowMs: number,
  checkFile: DatasetCheck = checkDatasetFile,
  judge: SourceJudgement = {},
): SourceStatus {
  const cls = freshnessClass(SOURCE_REGISTRY[source].freshness);
  const notPublished = judge.notPublished ?? null;
  let fileBytes: number | null = null;
  try {
    const st = lstatSync(datasetFilePath(cacheDir, source));
    fileBytes = st.isFile() ? st.size : null;
  } catch {
    fileBytes = null;
  }
  const base = {
    source,
    freshness_class: cls.id,
    beyond_hard: cls.beyondHard,
    consecutive_failures: failures,
    last_error:
      latest !== null && !latest.ok ? { at: latest.finished_at, error: latest.error } : null,
    file_present: fileBytes !== null,
    file_bytes: fileBytes,
    file_health: null,
    next_check_at: judge.nextCheckAt ?? null,
    backoff_until: judge.backoffUntil ?? null,
    not_published: notPublished,
  };
  if (current === null) {
    return {
      ...base,
      state: notPublished === null ? "never_loaded" : "not_published",
      age_s: null,
      basis_at: null,
      file_version: null,
      rows: null,
      seasons: [],
      last_success_at: null,
    };
  }
  const judged = stampState(
    cls,
    {
      as_of: current.release_updated_at ?? current.finished_at,
      fetched_at: current.finished_at,
      checked_at: current.checked_at,
    },
    nowMs,
    judge.cal ?? fallbackCalendar("never_loaded"),
  );
  // never "fresh" for a file the server cannot attach (QA-1-038): the same checks the refresh runs.
  // A refreshed source whose file is gone or not a regular file is unreadable too, never "never
  // loaded" — G1 reads it so, and `ff refresh <source>` is the repair either way.
  const health = checkFile(source, datasetFilePath(cacheDir, source), current.file_version ?? "");
  return {
    ...base,
    file_health: health,
    state: health !== "ok" ? "unreadable" : notPublished !== null ? "not_published" : judged.state,
    age_s: judged.age_s,
    basis_at: judged.basis_at,
    file_version: current.file_version,
    rows: current.rows,
    seasons: current.seasons,
    last_success_at: current.finished_at,
  };
}

/** The forecast horizon of the configured weather provider, in hours. */
function weatherHorizonHours(id: DatasetSourceId): number {
  return id === "weather:nws" ? NWS_PROVIDER.horizonHours : OPEN_METEO_PROVIDER.horizonHours;
}

/**
 * Every source's status from an open store, judged as G1 judges it: the TTL by the schedule's
 * game calendar, the season in progress by its coverage (a recent `not_published` season_check reads
 * as such), the tick's next check and the provider's pause.
 */
export function sourceStatuses(
  store: Store,
  config: Config,
  nowMs: number,
  view: ScheduleView = scheduleView(store.datasets.schedules, nowMs),
): SourceStatus[] {
  const rl = store.repos.refreshLog;
  const current = rl.current();
  const ports = {
    refreshLog: rl,
    providerBackoff: store.repos.providerBackoff,
    storeStats: () => store.stats(),
  };
  return configuredSources(config).map((s) => {
    const cur = current.find((r) => r.source === s && r.ok) ?? null;
    const cls = freshnessClass(SOURCE_REGISTRY[s].freshness);
    const season = view.phase.season;
    const coverage = s.startsWith("weather:")
      ? null
      : datasetCoverage({
          stamp:
            cur?.file_version == null
              ? null
              : {
                  source: s,
                  as_of: cur.release_updated_at ?? cur.finished_at,
                  fetched_at: cur.finished_at,
                  checked_at: cur.checked_at,
                  freshness_class: cls.id,
                  file_version: cur.file_version,
                  seasons: cur.seasons,
                },
          season,
          phase: view.phase,
          check: store.repos.seasonChecks.latest(s, season),
          hardLimitSeconds: cls.hardLimitSeconds,
          nowMs,
        });
    const decision = tickDecisionOf(ports, s, view.calendar, nowMs, weatherHorizonHours(s));
    const at = decision === null ? null : decision.due ? nowMs : decision.next_at_ms;
    const backoff = store.repos.providerBackoff.get(providerOf(s));
    const backoffMs = backoff === null ? Number.NaN : Date.parse(backoff.until_at);
    return sourceStatus(
      s,
      cur,
      rl.latest(s),
      rl.consecutiveFailures(s),
      config.cacheDir,
      nowMs,
      checkDatasetFile,
      {
        cal: view.calendar,
        notPublished:
          coverage?.state === "not_published" && coverage.checked_at !== null
            ? { season, checked_at: coverage.checked_at }
            : null,
        nextCheckAt: at === null ? null : new Date(nextTickAt(at)).toISOString(),
        backoffUntil:
          Number.isFinite(backoffMs) && backoffMs > nowMs
            ? new Date(backoffMs).toISOString()
            : null,
      },
    );
  });
}

/** How far back the status surfaces list kickoff changes (the notification horizon, as G1). */
export const STATUS_CHANGES_WINDOW_MS = 14 * 86_400_000;
/** The most change rows the status surfaces read. */
export const STATUS_CHANGES_MAX_ROWS = 200;

/** The league file's season, or null when there is no readable league file. */
export function leagueSeasonOf(io: CliIo, config: Config, log: Logger): number | null {
  try {
    return new ManualLeagueProvider({
      file: config.leagueFile,
      clock: io.clock,
      logger: log,
      requirePrivate: false,
    }).load().data.season;
  } catch {
    return null;
  }
}

/** The whole report (`--json` shape; the text view renders the same object). */
export interface StatusReport {
  readonly version: string;
  readonly node: string;
  readonly generated_at: string;
  readonly config: {
    readonly config_dir: string;
    readonly cache_dir: string;
    readonly league_file: string;
    readonly weather_source: string;
    readonly toolset: string;
    readonly fixture_mode: boolean;
    readonly warnings: readonly string[];
  };
  readonly store: {
    readonly state: "ok" | "missing" | "newer" | "pending" | "error";
    readonly path: string;
    readonly size_bytes: number | null;
    readonly schema_version: number | null;
    readonly binary_schema_version: number;
    readonly cache_misses_busy: number | null;
    readonly message: string | null;
  };
  readonly sources: readonly SourceStatus[];
  /** Where the NFL season is (the same block as G1's `season`); null when the store is not open. */
  readonly season: SeasonBlock | null;
  /** The game calendar and recent kickoff changes (G1's `schedule`); null when the store is not open. */
  readonly schedule: (ScheduleBlock & { readonly next_check_at: string | null }) | null;
  /** The refresh tick's last run (job_run), when recorded. */
  readonly tick: {
    readonly last_run_at: string;
    readonly exit: number;
    readonly summary: string | null;
  } | null;
  readonly journal: {
    readonly counts: Readonly<Record<string, number>>;
    readonly oldest_pending_age_s: number | null;
  } | null;
  readonly launchd: {
    readonly supported: boolean;
    readonly installed: readonly string[];
    readonly missing: readonly string[];
    /** Plists of retired jobs still installed (`ff install-launchd` retires them). */
    readonly legacy: readonly string[];
  };
}

function storeBlock(ex: ExistingStore, config: Config): StatusReport["store"] {
  const p = storePath(config.cacheDir);
  const bin = MIGRATIONS.length;
  switch (ex.kind) {
    case "open": {
      const st = ex.store.stats();
      return {
        state: "ok",
        path: p,
        size_bytes: st.size_bytes,
        schema_version: st.schema_version,
        binary_schema_version: bin,
        cache_misses_busy: st.cache_misses_busy,
        message: null,
      };
    }
    case "missing":
      return {
        state: "missing",
        path: p,
        size_bytes: null,
        schema_version: null,
        binary_schema_version: bin,
        cache_misses_busy: null,
        message: "not created yet — run `ff refresh all`",
      };
    case "newer":
      return {
        state: "newer",
        path: p,
        size_bytes: null,
        schema_version: ex.storeVersion,
        binary_schema_version: bin,
        cache_misses_busy: null,
        message: `written by a newer version (v${String(ex.storeVersion)}); this binary supports v${String(ex.binaryVersion)} — upgrade the package or restore a backup`,
      };
    case "pending":
      return {
        state: "pending",
        path: p,
        size_bytes: null,
        schema_version: ex.storeVersion,
        binary_schema_version: bin,
        cache_misses_busy: null,
        message: `schema v${String(ex.storeVersion)} → v${String(ex.binaryVersion)} migration pending — it runs on the next \`ff refresh\` or server start`,
      };
    case "error":
      return {
        state: "error",
        path: p,
        size_bytes: null,
        schema_version: null,
        binary_schema_version: bin,
        cache_misses_busy: null,
        message: ex.message,
      };
  }
}

/** Builds the report (the store is closed before returning). */
export function collectStatus(
  io: CliIo,
  config: Config,
  log: Logger,
  factory?: StoreFactory,
): StatusReport {
  const now = io.clock.nowMs();
  const ex = openExistingStore(config, io.clock, log, factory);
  try {
    const view = ex.kind === "open" ? scheduleView(ex.store.datasets.schedules, now) : null;
    const sources =
      ex.kind === "open" && view !== null
        ? sourceStatuses(ex.store, config, now, view)
        : configuredSources(config).map((s) =>
            sourceStatus(s, null, null, 0, config.cacheDir, now),
          );
    let season: StatusReport["season"] = null;
    let schedule: StatusReport["schedule"] = null;
    let tick: StatusReport["tick"] = null;
    if (ex.kind === "open" && view !== null) {
      const since = new Date(now - STATUS_CHANGES_WINDOW_MS).toISOString();
      season = seasonBlock(
        view,
        leagueSeasonOf(io, config, log),
        ex.store.repos.seasonChecks.all(),
        now,
      );
      schedule = {
        ...scheduleBlock(
          view,
          ex.store.repos.scheduleChanges.recent(since, STATUS_CHANGES_MAX_ROWS),
          now,
        ),
        next_check_at:
          sources.find((x) => x.source === "nflverse:schedules")?.next_check_at ?? null,
      };
      const run = ex.store.repos.jobRuns.list().find((j) => j.job === REFRESH_DUE_JOB);
      tick =
        run === undefined
          ? null
          : { last_run_at: run.last_run_at, exit: run.exit, summary: run.summary };
    }
    const journal =
      ex.kind === "open"
        ? {
            counts: { ...ex.store.repos.writeJournal.countByStatus() } as Record<string, number>,
            oldest_pending_age_s: ex.store.repos.writeJournal.oldestPendingAgeSeconds(
              io.clock.nowIso(),
            ),
          }
        : null;
    const plists = installedPlists(io.home);
    const installed = plists.filter((p) => !p.retired).map((p) => p.job);
    const legacy = plists.filter((p) => p.retired).map((p) => p.job);
    return {
      version: VERSION,
      node: io.nodeVersion,
      generated_at: io.clock.nowIso(),
      config: {
        config_dir: config.configDir,
        cache_dir: config.cacheDir,
        league_file: config.leagueFile,
        weather_source: config.weatherSource,
        toolset: config.toolset,
        fixture_mode: config.fixtureDir !== null,
        warnings: config.warnings,
      },
      store: storeBlock(ex, config),
      sources,
      season,
      schedule,
      tick,
      journal,
      launchd: {
        supported: io.platform === "darwin",
        installed,
        missing: JOBS.map((j) => j.name).filter((j) => !installed.includes(j)),
        legacy,
      },
    };
  } finally {
    if (ex.kind === "open") ex.store.close();
  }
}

/** Human age: 45s, 12m, 5h, 3d. */
export function formatAge(s: number | null): string {
  if (s === null) return "—";
  if (s < 90) return `${String(s)}s`;
  if (s < 90 * 60) return `${String(Math.round(s / 60))}m`;
  if (s < 36 * 3600) return `${String(Math.round(s / 3600))}h`;
  return `${String(Math.round(s / 86400))}d`;
}

const STATE_LABEL: Record<SourceStatus["state"], string> = {
  fresh: "fresh",
  stale: "STALE",
  expired: "EXPIRED",
  never_loaded: "NEVER LOADED",
  unreadable: "UNREADABLE",
  not_published: "not published",
};

/** The season and schedule lines of the dashboard (from the same blocks as G1). */
export function renderSeason(r: StatusReport): string[] {
  const out: string[] = [];
  const s = r.season;
  if (s !== null) {
    const week = s.week === null ? "" : ` week ${String(s.week)}`;
    const league =
      s.league_season === null
        ? "no league file"
        : `league season ${String(s.league_season)}${s.league_matches === false ? " — NOT the NFL season in progress: run the onboard Skill's new-season step" : ""}`;
    out.push(
      `season  ${String(s.nfl_season)} ${s.phase}${week} (${s.basis})${s.next_kickoff === null ? "" : `; next kickoff ${s.next_kickoff}`}; ${league}`,
    );
    for (const n of s.not_published)
      out.push(
        `        ${n.source} ${String(n.season)}: not published upstream yet (checked ${n.checked_at}) — upstream's state; nothing to repair`,
      );
    for (const v of s.reference_past_vintage)
      out.push(
        `        reference table ${v.id} is verified through ${String(v.verified_through_season)}; it still works, re-check it`,
      );
    if (s.week_bound_exceeded)
      out.push(
        `        a loaded season runs past week ${String(TOOL_INPUT_WEEK_MAX)}, the tool-input bound: tools cannot ask for its last weeks`,
      );
  }
  const c = r.schedule;
  if (c !== null) {
    out.push(
      `schedule calendar ${c.calendar}${c.fallback_reason === null ? "" : ` (${c.fallback_reason}: every hour is treated as a game window)`}; ${c.in_window ? "in a game window" : "outside game windows"}${c.next_check_at === null ? "" : `; next check ${c.next_check_at}`}`,
    );
    for (const x of c.recent_changes)
      out.push(
        `        ${x.game} ${String(x.season)} week ${String(x.week)} ${x.kind}: ${x.old ?? "—"} → ${x.new ?? "—"} (detected ${x.detected_at})`,
      );
    if (c.recent_changes_more > 0)
      out.push(`        … ${String(c.recent_changes_more)} more schedule change(s)`);
    for (const t of c.tentative_weeks)
      out.push(
        `        ${String(t.season)} week ${String(t.week)} kickoffs are tentative (${t.reason})${t.until === null ? "" : ` until ${t.until}`}`,
      );
  }
  if (r.tick !== null)
    out.push(
      `tick    last run ${r.tick.last_run_at} (exit ${String(r.tick.exit)})${r.tick.summary === null ? "" : ` — ${r.tick.summary}`}`,
    );
  return out;
}

/** Renders the text dashboard. */
export function renderStatus(r: StatusReport): string[] {
  const out: string[] = [];
  out.push(`fantasy-football-mcp ${r.version} (node ${r.node}) — ${r.generated_at}`);
  out.push(`config  ${r.config.config_dir}${r.config.fixture_mode ? "  [fixture mode]" : ""}`);
  out.push(`cache   ${r.config.cache_dir}`);
  const s = r.store;
  out.push(
    s.state === "ok"
      ? `store   schema v${String(s.schema_version)}  ${String(Math.round((s.size_bytes ?? 0) / 1024))} KB  busy cache misses ${String(s.cache_misses_busy)}`
      : `store   ${s.state.toUpperCase()}: ${s.message ?? ""}`,
  );
  const seasonLines = renderSeason(r);
  if (seasonLines.length > 0) out.push(...seasonLines);
  out.push("");
  out.push("source                       state         age    version / rows            failures");
  for (const src of r.sources) {
    const v =
      src.file_version === null
        ? "—"
        : `${src.file_version.slice(0, 22)} / ${String(src.rows ?? 0)}`;
    const err =
      src.last_error === null
        ? ""
        : `  last error ${src.last_error.error ?? "?"} at ${src.last_error.at}`;
    out.push(
      `${src.source.padEnd(28)} ${STATE_LABEL[src.state].padEnd(13)} ${formatAge(src.age_s).padEnd(6)} ${v.padEnd(25)} ${String(src.consecutive_failures)}${err}`,
    );
  }
  const red = r.sources.filter((x) => x.state === "expired" || x.state === "never_loaded");
  if (red.length > 0)
    out.push(`→ run \`ff refresh all\` (${String(red.length)} source(s) expired or never loaded)`);
  for (const x of r.sources.filter((y) => y.state === "unreadable"))
    out.push(`→ ${x.source}: dataset file unreadable — run \`ff refresh ${x.source}\``);
  for (const x of r.sources)
    if (x.state === "not_published" && x.not_published !== null)
      out.push(
        `→ ${x.source}: season ${String(x.not_published.season)} not published upstream yet (checked ${x.not_published.checked_at}) — upstream's state, not a failure`,
      );
  for (const x of r.sources)
    if (x.backoff_until !== null)
      out.push(`→ ${x.source}: upstream asked for a pause; next try after ${x.backoff_until}`);
  if (r.journal !== null) {
    const pending =
      (r.journal.counts.prepared ?? 0) +
      (r.journal.counts.sent ?? 0) +
      (r.journal.counts.sent_unknown ?? 0);
    out.push("");
    out.push(`journal pending writes: ${String(pending)} (writes are not supported in this build)`);
  }
  out.push("");
  if (!r.launchd.supported)
    out.push(
      "launchd: not available on this platform (schedule `ff refresh due` every 15 min with systemd or cron)",
    );
  else if (r.launchd.installed.length === 0)
    out.push("launchd: no jobs installed — `ff install-launchd`");
  else
    out.push(
      `launchd: ${String(r.launchd.installed.length)}/${String(r.launchd.installed.length + r.launchd.missing.length)} jobs installed${r.launchd.missing.length > 0 ? ` (missing: ${r.launchd.missing.join(", ")})` : ""} — \`ff doctor\` checks they are loaded`,
    );
  if (r.launchd.legacy.length > 0)
    out.push(
      `launchd: an earlier version's jobs are still installed (${r.launchd.legacy.join(", ")}) — \`ff install-launchd\` replaces them with refresh-due`,
    );
  for (const w of r.config.warnings) out.push(`warning: ${w}`);
  return out;
}

/** `ff status`. */
export async function status(
  io: CliIo,
  config: Config,
  log: Logger,
  opts: { readonly json: boolean; readonly factory?: StoreFactory },
): Promise<number> {
  const report = collectStatus(io, config, log, opts.factory);
  if (opts.json) await writeLine(io.stdout, JSON.stringify(report, null, 2));
  else for (const l of renderStatus(report)) await writeLine(io.stdout, l);
  return report.store.state === "error" ? EXIT.ERROR : EXIT.OK;
}
