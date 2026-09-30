// clock.test.ts — src/domain/clock.ts: the injected time source (plan 05 §2 determinism).
import { describe, expect, it } from "vitest";
import { ageSeconds, fixedClock, parseIso, systemClock, toIso } from "../../src/domain/clock.js";

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
