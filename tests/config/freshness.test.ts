// freshness.test.ts — src/config/freshness.ts (plan 05 §2 `config/freshness`): the SHAPE of the
// table (fresh < hard for every class, not the assumed values), a monotone classifier, the
// provisional-week rule, and the source registry's license/attribution coverage.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTRIBUTIONS,
  DATASET_SOURCE_IDS,
  FRESHNESS_CLASS_IDS,
  FRESHNESS_TABLE,
  SOURCE_REGISTRY,
  attributionFor,
  classifyAge,
  freshnessClass,
  isDatasetSourceId,
  isProvisionalWeek,
  resourceTtlMs,
  stampState,
  worseFreshness,
  type FreshnessClassId,
  type FreshnessState,
} from "../../src/config/freshness.js";

const classes = FRESHNESS_CLASS_IDS.map((id) => FRESHNESS_TABLE[id]);
const RANK: Record<FreshnessState, number> = { fresh: 0, stale: 1, expired: 2 };

describe("freshness table shape (plan 01 A-4..A-9: shape, not values)", () => {
  it("has exactly one row per class id, keyed by its own id", () => {
    expect(Object.keys(FRESHNESS_TABLE).sort()).toEqual([...FRESHNESS_CLASS_IDS].sort());
    for (const c of classes) expect(FRESHNESS_TABLE[c.id]).toBe(c);
  });

  it.each(classes)("$id: fresh < hard, both positive integers when present", (c) => {
    if (c.ttlSeconds !== null) {
      expect(Number.isInteger(c.ttlSeconds)).toBe(true);
      expect(c.ttlSeconds).toBeGreaterThan(0);
    }
    if (c.hardLimitSeconds !== null) {
      expect(Number.isInteger(c.hardLimitSeconds)).toBe(true);
      expect(c.ttlSeconds).not.toBeNull();
      expect(c.hardLimitSeconds).toBeGreaterThan(c.ttlSeconds ?? Infinity);
    }
  });

  it.each(classes)("$id: beyondHard is set exactly when a hard limit exists", (c) => {
    expect(c.beyondHard === null).toBe(c.hardLimitSeconds === null);
  });

  it.each(classes)("$id: immutable basis means never ages", (c) => {
    if (c.basis === "immutable") {
      expect(c.ttlSeconds).toBeNull();
      expect(c.hardLimitSeconds).toBeNull();
    } else {
      expect(c.ttlSeconds).not.toBeNull();
    }
  });

  it("drivers that may be omitted (lines, weather, news, trending, odds) never raise STALE_ONLY", () => {
    for (const id of ["lines", "weather", "news", "sleeper_trending", "odds"] as const) {
      expect(FRESHNESS_TABLE[id].beyondHard).toBe("omit");
    }
  });

  it("the user's own league file never hard-fails (X1 re-edit cadence is a warning, not an error)", () => {
    expect(FRESHNESS_TABLE.manual_league.hardLimitSeconds).toBeNull();
    expect(FRESHNESS_TABLE.manual_league.basis).toBe("file");
  });

  it("rows are frozen", () => {
    expect(Object.isFrozen(FRESHNESS_TABLE)).toBe(true);
    for (const c of classes) expect(Object.isFrozen(c)).toBe(true);
  });

  it("freshnessClass looks up and rejects an unknown id", () => {
    expect(freshnessClass("weather").id).toBe("weather");
    expect(() => freshnessClass("nope" as FreshnessClassId)).toThrow(/unknown class/);
  });
});

describe("classifyAge", () => {
  it.each(classes)("$id: boundaries are inclusive and ordered", (c) => {
    expect(classifyAge(c, 0)).toBe("fresh");
    if (c.ttlSeconds === null) {
      expect(classifyAge(c, 1e12)).toBe("fresh");
      return;
    }
    expect(classifyAge(c, c.ttlSeconds)).toBe("fresh");
    expect(classifyAge(c, c.ttlSeconds + 1)).toBe("stale");
    if (c.hardLimitSeconds === null) {
      expect(classifyAge(c, 1e12)).toBe("stale");
    } else {
      expect(classifyAge(c, c.hardLimitSeconds)).toBe("stale");
      expect(classifyAge(c, c.hardLimitSeconds + 1)).toBe("expired");
    }
  });

  it("property: monotone non-decreasing in age for every class", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...classes),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        (c, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          return RANK[classifyAge(c, lo)] <= RANK[classifyAge(c, hi)];
        },
      ),
    );
  });

  it.each([-1, -0.001, NaN, Infinity, -Infinity])(
    "rejects a bad age %s instead of reading fresh",
    (age) => {
      expect(() => classifyAge(FRESHNESS_TABLE.nflverse_injuries, age)).toThrow(RangeError);
    },
  );

  it("fractional ages just past a limit are stale, not fresh", () => {
    expect(classifyAge(FRESHNESS_TABLE.weather, 3600.0001)).toBe("stale");
  });
});

describe("worseFreshness", () => {
  it("orders stale > provisional > fresh, symmetric", () => {
    expect(worseFreshness("fresh", "fresh")).toBe("fresh");
    expect(worseFreshness("fresh", "provisional")).toBe("provisional");
    expect(worseFreshness("provisional", "fresh")).toBe("provisional");
    expect(worseFreshness("provisional", "stale")).toBe("stale");
    expect(worseFreshness("stale", "fresh")).toBe("stale");
  });
});

describe("resourceTtlMs", () => {
  it("is the class TTL in ms, capped at one day, and one day for immutable classes", () => {
    expect(resourceTtlMs(FRESHNESS_TABLE.weather)).toBe(3_600_000);
    expect(resourceTtlMs(FRESHNESS_TABLE.manual_league)).toBe(86_400_000);
    expect(resourceTtlMs(FRESHNESS_TABLE.crosswalk)).toBe(86_400_000);
    for (const c of classes) {
      const t = resourceTtlMs(c);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(86_400_000);
    }
  });
});

describe("isProvisionalWeek (research 03 §D.2: final after the next week's first kickoff)", () => {
  const kickoff = Date.parse("2026-10-08T00:15:00Z");
  it("is provisional before the next kickoff and final at/after it", () => {
    expect(isProvisionalWeek(kickoff, kickoff - 1)).toBe(true);
    expect(isProvisionalWeek(kickoff, kickoff)).toBe(false);
    expect(isProvisionalWeek(kickoff, kickoff + 1)).toBe(false);
  });
  it("is conservatively provisional when the next kickoff is unknown", () => {
    expect(isProvisionalWeek(null, kickoff)).toBe(true);
  });
  it("property: flips exactly once, at the kickoff", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4e12 }),
        fc.integer({ min: 0, max: 4e12 }),
        (k, now) => {
          return isProvisionalWeek(k, now) === now < k;
        },
      ),
    );
  });
});

describe("source registry (plan 01 §8 license + attribution; research 04 §G.3)", () => {
  it("has one row per dataset source id with a known freshness class", () => {
    expect(Object.keys(SOURCE_REGISTRY).sort()).toEqual([...DATASET_SOURCE_IDS].sort());
    for (const id of DATASET_SOURCE_IDS) {
      const row = SOURCE_REGISTRY[id];
      expect(row.id).toBe(id);
      expect(FRESHNESS_CLASS_IDS).toContain(row.freshness);
      expect(row.attribution.url).toMatch(/^https:\/\//);
      expect(row.attribution.license).not.toBeNull();
    }
  });

  it("marks the non-commercial and share-alike sources visibly", () => {
    expect(SOURCE_REGISTRY["sleeper:trending"].attribution.license).toBe("non-commercial");
    expect(SOURCE_REGISTRY["weather:open_meteo"].attribution.license).toBe("non-commercial");
    expect(SOURCE_REGISTRY["ffopportunity:ep_weekly"].attribution.license).toBe("CC-BY-SA-4.0");
    expect(SOURCE_REGISTRY["nflverse:stats_player_week"].attribution.license).toBe("CC-BY-4.0");
    expect(SOURCE_REGISTRY["weather:nws"].attribution.license).toBe("public-domain");
  });

  it("the 1a sources are exactly the plan 10 §3.1a set", () => {
    const oneA = DATASET_SOURCE_IDS.filter((id) => SOURCE_REGISTRY[id].phase === "1a").sort();
    expect(oneA).toEqual(
      [
        "nflverse:injuries",
        "nflverse:roster_weekly",
        "nflverse:schedules",
        "nflverse:stats_player_week",
        "weather:nws",
        "weather:open_meteo",
      ].sort(),
    );
  });

  it("isDatasetSourceId accepts registry ids only", () => {
    expect(isDatasetSourceId("nflverse:injuries")).toBe(true);
    for (const bad of [
      "",
      "nflverse",
      "NFLVERSE:injuries",
      "nflverse:injuries ",
      "yahoo",
      "__proto__",
      "constructor",
    ]) {
      expect(isDatasetSourceId(bad)).toBe(false);
    }
  });
});

describe("attributionFor", () => {
  it("returns Yahoo's exact wording whenever yahoo contributed (HANDOFF terms)", () => {
    expect(attributionFor("yahoo")).toBe(ATTRIBUTIONS.yahoo);
    expect(attributionFor("yahoo:roster")).toBe(ATTRIBUTIONS.yahoo);
    expect(ATTRIBUTIONS.yahoo.text).toBe("Fantasy data provided by Yahoo Fantasy");
  });
  it("returns the dataset's attribution for a dataset source", () => {
    expect(attributionFor("nflverse:schedules")).toBe(ATTRIBUTIONS.nflverse);
    expect(attributionFor("weather:open_meteo")).toBe(ATTRIBUTIONS.open_meteo);
  });
  it("owes nothing for the user's own league file or internal tags", () => {
    for (const tag of [
      "manual",
      "engine",
      "store.recommendation_log",
      "",
      "toString",
      "__proto__",
    ]) {
      expect(attributionFor(tag)).toBeNull();
    }
  });
});

describe("stampState — the class basis picks the instant (critics C-12, C-08b)", () => {
  const NOW = Date.parse("2026-10-10T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const H = 3_600_000;
  const D = 24 * H;

  it("release basis: an unchanged release checked an hour ago is fresh however old the download", () => {
    const cls = freshnessClass("nflverse_stats_player_week");
    const st = stampState(
      cls,
      { as_of: iso(10 * D), fetched_at: iso(10 * D), checked_at: iso(H) },
      NOW,
    );
    expect(st.state).toBe("fresh");
    expect(st.basis_at).toBe(iso(H));
    expect(st.age_s).toBe(3600);
    // the same stamp judged by fetched_at alone would be expired (the bug the critics measured)
    expect(classifyAge(cls, (10 * D) / 1000)).toBe("expired");
  });
  it("release basis: a missed daily check goes stale, then expired, by checked_at", () => {
    const cls = freshnessClass("nflverse_schedules");
    expect(
      stampState(cls, { as_of: iso(D), fetched_at: iso(D), checked_at: iso(2 * H) }, NOW).state,
    ).toBe("stale");
    expect(
      stampState(cls, { as_of: iso(9 * D), fetched_at: iso(9 * D), checked_at: iso(8 * D) }, NOW)
        .state,
    ).toBe("expired");
  });
  it("release basis: checked_at null or older than fetched_at falls back to the later instant", () => {
    const cls = freshnessClass("nflverse_injuries");
    const a = stampState(cls, { as_of: iso(H), fetched_at: iso(H), checked_at: null }, NOW);
    expect(a.basis_at).toBe(iso(H));
    const b = stampState(cls, { as_of: iso(H), fetched_at: iso(H), checked_at: iso(5 * D) }, NOW);
    expect(b.basis_at).toBe(iso(H));
    expect(b.state).toBe("fresh");
  });
  it("file basis (manual_league): judged from the mtime (as_of), not the read time", () => {
    const cls = freshnessClass("manual_league");
    const st = stampState(cls, { as_of: iso(8 * D), fetched_at: iso(0), checked_at: null }, NOW);
    expect(st.state).toBe("stale");
    expect(st.basis_at).toBe(iso(8 * D));
    expect(st.age_s).toBe(8 * 86_400);
    // no hard limit for the manual league: never expired
    expect(
      stampState(cls, { as_of: iso(400 * D), fetched_at: iso(0), checked_at: null }, NOW).state,
    ).toBe("stale");
  });
  it("age basis uses fetched_at; immutable is always fresh", () => {
    const w = freshnessClass("weather");
    expect(
      stampState(w, { as_of: iso(0), fetched_at: iso(2 * H), checked_at: iso(0) }, NOW).state,
    ).toBe("stale");
    const c = freshnessClass("crosswalk");
    const st = stampState(
      c,
      { as_of: iso(900 * D), fetched_at: iso(900 * D), checked_at: null },
      NOW,
    );
    expect(st.state).toBe("fresh");
    expect(st.age_s).toBe(900 * 86_400);
  });
  it("a future instant (clock skew) reads age 0; garbage throws instead of reading fresh", () => {
    const cls = freshnessClass("weather");
    expect(
      stampState(cls, { as_of: iso(-H), fetched_at: iso(-H), checked_at: null }, NOW).age_s,
    ).toBe(0);
    expect(() =>
      stampState(cls, { as_of: "x", fetched_at: "not a date", checked_at: null }, NOW),
    ).toThrow(RangeError);
    expect(() =>
      stampState(
        freshnessClass("nflverse_pbp"),
        { as_of: iso(0), fetched_at: iso(0), checked_at: "nope" },
        NOW,
      ),
    ).toThrow(RangeError);
    expect(() =>
      stampState(
        freshnessClass("manual_league"),
        { as_of: "nope", fetched_at: iso(0), checked_at: null },
        NOW,
      ),
    ).toThrow(RangeError);
    expect(() =>
      stampState(cls, { as_of: iso(0), fetched_at: iso(0), checked_at: null }, NaN),
    ).toThrow(RangeError);
  });
  it("property: for every class and basis instant, state equals classifyAge of the basis age", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...classes),
        fc.integer({ min: 0, max: 60 * 86_400 }),
        fc.integer({ min: 0, max: 60 * 86_400 }),
        (cls, fetchedAgo, checkedAgo) => {
          const t = {
            as_of: iso(fetchedAgo * 1000),
            fetched_at: iso(fetchedAgo * 1000),
            checked_at: iso(checkedAgo * 1000),
          };
          const st = stampState(cls, t, NOW);
          const basisAgo = cls.basis === "release" ? Math.min(fetchedAgo, checkedAgo) : fetchedAgo;
          expect(st.age_s).toBe(basisAgo);
          expect(st.state).toBe(cls.basis === "immutable" ? "fresh" : classifyAge(cls, basisAgo));
        },
      ),
    );
  });
});
