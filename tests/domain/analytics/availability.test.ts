// availability.test.ts — P(active) (research 05 §3.5 base rates; plan 07 D2 / OBJ-16 game-day
// status wins inside 3 h of kickoff), plus the inputs[] builder and the analytics error contract.
import { describe, expect, it } from "vitest";
import { pActive } from "../../../src/domain/analytics/availability.js";
import { GAME_DAY_WINDOW_MS, P_ACTIVE } from "../../../src/domain/analytics/constants.js";
import {
  AnalyticsError,
  INCOMPLETE_OPPONENT_HINT,
  NO_OPPONENT_HINT,
} from "../../../src/domain/analytics/errors.js";
import { collectInputs, mergeInputs, newestAsOf } from "../../../src/domain/analytics/inputs.js";
import type { DatasetStamp, InjuryReport } from "../../../src/domain/analytics/types.js";
import { fixedClock } from "../../../src/domain/clock.js";
import type { PlatformStamp } from "../../../src/domain/league/types.js";
import {
  MANUAL_INCOMPLETE_OPPONENT_HINT,
  MANUAL_NO_OPPONENT_HINT,
  SERVER_HINTS,
} from "../../../src/providers/platform.js";

const KO = Date.parse("2026-09-27T17:00:00Z");
const report = (status: string | null, practice: string | null = null): InjuryReport => ({
  gsis_id: "00-0012345",
  season: 2026,
  week: 3,
  nfl_team: "BUF",
  report_status: status,
  practice: practice === null ? [] : [{ day: "week", status: practice }],
  primary_injury: null,
  secondary_injury: null,
  as_of: "2026-09-26T20:00:00Z",
});
const base = {
  report: null,
  injuriesLoaded: true,
  platformStatus: null,
  kickoffMs: KO,
  nowMs: KO - 2 * 24 * 3600 * 1000,
};

describe("pActive", () => {
  it("official designations: Out 0, Doubtful 5.9 %, Questionable 71 %", () => {
    expect(pActive({ ...base, report: report("Out") })).toEqual({
      p: 0,
      basis: "designation_base_rate",
    });
    expect(pActive({ ...base, report: report("Doubtful") }).p).toBe(0.059);
    expect(pActive({ ...base, report: report("Questionable") })).toEqual({
      p: 0.71,
      basis: "designation_base_rate",
    });
  });
  it("the last practice level refines Questionable (trend_model)", () => {
    const q = (s: string): number | null =>
      pActive({ ...base, report: report("Questionable", s) }).p;
    expect(q("Full Participation in Practice")).toBe(P_ACTIVE.questionableByPractice.full);
    expect(q("Limited Participation in Practice")).toBe(P_ACTIVE.questionableByPractice.limited);
    expect(q("Did Not Participate In Practice")).toBe(P_ACTIVE.questionableByPractice.dnp);
    expect(
      pActive({ ...base, report: report("Questionable", "Full Participation in Practice") }).basis,
    ).toBe("trend_model");
    expect(q("something else entirely")).toBe(0.71);
  });
  it("no designation on the report (or not listed) → active; hostile text is not a designation", () => {
    expect(pActive({ ...base, report: report(null, "Did Not Participate In Practice") }).p).toBe(1);
    expect(pActive({ ...base, report: report("OUT‮<script>") }).p).toBe(1);
    expect(pActive({ ...base }).p).toBe(1);
  });
  it("the provider's roster status is used when the report says nothing", () => {
    expect(pActive({ ...base, platformStatus: "IR" }).p).toBe(0);
    expect(pActive({ ...base, platformStatus: "o" }).p).toBe(0);
    expect(pActive({ ...base, platformStatus: "D" }).p).toBe(0.059);
    expect(pActive({ ...base, platformStatus: "Q" }).p).toBe(0.71);
    expect(pActive({ ...base, platformStatus: "P" }).p).toBe(1);
  });
  it("nothing loaded → p null, basis none", () => {
    expect(pActive({ ...base, injuriesLoaded: false })).toEqual({ p: null, basis: "none" });
  });
  it("a game-day status wins only inside the window (OBJ-16)", () => {
    const gd = { status: "O" };
    const inside = {
      ...base,
      report: report("Questionable"),
      gameDayStatus: gd,
      nowMs: KO - GAME_DAY_WINDOW_MS,
    };
    expect(pActive(inside)).toEqual({ p: 0, basis: "yahoo_gameday_status" });
    expect(pActive({ ...inside, nowMs: KO - GAME_DAY_WINDOW_MS - 1 }).basis).toBe(
      "designation_base_rate",
    );
    expect(pActive({ ...inside, gameDayStatus: { status: null } }).p).toBe(1);
    expect(pActive({ ...inside, gameDayStatus: { status: "Q" } }).p).toBe(0.71);
    expect(pActive({ ...inside, kickoffMs: null }).basis).toBe("designation_base_rate");
    expect(pActive({ ...inside, nowMs: KO + 60_000 }).basis).toBe("yahoo_gameday_status");
  });
});

const dstamp = (source: DatasetStamp["source"], asOf: string, fetched: string): DatasetStamp => ({
  source,
  as_of: asOf,
  fetched_at: fetched,
  checked_at: fetched,
  freshness_class: source === "nflverse:schedules" ? "nflverse_schedules" : "nflverse_injuries",
  file_version: "v1",
});

describe("inputs", () => {
  it("one entry per source, newest as_of wins, sorted, nulls skipped", () => {
    const clock = fixedClock("2026-09-30T12:00:00Z");
    const out = collectInputs(
      [
        dstamp("nflverse:schedules", "2026-09-29T00:00:00Z", "2026-09-30T11:00:00Z"),
        null,
        undefined,
        dstamp("nflverse:injuries", "2026-09-28T00:00:00Z", "2026-09-30T11:59:00Z"),
        dstamp("nflverse:schedules", "2026-09-30T00:00:00Z", "2026-09-30T11:30:00Z"),
        dstamp("nflverse:schedules", "2026-09-01T00:00:00Z", "2026-09-30T11:30:00Z"),
      ],
      clock,
    );
    expect(out.map((i) => i.source)).toEqual(["nflverse:injuries", "nflverse:schedules"]);
    expect(out[1]).toEqual({
      source: "nflverse:schedules",
      as_of: "2026-09-30T00:00:00.000Z",
      age_s: 1800,
      freshness: "fresh",
    });
  });
  it("a provisional platform stamp reads provisional; an old one stale", () => {
    const clock = fixedClock("2026-09-30T12:00:00Z");
    const ps: PlatformStamp = {
      source: "manual",
      as_of: "2026-09-30T10:00:00Z",
      fetched_at: "2026-09-30T11:59:00Z",
      freshness: "manual_league",
      provisional: true,
    };
    expect(collectInputs([ps], clock)[0]?.freshness).toBe("provisional");
    const old = dstamp("nflverse:injuries", "2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z");
    expect(collectInputs([old], clock)[0]?.freshness).toBe("stale");
  });
  it("mergeInputs keeps the newest per source; newestAsOf falls back and skips junk", () => {
    const a = {
      source: "x",
      as_of: "2026-09-01T00:00:00.000Z",
      age_s: 1,
      freshness: "fresh" as const,
    };
    const b = { ...a, as_of: "2026-09-02T00:00:00.000Z" };
    const c = { ...a, source: "a" };
    expect(mergeInputs([a], [b, c])).toEqual([c, b]);
    expect(mergeInputs([b], [a])).toEqual([b]);
    expect(newestAsOf([a, b, { as_of: "not a date" }], "F")).toBe("2026-09-02T00:00:00.000Z");
    expect(newestAsOf([], "F")).toBe("F");
  });
});

describe("AnalyticsError", () => {
  it("no_opponent carries NOT_FOUND and the server hint byte-for-byte", () => {
    const e = new AnalyticsError("no_opponent", "x");
    expect(e.ffCode).toBe("NOT_FOUND");
    expect(e.ffHint).toBe(MANUAL_NO_OPPONENT_HINT);
    expect(NO_OPPONENT_HINT).toBe(MANUAL_NO_OPPONENT_HINT);
    expect(SERVER_HINTS.has(e.ffHint ?? "")).toBe(true);
    // QA-1-069: the hint says what to add where
    expect(NO_OPPONENT_HINT).toMatch(/under opponents/);
    expect(NO_OPPONENT_HINT).toMatch(/other_teams/);
  });
  it("incomplete_opponent → NOT_FOUND with a server hint the mapper honours [QA-1-043]", () => {
    const e = new AnalyticsError("incomplete_opponent", "x");
    expect(e.ffCode).toBe("NOT_FOUND");
    expect(e.ffHint).toBe(INCOMPLETE_OPPONENT_HINT);
    expect(INCOMPLETE_OPPONENT_HINT).toBe(MANUAL_INCOMPLETE_OPPONENT_HINT);
    expect(SERVER_HINTS.has(e.ffHint ?? "")).toBe(true);
  });
  it("other codes map without a hint; detail is capped", () => {
    const e = new AnalyticsError(
      "dataset_never_loaded",
      "y",
      Array.from({ length: 30 }, () => "z".repeat(500)),
    );
    expect(e.ffCode).toBe("STALE_ONLY");
    expect(e.ffHint).toBeUndefined();
    expect(e.detail).toHaveLength(10);
    expect(e.detail.every((d) => d.length === 80)).toBe(true);
    expect(new AnalyticsError("invalid_request", "z").ffCode).toBe("VALIDATION");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AnalyticsError");
  });
});
