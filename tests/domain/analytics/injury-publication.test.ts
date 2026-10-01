// injury-publication.test.ts — QA-1-021: a week's injury report is published team by team (the
// Thursday teams first, the rest Wednesday–Friday), and a report that does not exist yet is not a
// clean bill of health. Until a player's team has a week-w report, his availability is carried from
// the previous week's report (labelled as such); "not listed" means cleared only once his team's
// report for that week is out.
import { beforeAll, describe, expect, it } from "vitest";
import { pActive } from "../../../src/domain/analytics/availability.js";
import { P_ACTIVE } from "../../../src/domain/analytics/constants.js";
import {
  projectPlayers,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import type { InjuryReport } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
});

const KO = Date.parse("2026-10-04T17:00:00Z");
const row = (
  week: number,
  status: string | null,
  practice: string | null = null,
): InjuryReport => ({
  gsis_id: "00-0012345",
  season: 2026,
  week,
  nfl_team: "HOU",
  report_status: status,
  practice: practice === null ? [] : [{ day: "week", status: practice }],
  primary_injury: "Hamstring",
  secondary_injury: null,
  as_of: "2026-09-27T20:00:00Z",
});
const base = {
  report: null,
  injuriesLoaded: true,
  platformStatus: null,
  kickoffMs: KO,
  nowMs: KO - 4 * 24 * 3600 * 1000,
};

describe("QA-1-021 — pActive when this week's report is not published yet", () => {
  it("carries last week's designation (Out → 0, Doubtful, Questionable by practice)", () => {
    const carry = (r: InjuryReport | null) =>
      pActive({ ...base, reportPublished: false, priorPublished: true, priorReport: r });
    expect(carry(row(3, "Out"))).toEqual({ p: 0, basis: "designation_base_rate", carried_from: 3 });
    expect(carry(row(3, "Doubtful")).p).toBe(P_ACTIVE.doubtful);
    expect(carry(row(3, "Questionable", "Limited Participation in Practice"))).toEqual({
      p: P_ACTIVE.questionableByPractice.limited,
      basis: "trend_model",
      carried_from: 3,
    });
    // not on last week's report either: cleared then, nothing new since
    expect(carry(null)).toEqual({ p: 1, basis: "designation_base_rate" });
  });

  it("a published report wins over the carried one; a typed status wins over a carried one", () => {
    expect(
      pActive({ ...base, reportPublished: true, priorPublished: true, priorReport: row(3, "Out") }),
    ).toEqual({ p: 1, basis: "designation_base_rate" });
    expect(
      pActive({
        ...base,
        platformStatus: "Q",
        reportPublished: false,
        priorPublished: true,
        priorReport: row(3, "Out"),
      }).p,
    ).toBe(P_ACTIVE.questionable);
  });

  it("without the new fields the old contract holds (loaded and unlisted → active)", () => {
    expect(pActive({ ...base })).toEqual({ p: 1, basis: "designation_base_rate" });
    expect(pActive({ ...base, injuriesLoaded: false })).toEqual({ p: null, basis: "none" });
  });
});

describe("QA-1-021 — E1 on the fixture (week 4: only CLE and PIT have a report yet)", () => {
  const collins: ProjectionTarget = {
    player_key: "manual.p.00-0036554",
    subject: { kind: "player", gsis_id: "00-0036554" },
    name: "Nico Collins",
    position: "WR",
    nfl_team: "HOU",
    platform_status: null, // the manual user typed no status
  };
  const boswell: ProjectionTarget = {
    player_key: "manual.p.00-0031136",
    subject: { kind: "player", gsis_id: "00-0031136" },
    name: "Chris Boswell",
    position: "K",
    nfl_team: "PIT",
    platform_status: null,
  };
  const req = (week: number, targets: ProjectionTarget[]): ProjectionRequest => ({
    targets,
    season: 2026,
    weeks: [week],
    settings,
    readers: fixtureReaders(data),
    clock: fixedClock(beforeWeek(data, 4) + 12 * 3600 * 1000),
    rng: seededRng(1),
    n_sims: 1000,
  });

  it("Out on the week-3 report, HOU's week-4 report not out: p_active 0, said so", () => {
    const p = projectPlayers(req(4, [collins])).result.projections[0];
    expect(p?.weeks[0]?.p_active).toBe(0);
    expect(p?.weeks[0]?.points.mean).toBe(0);
    expect(p?.weeks[0]?.points.p_zero).toBe(1);
    expect(
      p?.assumptions.some((a) =>
        a.text.startsWith("week 4 injury report not published yet for HOU"),
      ),
    ).toBe(true);
    const w3 = projectPlayers(req(3, [collins])).result.projections[0];
    expect(w3?.weeks[0]?.p_active).toBe(0); // the published week-3 Out, unchanged
  });

  it("PIT's week-4 report is out and Boswell is not on it: cleared", () => {
    const p = projectPlayers(req(4, [boswell])).result.projections[0];
    expect(p?.weeks[0]?.p_active).toBe(1);
    expect(p?.weeks[0]?.p_active_basis).toBe("designation_base_rate");
    expect(p?.assumptions.some((a) => a.text.includes("not published yet"))).toBe(false);
  });
});
