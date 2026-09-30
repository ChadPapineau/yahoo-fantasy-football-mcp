// clock.ts — the injected sources of nondeterminism: the one source of "now" for every
// time-dependent module (plan 01 §5.4 freshness/age, plan 02 §4.4 TTLs, plan 05 §2 determinism) and
// the one seeded random source for every stochastic engine (plan 07 E1 `seed` + §5.3 "deterministic
// for a seed", E3 `mc`, plan 08 §7 P12; critic C-17). Domain code takes a Clock and an Rng; it never
// calls Date.now() or Math.random().

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

// --- seeded randomness (critic C-17) ----------------------------------------------------------------

/** The largest seed (plan 07 E1 `seed`; BOUNDS.seed in src/mcp/bounds.ts): 2^31 − 1. */
export const MAX_SEED = 2 ** 31 - 1;

/**
 * A deterministic random source. Engines take one by injection (as they take a Clock); E1's `seed`
 * feeds it. `fork(label)` gives an independent stream that depends only on the root seed and the
 * label path — never on how many numbers the parent has drawn — so adding a draw in one module can
 * never shift another module's stream.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An independent child stream named `label` (e.g. `"projection:00-0012345"`). */
  fork(label: string): Rng;
}

/** FNV-1a 32-bit over UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32: expands one 32-bit value into well-mixed state words. */
function splitmix32(a: number): () => number {
  let x = a >>> 0;
  return () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

function rngFromPath(seed: number, path: string): Rng {
  const mix = splitmix32((seed ^ fnv1a(path)) >>> 0);
  let a = mix();
  let b = mix();
  let c = mix();
  let d = mix();
  // sfc32 (Chris Doty-Humphrey's Small Fast Chaotic generator), warmed up 12 rounds.
  const step = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    c = (c + t) >>> 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) step();
  return {
    next: () => step() / 4294967296,
    fork: (label: string) => rngFromPath(seed, `${path}/${label}`),
  };
}

/** A seeded Rng (sfc32). `seed` must be an integer in 0..MAX_SEED; anything else throws RangeError. */
export function seededRng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED)
    throw new RangeError("rng: seed must be an integer in 0..2^31-1");
  return rngFromPath(seed, "");
}
