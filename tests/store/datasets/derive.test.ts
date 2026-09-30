// derive.test.ts — src/store/datasets/derive.ts: the Eastern kickoff → UTC instant across both DST
// transitions and the real 2026 kickoff slots, malformed/hostile inputs never throwing, a round-trip
// property, and the text/roof/date/implied-total normalisations the dataset contract names.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  NFLVERSE_KICKOFF_TZ,
  emptyToNull,
  impliedPoints,
  isoDate,
  kickoffUtcFromEastern,
  normalizeRoof,
  wallTimeToUtcIso,
  zoneOffsetMs,
} from "../../../src/store/datasets/derive.js";

describe("kickoffUtcFromEastern", () => {
  it.each([
    ["2026-10-01", "20:15", "2026-10-02T00:15:00.000Z"], // TNF, EDT, crosses the UTC date
    ["2026-09-13", "13:00", "2026-09-13T17:00:00.000Z"],
    ["2026-10-04", "09:30", "2026-10-04T13:30:00.000Z"], // London slot
    ["2026-12-27", "13:00", "2026-12-27T18:00:00.000Z"], // EST
    ["2026-11-01", "13:00", "2026-11-01T18:00:00.000Z"], // DST ends 02:00 that morning
    ["2026-10-31", "20:15", "2026-11-01T00:15:00.000Z"], // the evening before, still EDT
    ["2026-03-08", "13:00", "2026-03-08T17:00:00.000Z"], // DST began 02:00 that morning
    ["2027-01-10", "16:25", "2027-01-10T21:25:00.000Z"],
    ["2026-09-10", "20:35", "2026-09-11T00:35:00.000Z"], // Melbourne game, ET slot as filed
  ])("%s %s ET → %s", (d, t, want) => {
    expect(kickoffUtcFromEastern(d, t)).toBe(want);
  });

  it("resolves a spring-forward gap and a fall-back repeat deterministically", () => {
    expect(kickoffUtcFromEastern("2026-03-08", "02:30")).toMatch(/^2026-03-08T0[67]:30:00\.000Z$/);
    const fb = kickoffUtcFromEastern("2026-11-01", "01:30");
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(fb);
  });

  it.each([
    [null, "13:00"],
    ["2026-10-01", null],
    [undefined, undefined],
    [20261001, "13:00"],
    ["2026-13-01", "13:00"],
    ["2026-00-10", "13:00"],
    ["2026-02-30", "13:00"],
    ["2026-02-00", "13:00"],
    ["2026-10-01", "24:00"],
    ["2026-10-01", "12:60"],
    ["2026-10-01", "7:30"],
    ["2026-10-01", "13:00:00"],
    ["2026-10-01T13:00", "13:00"],
    ["", ""],
    [" 2026-10-01", "13:00"],
    ["２０２６-１０-０１", "13:00"], // full-width digits
    ["2026-10-01", "１３:００"],
    ["x".repeat(100_000), "13:00"],
  ])("returns null for malformed input %j %j", (d, t) => {
    expect(kickoffUtcFromEastern(d, t)).toBeNull();
  });

  it("round-trips: the UTC instant shows the same Eastern wall time (outside the 02:xx gap)", () => {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: NFLVERSE_KICKOFF_TZ,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2035-12-31T00:00:00Z"),
          noInvalidDate: true,
        }),
        fc.integer({ min: 0, max: 23 }).filter((h) => h !== 1 && h !== 2),
        fc.integer({ min: 0, max: 59 }),
        (date, h, m) => {
          const d = date.toISOString().slice(0, 10);
          const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
          const iso = kickoffUtcFromEastern(d, t);
          expect(iso).not.toBeNull();
          const shown = fmt.format(new Date(iso ?? "")).replace(",", "");
          expect(shown).toBe(`${d} ${t}`);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("works for any IANA zone and throws on an unknown one (a programming error)", () => {
    expect(wallTimeToUtcIso("2026-10-04", "14:30", "Europe/London")).toBe(
      "2026-10-04T13:30:00.000Z",
    );
    expect(wallTimeToUtcIso("2026-09-10", "20:35", "Australia/Melbourne")).toBe(
      "2026-09-10T10:35:00.000Z",
    );
    expect(() => wallTimeToUtcIso("2026-10-04", "14:30", "Mars/Olympus")).toThrow();
    expect(() => zoneOffsetMs("Not/AZone", 0)).toThrow();
    expect(zoneOffsetMs("UTC", Date.UTC(2026, 0, 1))).toBe(0);
    expect(zoneOffsetMs(NFLVERSE_KICKOFF_TZ, Date.UTC(2026, 0, 1))).toBe(-5 * 3_600_000);
  });
});

describe("text, roof and date normalisation", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    [" \t\n", null],
    [5, null],
    [{}, null],
    [" 30977 ", "30977"],
    ["Ja'Marr Chase", "Ja'Marr Chase"],
    ["Maracanã", "Maracanã"],
  ])("emptyToNull(%j) = %j", (v, want) => {
    expect(emptyToNull(v)).toBe(want);
  });

  it("normalizeRoof: '' → null (retractable, state unknown), otherwise lower-cased", () => {
    expect(normalizeRoof("")).toBeNull();
    expect(normalizeRoof(null)).toBeNull();
    expect(normalizeRoof(" Dome ")).toBe("dome");
    expect(normalizeRoof("outdoors")).toBe("outdoors");
  });

  it("isoDate accepts a Date, an ISO date string or a day count; nothing else", () => {
    expect(isoDate(new Date("1983-12-02T00:00:00.000Z"))).toBe("1983-12-02");
    expect(isoDate("2001-02-03")).toBe("2001-02-03");
    expect(isoDate(0)).toBe("1970-01-01");
    expect(isoDate(new Date("nope"))).toBeNull();
    expect(isoDate("2001-02-30T00:00")).toBeNull();
    expect(isoDate("2001-13-45")).toBeNull();
    expect(isoDate("2001-02-30")).toBeNull();
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
    expect(isoDate(1.5)).toBeNull();
    expect(isoDate(1e12)).toBeNull(); // beyond Date's range
    expect(isoDate(-1_000_000)).toBeNull(); // year < 0 → extended ISO form
    expect(isoDate(null)).toBeNull();
  });
});

describe("impliedPoints (positive spread = home favoured)", () => {
  it("splits the total around the spread", () => {
    expect(impliedPoints(3, 44.5)).toEqual({ away: 20.75, home: 23.75 });
    expect(impliedPoints(-2.5, 38.5)).toEqual({ away: 20.5, home: 18 });
    expect(impliedPoints(0, 40)).toEqual({ away: 20, home: 20 });
  });

  it("is null for any missing or non-finite input", () => {
    for (const [s, t] of [
      [null, 40],
      [3, null],
      [Number.NaN, 40],
      [3, Number.POSITIVE_INFINITY],
      ["3", "40"],
    ] as const) {
      expect(impliedPoints(s, t)).toEqual({ away: null, home: null });
    }
  });

  it("property: the two implied totals sum to the total and differ by the spread", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -30, max: 30, noNaN: true }),
        fc.double({ min: 20, max: 80, noNaN: true }),
        (s, t) => {
          const { away, home } = impliedPoints(s, t);
          expect((away ?? 0) + (home ?? 0)).toBeCloseTo(t, 9);
          expect((home ?? 0) - (away ?? 0)).toBeCloseTo(s, 9);
        },
      ),
    );
  });
});
