// status.ts — `ff status [--json]`, the terminal dashboard (plan 01 §7 `ff status` snapshot; plan 06
// J2 "`ff status` is the dashboard", §3 "any source past its hard limit; pending journal rows; jobs
// not loaded"). Reads only: the store is opened without creating or migrating it. Per source: last
// success, last error, age judged by the class's basis (stampState), consecutive failures, the
// attached file. Exit 0 whenever the report was produced; 1 only when the store cannot be read.
import { lstatSync } from "node:fs";
import {
  freshnessClass,
  SOURCE_REGISTRY,
  stampState,
  type DatasetSourceId,
  type FreshnessState,
} from "../config/freshness.js";
import { datasetFilePath, storePath } from "../config/paths.js";
import type { Config } from "../config/schema.js";
import type { RefreshLogRow } from "../domain/analytics/types.js";
import { MIGRATIONS } from "../store/index.js";
import type { Store, StoreFactory } from "../store/types.js";
import { VERSION } from "../version.js";
import { EXIT } from "./exit.js";
import { writeLine, type CliIo } from "./io.js";
import { installedPlists, JOBS } from "./launchd.js";
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
  /** `never_loaded` when no successful refresh exists. */
  readonly state: FreshnessState | "never_loaded";
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
}

/** Judges one source from its refresh_log rows. */
export function sourceStatus(
  source: DatasetSourceId,
  current: RefreshLogRow | null,
  latest: RefreshLogRow | null,
  failures: number,
  cacheDir: string,
  nowMs: number,
): SourceStatus {
  const cls = freshnessClass(SOURCE_REGISTRY[source].freshness);
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
  };
  if (current === null) {
    return {
      ...base,
      state: "never_loaded",
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
  );
  return {
    ...base,
    state: fileBytes === null ? "never_loaded" : judged.state,
    age_s: judged.age_s,
    basis_at: judged.basis_at,
    file_version: current.file_version,
    rows: current.rows,
    seasons: current.seasons,
    last_success_at: current.finished_at,
  };
}

/** Every source's status from an open store. */
export function sourceStatuses(store: Store, config: Config, nowMs: number): SourceStatus[] {
  const rl = store.repos.refreshLog;
  const current = rl.current();
  return configuredSources(config).map((s) =>
    sourceStatus(
      s,
      current.find((r) => r.source === s && r.ok) ?? null,
      rl.latest(s),
      rl.consecutiveFailures(s),
      config.cacheDir,
      nowMs,
    ),
  );
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
  readonly journal: {
    readonly counts: Readonly<Record<string, number>>;
    readonly oldest_pending_age_s: number | null;
  } | null;
  readonly launchd: {
    readonly supported: boolean;
    readonly installed: readonly string[];
    readonly missing: readonly string[];
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
    const sources =
      ex.kind === "open"
        ? sourceStatuses(ex.store, config, now)
        : configuredSources(config).map((s) =>
            sourceStatus(s, null, null, 0, config.cacheDir, now),
          );
    const journal =
      ex.kind === "open"
        ? {
            counts: { ...ex.store.repos.writeJournal.countByStatus() } as Record<string, number>,
            oldest_pending_age_s: ex.store.repos.writeJournal.oldestPendingAgeSeconds(
              io.clock.nowIso(),
            ),
          }
        : null;
    const installed = installedPlists(io.home).map((p) => p.job);
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
      journal,
      launchd: {
        supported: io.platform === "darwin",
        installed,
        missing: JOBS.map((j) => j.name).filter((j) => !installed.includes(j)),
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
};

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
    out.push("launchd: not available on this platform (schedule `ff refresh` yourself)");
  else if (r.launchd.installed.length === 0)
    out.push("launchd: no jobs installed — `ff install-launchd`");
  else
    out.push(
      `launchd: ${String(r.launchd.installed.length)}/${String(r.launchd.installed.length + r.launchd.missing.length)} jobs installed${r.launchd.missing.length > 0 ? ` (missing: ${r.launchd.missing.join(", ")})` : ""} — \`ff doctor\` checks they are loaded`,
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
