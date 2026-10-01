// release.test.ts — timestamp.txt versioning and release downloads (plan 01 §5.5; plan 05 §2
// `sources/*`): parsing, the version contract (null = unreachable, a garbled stamp fails loudly),
// abort propagation, and the download path through HttpGet or the runner's HttpDownload.
import { existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RELEASE_FILE_BYTES,
  NflverseSourceError,
  SEASON_PUBLISH_GRACE_DAYS,
  assertSeason,
  downloadAsset,
  isNotFound,
  mayBeUnpublished,
  nflSeasonAt,
  parseNflverseTimestamp,
  releaseUrl,
  releaseVersion,
  runSeasons,
  sourceTempDir,
  versionString,
} from "../../../src/sources/nflverse/release.js";
import { HttpError } from "../../../src/http/errors.js";
import { REL, makeCtx, type Ctx } from "./helpers/harness.js";

const open: Ctx[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.cleanup();
});
const ctxFor = (...args: Parameters<typeof makeCtx>): Ctx => {
  const c = makeCtx(...args);
  open.push(c);
  return c;
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("parseNflverseTimestamp", () => {
  it.each([
    ["2026-09-30 09:36:26 EDT", "2026-09-30T13:36:26.000Z"],
    ["2026-01-15 09:36:26 EST", "2026-01-15T14:36:26.000Z"],
    ["2026-09-30 09:36:26 UTC", "2026-09-30T09:36:26.000Z"],
    ["2026-09-30 09:36:26 GMT", "2026-09-30T09:36:26.000Z"],
    ["2026-09-30T13:36:26Z", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T13:36:26.123Z", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T09:36:26-04:00", "2026-09-30T13:36:26.000Z"],
    ["2026-09-30T19:06:26+0530", "2026-09-30T13:36:26.000Z"],
    ["  2026-09-30 09:36:26 EDT\n", "2026-09-30T13:36:26.000Z"],
    ["2024-02-29 00:00:00 EST", "2024-02-29T05:00:00.000Z"],
  ])("%j → %s", (input, iso) => {
    expect(parseNflverseTimestamp(input)).toBe(iso);
  });

  it.each([
    "",
    "2026-09-30",
    "2026-09-30 09:36:26",
    "2026-09-30 09:36:26 PDT", // a zone we do not know is never guessed
    "2026-09-30 09:36:26 edt",
    "2026-02-30 09:36:26 EDT",
    "2025-02-29 09:36:26 EDT",
    "2026-13-01 09:36:26 EDT",
    "2026-09-30 24:00:00 EDT",
    "2026-09-30 09:60:00 EDT",
    "2026-09-30 09:36:60 EDT",
    "2026-09-30T09:36:26+15:00",
    "2026-09-30T09:36:26+05:61",
    "2026-09-30 09:36:26 EDT; rm -rf /",
    "<html>rate limited</html>",
    "２０２６-09-30 09:36:26 EDT",
    `2026-09-30 09:36:26 EDT${" ".repeat(300)}`,
  ])("rejects %j", (input) => {
    expect(parseNflverseTimestamp(input)).toBeNull();
  });

  it("rejects non-strings", () => {
    for (const v of [null, undefined, 0, 1727703386, {}, [], new Date()]) {
      expect(parseNflverseTimestamp(v)).toBeNull();
    }
  });

  it("never throws and yields only valid ISO instants (fuzz)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const r = parseNflverseTimestamp(s);
        return r === null || new Date(r).toISOString() === r;
      }),
      { numRuns: 2000 },
    );
  });

  it("round-trips every instant written as a UTC timestamp line (property)", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2099-12-31T23:59:59Z"),
          noInvalidDate: true,
        }),
        (d) => {
          const iso = new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString();
          const line = `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
          return parseNflverseTimestamp(line) === iso;
        },
      ),
    );
  });
});

describe("versionString / seasons / urls", () => {
  it("is filename-safe and carries the seasons", () => {
    const v = versionString("2026-09-30T13:36:26.000Z", [2024, 2025, 2026]);
    expect(v).toBe("20260930T133626Z_2024-2025-2026");
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(versionString("2026-09-30T13:36:26.000Z", [2026])).not.toBe(v);
  });

  it("validates seasons", () => {
    expect(assertSeason(2026)).toBe(2026);
    for (const bad of [1998, 2101, 2026.5, Number.NaN, "2026", null, -1, Infinity]) {
      expect(() => assertSeason(bad)).toThrow(NflverseSourceError);
    }
    expect(runSeasons([2026, 2025, 2026])).toEqual([2026, 2025]);
    expect(() => runSeasons([2026, 3000])).toThrow(/season/);
  });

  it("refuses path tricks in file names", () => {
    expect(releaseUrl("injuries", "injuries_2026.parquet")).toBe(
      `${REL}/injuries/injuries_2026.parquet`,
    );
    for (const bad of ["../x", "a/b", "", "a b", "x?y=1", "..", "%2e%2e", "a".repeat(81)]) {
      expect(() => releaseUrl("injuries", bad)).toThrow(NflverseSourceError);
    }
  });
});

describe("releaseVersion", () => {
  it("reads the tag's timestamp.txt", async () => {
    const c = ctxFor([2026]);
    await expect(releaseVersion("injuries", c.ctx)).resolves.toEqual({
      version: "20260930T133626Z_2026",
      released_at: "2026-09-30T13:36:26.000Z",
    });
    expect(c.calls).toEqual([`${REL}/injuries/timestamp.txt`]);
  });

  it("returns null when upstream is unreachable or answers non-200", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    for (const r of [new Error("dns"), 404, 500, 302]) {
      const c = ctxFor([2026], new Map([[url, r]]));
      await expect(releaseVersion("schedules", c.ctx)).resolves.toBeNull();
    }
    const big = ctxFor([2026], new Map([[url, new Uint8Array(4096)]]));
    await expect(releaseVersion("schedules", big.ctx)).resolves.toBeNull();
  });

  it("re-throws a transient network failure (the runner retries it); a permanent one is null", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    for (const kind of ["dns", "reset", "timeout", "http_5xx", "rate_limited"] as const) {
      const e = new HttpError({
        kind,
        host: "github.com",
        status: kind === "http_5xx" ? 503 : null,
      });
      const c = ctxFor([2026], new Map([[url, e]]));
      await expect(releaseVersion("schedules", c.ctx)).rejects.toBe(e);
    }
    for (const kind of ["tls", "http_4xx", "too_large", "redirect_refused"] as const) {
      const e = new HttpError({
        kind,
        host: "github.com",
        status: kind === "http_4xx" ? 404 : null,
      });
      const c = ctxFor([2026], new Map([[url, e]]));
      await expect(releaseVersion("schedules", c.ctx)).resolves.toBeNull();
    }
  });

  it("fails loudly on a garbled or non-UTF-8 stamp", async () => {
    const url = `${REL}/schedules/timestamp.txt`;
    const garbled = ctxFor([2026], new Map([[url, enc("soon")]]));
    await expect(releaseVersion("schedules", garbled.ctx)).rejects.toMatchObject({
      code: "bad_timestamp",
    });
    const binary = ctxFor([2026], new Map([[url, Uint8Array.from([0xff, 0xfe, 0x00])]]));
    await expect(releaseVersion("schedules", binary.ctx)).rejects.toThrow(/UTF-8/);
  });

  it("propagates cancellation instead of reporting an outage", async () => {
    const c = ctxFor([2026]);
    c.abort.abort();
    await expect(releaseVersion("injuries", c.ctx)).rejects.toThrow(/aborted/);
  });

  it("validates the run's seasons before any request", async () => {
    const c = ctxFor([1900]);
    await expect(releaseVersion("injuries", c.ctx)).rejects.toMatchObject({ code: "bad_season" });
    expect(c.calls).toEqual([]);
  });
});

describe("downloadAsset", () => {
  const url = `${REL}/injuries/injuries_2026.parquet`;

  it("writes the body to a fresh 0600 file through HttpGet", async () => {
    const c = ctxFor([2026], new Map([[url, enc("PAR1xxxxPAR1")]]));
    const dir = await sourceTempDir(c.ctx, "t");
    const f = await downloadAsset(c.ctx, url, join(dir, "a.parquet"), 2026);
    expect(f).toEqual({ path: join(dir, "a.parquet"), bytes: 12, season: 2026 });
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  });

  it("fails on non-200 naming the URL, and leaves no partial file", async () => {
    const c = ctxFor([2026], new Map([[url, 404]]));
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(
      /injuries_2026\.parquet answered 404/,
    );
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses to overwrite an existing file (exclusive create)", async () => {
    const c = ctxFor([2026], new Map([[url, enc("x")]]));
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    writeFileSync(dest, "keep");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/EEXIST/);
  });

  it("uses the runner's streaming download when present, and checks its answer", async () => {
    const seen: string[] = [];
    const download = (u: string, o: { dest: string; maxBytes: number }) => {
      seen.push(u);
      writeFileSync(o.dest, "PAR1");
      expect(o.maxBytes).toBe(MAX_RELEASE_FILE_BYTES);
      return Promise.resolve({
        status: 200,
        bytes: 4,
        final_url: "https://release-assets.githubusercontent.com/z",
        headers: {},
        path: o.dest,
      });
    };
    const c = ctxFor([2026], new Map(), { download });
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).resolves.toMatchObject({ bytes: 4 });
    expect(seen).toEqual([url]);
    expect(c.calls).toEqual([]); // HttpGet not used

    const notOk = ctxFor([2026], new Map(), {
      download: (_u: string, o: { dest: string }) => {
        writeFileSync(o.dest, "partial");
        return Promise.resolve({
          status: 500,
          bytes: 7,
          final_url: "https://x/",
          headers: {},
          path: o.dest,
        });
      },
    });
    const dest2 = join(await sourceTempDir(notOk.ctx, "t"), "b.parquet");
    await expect(downloadAsset(notOk.ctx, url, dest2, 2026)).rejects.toThrow(/answered 500/);
    expect(existsSync(dest2)).toBe(false);

    const huge = ctxFor([2026], new Map(), {
      download: (_u: string, o: { dest: string }) =>
        Promise.resolve({
          status: 200,
          bytes: MAX_RELEASE_FILE_BYTES + 1,
          final_url: "https://x/",
          headers: {},
          path: o.dest,
        }),
    });
    const dest3 = join(await sourceTempDir(huge.ctx, "t"), "c.parquet");
    await expect(downloadAsset(huge.ctx, url, dest3, 2026)).rejects.toThrow(/size cap/);
  });

  it("refuses a body served over plain http or from an unparseable final URL", async () => {
    for (const final_url of ["http://evil.example/x", "not a url"]) {
      const c = ctxFor([2026], new Map(), {
        http: () => Promise.resolve({ status: 200, body: enc("x"), headers: {}, final_url }),
      });
      const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
      await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/https/);
      expect(existsSync(dest)).toBe(false);
    }
  });

  it("enforces the size cap even when HttpGet does not", async () => {
    const c = ctxFor([2026], new Map(), {
      http: () =>
        Promise.resolve({
          status: 200,
          body: new Uint8Array(MAX_RELEASE_FILE_BYTES + 1),
          headers: {},
          final_url: "https://release-assets.githubusercontent.com/x",
        }),
    });
    const dest = join(await sourceTempDir(c.ctx, "t"), "a.parquet");
    await expect(downloadAsset(c.ctx, url, dest, 2026)).rejects.toThrow(/size cap/);
    expect(existsSync(dest)).toBe(false);
  });

  it("falls back to the OS temp dir when the runner gives none", async () => {
    const c = ctxFor([2026], new Map(), { tempDir: undefined });
    const dir = await sourceTempDir(c.ctx, "fallback");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toContain("ff-fallback-");
    expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("[QA-1-033] the new-season window: which 404 may mean 'not published yet'", () => {
  const DAY = 86_400_000;
  it("nflSeasonAt: the calendar year from 1 September (UTC), else the previous one", () => {
    expect(nflSeasonAt(Date.parse("2027-08-31T23:59:59Z"))).toBe(2026);
    expect(nflSeasonAt(Date.parse("2027-09-01T00:00:00Z"))).toBe(2027);
    expect(nflSeasonAt(Date.parse("2028-02-10T12:00:00Z"))).toBe(2027); // the Super Bowl
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4_102_444_800_000 }), (ms) => {
        const s = nflSeasonAt(ms);
        const y = new Date(ms).getUTCFullYear();
        return s === y || s === y - 1;
      }),
    );
  });

  it("isNotFound: a 404 from src/http or a status-returning transport, nothing else", () => {
    expect(isNotFound(new HttpError({ kind: "http_4xx", status: 404 }))).toBe(true);
    expect(isNotFound(new NflverseSourceError("download", "x answered 404", 404))).toBe(true);
    expect(isNotFound(new HttpError({ kind: "http_4xx", status: 403 }))).toBe(false);
    expect(isNotFound(new HttpError({ kind: "http_5xx", status: 404 }))).toBe(false);
    expect(isNotFound(new NflverseSourceError("download", "x answered 500", 500))).toBe(false);
    expect(isNotFound(new Error("404"))).toBe(false);
    expect(isNotFound({ status: 404 })).toBe(false);
  });

  const ctxAt = (now: string, firstKickoff: (s: number, w: number) => string | null) => {
    const c = ctxFor([2027]);
    return {
      ...c.ctx,
      clock: { nowMs: () => Date.parse(now), nowIso: () => now },
      datasets: { schedules: { games: () => ({ rows: [], stamp: null }), firstKickoff } },
    } as typeof c.ctx;
  };

  it("a past season never; the current season until GRACE days after its first kickoff", () => {
    const k = "2027-09-10T00:20:00.000Z";
    const sched = (s: number, w: number) => (s === 2027 && w === 1 ? k : null);
    expect(mayBeUnpublished(2026, ctxAt("2027-09-01T12:00:00.000Z", sched))).toBe(false);
    expect(mayBeUnpublished(2027, ctxAt("2027-09-01T12:00:00.000Z", sched))).toBe(true);
    const edge = Date.parse(k) + SEASON_PUBLISH_GRACE_DAYS * DAY;
    expect(mayBeUnpublished(2027, ctxAt(new Date(edge - 1).toISOString(), sched))).toBe(true);
    expect(mayBeUnpublished(2027, ctxAt(new Date(edge).toISOString(), sched))).toBe(false);
    // a future season (an explicit --seasons) is not published either
    expect(mayBeUnpublished(2028, ctxAt("2027-12-01T12:00:00.000Z", sched))).toBe(true);
  });

  it("schedules that do not know the season (or throw) cannot prove it started: may be unpublished", () => {
    expect(
      mayBeUnpublished(
        2027,
        ctxAt("2027-12-01T12:00:00.000Z", () => null),
      ),
    ).toBe(true);
    expect(
      mayBeUnpublished(
        2027,
        ctxAt("2027-12-01T12:00:00.000Z", () => {
          throw new Error("schedules unreadable");
        }),
      ),
    ).toBe(true);
    expect(
      mayBeUnpublished(
        2027,
        ctxAt("2027-12-01T12:00:00.000Z", () => "garbage"),
      ),
    ).toBe(true);
  });
});
