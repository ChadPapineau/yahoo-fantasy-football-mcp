// limiter.ts — per-source politeness limits (plan 01 §6 "per-source limiters": GitHub ≤ 1 poll per
// 15 min per release, Open-Meteo / NWS ≤ 1 per venue per hour — the hourly job cadence — with a
// spacing floor and a daily cap here). Requests of one source are serialised and spaced at least
// `minIntervalMs` apart (start to start); past `maxPerDay` in the current UTC day this process
// refuses with `quota_exhausted`. The cap is per process (each `ff refresh` is one process);
// a cross-process cap would need the store's limiter_state (plan 01 A-11) — not needed at these rates.
import type { HttpDownload, HttpGet, RateLimit } from "../sources/source.js";
import { HttpError } from "./errors.js";
import { abortableSleep, type Sleep } from "./sleep.js";

const DAY_MS = 86_400_000;

/** What the limiter needs from its host: a clock and a sleep (both injected in tests). */
export interface LimiterDeps {
  nowMs(): number;
  readonly sleep?: Sleep;
}

/** A per-source limiter: `acquire` resolves when the next request may start. */
export interface RateLimiter {
  acquire(signal: AbortSignal): Promise<void>;
  /** Requests started in the current UTC day. */
  readonly usedToday: number;
}

/** Validates a RateLimit; throws RangeError on a programming error. */
export function validateRateLimit(limit: RateLimit): void {
  if (!Number.isFinite(limit.minIntervalMs) || limit.minIntervalMs < 0)
    throw new RangeError("limiter: minIntervalMs must be a finite number ≥ 0");
  if (limit.maxPerDay !== null && (!Number.isSafeInteger(limit.maxPerDay) || limit.maxPerDay < 0))
    throw new RangeError("limiter: maxPerDay must be null or an integer ≥ 0");
}

/** Builds a limiter for one source. */
export function createRateLimiter(limit: RateLimit, deps: LimiterDeps): RateLimiter {
  validateRateLimit(limit);
  const sleep = deps.sleep ?? abortableSleep;
  let tail: Promise<void> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;
  let day = Number.NaN;
  let count = 0;
  const rollDay = (now: number): void => {
    const d = Math.floor(now / DAY_MS);
    if (d !== day) {
      day = d;
      count = 0;
    }
  };
  const step = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw new HttpError({ kind: "aborted" });
    rollDay(deps.nowMs());
    if (limit.maxPerDay !== null && count >= limit.maxPerDay)
      throw new HttpError({ kind: "quota_exhausted" });
    const wait = lastStart + limit.minIntervalMs - deps.nowMs();
    if (wait > 0) {
      try {
        await sleep(wait, signal);
      } catch (e) {
        throw new HttpError({ kind: "aborted", cause: e });
      }
    }
    const now = deps.nowMs();
    rollDay(now);
    lastStart = now;
    count++;
  };
  return {
    acquire(signal) {
      const p = tail.then(() => step(signal));
      tail = p.catch(() => undefined);
      return p;
    },
    get usedToday() {
      return count;
    },
  };
}

/** Wraps an HttpGet so every call first waits for the limiter. */
export function limitGet(http: HttpGet, limiter: RateLimiter): HttpGet {
  return async (url, opts) => {
    await limiter.acquire(opts.signal);
    return http(url, opts);
  };
}

/** Wraps an HttpDownload so every call first waits for the limiter. */
export function limitDownload(download: HttpDownload, limiter: RateLimiter): HttpDownload {
  return async (url, opts) => {
    await limiter.acquire(opts.signal);
    return download(url, opts);
  };
}
