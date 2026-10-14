// refresh.ts — what a result says about its answer-time refresh (season-fresh spec §6.4): the fixed
// warnings for a refresh still running, one that failed, a backoff and the throttle, each naming the
// release the answer used ("checked <age> ago"); and the per-call lookup the dataset helpers use to
// pick the STALE_ONLY variant (refresh_in_progress / refresh_failed). Fixed vocabulary only: source
// ids, outcome codes, ages and ISO instants — never child or upstream text.
import {
  ON_DEMAND_TIER,
  TICK_MS,
  dueDecision,
  weatherBucketMs,
  type DueDecision,
  type DueSource,
  type SourceState,
} from "../config/cadence.js";
import type { GameCalendar } from "../config/game-calendar.js";
import type { DatasetSourceId, StampInstants } from "../config/freshness.js";
import type {
  BackoffProvider,
  ProviderBackoffRepository,
  RefreshLogRepository,
  RefreshLogRow,
  StoreStats,
} from "../domain/analytics/types.js";
import { humanAge } from "./envelope.js";
import type { McpServices, RefreshReport, RefreshSourceReport } from "./services.js";

/** The due source a dataset source is refreshed as (`weather:*` → `weather`). */
export function dueSourceOf(id: DatasetSourceId): DueSource | null {
  switch (id) {
    case "nflverse:schedules":
    case "nflverse:injuries":
    case "nflverse:roster_weekly":
    case "nflverse:stats_player_week":
      return id;
    case "weather:open_meteo":
    case "weather:nws":
      return "weather";
    default:
      return null;
  }
}

/** The provider whose persisted 429 / Retry-After backoff gates a source. */
export function providerOf(id: DatasetSourceId): BackoffProvider {
  return id === "weather:open_meteo" || id === "weather:nws" ? id : "nflverse";
}

/** The instants a current refresh_log row's file is judged from (as G1 and `ff status` judge them). */
export function basisOf(row: RefreshLogRow): StampInstants {
  return {
    as_of: row.release_updated_at ?? row.finished_at,
    fetched_at: row.finished_at,
    checked_at: row.checked_at,
  };
}

const msOrNull = (iso: string | null | undefined): number | null => {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/** The read-only store ports a source's refresh state is read from. */
export interface SourceStatePorts {
  readonly refreshLog: Pick<RefreshLogRepository, "current" | "latest" | "consecutiveFailures">;
  readonly providerBackoff: Pick<ProviderBackoffRepository, "get">;
  readonly storeStats: () => StoreStats;
}

/**
 * A source's refresh state (src/config/cadence.ts `SourceState`) from refresh_log, the attachment
 * and the provider backoff — the one reading the answer-time orchestrator, G1 and the tick share:
 * a current file the server has not attached at its version is `unreadable` (QA-1-038); the last
 * attempt counts every process's runs (the 14-minute floor holds across processes).
 */
export function sourceStateOf(
  ports: SourceStatePorts,
  id: DatasetSourceId,
  nowMs: number,
): { readonly state: SourceState; readonly current: RefreshLogRow | null } {
  const current = ports.refreshLog.current().find((r) => r.source === id) ?? null;
  const attached = ports.storeStats().attached.find((a) => a.source === id);
  const latest = ports.refreshLog.latest(id);
  const file: SourceState["file"] =
    current === null
      ? "never_loaded"
      : current.file_version === null || attached?.file_version !== current.file_version
        ? "unreadable"
        : "ok";
  const attempts = [msOrNull(latest?.started_at), msOrNull(current?.checked_at)].filter(
    (x): x is number => x !== null,
  );
  const backoff = msOrNull(ports.providerBackoff.get(providerOf(id))?.until_at);
  return {
    current,
    state: {
      file,
      basis: current === null ? null : basisOf(current),
      lastAttemptMs: attempts.length === 0 ? null : Math.max(...attempts),
      consecutiveFailures: ports.refreshLog.consecutiveFailures(id),
      backoffUntilMs: backoff !== null && backoff > nowMs ? backoff : null,
    },
  };
}

/** The tick's decision for a source now (G1 `next_check_at`); null for a source the tick skips. */
export function tickDecisionOf(
  ports: SourceStatePorts,
  id: DatasetSourceId,
  cal: GameCalendar,
  nowMs: number,
  weatherHorizonHours: number,
): DueDecision | null {
  const due = dueSourceOf(id);
  if (due === null) return null;
  const { state, current } = sourceStateOf(ports, id, nowMs);
  return dueDecision({
    source: due,
    nowMs,
    cal,
    state,
    ...(due === "weather"
      ? {
          weather: {
            lastBucketMs:
              current?.file_version == null ? null : weatherBucketMs(current.file_version),
            horizonHours: weatherHorizonHours,
          },
        }
      : {}),
  });
}

/** The first tick (UTC quarter-hour) at or after `ms`. */
export function nextTickAt(ms: number): number {
  return Math.ceil(ms / TICK_MS) * TICK_MS;
}

/** The warning when the installed `ff` refused the child (`--expect-version` / `--no-migrate`). */
export const RESTART_CLIENT_WARNING =
  "restart the client: the installed ff no longer matches this server";
/** The warning when the child could not be started at all (a sandbox, a missing binary). */
export const SPAWN_FAILED_WARNING =
  "answers use the stored releases: this server could not start ff refresh (spawn), so it does not refresh at answer time until it restarts";

const ageSince = (iso: string | null | undefined, nowMs: number): string | null => {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? humanAge(Math.max(0, Math.floor((nowMs - ms) / 1000))) : null;
};

/** "this answer uses the release checked <age> ago" (or that none is loaded yet). */
function usedRelease(checked: string | null): string {
  return checked === null
    ? "no release of it is loaded yet"
    : `this answer uses the release checked ${checked} ago`;
}

/**
 * The fixed warnings of a refresh report (§6.4). Silent for `updated`, `revalidated`, `skipped` and
 * for a slow source's background revalidation (by design it never holds an answer); one line for a
 * fast source still refreshing, another process's refresh, a failure, a backoff or the throttle.
 */
export function refreshWarnings(
  report: RefreshReport | null,
  services: Pick<McpServices, "refreshLog">,
  nowMs: number,
): string[] {
  if (report === null) return [];
  const current = new Map(services.refreshLog.current().map((r) => [r.source, r]));
  const out: string[] = [];
  const add = (w: string): void => {
    if (!out.includes(w)) out.push(w);
  };
  for (const s of report.sources) {
    const checked = ageSince(current.get(s.source)?.checked_at, nowMs);
    const due = dueSourceOf(s.source);
    switch (s.outcome) {
      case "in_progress":
        if (due !== null && ON_DEMAND_TIER[due] === "slow" && checked !== null) break;
        add(
          `refreshing ${s.source} in the background (started ${ageSince(s.started_at, nowMs) ?? "0s"} ago); ${usedRelease(checked)} — ask again in a minute for newer data`,
        );
        break;
      case "joined":
        add(
          `another ff refresh is updating ${s.source} (started ${ageSince(s.started_at, nowMs) ?? "0s"} ago); ${usedRelease(checked)} — ask again in a minute for newer data`,
        );
        break;
      case "failed":
        if (s.code === "version" || s.code === "migration") add(RESTART_CLIENT_WARNING);
        else if (s.code === "spawn") add(SPAWN_FAILED_WARNING);
        else
          add(`could not refresh ${s.source} (${s.code ?? "internal"}); ${usedRelease(checked)}`);
        break;
      case "backoff":
        add(
          `not retrying ${s.source} until ${s.next_retry_at ?? "later"} (${s.code ?? "failure_backoff"}); ${usedRelease(checked)}`,
        );
        break;
      case "throttled":
        add(
          `not refreshing ${s.source} now (answer-time refresh limit reached); ${usedRelease(checked)}`,
        );
        break;
      case "updated":
      case "revalidated":
      case "skipped":
        break;
    }
  }
  return out;
}

/** This call's refresh row for a source, or null. */
export function refreshRowOf(
  report: RefreshReport | null,
  source: DatasetSourceId,
): RefreshSourceReport | null {
  return report?.sources.find((s) => s.source === source) ?? null;
}
