// clock.test.ts — src/domain/clock.ts: the injected time source (plan 05 §2 determinism).
import { describe, expect, it } from "vitest";
import {
  MAX_SEED,
  ageSeconds,
  fixedClock,
  parseIso,
  seededRng,
  systemClock,
  toIso,
} from "../../src/domain/clock.js";

describe("systemClock", () => {
  it("reads the wall clock", () => {
    const before = Date.now();
    const ms = systemClock.nowMs();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms - before).toBeLessThan(5_000);
    expect(Date.parse(systemClock.nowIso())).toBeGreaterThanOrEqual(before);
    expect(systemClock.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("is frozen (no test can monkey-patch time for everyone)", () => {
    expect(Object.isFrozen(systemClock)).toBe(true);
  });
});

describe("fixedClock", () => {
  it("starts at an epoch ms or an ISO string and only moves when told", () => {
    const c = fixedClock("2026-09-30T12:00:00Z");
    expect(c.nowIso()).toBe("2026-09-30T12:00:00.000Z");
    expect(c.nowMs()).toBe(Date.parse("2026-09-30T12:00:00Z"));
    c.advance(1500);
    expect(c.nowIso()).toBe("2026-09-30T12:00:01.500Z");
    c.advance(-500);
    expect(c.nowIso()).toBe("2026-09-30T12:00:01.000Z");
    c.set(0);
    expect(c.nowIso()).toBe("1970-01-01T00:00:00.000Z");
    c.set("2027-01-01T00:00:00.000Z");
    expect(c.nowMs()).toBe(Date.UTC(2027, 0, 1));
    expect(fixedClock(42).nowMs()).toBe(42);
  });

  it.each([NaN, Infinity, -Infinity])("rejects a non-finite start/advance/set (%s)", (bad) => {
    expect(() => fixedClock(bad)).toThrow(RangeError);
    const c = fixedClock(0);
    expect(() => {
      c.advance(bad);
    }).toThrow(RangeError);
    expect(() => {
      c.set(bad);
    }).toThrow(RangeError);
    expect(c.nowMs()).toBe(0);
  });

  it.each(["", "not a date", "2026-13-45T99:99:99Z", "\u202e2026-09-30"])(
    "rejects an invalid ISO start %j",
    (bad) => {
      expect(() => fixedClock(bad)).toThrow(RangeError);
    },
  );

  it("an instant beyond the Date range cannot be rendered as ISO", () => {
    const c = fixedClock(8.64e15);
    c.advance(1);
    expect(() => c.nowIso()).toThrow(RangeError);
  });
});

describe("toIso / parseIso", () => {
  it("round-trips", () => {
    expect(toIso(parseIso("2026-09-30T15:46:00Z"))).toBe("2026-09-30T15:46:00.000Z");
  });
  it("rejects non-finite input", () => {
    expect(() => toIso(NaN)).toThrow(RangeError);
    expect(() => parseIso("garbage")).toThrow(RangeError);
  });
});

describe("ageSeconds", () => {
  const clock = fixedClock("2026-09-30T12:00:10.900Z");
  it("floors whole seconds from the given instant to now", () => {
    expect(ageSeconds("2026-09-30T12:00:00.000Z", clock)).toBe(10);
    expect(ageSeconds("2026-09-30T12:00:10.900Z", clock)).toBe(0);
  });
  it("never goes negative (a future timestamp is clock skew, not a negative age)", () => {
    expect(ageSeconds("2026-10-01T00:00:00Z", clock)).toBe(0);
  });
  it("throws on an invalid timestamp rather than reading as fresh", () => {
    expect(() => ageSeconds("yesterday", clock)).toThrow(RangeError);
  });
});

describe("seededRng (critic C-17: one deterministic random source; plan 07 E1 seed)", () => {
  const draw = (seed: number, n: number, label?: string) => {
    const r = label === undefined ? seededRng(seed) : seededRng(seed).fork(label);
    return Array.from({ length: n }, () => r.next());
  };

  it("is deterministic for a seed and differs across seeds", () => {
    expect(draw(42, 50)).toEqual(draw(42, 50));
    expect(draw(42, 50)).not.toEqual(draw(43, 50));
    expect(draw(0, 5)).not.toEqual(draw(1, 5));
  });
  it("yields floats in [0, 1) with a plausible mean and no short cycle", () => {
    const xs = draw(7, 20_000);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    expect(new Set(xs).size).toBeGreaterThan(19_990);
    // bucket uniformity: 10 buckets within ±10 % of expectation
    const buckets = new Array<number>(10).fill(0);
    for (const x of xs) buckets[Math.floor(x * 10)]! += 1;
    for (const b of buckets) expect(Math.abs(b - 2000)).toBeLessThan(200);
  });
  it("fork depends only on the root seed and the label path, never on parent draws", () => {
    const a = seededRng(99);
    const b = seededRng(99);
    for (let i = 0; i < 37; i++) b.next();
    const fa = Array.from({ length: 10 }, () => a.fork("projection:00-0012345").next());
    const fb = Array.from({ length: 10 }, () => b.fork("projection:00-0012345").next());
    expect(fa).toEqual(fb);
    expect(draw(99, 10, "x")).not.toEqual(draw(99, 10, "y"));
    expect(draw(99, 10, "x")).not.toEqual(draw(99, 10));
    // nested forks are paths: fork("a").fork("b") differs from fork("a/b")? same path string → equal
    const n1 = seededRng(5).fork("a").fork("b").next();
    const n2 = seededRng(5).fork("a").fork("b").next();
    expect(n1).toBe(n2);
    expect(seededRng(5).fork("a").fork("b").next()).not.toBe(
      seededRng(5).fork("b").fork("a").next(),
    );
  });
  it("rejects every seed outside 0..2^31-1 (never silently wraps)", () => {
    expect(MAX_SEED).toBe(2 ** 31 - 1);
    expect(() => seededRng(MAX_SEED)).not.toThrow();
    expect(() => seededRng(0)).not.toThrow();
    for (const bad of [-1, MAX_SEED + 1, 1.5, NaN, Infinity, -Infinity, 2 ** 53])
      expect(() => seededRng(bad)).toThrow(RangeError);
  });
  it("hostile labels (empty, huge, unicode) fork without throwing and stay deterministic", () => {
    for (const label of ["", "x".repeat(100_000), "\u202e\u0000\ud800", "__proto__"]) {
      expect(draw(3, 3, label)).toEqual(draw(3, 3, label));
    }
  });
});
