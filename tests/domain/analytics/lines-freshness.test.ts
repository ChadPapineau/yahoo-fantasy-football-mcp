// lines-freshness.test.ts — QA-1-004: betting lines have their own freshness class (plan 01 §5.4:
// "Lines | 30 min | 24 h | omitted driver — not an error, the recommendation says the driver is
// missing"). When the schedules release (which carries the lines) was last checked more than 24 h
// ago, the target weeks' lines are omitted: no implied-total scaling, no implied totals in K/DEF,
// and the omission is named — even though the schedule itself (7-day limit) is still served.
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeKdef } from "../../../src/domain/analytics/kdef.js";
import {
  projectPlayers,
  type ProjectionReaders,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
});

const NOW = Date.parse("2026-10-01T12:00:00Z"); // before week 4's first kickoff
const ALLEN: ProjectionTarget = {
  player_key: "manual.p.00-0034857",
  subject: { kind: "player", gsis_id: "00-0034857" },
  name: "Josh Allen",
  position: "QB",
  nfl_team: "BUF",
  platform_status: null,
};

/** The fixture readers with the schedules release last checked (and fetched) `ageH` hours ago. */
function readers(ageH: number): ProjectionReaders {
  const r = fixtureReaders(data);
  const at = new Date(NOW - ageH * 3600 * 1000).toISOString();
  return {
    ...r,
    schedules: {
      ...r.schedules,
      games: (season, weeks) => {
        const g = r.schedules.games(season, weeks);
        return g.stamp === null
          ? g
          : { rows: g.rows, stamp: { ...g.stamp, fetched_at: at, checked_at: at } };
      },
    },
  };
}

const e1 = (ageH: number) =>
  projectPlayers({
    targets: [ALLEN],
    season: 2026,
    weeks: [4],
    settings,
    readers: readers(ageH),
    clock: fixedClock(NOW),
    rng: seededRng(1),
    n_sims: 1000,
  }).result.projections[0];

describe("QA-1-004 — betting lines past their 24 h limit are omitted and named", () => {
  it("E1: a 4-day-old release check drops the implied total and says why; a fresh one keeps it", () => {
    const fresh = e1(2);
    expect(fresh?.weeks[0]?.implied_total).not.toBeNull();
    expect(fresh?.multipliers.matchup).not.toBeNull();
    const old = e1(4 * 24);
    expect(old?.weeks[0]?.implied_total).toBeNull();
    expect(old?.multipliers.matchup).toBeNull();
    expect(old?.assumptions.some((a) => a.text.startsWith("betting lines omitted"))).toBe(true);
    expect(old?.assumptions.some((a) => a.text.startsWith("no betting line"))).toBe(true);
    // the trailing base itself is untouched (only the line-driven driver is omitted)
    const base = (p: typeof old) => p?.drivers.find((d) => d.name === "trailing_mean");
    expect(base(old)).toEqual(base(fresh));
    // 23 h is still inside the hard limit
    expect(e1(23)?.weeks[0]?.implied_total).not.toBeNull();
  });

  it("E5: K/DEF candidates carry no implied totals and the rec names the omitted driver", () => {
    const out = analyzeKdef({
      positions: ["K", "DEF"],
      season: 2026,
      week: 4,
      look_ahead: 0,
      universe: kdefUniverse(data),
      current: [],
      availability_known: false,
      settings,
      readers: readers(4 * 24),
      clock: fixedClock(NOW),
      rng: seededRng(1),
    }).analysis;
    for (const c of out.candidates) {
      expect(c.kdef?.implied_total).toBeNull();
      expect(c.kdef?.opp_implied_total).toBeNull();
      expect(c.signals.some((s) => s.kind === "implied_total")).toBe(false);
    }
    expect(out.rec.assumptions.some((a) => a.text.startsWith("betting lines omitted"))).toBe(true);
  });
});
