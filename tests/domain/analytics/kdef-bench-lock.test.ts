// kdef-bench-lock.test.ts — QA-2-033: a lock applies to the locked player. A benched K/DEF whose game
// has started can be neither started nor dropped, but it does not freeze the position when the
// starter is still unlocked, and it is never the hold-vs-stream baseline (a player who cannot score
// for me this week). A locked STARTER still freezes his position (QA-1-022), and a K/DEF whose slot
// is unknown is read as a possible starter (the conservative reading).
//
// Week 5 of the fixture: TB@DAL kicks off Thu 2026-10-09 00:15 Z; KC and CAR are on bye; every other
// game is Sunday or Monday.
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefRequest,
} from "../../../src/domain/analytics/kdef.js";
import type { ProjectionReaders } from "../../../src/domain/analytics/projection.js";
import type { WaiverAnalysis } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { SlotClass } from "../../../src/domain/league/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";
import { recTextsFit } from "./helpers.js";

let data: FixtureData;
let settings: ScoringSettings;
let universe: KdefCandidateInput[];

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  universe = kdefUniverse(data);
});

/** Friday noon ET, Saturday, Sunday before the first Sunday kickoff: TB and DAL are locked. */
const AFTER_THU = [
  "2026-10-09T16:00:00.000Z",
  "2026-10-10T15:00:00.000Z",
  "2026-10-11T12:00:00.000Z",
];
const THU_TEAMS = ["DAL", "TB"] as const;
/** Unlocked starters: on bye (KC, CAR) or playing Sunday/Monday. */
const OPEN_STARTERS = ["KC", "CAR", "MIA", "NYG", "LA"] as const;

const def = (team: string, slot_class?: SlotClass | null): KdefCandidateInput => {
  const u = universe.find((x) => x.position === "DEF" && x.nfl_team === team);
  if (u === undefined) throw new Error(`fixture: no DEF ${team}`);
  return {
    ...u,
    availability: "T",
    ...(slot_class === undefined ? {} : { slot_class }),
  };
};

/** The fixture readers with the schedules release (and its lines) checked an hour before `now`. */
function freshReaders(now: string): ProjectionReaders {
  const r = fixtureReaders(data);
  const at = new Date(Date.parse(now) - 3600 * 1000).toISOString();
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

const run = (now: string, current: KdefCandidateInput[], over: Partial<KdefRequest> = {}) =>
  analyzeKdef({
    positions: ["DEF"],
    season: 2026,
    week: 5,
    look_ahead: 0,
    universe,
    current,
    availability_known: false,
    settings,
    readers: freshReaders(now),
    clock: fixedClock(now),
    rng: seededRng(1),
    ...over,
  }).analysis;

/** The decision a user acts on (all of it computed from the model's means). */
const decision = (a: WaiverAnalysis) => ({
  action: a.rec.action,
  no_move: a.rec.no_move,
  subjects: a.rec.subjects.map((s) => [s.role, s.player_key]),
  delta: a.rec.delta_vs_next.value,
  hold_vs_stream: a.hold_vs_stream,
  marginal: a.candidates.map((c) => [c.player_key, c.marginal_value.mean]),
});

describe("QA-2-033 — a locked BENCH K/DEF does not freeze the position or set the baseline", () => {
  it("adding a locked benched DEF never changes the call over an unlocked starter", () => {
    let streams = 0;
    for (const now of AFTER_THU) {
      for (const s of OPEN_STARTERS) {
        const alone = run(now, [def(s, "starter")]);
        for (const b of THU_TEAMS) {
          const both = run(now, [def(s, "starter"), def(b, "bench")]);
          expect(decision(both), `${now} ${s} + bench ${b}`).toEqual(decision(alone));
          // the locked bench DEF is neither the drop nor the baseline, and the lock is said
          expect(both.rec.subjects.some((x) => x.player_key === def(b).player_key)).toBe(false);
          expect(
            both.rec.assumptions.some((x) => x.text.includes(`benched DEF ${def(b).player_key}`)),
          ).toBe(true);
          expect(both.rec.assumptions.some((x) => x.text.includes("no DEF move"))).toBe(false);
          expect(recTextsFit(both.rec)).toBe(true);
        }
        if (!alone.rec.no_move) streams += 1;
      }
    }
    // not vacuous: a bye-week starter is streamed over at every clock
    expect(streams).toBeGreaterThanOrEqual(2 * AFTER_THU.length);
  });

  it("the finding's case: KC (bye) starts, DAL (played Thursday) benched — stream over KC", () => {
    const now = AFTER_THU[0] ?? "";
    const a = run(now, [def("KC", "starter"), def("DAL", "bench")]);
    expect(a.rec.no_move).toBe(false);
    expect(a.rec.subjects).toContainEqual(
      expect.objectContaining({ role: "drop", player_key: def("KC").player_key }),
    );
    // measured against KC (bye: 0 points), so the gain is the stream's whole mean
    const best = a.candidates[0];
    expect(a.hold_vs_stream?.current_starter_delta).toBeCloseTo(best?.marginal_value.mean ?? 0, 2);
    expect(best?.marginal_value.mean).toBeGreaterThan(5);
  });

  it("a locked STARTER still freezes the position, whatever is on the bench", () => {
    for (const now of AFTER_THU) {
      for (const s of THU_TEAMS) {
        for (const bench of [[], [def("KC", "bench")], [def("MIA", "bench")]]) {
          const a = run(now, [def(s, "starter"), ...bench]);
          expect(a.rec.no_move, `${now} ${s}`).toBe(true);
          expect(a.rec.subjects).toEqual([]);
          expect(
            a.rec.assumptions.some((x) =>
              x.text.includes(`your DEF ${def(s).player_key} is locked for week 5`),
            ),
          ).toBe(true);
        }
      }
    }
  });

  it("an unknown slot is read as a possible starter: locked → no move (the old, safe reading)", () => {
    for (const now of AFTER_THU) {
      for (const slot of [undefined, null] as const) {
        const a = run(now, [def("KC", "starter"), def("DAL", slot)]);
        expect(a.rec.no_move).toBe(true);
        expect(a.rec.subjects).toEqual([]);
      }
    }
  });

  it("before Thursday's kickoff nothing is locked: the bench DEF is a baseline like any other", () => {
    const tue = "2026-10-06T12:00:00.000Z";
    const a = run(tue, [def("KC", "starter"), def("DAL", "bench")]);
    expect(a.rec.assumptions.some((x) => x.text.includes("locked"))).toBe(false);
    // the baseline is the better of the two (DAL plays; KC is on bye)
    const withDal = run(tue, [def("DAL", "starter")]);
    expect(a.hold_vs_stream?.current_starter_delta).toBe(
      withDal.hold_vs_stream?.current_starter_delta,
    );
  });
});
