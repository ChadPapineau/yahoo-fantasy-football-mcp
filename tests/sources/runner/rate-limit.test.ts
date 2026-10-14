// rate-limit.test.ts — an upstream rate limit is a pause, never a retry storm (plan 01 §6, §5.7):
// a 429 (or GitHub's 403 + Retry-After) is recorded as `rate_limited`, never `network`; a
// Retry-After longer than the run's retry cap is not waited out (one request); the provider is
// paused across processes in provider_backoff until now + max(Retry-After, 15 min × 2^(n−1)),
// capped at 2 h; a short Retry-After is honoured as the retry delay; a later success clears the
// pause. Real src/http client over a fake fetch; in-memory refresh log and backoff store.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rateLimitBackoffMs, RATE_LIMIT_BACKOFF_CAP_MS } from "../../../src/config/cadence.js";
import type {
  BackoffProvider,
  ProviderBackoffRow,
  RefreshLogRow,
} from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createHttpClient } from "../../../src/http/client.js";
import { HttpError } from "../../../src/http/errors.js";
import {
  fsTempArea,
  providerOf,
  runRefresh,
  type RefreshDeps,
} from "../../../src/sources/runner.js";
import { fakeFetch } from "../../http/helpers.js";
import { fakePublisher, fakeSchedules, fakeSource, okRow } from "./helpers.js";

const NOW = "2026-12-08T14:00:00.000Z";
const NOW_MS = Date.parse(NOW);
let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ff-429-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** An in-memory provider_backoff. */
function backoffStore(initial: ProviderBackoffRow[] = []): {
  rows: Map<BackoffProvider, ProviderBackoffRow>;
  cleared: BackoffProvider[];
  get(p: BackoffProvider): ProviderBackoffRow | null;
  set(r: ProviderBackoffRow): Promise<void>;
  clear(p: BackoffProvider): Promise<void>;
} {
  const rows = new Map(initial.map((r) => [r.provider, r]));
  const cleared: BackoffProvider[] = [];
  return {
    rows,
    cleared,
    get: (p) => rows.get(p) ?? null,
    set(r) {
      rows.set(r.provider, r);
      return Promise.resolve();
    },
    clear(p) {
      cleared.push(p);
      rows.delete(p);
      return Promise.resolve();
    },
  };
}

/** A refresh log that also counts failures since the last success (as the store does). */
function countingLog(initial: RefreshLogRow[] = []) {
  const rows = [...initial];
  return {
    rows,
    record(row: RefreshLogRow) {
      rows.push(row);
      return Promise.resolve();
    },
    current: () => rows.filter((r) => r.ok),
    consecutiveFailures(source: string) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r?.source !== source) continue;
        if (r.ok) break;
        n++;
      }
      return n;
    },
  };
}

function failRow(source: RefreshLogRow["source"]): RefreshLogRow {
  return { ...okRow(source, "v0"), ok: false, error: "rate_limited", file: null };
}

/** A source whose release check goes through the real client at `url`. */
function httpSource(url: string, id: RefreshLogRow["source"] = "nflverse:injuries") {
  return fakeSource({
    id,
    version: async (ctx) => {
      await ctx.http(url, { signal: ctx.signal, maxBytes: 256 });
      return { version: "2026-12-08T13:46:39Z", released_at: "2026-12-08T13:46:39.000Z" };
    },
  });
}

function deps(
  over: Partial<RefreshDeps>,
  status: () => Response,
): {
  d: RefreshDeps;
  calls: () => number;
  sleeps: number[];
} {
  const f = fakeFetch(status);
  const client = createHttpClient({ fetch: f.fetch });
  const sleeps: number[] = [];
  return {
    d: {
      http: client.get,
      download: client.download,
      clock: fixedClock(NOW),
      rng: seededRng(11),
      publisher: fakePublisher(),
      refreshLog: countingLog(),
      schedules: fakeSchedules([]),
      temp: fsTempArea(join(root, "tmp")),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      ...over,
    },
    calls: () => f.calls.length,
    sleeps,
  };
}

const TS = "https://github.com/nflverse/nflverse-data/releases/download/injuries/timestamp.txt";

describe("a 429 with a Retry-After past the retry cap", () => {
  for (const [label, status, headers] of [
    ["429", 429, { "retry-after": "3600" }],
    ["GitHub's 403 + Retry-After", 403, { "retry-after": "3600" }],
  ] as const)
    it(`${label}: one request, failed rate_limited, nflverse paused 1 h; the failure row says rate_limited`, async () => {
      const b = backoffStore();
      const log = countingLog();
      const { d, calls } = deps(
        { providerBackoff: b, refreshLog: log },
        () => new Response("slow down", { status, headers }),
      );
      const r = await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
      expect(r).toMatchObject({ status: "failed", error: "rate_limited", attempts: 1 });
      expect(calls()).toBe(1);
      expect(log.rows.map((x) => x.error)).toEqual(["rate_limited"]);
      expect(b.get("nflverse")).toEqual({
        provider: "nflverse",
        until_at: new Date(NOW_MS + 3_600_000).toISOString(),
        reason: "rate_limited",
        set_at: NOW,
      });
    });
});

describe("the pause length: max(Retry-After, 15 min × 2^(n−1)), capped at 2 h", () => {
  it("over any Retry-After and failure streak (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 31, max: 20_000 }), { nil: null }),
        fc.integer({ min: 0, max: 6 }),
        async (retryAfter, prior) => {
          const b = backoffStore();
          const log = countingLog(
            Array.from({ length: prior }, () => failRow("nflverse:injuries")),
          );
          const headers: Record<string, string> =
            retryAfter === null ? {} : { "retry-after": String(retryAfter) };
          const { d } = deps(
            { providerBackoff: b, refreshLog: log, retry: { maxAttempts: 1 } },
            () => new Response("", { status: 429, headers }),
          );
          await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
          const until = Date.parse(b.get("nflverse")?.until_at ?? "");
          const want = rateLimitBackoffMs(retryAfter, prior + 1);
          expect(until - NOW_MS).toBe(want);
          expect(until - NOW_MS).toBeLessThanOrEqual(RATE_LIMIT_BACKOFF_CAP_MS);
          expect(until - NOW_MS).toBeGreaterThanOrEqual(
            Math.min(RATE_LIMIT_BACKOFF_CAP_MS, Math.max((retryAfter ?? 0) * 1000, 15 * 60_000)),
          );
        },
      ),
      { numRuns: 60 },
    );
  });

  it("each provider is paused on its own (weather providers never pause nflverse)", () => {
    expect(providerOf("nflverse:schedules")).toBe("nflverse");
    expect(providerOf("nflverse:stats_player_week")).toBe("nflverse");
    expect(providerOf("weather:open_meteo")).toBe("weather:open_meteo");
    expect(providerOf("weather:nws")).toBe("weather:nws");
  });
});

describe("a short Retry-After inside the cap", () => {
  it("is retried after at least Retry-After; a success then clears the pause", async () => {
    let n = 0;
    const b = backoffStore([
      { provider: "nflverse", until_at: NOW, reason: "rate_limited", set_at: NOW },
    ]);
    const { d, calls, sleeps } = deps({ providerBackoff: b }, () =>
      ++n === 1
        ? new Response("", { status: 429, headers: { "retry-after": "2" } })
        : new Response("2026-12-08T13:46:39Z"),
    );
    const r = await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
    expect(r.status).toBe("published");
    expect(calls()).toBe(2);
    expect(sleeps.some((ms) => ms >= 2_000)).toBe(true);
    expect(b.get("nflverse")).toBeNull();
    expect(b.cleared).toEqual(["nflverse"]);
  });
});

describe("what never sets a pause", () => {
  it("a 503 without Retry-After, a DNS failure, a 404", async () => {
    for (const make of [
      () => new Response("", { status: 503 }),
      () => {
        throw new HttpError({ kind: "dns", host: "github.com" });
      },
      () => new Response("", { status: 404 }),
    ]) {
      const b = backoffStore();
      const { d } = deps({ providerBackoff: b, retry: { maxAttempts: 1 } }, make);
      const r = await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
      expect(r.status).toBe("failed");
      expect(b.rows.size).toBe(0);
    }
  });

  it("a 503 with a long Retry-After pauses as server_error and fails as network", async () => {
    const b = backoffStore();
    const { d, calls } = deps(
      { providerBackoff: b },
      () => new Response("", { status: 503, headers: { "retry-after": "900" } }),
    );
    const r = await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
    expect(r).toMatchObject({ status: "failed", error: "network" });
    expect(calls()).toBe(1);
    expect(b.get("nflverse")?.reason).toBe("server_error");
  });

  it("a store that cannot record the pause never changes the result", async () => {
    const { d } = deps(
      {
        providerBackoff: {
          get: () => null,
          set: () => Promise.reject(new Error("busy")),
          clear: () => Promise.reject(new Error("busy")),
        },
      },
      () => new Response("", { status: 429, headers: { "retry-after": "3600" } }),
    );
    const r = await runRefresh({ source: httpSource(TS), seasons: [2026], week: null }, d);
    expect(r).toMatchObject({ status: "failed", error: "rate_limited" });
  });
});
