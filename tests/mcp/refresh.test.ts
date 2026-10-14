// refresh.test.ts — src/mcp/refresh.ts (season-fresh spec §6.4): the fixed warnings a refresh
// report adds (silent when the refresh landed or nothing was needed; one line per in-progress,
// joined, failed, backoff or throttled source naming the release the answer used), the source state
// the orchestrator and G1 share, and the tick grid.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DatasetSourceId } from "../../src/config/freshness.js";
import type {
  RefreshLogRow,
  SeasonCheckRow,
  StoreStats,
} from "../../src/domain/analytics/types.js";
import {
  RESTART_CLIENT_WARNING,
  SPAWN_FAILED_WARNING,
  dueSourceOf,
  nextTickAt,
  providerOf,
  refreshWarnings,
  sourceStateOf,
} from "../../src/mcp/refresh.js";
import {
  REFRESH_OUTCOME_CODES,
  REFRESH_OUTCOMES,
  type RefreshReport,
  type RefreshSourceReport,
} from "../../src/mcp/services.js";

const NOW = Date.parse("2027-11-28T17:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

function row(source: DatasetSourceId, checkedAgoMs: number, ok = true): RefreshLogRow {
  return {
    source,
    file: ok ? "f" : null,
    file_version: ok ? "v1" : null,
    release_updated_at: iso(NOW - 2 * 86_400_000),
    seasons: [2027],
    rows: ok ? 10 : null,
    columns_hash: ok ? "h" : null,
    started_at: iso(NOW - checkedAgoMs - 1000),
    finished_at: iso(NOW - checkedAgoMs),
    ok,
    error: ok ? null : "network",
    checked_at: iso(NOW - checkedAgoMs),
  };
}

const logOf = (rows: RefreshLogRow[]) => ({
  current: () => rows.filter((r) => r.ok),
  latest: (s: DatasetSourceId) => rows.filter((r) => r.source === s).at(-1) ?? null,
  consecutiveFailures: (s: DatasetSourceId) => {
    let n = 0;
    for (const r of rows.filter((x) => x.source === s).reverse()) {
      if (r.ok) break;
      n += 1;
    }
    return n;
  },
});

const rep = (sources: Partial<RefreshSourceReport>[]): RefreshReport => ({
  mode: "wait",
  sources: sources.map((s) => ({
    source: "nflverse:injuries",
    outcome: "updated",
    code: null,
    started_at: iso(NOW - 6_000),
    at: iso(NOW),
    next_retry_at: null,
    ...s,
  })),
});

describe("refreshWarnings", () => {
  const services = {
    refreshLog: logOf([
      row("nflverse:injuries", 2 * 3_600_000),
      row("nflverse:stats_player_week", 7 * 3_600_000),
    ]),
  };

  it("silent without a report, and for updated / revalidated / skipped", () => {
    expect(refreshWarnings(null, services, NOW)).toEqual([]);
    expect(
      refreshWarnings(
        rep([
          { outcome: "updated" },
          { outcome: "revalidated" },
          { outcome: "skipped", code: "not_published" },
        ]),
        services,
        NOW,
      ),
    ).toEqual([]);
  });

  it("a fast source still refreshing names the release the answer used", () => {
    expect(refreshWarnings(rep([{ outcome: "in_progress" }]), services, NOW)).toEqual([
      "refreshing nflverse:injuries in the background (started 6s ago); this answer uses the release checked 2h ago — ask again in a minute for newer data",
    ]);
  });

  it("a slow source revalidated behind a loaded release is silent; one never loaded is not", () => {
    expect(
      refreshWarnings(
        rep([{ source: "nflverse:stats_player_week", outcome: "in_progress" }]),
        services,
        NOW,
      ),
    ).toEqual([]);
    expect(
      refreshWarnings(
        rep([{ source: "nflverse:roster_weekly", outcome: "in_progress" }]),
        services,
        NOW,
      )[0],
    ).toContain("no release of it is loaded yet");
  });

  it("failed, version, spawn, backoff, throttled and joined each have their fixed line", () => {
    const w = refreshWarnings(
      rep([
        { outcome: "failed", code: "network" },
        { source: "nflverse:schedules", outcome: "failed", code: "version" },
        { source: "weather:open_meteo", outcome: "failed", code: "spawn" },
        {
          source: "nflverse:stats_player_week",
          outcome: "backoff",
          code: "rate_limited",
          next_retry_at: iso(NOW + 1_800_000),
        },
        { source: "nflverse:roster_weekly", outcome: "throttled" },
        { source: "nflverse:injuries", outcome: "joined", code: "locked" },
      ]),
      services,
      NOW,
    );
    expect(w).toContain(
      "could not refresh nflverse:injuries (network); this answer uses the release checked 2h ago",
    );
    expect(w).toContain(RESTART_CLIENT_WARNING);
    expect(w).toContain(SPAWN_FAILED_WARNING);
    expect(w).toContain(
      `not retrying nflverse:stats_player_week until ${iso(NOW + 1_800_000)} (rate_limited); this answer uses the release checked 7h ago`,
    );
    expect(w.some((l) => l.startsWith("not refreshing nflverse:roster_weekly now"))).toBe(true);
    expect(w.some((l) => l.startsWith("another ff refresh is updating nflverse:injuries"))).toBe(
      true,
    );
  });

  it("any report: lines are fixed vocabulary, ≤ 400 chars, deduplicated", () => {
    const src = fc.constantFrom<DatasetSourceId>(
      "nflverse:schedules",
      "nflverse:injuries",
      "nflverse:roster_weekly",
      "nflverse:stats_player_week",
      "weather:open_meteo",
      "weather:nws",
    );
    const one = fc.record({
      source: src,
      outcome: fc.constantFrom(...REFRESH_OUTCOMES),
      code: fc.constantFrom(...REFRESH_OUTCOME_CODES, null),
      started_at: fc.option(fc.integer({ min: 0, max: 600_000 }).map((d) => iso(NOW - d))),
      at: fc.constant(iso(NOW)),
      next_retry_at: fc.option(fc.integer({ min: 0, max: 7_200_000 }).map((d) => iso(NOW + d))),
    });
    fc.assert(
      fc.property(fc.array(one, { minLength: 1, maxLength: 8 }), (sources) => {
        const w = refreshWarnings({ mode: "wait", sources }, services, NOW);
        expect(new Set(w).size).toBe(w.length);
        for (const l of w) {
          expect(l.length).toBeLessThanOrEqual(400);
          expect(l).toMatch(/^[\x20-\x7e—]+$/);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("sourceStateOf (the orchestrator, G1 and the tick read a source alike)", () => {
  const stats =
    (attached: [DatasetSourceId, string][]): (() => StoreStats) =>
    () => ({
      path: "x",
      size_bytes: 0,
      schema_version: 3,
      cache_misses_busy: 0,
      attached: attached.map(([source, file_version]) => ({
        source,
        schema: "s",
        file: "f",
        file_version,
        inode: 1,
        mtime_ms: 0,
        size_bytes: 1,
        attached_at: iso(NOW),
      })),
    });
  it("never loaded, unreadable (not attached at its version), ok; attempts from every process", () => {
    const backoff = { get: () => null };
    expect(
      sourceStateOf(
        {
          refreshLog: logOf([]),
          providerBackoff: backoff,
          seasonChecks: { all: () => [] },
          storeStats: stats([]),
        },
        "nflverse:injuries",
        NOW,
        2027,
      ).state.file,
    ).toBe("never_loaded");
    const rows = [row("nflverse:injuries", 3_600_000), row("nflverse:injuries", 60_000, false)];
    const un = sourceStateOf(
      {
        refreshLog: logOf(rows),
        providerBackoff: backoff,
        seasonChecks: { all: () => [] },
        storeStats: stats([["nflverse:injuries", "v0"]]),
      },
      "nflverse:injuries",
      NOW,
      2027,
    );
    expect(un.state.file).toBe("unreadable");
    // the failed run a minute ago is the last attempt (the 14-minute floor counts it)
    expect(un.state.lastAttemptMs).toBe(NOW - 61_000);
    expect(un.state.consecutiveFailures).toBe(1);
    const ok = sourceStateOf(
      {
        refreshLog: logOf([row("nflverse:injuries", 3_600_000)]),
        providerBackoff: {
          get: (p) =>
            p === "nflverse"
              ? {
                  provider: "nflverse",
                  until_at: iso(NOW + 600_000),
                  reason: "rate_limited",
                  set_at: iso(NOW),
                }
              : null,
        },
        seasonChecks: { all: () => [] },
        storeStats: stats([["nflverse:injuries", "v1"]]),
      },
      "nflverse:injuries",
      NOW,
      2027,
    );
    expect(ok.state.file).toBe("ok");
    expect(ok.state.backoffUntilMs).toBe(NOW + 600_000);
  });
  it("a season check is an attempt; the phase season not published since the last refresh_log attempt is `notPublishedAtMs`", () => {
    // a not_published run writes no refresh_log row, only season_check rows: without counting them
    // the 14-minute floor and the cadence never saw the attempt (the tick re-polled every 15 min)
    const backoff = { get: () => null };
    for (const S of [2026, 2027, 2028, 2029, 2030]) {
      const fileOf = (seasons: number[]): RefreshLogRow => ({
        ...row("nflverse:injuries", 9 * 86_400_000),
        seasons,
      });
      const at = (agoMs: number): string => iso(NOW - agoMs);
      const state = (
        rows: RefreshLogRow[],
        checks: SeasonCheckRow[],
        season = S,
      ): ReturnType<typeof sourceStateOf>["state"] =>
        sourceStateOf(
          {
            refreshLog: logOf(rows),
            providerBackoff: backoff,
            seasonChecks: { all: () => checks },
            storeStats: stats(rows.length === 0 ? [] : [["nflverse:injuries", "v1"]]),
          },
          "nflverse:injuries",
          NOW,
          season,
        ).state;
      const np = (
        season: number,
        agoMs: number,
        source: DatasetSourceId = "nflverse:injuries",
      ) => ({
        source,
        season,
        checked_at: at(agoMs),
        status: "not_published" as const,
      });
      const old = [fileOf([S - 1])];
      // the old season's file, the phase season not published a minute ago
      const s1 = state(old, [np(S, 60_000)]);
      expect(s1.lastAttemptMs, String(S)).toBe(NOW - 60_000);
      expect(s1.notPublishedAtMs, String(S)).toBe(NOW - 60_000);
      // never loaded at all: the same
      const s0 = state([], [np(S, 60_000)]);
      expect(s0.file).toBe("never_loaded");
      expect(s0.notPublishedAtMs).toBe(NOW - 60_000);
      // another source's or another season's check is no not_published state for this one
      expect(
        state(old, [np(S, 60_000, "nflverse:stats_player_week")]).lastAttemptMs,
      ).toBeLessThanOrEqual(NOW - 9 * 86_400_000);
      const other = state(old, [np(S + 1, 60_000)]);
      expect(other.lastAttemptMs).toBe(NOW - 60_000); // still an attempt (the floor counts it)
      expect(other.notPublishedAtMs).toBeNull();
      // the phase season published since, or a refresh_log attempt at or after the check (a run that
      // published or re-checked the other seasons at the same start): no not_published state
      expect(state(old, [{ ...np(S, 60_000), status: "published" }]).notPublishedAtMs).toBeNull();
      const mixed = {
        ...fileOf([S - 1]),
        started_at: at(60_000),
        finished_at: at(30_000),
        checked_at: at(30_000),
      };
      expect(state([mixed], [np(S, 60_000)]).notPublishedAtMs).toBeNull();
      const failedAfter = { ...row("nflverse:injuries", 10_000, false) };
      expect(state([...old, failedAfter], [np(S, 60_000)]).notPublishedAtMs).toBeNull();
      // the file holds the phase season (upstream withdrew it): judged as before
      expect(state([fileOf([S - 1, S])], [np(S, 60_000)]).notPublishedAtMs).toBeNull();
    }
  });
  it("providers and due sources", () => {
    expect(providerOf("weather:nws")).toBe("weather:nws");
    expect(providerOf("nflverse:schedules")).toBe("nflverse");
    expect(dueSourceOf("weather:open_meteo")).toBe("weather");
    expect(dueSourceOf("nflverse:injuries")).toBe("nflverse:injuries");
  });
});

describe("nextTickAt", () => {
  it("is the first UTC quarter-hour at or after the instant, in every year", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Date.parse("2026-01-01"), max: Date.parse("2031-01-01") }),
        (ms) => {
          const t = nextTickAt(ms);
          expect(t % 900_000).toBe(0);
          expect(t).toBeGreaterThanOrEqual(ms);
          expect(t - ms).toBeLessThan(900_000);
        },
      ),
    );
  });
});
