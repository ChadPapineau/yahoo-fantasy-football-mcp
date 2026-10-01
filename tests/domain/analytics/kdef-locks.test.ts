// kdef-locks.test.ts — QA-1-022, QA-1-059: E5 respects locks. A K/DEF whose game has started cannot
// be dropped or streamed for that week: a locked current starter means no move at his position, a
// locked candidate is not offered, and a stream's deadline is the earliest lock among everything the
// move touches — the starter it drops included (a Thursday kicker locks days before a Sunday one).
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefRequest,
} from "../../../src/domain/analytics/kdef.js";
import type { ProjectionReaders } from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { NflRosterPlayer } from "../../../src/domain/crosswalk/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  fixtureStamp,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";
import { recTextsFit } from "./helpers.js";

let data: FixtureData;
let settings: ScoringSettings;
let universe: KdefCandidateInput[];
let boswell: KdefCandidateInput;

const TUE = "2026-09-30T12:00:00.000Z";
const FRI = "2026-10-02T12:00:00.000Z"; // PIT@CLE (Thu 00:15 Z) has kicked off
const SUN = "2026-10-04T18:00:00.000Z"; // the 13:30 Z and 17:00 Z games have kicked off
const PIT_LOCK = "2026-10-02T00:15:00.000Z";

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  universe = kdefUniverse(data);
  const b = universe.find((u) => u.player_key === "manual.p.00-0031136");
  if (b === undefined) throw new Error("fixture: no Boswell");
  boswell = { ...b, availability: "T" };
});

/** Readers where my kicker is on a reserve list, so streaming over him is decisive. */
function readers(): ProjectionReaders {
  const row: NflRosterPlayer = {
    gsis_id: "00-0031136",
    season: 2026,
    week: 4,
    full_name: "Chris Boswell",
    team: "PIT",
    position: "K",
    jersey_number: 9,
    yahoo_id: null,
    sleeper_id: null,
    espn_id: null,
    pfr_id: null,
    status: "RES",
  };
  return {
    ...fixtureReaders(data),
    rosters: {
      latest: () => ({
        rows: [row],
        stamp: fixtureStamp("nflverse:roster_weekly", "2026-09-30T10:00:00.000Z"),
      }),
    },
  };
}

const run = (now: string, over: Partial<KdefRequest> = {}) =>
  analyzeKdef({
    positions: ["K"],
    season: 2026,
    week: 4,
    look_ahead: 0,
    universe,
    current: [boswell],
    availability_known: false,
    settings,
    readers: readers(),
    clock: fixedClock(now),
    rng: seededRng(1),
    ...over,
  }).analysis;

const kickoffOf = (team: string): number => {
  const g = data.games.find(
    (x) => x.season === 2026 && x.week === 4 && (x.home === team || x.away === team),
  );
  return Date.parse(g?.kickoff ?? "");
};

describe("QA-1-059 — the deadline is the earliest lock of every subject", () => {
  it("Tuesday: streaming over a Thursday kicker must happen before HIS lock", () => {
    const a = run(TUE);
    expect(a.rec.subjects.map((s) => [s.role, s.player_key])).toContainEqual([
      "drop",
      boswell.player_key,
    ]);
    expect(a.rec.latest_execution_time).toBe(PIT_LOCK);
  });
});

describe("QA-1-022 — locked players are never moved or offered", () => {
  it("Friday: my Thursday kicker is locked — no K move this week, and it says why", () => {
    const a = run(FRI);
    expect(a.rec.no_move).toBe(true);
    expect(a.rec.subjects.some((s) => s.role === "drop" || s.role === "stream")).toBe(false);
    expect(a.rec.assumptions.some((x) => x.text.includes("locked for week 4"))).toBe(true);
  });

  it("Sunday 18:00 Z: no candidate whose game has kicked off; a stream is still executable", () => {
    const a = run(SUN, { current: [] });
    const now = Date.parse(SUN);
    expect(a.candidates.length).toBeGreaterThan(0);
    for (const c of a.candidates) expect(kickoffOf(c.nfl_team ?? "")).toBeGreaterThan(now);
    if (!a.rec.no_move) {
      expect(a.rec.latest_execution_time).not.toBeNull();
      expect(Date.parse(a.rec.latest_execution_time ?? "")).toBeGreaterThan(now);
    }
  });

  it("a move is never no_move: false with latest_execution_time: null", () => {
    for (const now of [TUE, FRI, SUN, "2026-10-06T12:00:00.000Z"]) {
      for (const current of [[boswell], []]) {
        const a = run(now, { current, positions: ["K", "DEF"] });
        expect(recTextsFit(a.rec)).toBe(true);
        if (!a.rec.no_move) expect(a.rec.latest_execution_time).not.toBeNull();
      }
    }
  });
});
