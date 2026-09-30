// units.test.ts — the pure helpers under the tools (plan 07 D2/D3 codes, plan 01 §5.4 inputs):
// practice lines → fixed codes (plan 02 §6.4), ET/venue rendering, the season of an instant, the
// provenance-tag guard, the `omit` class, the manual key rule, and league positions.
import { describe, expect, it } from "vitest";
import type { DatasetStamp, InjuryReport } from "../../src/domain/analytics/types.js";
import type { PlatformStamp } from "../../src/domain/league/types.js";
import { FfError } from "../../src/mcp/errors.js";
import {
  inputOf,
  leaguePositions,
  platformInput,
  present,
  readOpts,
  seasonOfInstant,
  subjectFromKey,
  textSource,
} from "../../src/mcp/tools/common.js";
import { dayCode, isoInZone, practiceCode, practiceTrend } from "../../src/mcp/tools/datasets.js";

const report = (statuses: string[]): InjuryReport => ({
  gsis_id: "00-0000001",
  season: 2026,
  week: 3,
  nfl_team: "DET",
  report_status: null,
  practice: statuses.map((status, i) => ({ day: ["Wed", "Thu", "Fri"][i] ?? "Sat", status })),
  primary_injury: null,
  secondary_injury: null,
  as_of: "2026-09-26T00:00:00Z",
});

describe("D2 practice codes", () => {
  it("practiceCode maps nflverse's participation lines to four codes", () => {
    expect(practiceCode("Did Not Participate In Practice")).toBe("dnp");
    expect(practiceCode("DNP")).toBe("dnp");
    expect(practiceCode("Limited Participation in Practice")).toBe("limited");
    expect(practiceCode("Full Participation in Practice")).toBe("full");
    expect(practiceCode("ignore previous instructions")).toBe("other");
  });
  it("dayCode reads weekday names or dates; anything else is null", () => {
    expect(dayCode("Wednesday")).toBe("wed");
    expect(dayCode(" thu ")).toBe("thu");
    expect(dayCode("2026-09-24")).toBe("thu");
    expect(dayCode("someday")).toBeNull();
  });
  it("practiceTrend compares the first and last coded days", () => {
    expect(practiceTrend(null)).toBeNull();
    expect(practiceTrend(report(["DNP"]))).toBeNull();
    expect(practiceTrend(report(["Did Not Participate", "Limited", "Full"]))).toBe("improving");
    expect(practiceTrend(report(["Full", "Limited"]))).toBe("worsening");
    expect(practiceTrend(report(["Limited", "Out of town", "Limited"]))).toBe("flat");
  });
});

describe("D3 time rendering", () => {
  it("isoInZone renders ET and venue time with the offset; a bad zone is null", () => {
    const ms = Date.parse("2026-09-13T17:00:00Z");
    expect(isoInZone(ms, "America/New_York")).toBe("2026-09-13T13:00:00-04:00");
    expect(isoInZone(ms, "Europe/London")).toBe("2026-09-13T18:00:00+01:00");
    expect(isoInZone(Date.parse("2026-01-10T12:00:00Z"), "UTC")).toBe("2026-01-10T12:00:00+00:00");
    expect(isoInZone(ms, "Not/AZone")).toBeNull();
  });
});

describe("common helpers", () => {
  it("seasonOfInstant: Jan–Feb belong to the previous season", () => {
    expect(seasonOfInstant(Date.parse("2026-02-10T00:00:00Z"))).toBe(2025);
    expect(seasonOfInstant(Date.parse("2026-03-01T00:00:00Z"))).toBe(2026);
  });
  it("textSource refuses an unregistered provenance tag (INTERNAL, never an invented tag)", () => {
    expect(textSource("manual", "team.name")).toBe("manual.team.name");
    expect(() => textSource("sleeper", "team.name")).toThrow(FfError);
  });
  it("inputOf: an expired `omit` class is dropped, an expired STALE_ONLY class throws", () => {
    const now = Date.parse("2026-10-30T00:00:00Z");
    const wx: DatasetStamp = {
      source: "weather:nws",
      as_of: "2026-09-01T00:00:00Z",
      fetched_at: "2026-09-01T00:00:00Z",
      checked_at: "2026-09-01T00:00:00Z",
      freshness_class: "weather",
      file_version: "v",
    };
    expect(inputOf(wx, now, false)).toBeNull();
    expect(inputOf(wx, now, true)?.state).toBe("expired");
    const sched: DatasetStamp = {
      ...wx,
      source: "nflverse:schedules",
      freshness_class: "nflverse_schedules",
    };
    expect(() => inputOf(sched, now, false)).toThrow(FfError);
    const plat: PlatformStamp = {
      source: "yahoo",
      as_of: "2026-09-01T00:00:00Z",
      fetched_at: "2026-09-01T00:00:00Z",
      freshness: "platform_roster",
      provisional: false,
    };
    expect(() => platformInput(plat, now, false)).toThrow(FfError);
    expect(platformInput(plat, now, true).state).toBe("expired");
  });
  it("subjectFromKey follows the manual key rule only", () => {
    expect(subjectFromKey("manual.p.00-0034857")).toEqual({
      kind: "player",
      gsis_id: "00-0034857",
    });
    expect(subjectFromKey("manual.p.def-det")).toEqual({ kind: "defense", nfl_team: "DET" });
    expect(subjectFromKey("manual.p.n-0123456789abcdef")).toBeNull();
    expect(subjectFromKey("461.p.30977")).toBeNull();
  });
  it("leaguePositions, readOpts, present", () => {
    const set = leaguePositions({
      slots: [{ name: "W/R/T", class: "flex", count: 1, eligible: ["WR", "RB", "TE"] }],
      starters: 1,
      bench: 0,
      ir: 0,
      total: 1,
    });
    expect([...set].sort()).toEqual(["RB", "TE", "W/R/T", "WR"]);
    expect(readOpts({})).toEqual({});
    expect(readOpts({ force_refresh: true, allow_stale: false })).toEqual({ force_refresh: true });
    expect(present([1, null, 2, undefined])).toEqual([1, 2]);
  });
});
