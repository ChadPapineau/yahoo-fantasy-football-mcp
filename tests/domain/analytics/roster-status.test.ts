// roster-status.test.ts — QA-1-030: a player on an NFL reserve list (nflverse roster_weekly status
// RES — injured reserve) never appears on the weekly injury report, so the report alone reads him as
// cleared. His newest roster status (at or before the target week) makes him unavailable: p_active 0,
// zero points, said so. INA (a game-day inactive) applies to its own week only; a status from a later
// week is never read (no look-ahead leak in a backtest).
import { beforeAll, describe, expect, it } from "vitest";
import { pActive } from "../../../src/domain/analytics/availability.js";
import {
  projectPlayers,
  type ProjectionReaders,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { NflRosterPlayer } from "../../../src/domain/crosswalk/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  fixtureStamp,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
});

const CHASE: ProjectionTarget = {
  player_key: "manual.p.00-0036900",
  subject: { kind: "player", gsis_id: "00-0036900" },
  name: "Ja'Marr Chase",
  position: "WR",
  nfl_team: "CIN",
  platform_status: null,
};
const rosterRow = (status: string, week: number): NflRosterPlayer => ({
  gsis_id: "00-0036900",
  season: 2026,
  week,
  full_name: "Ja'Marr Chase",
  team: "CIN",
  position: "WR",
  jersey_number: 1,
  yahoo_id: null,
  sleeper_id: null,
  espn_id: null,
  pfr_id: null,
  status,
});
const readers = (rows: NflRosterPlayer[] | null): ProjectionReaders => ({
  ...fixtureReaders(data),
  ...(rows === null
    ? {}
    : {
        rosters: {
          latest: () => ({
            rows,
            stamp: fixtureStamp("nflverse:roster_weekly", "2026-09-30T10:00:00.000Z"),
          }),
        },
      }),
});
const req = (week: number, rows: NflRosterPlayer[] | null): ProjectionRequest => ({
  targets: [CHASE],
  season: 2026,
  weeks: [week],
  settings,
  readers: readers(rows),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(3),
  n_sims: 1000,
});
const one = (r: ProjectionRequest) => {
  const p = projectPlayers(r).result.projections[0];
  if (p === undefined) throw new Error("no projection");
  return p;
};

describe("QA-1-030 — NFL roster status in P(active)", () => {
  it("pActive: RES / CUT / RET / SUS / UFA read 0 after a clean report; ACT and unknown codes say nothing", () => {
    const b = {
      report: null,
      injuriesLoaded: true,
      platformStatus: null,
      kickoffMs: null,
      nowMs: 0,
    };
    for (const s of ["RES", "CUT", "RET", "SUS", "UFA", "res"]) {
      expect(pActive({ ...b, rosterStatus: s })).toEqual({ p: 0, basis: "designation_base_rate" });
    }
    for (const s of ["ACT", "DEV", "XYZ", null]) {
      expect(pActive({ ...b, rosterStatus: s })).toEqual({ p: 1, basis: "designation_base_rate" });
    }
  });

  it("E1: RES in week 3 → week 3 and later weeks project 0 with the reason named", () => {
    for (const week of [3, 4]) {
      const p = one(req(week, [rosterRow("RES", 3)]));
      expect(p.weeks[0]?.p_active).toBe(0);
      expect(p.weeks[0]?.points.mean).toBe(0);
      expect(p.assumptions.some((a) => a.text.startsWith("NFL roster status RES"))).toBe(true);
    }
    expect(one(req(3, null)).weeks[0]?.p_active).toBe(1); // no roster reader: the old behaviour
    expect(one(req(3, [rosterRow("ACT", 3)])).weeks[0]?.p_active).toBe(1);
  });

  it("a status from a later week is never read; INA applies to its own week only", () => {
    expect(one(req(3, [rosterRow("RES", 4)])).weeks[0]?.p_active).toBe(1);
    expect(one(req(3, [rosterRow("INA", 3)])).weeks[0]?.p_active).toBe(0);
    expect(one(req(4, [rosterRow("INA", 3)])).weeks[0]?.p_active).toBe(1);
  });
});
