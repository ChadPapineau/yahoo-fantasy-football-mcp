// refresh-sim.ts — an in-memory refresh_log + season_check + attachment, written exactly as one
// `ff refresh` run writes them (src/sources/runner.ts with the store's publisher), so a simulation of
// ticks and answer-time refreshes reads each source's state through the production
// `sourceStateOf` (src/mcp/refresh.ts) instead of tracking `lastAttemptMs` by hand. Every write is
// stamped with the run's START instant except what really happens later (a publish's finish):
//   published     — a refresh_log row: started_at = start, finished_at = checked_at = end; the file
//                   is attached at its new version; a `published` season_check per season it holds;
//   unchanged     — the current row's checked_at moves to start (a copy row when failures followed it);
//   failed        — a failure row: started_at = start, finished_at = end, checked_at unchanged;
//   not_published — NO refresh_log row (QA-1-037), a `not_published` season_check per season at start,
//                   and the failure streak ended (a copy of the current row when failures followed it).
import type { DatasetSourceId } from "../../../src/config/freshness.js";
import type {
  RefreshLogRow,
  SeasonCheckRow,
  StoreStats,
} from "../../../src/domain/analytics/types.js";
import type { SourceStatePorts } from "../../../src/mcp/refresh.js";

const iso = (ms: number): string => new Date(ms).toISOString();

/** One simulated store shared by every simulated process (indexed: replays write thousands of rows). */
export class RefreshSim {
  readonly rows: RefreshLogRow[] = [];
  readonly checks = new Map<string, SeasonCheckRow>();
  private readonly attached = new Map<DatasetSourceId, string>();
  private readonly cur = new Map<DatasetSourceId, RefreshLogRow>();
  private readonly last = new Map<DatasetSourceId, RefreshLogRow>();
  private readonly fails = new Map<DatasetSourceId, number>();
  private versions = 0;

  /** The ports `sourceStateOf` reads (no provider backoff). */
  readonly ports: SourceStatePorts = {
    refreshLog: {
      current: () => [...this.cur.values()],
      latest: (s) => this.last.get(s) ?? null,
      consecutiveFailures: (s) => this.fails.get(s) ?? 0,
    },
    providerBackoff: { get: () => null },
    seasonChecks: { all: () => [...this.checks.values()] },
    storeStats: (): StoreStats => ({
      path: "sim",
      size_bytes: 0,
      schema_version: 3,
      cache_misses_busy: 0,
      attached: [...this.attached].map(([source, file_version]) => ({
        source,
        schema: "s",
        file: "f",
        file_version,
        inode: 1,
        mtime_ms: 0,
        size_bytes: 1,
        attached_at: "2000-01-01T00:00:00.000Z",
      })),
    }),
  };

  current(source: DatasetSourceId): RefreshLogRow | null {
    return this.cur.get(source) ?? null;
  }

  private push(row: RefreshLogRow): void {
    this.rows.push(row);
    this.last.set(row.source, row);
    if (row.ok) {
      this.cur.set(row.source, row);
      this.fails.set(row.source, 0);
    } else this.fails.set(row.source, (this.fails.get(row.source) ?? 0) + 1);
  }

  private note(
    source: DatasetSourceId,
    seasons: readonly number[],
    at: number,
    status: SeasonCheckRow["status"],
  ): void {
    for (const season of seasons)
      this.checks.set(`${source}|${String(season)}`, {
        source,
        season,
        checked_at: iso(at),
        status,
      });
  }

  /** A publish of `seasons` started at `start`, finished at `end`. Returns the file version. */
  published(
    source: DatasetSourceId,
    start: number,
    end: number,
    seasons: readonly number[],
    version = `v${String(++this.versions)}`,
  ): string {
    this.push({
      source,
      file: `ds/${source}.sqlite`,
      file_version: version,
      release_updated_at: iso(start - 3_600_000),
      seasons: [...seasons],
      rows: 10,
      columns_hash: "h",
      started_at: iso(start),
      finished_at: iso(end),
      ok: true,
      error: null,
      checked_at: iso(end),
    });
    this.attached.set(source, version);
    this.note(source, seasons, start, "published");
    return version;
  }

  /** The release re-checked at `start`, unchanged (a publish when nothing is current yet). */
  unchanged(source: DatasetSourceId, start: number, end: number, seasons: readonly number[]): void {
    const cur = this.current(source);
    if (cur === null) {
      this.published(source, start, end, seasons);
      return;
    }
    const moved = { ...cur, checked_at: iso(start) };
    if ((this.fails.get(source) ?? 0) > 0) this.push(moved);
    else {
      this.rows[this.rows.lastIndexOf(cur)] = moved;
      this.cur.set(source, moved);
      if (this.last.get(source) === cur) this.last.set(source, moved);
    }
  }

  /** A failed run. */
  failed(source: DatasetSourceId, start: number, end: number): void {
    this.push({
      source,
      file: null,
      file_version: null,
      release_updated_at: null,
      seasons: [],
      rows: null,
      columns_hash: null,
      started_at: iso(start),
      finished_at: iso(end),
      ok: false,
      error: "network",
      checked_at: this.current(source)?.checked_at ?? iso(start),
    });
  }

  /** A run whose every season upstream has not published yet. */
  notPublished(source: DatasetSourceId, start: number, seasons: readonly number[]): void {
    this.note(source, seasons, start, "not_published");
    const cur = this.current(source);
    if (cur !== null && (this.fails.get(source) ?? 0) > 0) this.push({ ...cur });
  }
}
