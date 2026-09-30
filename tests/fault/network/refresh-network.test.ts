// refresh-network.test.ts — plan 05 §4.1 fault rows on the REFRESH path (plan 10 A4a "the
// network-error-on-refresh row"; round 1 OBJ-22): an injected fetch that fails at the network layer
// or answers 429/5xx/garbage → refresh_log ok=0 with error "network", the previous dataset file
// intact (publish never called), never INTERNAL, no throw escapes, at most 3 attempts. Drives a
// release-style source (timestamp poll → streamed download) through the real runner + src/http.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTIONS } from "../../../src/config/freshness.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { createHttpClient } from "../../../src/http/client.js";
import { HttpError } from "../../../src/http/errors.js";
import { classifyError } from "../../../src/mcp/errors.js";
import { fsTempArea, runRefresh, type RefreshResult } from "../../../src/sources/runner.js";
import type { DataSource } from "../../../src/sources/source.js";
import { fakeFetch, netError, redirect, type Handler } from "../../http/helpers.js";
import { fakePublisher, fakeRefreshLog, fakeSchedules } from "../../sources/runner/helpers.js";

const TS_URL = "https://github.com/nflverse/nflverse-data/releases/download/injuries/timestamp.txt";
const FILE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.parquet";

/** A release source shaped like the nflverse ones: version from timestamp.txt, download per season. */
function releaseSource(errors: unknown[]): DataSource {
  return {
    id: "nflverse:injuries",
    license: "CC-BY-4.0",
    attribution: ATTRIBUTIONS.nflverse,
    freshness: "nflverse_injuries",
    limiter: { minIntervalMs: 0, maxPerDay: null },
    versioning: "release",
    tables: [],
    async version(ctx) {
      try {
        const r = await ctx.http(TS_URL, { signal: ctx.signal, maxBytes: 64 });
        return { version: new TextDecoder().decode(r.body).trim(), released_at: null };
      } catch (e) {
        errors.push(e);
        throw e;
      }
    },
    async fetch(_v, ctx) {
      if (ctx.download === undefined || ctx.tempDir === undefined)
        throw new Error("runner contract");
      const dest = join(ctx.tempDir, "injuries_2026.parquet");
      try {
        const r = await ctx.download(FILE_URL, { signal: ctx.signal, maxBytes: 1024 * 1024, dest });
        return [{ path: r.path, bytes: r.bytes, season: 2026 }];
      } catch (e) {
        errors.push(e);
        throw e;
      }
    },
    assertSchema: () =>
      Promise.resolve({
        ok: true,
        missing_columns: [],
        extra_columns: [],
        bad_codecs: [],
        rows: 1,
        warnings: [],
      }),
    publish: () => Promise.resolve({ rows: 1, tables: [], seasons: [2026], columns_hash: "h" }),
  };
}

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ff-fault-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(handler: Handler, opts: { connectTimeoutMs?: number } = {}) {
  const f = fakeFetch(handler);
  const client = createHttpClient({ fetch: f.fetch, ...opts });
  const publisher = fakePublisher();
  const refreshLog = fakeRefreshLog();
  const errors: unknown[] = [];
  let result: RefreshResult | undefined;
  let escaped: unknown = null;
  try {
    result = await runRefresh(
      { source: releaseSource(errors), seasons: [2026], week: null },
      {
        http: client.get,
        download: client.download,
        clock: fixedClock("2026-10-01T12:00:00.000Z"),
        rng: seededRng(11),
        publisher,
        refreshLog,
        schedules: fakeSchedules([]),
        temp: fsTempArea(join(root, "tmp")),
        sleep: () => Promise.resolve(),
      },
    );
  } catch (e) {
    escaped = e;
  }
  let left: string[] = [];
  try {
    left = await readdir(join(root, "tmp"));
  } catch {
    left = [];
  }
  return { f, publisher, refreshLog, errors, result, escaped, left };
}

const onTimestamp =
  (fail: () => Response): Handler =>
  (url) => {
    if (url === TS_URL) return fail();
    return new Response("PAR1");
  };
const onDownload =
  (fail: () => Response): Handler =>
  (url) =>
    url === TS_URL ? new Response("2026-10-01 08:00:00 EDT") : fail();

describe("network failures on refresh (plan 05 §4.1, OBJ-22)", () => {
  const throwing = (code: string) => () => {
    throw netError(code);
  };
  it.each([
    ["ENOTFOUND on the version poll", onTimestamp(throwing("ENOTFOUND")), 3],
    ["ECONNREFUSED on the version poll", onTimestamp(throwing("ECONNREFUSED")), 3],
    ["EAI_AGAIN on the download", onDownload(throwing("EAI_AGAIN")), 3],
    ["ECONNRESET on the download", onDownload(throwing("ECONNRESET")), 3],
    [
      "503 on the download",
      onDownload(() => new Response("<html>down</html>", { status: 503 })),
      3,
    ],
    ["500 on the version poll", onTimestamp(() => new Response("", { status: 500 })), 3],
    ["429 on the download", onDownload(() => new Response("", { status: 429 })), 3],
    ["a TLS failure (not transient)", onTimestamp(throwing("CERT_HAS_EXPIRED")), 1],
    ["a 404 (not transient)", onDownload(() => new Response("", { status: 404 })), 1],
    ["a redirect off the allow-list", onDownload(() => redirect("https://evil.example/x")), 1],
    ["a body over the cap", onDownload(() => new Response(new Uint8Array(2 * 1024 * 1024))), 1],
  ])(
    "%s → failed network, refresh_log ok=0, previous file intact",
    async (_name, handler, attempts) => {
      const r = await run(handler);
      expect(r.escaped).toBeNull();
      expect(r.result?.status).toBe("failed");
      if (r.result?.status !== "failed") return;
      expect(r.result.error).toBe("network");
      expect(r.refreshLog.rows).toHaveLength(1);
      expect(r.refreshLog.rows[0]).toMatchObject({
        ok: false,
        error: "network",
        source: "nflverse:injuries",
      });
      expect(r.publisher.published).toEqual([]); // the previous dataset file is never touched
      expect(r.errors).toHaveLength(attempts); // retries 3× on transient failures only
      for (const e of r.errors) {
        expect(e).toBeInstanceOf(HttpError);
        expect(classifyError(e).code).not.toBe("INTERNAL");
      }
      expect(r.left).toEqual([]); // no partial download survives
      expect(JSON.stringify(r.result)).not.toContain("<html>");
    },
  );

  it("a hung connection hits the connect timeout, retried 3×, then failed network", async () => {
    const r = await run(() => new Promise<Response>(() => undefined), { connectTimeoutMs: 5 });
    expect(r.result).toMatchObject({ status: "failed", error: "network" });
    expect(r.errors).toHaveLength(3);
    expect((r.errors[0] as HttpError).kind).toBe("timeout");
  });

  it("recovers when the network comes back within the attempts", async () => {
    let n = 0;
    const r = await run((url) => {
      if (url === TS_URL) return new Response("v1");
      n++;
      if (n < 3) throw netError("ECONNRESET");
      return new Response("PAR1");
    });
    expect(r.result?.status).toBe("published");
    expect(r.refreshLog.rows).toEqual([]);
    expect(r.left).toEqual([]);
  });
});
