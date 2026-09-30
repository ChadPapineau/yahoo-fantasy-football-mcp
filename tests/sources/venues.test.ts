// venues.test.ts — src/sources/venues.ts (research 04 §B7/§H.7; plan 01 §5.2 weather row): every
// stadium of the real 2026 schedule is present and resolves, zones are valid IANA names, the
// coordinates are in range and agree with the zone's offset, the mis-coded games resolve to the
// real venue, hostile input yields null, and the ds_venues rows match the table contract.
import { describe, expect, it } from "vitest";
import {
  GAME_VENUE_OVERRIDES,
  VENUES,
  normalizeVenueName,
  resolveVenueId,
  venueById,
  venueByName,
  venueRows,
} from "../../src/sources/venues.js";
import { DS_VENUES } from "../../src/store/datasets/tables.js";

/** Every (stadium_id, stadium) pair in nflverse schedules games.parquet for 2026 (read 2026-09-30). */
const PAIRS_2026: readonly (readonly [string, string])[] = [
  ["ATL97", "Mercedes-Benz Stadium"], ["BAL00", "M&T Bank Stadium"], ["BOS00", "Gillette Stadium"],
  ["BUF00", "Highmark Stadium"], ["CAR00", "Bank of America Stadium"], ["CHI98", "Soldier Field"],
  ["CIN00", "Paycor Stadium"], ["CLE00", "Huntington Bank Field"], ["DAL00", "AT&T Stadium"],
  ["DEN00", "Empower Field at Mile High"], ["DET00", "Ford Field"], ["GNB00", "Lambeau Field"],
  ["HOU00", "Reliant Stadium"], ["IND00", "Lucas Oil Stadium"], ["JAX00", "EverBank Stadium"],
  ["JAX00", "Tottenham Hotspur Stadium"], ["KAN00", "GEHA Field at Arrowhead Stadium"],
  ["LAX01", "SoFi Stadium"], ["LON00", "Wembley Stadium"], ["LON02", "Tottenham Hotspur Stadium"],
  ["MAD01", "Bernabeu"], ["MEL00", "Melbourne Cricket Ground"], ["MEX00", "Estadio Banorte"],
  ["MIA00", "Hard Rock Stadium"], ["MIN01", "U.S. Bank Stadium"],
  ["MUN01", "FC Bayern Munich Stadium"], ["NAS00", "Nissan Stadium"], ["NOR00", "Caesars Superdome"],
  ["NYC01", "MetLife Stadium"], ["PAR00", "Stade de France"], ["PHI00", "Lincoln Financial Field"],
  ["PHO00", "State Farm Stadium"], ["PIT00", "Acrisure Stadium"], ["RIO00", "Maracana Stadium"],
  ["SEA00", "Lumen Field"], ["SFO01", "Levi's Stadium"], ["TAM00", "Raymond James Stadium"],
  ["VEG00", "Allegiant Stadium"], ["WAS00", "Northwest Stadium"],
]; // prettier-ignore

/** Ids seen in 2023–2025 only (the two prior seasons the backtests load). */
const EARLIER_IDS = ["FRA00", "GER00", "SAO00"];

const offsetHours = (tz: string, at: Date): number => {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
  if (!m) return 0; // "GMT" alone = UTC+0
  const h = Number(m[2]) + Number(m[3]) / 60;
  return m[1] === "-" ? -h : h;
};

describe("VENUES reference table", () => {
  it("has every 2026 stadium_id and every 2023–2025 id", () => {
    const ids = new Set(VENUES.map((x) => x.stadium_id));
    const missing = [...new Set(PAIRS_2026.map(([id]) => id)), ...EARLIER_IDS].filter(
      (id) => !ids.has(id),
    );
    expect(missing).toEqual([]);
  });

  it("is sorted, unique and frozen", () => {
    const ids = VENUES.map((x) => x.stadium_id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.isFrozen(VENUES)).toBe(true);
    for (const x of VENUES) {
      expect(Object.isFrozen(x)).toBe(true);
      expect(Object.isFrozen(x.names)).toBe(true);
    }
  });

  it.each(VENUES.map((x) => [x.stadium_id, x] as const))("%s: valid fields", (_id, x) => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: x.tz })).not.toThrow();
    expect(x.tz).toMatch(/^[A-Z][A-Za-z_]+(\/[A-Z][A-Za-z_]+){1,2}$/); // IANA Area/Location
    expect(x.lat).toBeGreaterThanOrEqual(-90);
    expect(x.lat).toBeLessThanOrEqual(90);
    expect(x.lon).toBeGreaterThanOrEqual(-180);
    expect(x.lon).toBeLessThanOrEqual(180);
    expect(Math.abs(x.lat) + Math.abs(x.lon)).toBeGreaterThan(1); // not (0, 0)
    expect(["outdoors", "dome", "closed", "open"]).toContain(x.roof_default);
    if (x.retractable) expect(x.roof_default).toBe("closed");
    expect(x.country).toMatch(/^[A-Z]{2}$/);
    expect(x.names.length).toBeGreaterThan(0);
    expect(x.name.length).toBeGreaterThan(0);
    expect(x.stadium_id).toMatch(/^[A-Z]{3}\d{2}$/);
    if (x.country === "US") {
      expect(x.tz.startsWith("America/")).toBe(true);
      expect(x.lat).toBeGreaterThan(24);
      expect(x.lat).toBeLessThan(49);
      expect(x.lon).toBeGreaterThan(-125);
      expect(x.lon).toBeLessThan(-66);
    }
    // Sign/axis-swap check: the zone's standard offset is within 2.5 h of longitude / 15.
    const jan = offsetHours(x.tz, new Date("2026-01-15T12:00:00Z"));
    const jul = offsetHours(x.tz, new Date("2026-07-15T12:00:00Z"));
    expect(Math.abs(Math.min(jan, jul) - x.lon / 15)).toBeLessThan(2.5);
  });

  it("keeps each normalised name on exactly one venue", () => {
    const seen = new Map<string, string>();
    for (const x of VENUES) {
      for (const n of x.names) {
        const k = normalizeVenueName(n);
        expect(seen.get(k) ?? x.stadium_id, n).toBe(x.stadium_id);
        seen.set(k, x.stadium_id);
      }
    }
  });

  it("marks only the venues nflverse never coded as local", () => {
    expect(VENUES.filter((x) => x.origin === "local").map((x) => x.stadium_id)).toEqual([
      "BER00",
      "DUB00",
    ]);
  });
});

describe("resolveVenueId", () => {
  it.each(PAIRS_2026)("resolves the real 2026 pair (%s, %s)", (id, name) => {
    const want = id === "JAX00" && name === "Tottenham Hotspur Stadium" ? "LON02" : id;
    expect(resolveVenueId("2026_xx", id, name)).toBe(want);
  });

  it("fixes the mis-coded games: the 2026 London JAX home game by name, 2025 by override", () => {
    expect(resolveVenueId("2026_05_PHI_JAX", "JAX00", "Tottenham Hotspur Stadium")).toBe("LON02");
    expect(resolveVenueId("2025_04_MIN_PIT", "PIT00", "Acrisure Stadium")).toBe("DUB00");
    expect(resolveVenueId("2025_10_ATL_IND", "IND00", "Lucas Oil Stadium")).toBe("BER00");
    for (const sid of Object.values(GAME_VENUE_OVERRIDES)) expect(venueById(sid)).not.toBeNull();
  });

  it("falls back to the id when the name is unknown or absent; null when neither is known", () => {
    expect(resolveVenueId("g", "CLE00", "Some Future Naming-Rights Field")).toBe("CLE00");
    expect(resolveVenueId("g", "CLE00", null)).toBe("CLE00");
    expect(resolveVenueId(null, null, "Lambeau Field")).toBe("GNB00");
    expect(resolveVenueId("g", "ZZZ99", "Nowhere Park")).toBeNull();
    expect(resolveVenueId(undefined, undefined, undefined)).toBeNull();
  });

  it("normalises case, accents, punctuation and whitespace", () => {
    expect(venueByName("  MARACANÃ   stadium ")?.stadium_id).toBe("RIO00");
    expect(venueByName("levis stadium")?.stadium_id).toBe("SFO01");
    expect(venueByName("Levi’s Stadium")?.stadium_id).toBe("SFO01");
    expect(venueByName("u.s. bank stadium")?.stadium_id).toBe("MIN01");
    expect(venueByName("M&T Bank Stadium")?.stadium_id).toBe("BAL00");
    expect(venueByName("Bernabéu")?.stadium_id).toBe("MAD01");
    expect(venueByName("Lambeau\u200bField")?.stadium_id).toBe("GNB00"); // zero-width → separator
  });

  it.each([
    ["__proto__"],
    ["constructor"],
    ["toString"],
    ["hasOwnProperty"],
    [""],
    ["   "],
    ["\u0000"],
    ["x".repeat(1_000_000)],
    ["Lambeau Field".repeat(20)],
  ])("returns null for hostile input %#", (s) => {
    expect(venueById(s)).toBeNull();
    expect(venueByName(s)).toBeNull();
    expect(resolveVenueId(s, s, s)).toBeNull();
  });

  it("ignores non-string input", () => {
    for (const x of [42, {}, [], true, Symbol("x")] as const) {
      expect(venueById(x)).toBeNull();
      expect(venueByName(x)).toBeNull();
    }
    expect(resolveVenueId({ toString: () => "2025_04_MIN_PIT" }, "PIT00", null)).toBe("PIT00");
  });
});

describe("venueRows → ds_venues", () => {
  it("emits exactly the DS_VENUES columns, NOT NULL filled, typed", () => {
    const rows = venueRows();
    expect(rows).toHaveLength(VENUES.length);
    const cols = DS_VENUES.columns.map((c) => c.name).sort();
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(cols);
      for (const c of DS_VENUES.columns) {
        const val = r[c.name];
        expect(val, c.name).not.toBeNull();
        if (c.type === "TEXT") expect(typeof val).toBe("string");
        else expect(typeof val).toBe("number");
      }
      expect([0, 1]).toContain(r.retractable);
    }
  });
});
