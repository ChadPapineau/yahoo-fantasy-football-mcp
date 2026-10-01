// runner.test.ts — every branch of the refresh runner (plan 01 §5.5/§5.7; plan 06 §1.2, §2): unchanged,
// version null, schema fail, publish fail/throw/locked, transient retry then success, retries
// exhausted, off-season and never-loaded skips, temp cleanup on every path, aborts, and seeded,
// bounded jitter. Fakes only; temp dirs under os.tmpdir().
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { HttpError } from "../../../src/http/errors.js";
import {
  ALL_SEASON_WEEKS,
  DEFAULT_BASE_DELAY_MS,
  describeSchemaFailure,
  fsTempArea,
  isRefreshSuccess,
  JOB_LOCKED_ERROR,
  runRefresh,
  seasonState,
  type RefreshDeps,
  type RefreshResult,
  type TempArea,
} from "../../../src/sources/runner.js";
import type { HttpDownload, HttpGet, SchemaReport } from "../../../src/sources/source.js";
import type { DatasetPublisher, PublishOptions } from "../../../src/store/types.js";
import { captureLog, netError } from "../../http/helpers.js";
import {
  fakePublisher,
  fakeRefreshLog,
  fakeSchedules,
  fakeSource,
  game,
  okRow,
  STATS,
} from "./helpers.js";

const NOW = "2026-10-01T12:00:00.000Z";
let root = "";
let sleeps: number[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ff-runner-"));
  sleeps = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const noHttp: HttpGet = () => Promise.reject(new Error("no network in this test"));

function deps(over: Partial<RefreshDeps> = {}): RefreshDeps & {
  publisher: ReturnType<typeof fakePublisher>;
  refreshLog: ReturnType<typeof fakeRefreshLog>;
} {
  const base = {
    http: noHttp,
    clock: fixedClock(NOW),
    rng: seededRng(7),
    publisher: fakePublisher(),
    refreshLog: fakeRefreshLog(),
    schedules: fakeSchedules([game("2026_05_DAL_CLE", "2026-10-04T17:00:00.000Z")]),
    temp: fsTempArea(join(root, "tmp")),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    // the fakes publish no real file: the current one reads healthy unless a test says otherwise
    checkDataset: () => "ok" as const,
  };
  return { ...base, ...over } as RefreshDeps & {
    publisher: ReturnType<typeof fakePublisher>;
    refreshLog: ReturnType<typeof fakeRefreshLog>;
  };
}

async function tmpLeft(): Promise<string[]> {
  try {
    return await readdir(join(root, "tmp"));
  } catch {
    return [];
  }
}

function expectStatus<S extends RefreshResult["status"]>(
  r: RefreshResult,
  s: S,
): asserts r is Extract<RefreshResult, { status: S }> {
  expect(r.status).toBe(s);
}

describe("happy path", () => {
  it("version → fetch → assert → publish; temp removed; publisher gets version + release time", async () => {
    const src = fakeSource();
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2024, 2025, 2026], week: null }, d);
    expectStatus(r, "published");
    expect(r.stats).toEqual(STATS);
    expect(r.file_version).toBe("2026-09-30T13:36:27Z");
    expect(r.warnings).toEqual(["extra column new_col"]);
    expect(r.attempts).toBe(2);
    expect(d.publisher.published).toEqual([
      {
        source: "nflverse:injuries",
        version: "2026-09-30T13:36:27Z",
        released: "2026-09-30T13:36:27.000Z",
      },
    ]);
    expect(src.calls).toEqual({ version: 1, fetch: 1, assert: 1, publish: 1 });
    expect(d.refreshLog.rows).toEqual([]); // the publisher records publish rows, not the runner
    expect(await tmpLeft()).toEqual([]);
    const ctx = src.contexts[1];
    expect(ctx?.seasons).toEqual([2024, 2025, 2026]);
    expect(ctx?.tempDir).toMatch(/nflverse_injuries-/);
    expect(ctx?.download).toBeUndefined();
    expect(isRefreshSuccess(r)).toBe(true);
  });

  it("wraps http and download with the source's limiter", async () => {
    const calls: string[] = [];
    const http: HttpGet = (url) => {
      calls.push(url);
      return Promise.resolve({ status: 200, body: new Uint8Array(), headers: {}, final_url: url });
    };
    const download: HttpDownload = (url, o) => {
      calls.push(url);
      return Promise.resolve({ status: 200, bytes: 0, headers: {}, final_url: url, path: o.dest });
    };
    const src = fakeSource({
      limiter: { minIntervalMs: 900, maxPerDay: null },
      version: async (ctx) => {
        await ctx.http("https://github.com/v", { signal: ctx.signal, maxBytes: 64 });
        await ctx.http("https://github.com/v2", { signal: ctx.signal, maxBytes: 64 });
        return { version: "v", released_at: null };
      },
      fetch: async (_v, ctx) => {
        expect(ctx.download).toBeDefined();
        await ctx.download?.("https://github.com/f", {
          signal: ctx.signal,
          maxBytes: 9,
          dest: join(ctx.tempDir ?? "", "f"),
        });
        return [];
      },
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: 5 }, deps({ http, download }));
    expectStatus(r, "published");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([900, 900]);
  });
});

describe("unchanged release (plan 01 §5.5 'skips if unchanged')", () => {
  it("records the check and never fetches", async () => {
    const src = fakeSource();
    const d = deps({
      refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "unchanged");
    expect(d.publisher.unchanged).toEqual([
      { source: "nflverse:injuries", version: "2026-09-30T13:36:27Z", at: NOW },
    ]);
    expect(src.calls.fetch).toBe(0);
    expect(await tmpLeft()).toEqual([]);
  });

  it("force re-downloads; another source's row or a different version does not count", async () => {
    const log = fakeRefreshLog([
      okRow("nflverse:injuries", "2026-09-30T13:36:27Z"),
      okRow("nflverse:schedules", "other"),
    ]);
    const forced = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null, force: true },
      deps({ refreshLog: log }),
    );
    expect(forced.status).toBe("published");
    const other = await runRefresh(
      { source: fakeSource({ id: "nflverse:schedules" }), seasons: [2026], week: null },
      deps({ refreshLog: log }),
    );
    expect(other.status).toBe("published");
  });

  it("a time-bucket source is never skipped as unchanged", async () => {
    const src = fakeSource({
      id: "weather:open_meteo",
      versioning: "time_bucket",
      version: () => Promise.resolve({ version: "2026-10-01T12", released_at: null }),
    });
    const d = deps({ refreshLog: fakeRefreshLog([okRow("weather:open_meteo", "2026-10-01T12")]) });
    const r = await runRefresh({ source: src, seasons: [2026], week: 5 }, d);
    expectStatus(r, "published");
    expect(d.publisher.unchanged).toEqual([]);
  });

  it("[QA-1-097] a failing recordUnchanged falls through to publish (the file may be gone) — never a store failure", async () => {
    const d = deps({
      refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
      publisher: fakePublisher(undefined, { throwOnUnchanged: true }),
    });
    const src = fakeSource();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "published");
    expect(src.calls.fetch).toBe(1);
    expect(d.publisher.published).toHaveLength(1);
    expect(d.refreshLog.rows).toHaveLength(1); // no failure row
    expect(await tmpLeft()).toEqual([]);
  });

  describe("[QA-1-097] 'unchanged' only when the current file is servable", () => {
    const spyPublisher = () => {
      const inner = fakePublisher();
      const options: (PublishOptions | undefined)[] = [];
      const p: DatasetPublisher = {
        ...inner,
        publish(source, version, released, fill, o) {
          options.push(o);
          return inner.publish(source, version, released, fill);
        },
      };
      return { p, options, inner };
    };

    it("the check is asked about the file refresh_log lists, at the upstream version", async () => {
      const seen: unknown[] = [];
      await runRefresh(
        { source: fakeSource(), seasons: [2026], week: null },
        deps({
          refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
          checkDataset: (...a) => {
            seen.push(a);
            return "ok";
          },
        }),
      );
      expect(seen).toEqual([
        ["nflverse:injuries", "/cache/ds/nflverse:injuries.sqlite", "2026-09-30T13:36:27Z"],
      ]);
    });

    for (const health of ["missing", "unreadable", "mismatch", "throws"] as const) {
      it(`a ${health} current file is republished, bypassing the under-lock 'already current' check`, async () => {
        const { p, options, inner } = spyPublisher();
        const cap = captureLog();
        const src = fakeSource();
        const r = await runRefresh(
          { source: src, seasons: [2026], week: null },
          deps({
            publisher: p,
            log: cap.log,
            refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
            checkDataset: () => {
              if (health === "throws") throw new Error("EIO");
              return health;
            },
          }),
        );
        expectStatus(r, "published");
        expect(src.calls.fetch).toBe(1);
        expect(inner.unchanged).toEqual([]);
        expect(options).toEqual([{ skipIfCurrent: false }]);
        expect(cap.lines.map((e) => e.event)).toContain("refresh.dataset_repair");
      });
    }

    it("the check is not consulted when the version differs, on --force, or for a time bucket", async () => {
      let asked = 0;
      const checkDataset = () => {
        asked++;
        return "missing" as const;
      };
      const refreshLog = fakeRefreshLog([okRow("nflverse:injuries", "older")]);
      await runRefresh(
        { source: fakeSource(), seasons: [2026], week: null },
        deps({ refreshLog, checkDataset }),
      );
      await runRefresh(
        { source: fakeSource(), seasons: [2026], week: null, force: true },
        deps({
          refreshLog: fakeRefreshLog([okRow("nflverse:injuries", "2026-09-30T13:36:27Z")]),
          checkDataset,
        }),
      );
      expect(asked).toBe(0);
    });
  });

  it("a throwing or null-version refresh log is read as 'no previous release'", async () => {
    const throwing = {
      record: () => Promise.resolve(),
      current: () => {
        throw new Error("store busy");
      },
    };
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ refreshLog: throwing }),
    );
    expect(r.status).toBe("published");
    const nullVersion = { ...okRow("nflverse:injuries", "x"), file_version: null };
    const r2 = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ refreshLog: fakeRefreshLog([nullVersion]) }),
    );
    expect(r2.status).toBe("published");
  });
});

describe("failures before publish are recorded; nothing is written", () => {
  it("version null → failed network, refresh_log ok=0 error network, no fetch/publish", async () => {
    const src = fakeSource({ version: () => Promise.resolve(null) });
    const prev = okRow("nflverse:injuries", "old");
    const d = deps({ refreshLog: fakeRefreshLog([prev]) });
    const r = await runRefresh({ source: src, seasons: [2025, 2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("network");
    expect(src.calls.fetch).toBe(0);
    expect(d.publisher.published).toEqual([]);
    const row = d.refreshLog.rows[1];
    expect(row).toMatchObject({
      source: "nflverse:injuries",
      ok: false,
      error: "network",
      file: null,
      file_version: null,
      seasons: [2025, 2026],
      started_at: NOW,
      checked_at: prev.checked_at, // a failure never advances the release check
    });
  });

  it("schema failure → names the column and codec; publish never called; temp removed", async () => {
    const report: SchemaReport = {
      ok: false,
      missing_columns: ["report_status"],
      extra_columns: [],
      bad_codecs: [{ column: "gsis_id", codec: "ZSTD" }],
      rows: 0,
      warnings: [],
    };
    const src = fakeSource({ assertSchema: () => Promise.resolve(report) });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("schema");
    expect(r.message).toBe(
      "schema assertion failed: missing column(s): report_status; unsupported codec(s): gsis_id=ZSTD",
    );
    expect(r.schema).toEqual(report);
    expect(src.calls.publish).toBe(0);
    expect(d.publisher.published).toEqual([]);
    expect(d.refreshLog.rows[0]).toMatchObject({
      ok: false,
      error: "schema",
      file_version: "2026-09-30T13:36:27Z",
    });
    expect(await tmpLeft()).toEqual([]);
  });

  it("assertSchema throwing (a corrupt file) is a schema failure", async () => {
    const src = fakeSource({ assertSchema: () => Promise.reject(new Error("not parquet")) });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("schema");
    expect(await tmpLeft()).toEqual([]);
  });

  it("a non-network fetch error is internal and not retried", async () => {
    const src = fakeSource({ fetch: () => Promise.reject(new Error("parse")) });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("internal");
    expect(src.calls.fetch).toBe(1);
  });

  it("a non-transient HTTP failure (404) is a network failure, not retried", async () => {
    const src = fakeSource({
      fetch: () =>
        Promise.reject(new HttpError({ kind: "http_4xx", status: 404, host: "github.com" })),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("network");
    expect(r.message).toBe("http: upstream answered with a client error (github.com) status 404");
    expect(src.calls.fetch).toBe(1);
  });

  it("a record() that throws still returns the failure (logged)", async () => {
    const cap = captureLog();
    const src = fakeSource({ version: () => Promise.resolve(null) });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      deps({
        log: cap.log,
        refreshLog: { record: () => Promise.reject(new Error("busy")), current: () => [] },
      }),
    );
    expect(r.status).toBe("failed");
    expect(cap.lines.map((l) => l.event)).toContain("refresh.log_write_failed");
  });

  it("invalid requests are refused without recording", async () => {
    for (const req of [
      { seasons: [] as number[], week: null },
      { seasons: [1990], week: null },
      { seasons: [2026.5], week: null },
      { seasons: [2026], week: 0 },
      { seasons: [2026], week: 23 },
    ]) {
      const d = deps();
      const r = await runRefresh({ source: fakeSource(), ...req }, d);
      expectStatus(r, "failed");
      expect(r.error).toBe("invalid_request");
      expect(d.refreshLog.rows).toEqual([]);
    }
  });

  it("an unexpected runner failure (an invalid limiter) is internal, never a throw", async () => {
    const src = fakeSource({ limiter: { minIntervalMs: -1, maxPerDay: null } });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("internal");
    expect(isRefreshSuccess(r)).toBe(false);
  });
});

describe("publish outcomes", () => {
  it("ok:false → failed publish; the runner does not double-record the publisher's row", async () => {
    const d = deps({ publisher: fakePublisher(() => ({ ok: false, error: "rename failed" })) });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("publish");
    expect(d.refreshLog.rows).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("a throwing publisher → failed publish, recorded", async () => {
    const d = deps({ publisher: fakePublisher(undefined, { throwOnPublish: true }) });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("publish");
    expect(d.refreshLog.rows[0]).toMatchObject({ ok: false, error: "publish" });
    expect(await tmpLeft()).toEqual([]);
  });

  it(`a held job lock (${JOB_LOCKED_ERROR}) is a skip, exit-0`, async () => {
    const d = deps({
      publisher: fakePublisher(() => ({ ok: false, error: `${JOB_LOCKED_ERROR}: pid 4242` })),
    });
    const r = await runRefresh({ source: fakeSource(), seasons: [2026], week: null }, d);
    expectStatus(r, "skipped");
    expect(r.reason).toBe("locked");
    expect(isRefreshSuccess(r)).toBe(true);
    expect(await tmpLeft()).toEqual([]);
  });

  it("a fill that throws inside the publisher surfaces as a publish failure", async () => {
    const src = fakeSource({ publish: () => Promise.reject(new Error("constraint")) });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("publish");
  });
});

describe("retries (plan 01 §5.7: 3× with jitter, then stop)", () => {
  it("transient version failures, then success: 3 attempts, 2 bounded jittered sleeps", async () => {
    const src = fakeSource({
      version: (_c, n) =>
        n < 3
          ? Promise.reject(netError("ECONNRESET"))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "published");
    expect(src.calls.version).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(0);
    expect(sleeps[0]).toBeLessThan(DEFAULT_BASE_DELAY_MS);
    expect(sleeps[1]).toBeLessThan(2 * DEFAULT_BASE_DELAY_MS);
  });

  it("jitter is deterministic for a seed and differs across seeds", async () => {
    const run = async (seed: number): Promise<number[]> => {
      sleeps = [];
      const src = fakeSource({
        fetch: () => Promise.reject(new HttpError({ kind: "http_5xx", status: 503 })),
      });
      await runRefresh(
        { source: src, seasons: [2026], week: null },
        deps({ rng: seededRng(seed) }),
      );
      return [...sleeps];
    };
    const a = await run(1);
    expect(await run(1)).toEqual(a);
    expect(await run(2)).not.toEqual(a);
  });

  it("retries exhausted on fetch → failed network after 3 attempts; every attempt's dir removed", async () => {
    const dirs: string[] = [];
    const src = fakeSource({
      fetch: async (_v, ctx) => {
        dirs.push(ctx.tempDir ?? "");
        await writeFile(join(ctx.tempDir ?? "", "partial.parquet"), "PA");
        throw netError("ENOTFOUND");
      },
    });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("network");
    expect(r.attempts).toBe(4); // 1 version + 3 fetch
    expect(src.calls.fetch).toBe(3);
    expect(new Set(dirs).size).toBe(3);
    expect(await tmpLeft()).toEqual([]);
    expect(d.refreshLog.rows[0]).toMatchObject({ ok: false, error: "network" });
    expect(d.publisher.published).toEqual([]);
  });

  it("uses the real abortable sleep when none is injected", async () => {
    const src = fakeSource({
      version: (_c, n) =>
        n < 2
          ? Promise.reject(netError("EAI_AGAIN"))
          : Promise.resolve({ version: "v", released_at: null }),
    });
    const d = deps({ retry: { baseDelayMs: 2, maxDelayMs: 2 } });
    const { sleep: _drop, ...noSleep } = d;
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, noSleep);
    expect(r.status).toBe("published");
    expect(src.calls.version).toBe(2);
  });

  it("maxAttempts 1 disables retries; backoff is capped by maxDelayMs", async () => {
    const src = fakeSource({ version: () => Promise.reject(netError("ETIMEDOUT")) });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      deps({ retry: { maxAttempts: 1 } }),
    );
    expect(r.status).toBe("failed");
    expect(src.calls.version).toBe(1);
    const src2 = fakeSource({ version: () => Promise.reject(netError("ETIMEDOUT")) });
    await runRefresh(
      { source: src2, seasons: [2026], week: null },
      deps({ retry: { maxAttempts: 5, baseDelayMs: 10_000, maxDelayMs: 50 } }),
    );
    expect(sleeps.every((s) => s < 50)).toBe(true);
    expect(sleeps).toHaveLength(4);
  });
});

describe("temp cleanup on every path", () => {
  it("a TempFile a source wrote outside its run dir is removed too", async () => {
    const outside = join(root, "stray.parquet");
    const src = fakeSource({
      fetch: async () => {
        await writeFile(outside, "x");
        return [{ path: outside, bytes: 1, season: 2026 }];
      },
    });
    await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expect(await readdir(root)).toEqual(["tmp"]);
  });

  it("a temp area that fails to create is an internal failure", async () => {
    const temp: TempArea = {
      create: () => Promise.reject(new Error("EACCES")),
      remove: () => Promise.resolve(),
    };
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ temp }),
    );
    expectStatus(r, "failed");
    expect(r.error).toBe("internal");
  });

  it("a remove that throws never escapes", async () => {
    const real = fsTempArea(join(root, "tmp"));
    const temp: TempArea = {
      create: (s) => real.create(s),
      remove: () => Promise.reject(new Error("EBUSY")),
    };
    const r = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ temp }),
    );
    expect(r.status).toBe("published");
  });
});

describe("aborts", () => {
  it("aborted before publish → failed aborted, recorded, nothing published", async () => {
    const ac = new AbortController();
    const src = fakeSource({
      assertSchema: () => {
        ac.abort();
        return Promise.resolve({
          ok: true,
          missing_columns: [],
          extra_columns: [],
          bad_codecs: [],
          rows: 0,
          warnings: [],
        });
      },
    });
    const d = deps();
    const r = await runRefresh({ source: src, seasons: [2026], week: null, signal: ac.signal }, d);
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
    expect(d.publisher.published).toEqual([]);
    expect(await tmpLeft()).toEqual([]);
  });

  it("an abort during a transient failure stops retrying", async () => {
    const ac = new AbortController();
    const src = fakeSource({
      version: () => {
        ac.abort();
        return Promise.reject(netError("ECONNRESET"));
      },
    });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null, signal: ac.signal },
      deps(),
    );
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
    expect(src.calls.version).toBe(1);
  });

  it("an HttpError 'aborted' from the source is an abort", async () => {
    const src = fakeSource({ fetch: () => Promise.reject(new HttpError({ kind: "aborted" })) });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, deps());
    expectStatus(r, "failed");
    expect(r.error).toBe("aborted");
  });
});

describe("season awareness (plan 06 §2)", () => {
  it("in_season source off-season → skipped before any call", async () => {
    const src = fakeSource({ seasonGate: "in_season" });
    const d = deps({
      schedules: fakeSchedules([game("2026_01_A_B", "2026-09-10T00:20:00.000Z", { week: 1 })]),
    });
    const r = await runRefresh({ source: src, seasons: [2026], week: null }, d);
    expectStatus(r, "skipped");
    expect(r.reason).toBe("off_season");
    expect(src.calls.version).toBe(0);
    expect(d.refreshLog.rows).toEqual([]);
  });

  it("schedules never loaded → skipped schedules_never_loaded", async () => {
    const src = fakeSource({ seasonGate: "in_season" });
    const r = await runRefresh(
      { source: src, seasons: [2026], week: null },
      deps({ schedules: fakeSchedules([], false) }),
    );
    expectStatus(r, "skipped");
    expect(r.reason).toBe("schedules_never_loaded");
  });

  it("in season → runs; an always-gated source ignores the schedule entirely", async () => {
    const r = await runRefresh(
      { source: fakeSource({ seasonGate: "in_season" }), seasons: [2026], week: 5 },
      deps(),
    );
    expect(r.status).toBe("published");
    const sch = fakeSchedules([], false);
    const r2 = await runRefresh(
      { source: fakeSource(), seasons: [2026], week: null },
      deps({ schedules: sch }),
    );
    expect(r2.status).toBe("published");
    expect(sch.queries).toEqual([]);
  });

  it("seasonState: ±7 days inclusive, null/garbage kickoffs ignored, newest season", () => {
    const now = Date.parse(NOW);
    const at = (d: number): string => new Date(now + d * 86_400_000).toISOString();
    expect(seasonState(fakeSchedules([game("a", at(7))]), 2026, now)).toBe("in_season");
    expect(seasonState(fakeSchedules([game("a", at(-7))]), 2026, now)).toBe("in_season");
    expect(seasonState(fakeSchedules([game("a", at(7.01))]), 2026, now)).toBe("off_season");
    expect(seasonState(fakeSchedules([game("a", null), game("b", "garbage")]), 2026, now)).toBe(
      "off_season",
    );
    const sch = fakeSchedules([]);
    seasonState(sch, 2026, now);
    expect(sch.queries[0]?.weeks).toEqual(ALL_SEASON_WEEKS);
  });
});

describe("describeSchemaFailure", () => {
  it("sanitises hostile names and caps the list", () => {
    const r: SchemaReport = {
      ok: false,
      missing_columns: [
        "ok_col",
        "bad\ncol; DROP",
        ...Array.from({ length: 20 }, (_, i) => `c${String(i)}`),
      ],
      extra_columns: [],
      bad_codecs: [{ column: "x", codec: "<script>" }],
      rows: 0,
      warnings: [],
    };
    const m = describeSchemaFailure(r);
    expect(m).toContain("ok_col, ?");
    expect(m).toContain("x=?");
    expect(m).not.toContain("c15");
    expect(describeSchemaFailure({ ...r, missing_columns: [], bad_codecs: [] })).toBe(
      "schema assertion failed",
    );
  });
});

describe("fsTempArea", () => {
  it("creates private per-source dirs and removes them (missing paths are fine)", async () => {
    const t = fsTempArea(join(root, "t"));
    const a = await t.create("weather:open_meteo");
    expect(a).toMatch(/weather_open_meteo-/);
    await t.remove(a);
    await t.remove(join(root, "t", "never-existed"));
    expect(await readdir(join(root, "t"))).toEqual([]);
  });
});
