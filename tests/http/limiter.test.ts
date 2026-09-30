// limiter.test.ts — per-source limits (plan 01 §6): spacing between request starts, a per-UTC-day
// cap, serialisation of concurrent callers, aborts; and the abortable sleep they wait on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/http/errors.js";
import {
  createRateLimiter,
  limitDownload,
  limitGet,
  validateRateLimit,
} from "../../src/http/limiter.js";
import { abortableSleep } from "../../src/http/sleep.js";
import type { HttpDownload, HttpGet } from "../../src/sources/source.js";

function fakeTime(start = Date.UTC(2026, 9, 1, 23, 59, 0)) {
  let now = start;
  const sleeps: number[] = [];
  return {
    nowMs: () => now,
    sleep: (ms: number, signal: AbortSignal) => {
      if (signal.aborted) return Promise.reject(new Error("aborted"));
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}
const sig = () => new AbortController().signal;

describe("createRateLimiter", () => {
  it("spaces request starts by minIntervalMs; the first request never waits", async () => {
    const t = fakeTime();
    const l = createRateLimiter({ minIntervalMs: 500, maxPerDay: null }, t);
    await l.acquire(sig());
    await l.acquire(sig());
    t.advance(200);
    await l.acquire(sig());
    t.advance(900);
    await l.acquire(sig());
    expect(t.sleeps).toEqual([500, 300]);
    expect(l.usedToday).toBe(4);
  });

  it("serialises concurrent callers (each waits its own interval)", async () => {
    const t = fakeTime();
    const l = createRateLimiter({ minIntervalMs: 100, maxPerDay: null }, t);
    await Promise.all([l.acquire(sig()), l.acquire(sig()), l.acquire(sig())]);
    expect(t.sleeps).toEqual([100, 100]);
  });

  it("refuses past maxPerDay with quota_exhausted, and resets at the next UTC day", async () => {
    const t = fakeTime(Date.UTC(2026, 9, 1, 23, 59, 50));
    const l = createRateLimiter({ minIntervalMs: 0, maxPerDay: 2 }, t);
    await l.acquire(sig());
    await l.acquire(sig());
    const e = await l.acquire(sig()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).kind).toBe("quota_exhausted");
    expect((e as HttpError).transient).toBe(false);
    t.advance(20_000); // past midnight UTC
    await l.acquire(sig());
    expect(l.usedToday).toBe(1);
  });

  it("maxPerDay 0 refuses everything; a failed acquire does not wedge the queue", async () => {
    const t = fakeTime();
    const l0 = createRateLimiter({ minIntervalMs: 0, maxPerDay: 0 }, t);
    await expect(l0.acquire(sig())).rejects.toThrow(HttpError);
    const l = createRateLimiter({ minIntervalMs: 10, maxPerDay: null }, t);
    const ac = new AbortController();
    ac.abort();
    await expect(l.acquire(ac.signal)).rejects.toMatchObject({ kind: "aborted" });
    await l.acquire(sig());
  });

  it("an abort during the wait rejects with aborted", async () => {
    const t = fakeTime();
    const l = createRateLimiter(
      { minIntervalMs: 1000, maxPerDay: null },
      {
        nowMs: t.nowMs,
        sleep: () => Promise.reject(new Error("aborted")),
      },
    );
    await l.acquire(sig());
    await expect(l.acquire(sig())).rejects.toMatchObject({ kind: "aborted" });
  });

  it("uses the real abortable sleep by default", async () => {
    let now = 0;
    const l = createRateLimiter({ minIntervalMs: 5, maxPerDay: null }, { nowMs: () => now });
    await l.acquire(sig());
    now = 1;
    await l.acquire(sig());
    expect(l.usedToday).toBe(2);
  });

  it.each([
    [{ minIntervalMs: -1, maxPerDay: null }],
    [{ minIntervalMs: Number.NaN, maxPerDay: null }],
    [{ minIntervalMs: 0, maxPerDay: -1 }],
    [{ minIntervalMs: 0, maxPerDay: 1.5 }],
  ])("validateRateLimit(%j) throws", (limit) => {
    expect(() => {
      validateRateLimit(limit);
    }).toThrow(RangeError);
  });
});

describe("limitGet / limitDownload", () => {
  it("every call waits for the limiter, then calls through", async () => {
    const t = fakeTime();
    const l = createRateLimiter({ minIntervalMs: 250, maxPerDay: 3 }, t);
    const http: HttpGet = (url) =>
      Promise.resolve({ status: 200, body: new Uint8Array(), headers: {}, final_url: url });
    const dl: HttpDownload = (url, o) =>
      Promise.resolve({ status: 200, bytes: 0, headers: {}, final_url: url, path: o.dest });
    const g = limitGet(http, l);
    const d = limitDownload(dl, l);
    expect((await g("u1", { signal: sig(), maxBytes: 1 })).final_url).toBe("u1");
    expect((await d("u2", { signal: sig(), maxBytes: 1, dest: "/x" })).path).toBe("/x");
    await g("u3", { signal: sig(), maxBytes: 1 });
    await expect(g("u4", { signal: sig(), maxBytes: 1 })).rejects.toMatchObject({
      kind: "quota_exhausted",
    });
    expect(t.sleeps).toEqual([250, 250]);
  });
});

describe("abortableSleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after ms; clamps bad ms to 0", async () => {
    let done = false;
    const p = abortableSleep(100, sig()).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
    const q = abortableSleep(Number.NaN, sig());
    await vi.advanceTimersByTimeAsync(0);
    await q;
    await Promise.all([abortableSleep(-5, sig()), vi.advanceTimersByTimeAsync(0)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when pre-aborted, and on abort mid-wait (clearing its timer)", async () => {
    const pre = new AbortController();
    pre.abort(new Error("stop"));
    await expect(abortableSleep(10, pre.signal)).rejects.toThrow("stop");
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort("not an error");
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
