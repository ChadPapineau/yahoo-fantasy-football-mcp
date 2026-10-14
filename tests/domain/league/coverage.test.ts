// coverage.test.ts — src/domain/league/coverage.ts (season-fresh spec §3.3): the four coverage
// states over seasons 2026–2030, including the September case that used to read as an outage — the
// injuries file still holds only S−1 and upstream has not published S yet (a recent season_check).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { freshnessClass, type DatasetSourceId } from "../../../src/config/freshness.js";
import type { DatasetStamp, SeasonCheckRow } from "../../../src/domain/analytics/types.js";
import { datasetCoverage } from "../../../src/domain/league/coverage.js";
import type { SeasonPhase, SeasonPhaseName } from "../../../src/domain/league/season.js";

const H = 3_600_000;
const INJ_HARD = freshnessClass("nflverse_injuries").hardLimitSeconds; // 36 h
const iso = (ms: number): string => new Date(ms).toISOString();

const phase = (season: number, p: SeasonPhaseName = "regular"): SeasonPhase => ({
  season,
  phase: p,
  week: 1,
  next_kickoff: null,
  next_season_published: false,
  basis: "schedule",
});
const stamp = (
  seasons: readonly number[] | undefined,
  at: number,
  source: DatasetSourceId = "nflverse:injuries",
): DatasetStamp => ({
  source,
  as_of: iso(at),
  fetched_at: iso(at),
  checked_at: iso(at),
  freshness_class: "nflverse_injuries",
  file_version: "v",
  ...(seasons === undefined ? {} : { seasons }),
});
const check = (
  season: number,
  at: number,
  status: SeasonCheckRow["status"] = "not_published",
  source: DatasetSourceId = "nflverse:injuries",
): SeasonCheckRow => ({
  source,
  season,
  checked_at: iso(at),
  status,
});

describe("datasetCoverage", () => {
  it("the September case: S−1 in the file, S not published upstream (checked within 36 h) → not_published", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2026, max: 2030 }),
        fc.integer({ min: 0, max: 36 * 60 }),
        (S, agoMin) => {
          const now = Date.UTC(S, 8, 10, 15);
          const c = datasetCoverage({
            stamp: stamp([S - 1], now - 2 * H),
            season: S,
            phase: phase(S, "regular"),
            check: check(S, now - agoMin * 60_000),
            hardLimitSeconds: INJ_HARD,
            nowMs: now,
          });
          expect(c).toEqual({
            state: "not_published",
            season: S,
            checked_at: iso(now - agoMin * 60_000),
          });
        },
      ),
    );
  });

  it("a season check older than the hard limit, of another season or source, or published → missing", () => {
    const S = 2028;
    const now = Date.UTC(S, 8, 10, 15);
    const base = {
      stamp: stamp([S - 1], now - 2 * H),
      season: S,
      phase: phase(S),
      hardLimitSeconds: INJ_HARD,
      nowMs: now,
    };
    const missing = { state: "missing", season: S, checked_at: null };
    expect(datasetCoverage({ ...base, check: check(S, now - 37 * H) })).toEqual(missing);
    expect(datasetCoverage({ ...base, check: check(S - 1, now - H) })).toEqual(missing);
    expect(datasetCoverage({ ...base, check: check(S, now - H, "published") })).toEqual(missing);
    expect(
      datasetCoverage({ ...base, check: check(S, now - H, "not_published", "weather:nws") }),
    ).toEqual(missing);
    expect(
      datasetCoverage({ ...base, check: { ...check(S, now), checked_at: "garbage" } }),
    ).toEqual(missing);
    expect(datasetCoverage({ ...base, check: null })).toEqual(missing);
  });

  it("never loaded: a recent not-published check still names the state; no check is missing", () => {
    const now = Date.UTC(2029, 8, 3);
    const c = {
      stamp: null,
      season: 2029,
      phase: phase(2029, "preseason"),
      hardLimitSeconds: INJ_HARD,
      nowMs: now,
    };
    expect(datasetCoverage({ ...c, check: check(2029, now - H) }).state).toBe("not_published");
    expect(datasetCoverage({ ...c, check: null }).state).toBe("missing");
    // no hard limit: any not-published check counts
    expect(
      datasetCoverage({ ...c, hardLimitSeconds: null, check: check(2029, now - 900 * H) }).state,
    ).toBe("not_published");
  });

  it("covered in the phase season; complete before it (finished data does not age)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2026, max: 2030 }),
        fc.integer({ min: 0, max: 3 }),
        (S, back) => {
          const now = Date.UTC(S, 10, 1);
          const s = S - back;
          const c = datasetCoverage({
            stamp: stamp([S - 3, S - 2, S - 1, S], now - H),
            season: s,
            phase: phase(S),
            check: null,
            hardLimitSeconds: INJ_HARD,
            nowMs: now,
          });
          expect(c).toEqual({
            state: back === 0 ? "covered" : "complete",
            season: s,
            checked_at: iso(now - H),
          });
        },
      ),
    );
  });

  it("a stamp without seasons is judged as today (covered / complete by the phase)", () => {
    const now = Date.UTC(2027, 10, 1);
    const st = stamp(undefined, now - H);
    const at = (season: number) =>
      datasetCoverage({
        stamp: st,
        season,
        phase: phase(2027),
        check: null,
        hardLimitSeconds: INJ_HARD,
        nowMs: now,
      }).state;
    expect(at(2027)).toBe("covered");
    expect(at(2026)).toBe("complete");
    expect(at(2028)).toBe("covered");
  });
});
