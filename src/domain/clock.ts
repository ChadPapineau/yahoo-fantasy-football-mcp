// clock.ts — the one source of "now" for every time-dependent module (plan 01 §5.4 freshness/age,
// plan 02 §4.4 TTLs, plan 05 §2 determinism). Domain code takes a Clock; it never calls Date.now().

/** A source of the current instant. Every time-dependent module takes one by injection. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  nowMs(): number;
  /** The current instant as an ISO-8601 UTC string with millisecond precision. */
  nowIso(): string;
}

/** A test clock whose time only moves when told to. */
export interface FixedClock extends Clock {
  /** Move the clock forward (or backward, with a negative value) by `ms` milliseconds. */
  advance(ms: number): void;
  /** Jump to an absolute instant (epoch ms or ISO string). */
  set(at: number | string): void;
}

/** Converts epoch milliseconds to an ISO-8601 UTC string; throws RangeError on a non-finite value. */
export function toIso(ms: number): string {
  if (!Number.isFinite(ms)) throw new RangeError("clock: instant must be a finite number");
  return new Date(ms).toISOString();
}

/** Parses an ISO-8601 instant to epoch ms; throws RangeError when it is not a valid date. */
export function parseIso(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError("clock: not a valid ISO-8601 instant");
  return ms;
}

/**
 * Whole seconds elapsed from `fromIso` to the clock's now, floored and never negative (a timestamp
 * in the future — clock skew — reads as age 0, not a negative age). Plan 01 §4.2 `meta.age_s`.
 */
export function ageSeconds(fromIso: string, clock: Clock): number {
  const age = Math.floor((clock.nowMs() - parseIso(fromIso)) / 1000);
  return age > 0 ? age : 0;
}

/** The real wall clock. The only place in src/domain that reads Date.now(). */
export const systemClock: Clock = Object.freeze({
  nowMs: () => Date.now(),
  nowIso: () => new Date(Date.now()).toISOString(),
});

/** A deterministic clock for tests, starting at `start` (epoch ms or ISO string). */
export function fixedClock(start: number | string): FixedClock {
  const toMs = (at: number | string): number => {
    const ms = typeof at === "number" ? at : parseIso(at);
    if (!Number.isFinite(ms)) throw new RangeError("clock: instant must be a finite number");
    return ms;
  };
  let now = toMs(start);
  return {
    nowMs: () => now,
    nowIso: () => toIso(now),
    advance(ms: number) {
      if (!Number.isFinite(ms)) throw new RangeError("clock: advance must be a finite number");
      now = toMs(now + ms);
    },
    set(at: number | string) {
      now = toMs(at);
    },
  };
}
