// work-bound.test.ts — QA-1-079: every in-bounds E1 call does bounded work. The worst request the
// tool accepts (50 pool players × a 6-week horizon × n_sims 20 000 = 6 M simulated lines) stalled the
// stdio loop ~17 s, past the 10 s shutdown ceiling, to return 5 of the 40 projections. The engine
// caps the simulated lines of one call at SIMS.maxTotalLines (sharing them evenly per player-week,
// never below the public floor of SIMS.min) and says so; a small request keeps its n_sims exactly.
import { beforeAll, describe, expect, it } from "vitest";
import { SIMS } from "../../../src/domain/analytics/constants.js";
import { projectPlayers, type ProjectionTarget } from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { scoringEngine } from "../../../src/domain/scoring/engine.js";
import type { ScoringEngine, ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let targets: ProjectionTarget[];

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  const seen = new Set<string>();
  targets = [];
  for (const l of data.lines) {
    if (seen.has(l.gsis_id) || targets.length >= 50) continue;
    if (!["QB", "RB", "WR", "TE", "K"].includes(l.position)) continue;
    seen.add(l.gsis_id);
    targets.push({
      player_key: null,
      subject: { kind: "player", gsis_id: l.gsis_id },
      name: l.gsis_id,
      position: l.position,
      nfl_team: l.nfl_team,
    });
  }
});

/** The real engine, counting every simulated line it scores. */
function counting(): { engine: ScoringEngine; lines: () => number; sizes: Set<number> } {
  let n = 0;
  const sizes = new Set<number>();
  return {
    engine: {
      ...scoringEngine,
      scoreSamples: (lines, s, basis) => {
        n += lines.length;
        sizes.add(lines.length);
        return scoringEngine.scoreSamples(lines, s, basis);
      },
    },
    lines: () => n,
    sizes,
  };
}

const run = (tg: ProjectionTarget[], weeks: number[], nSims: number, engine: ScoringEngine) =>
  projectPlayers({
    targets: tg,
    season: 2026,
    weeks,
    settings,
    readers: fixtureReaders(data),
    clock: fixedClock(beforeWeek(data, 4)),
    rng: seededRng(1),
    n_sims: nSims,
    engine,
  });

describe("QA-1-079 — one E1 call simulates a bounded number of lines", () => {
  it("50 players × 6 weeks × 20 000: at most SIMS.maxTotalLines lines, and the reduction is named", () => {
    expect(targets).toHaveLength(50);
    const c = counting();
    const out = run(targets, [4, 5, 6, 7, 8, 9], 20000, c.engine);
    expect(c.lines()).toBeLessThanOrEqual(SIMS.maxTotalLines);
    expect(out.result.projections).toHaveLength(50);
    for (const p of out.result.projections) {
      expect(p.assumptions.some((a) => a.text.startsWith("n_sims reduced to"))).toBe(true);
    }
  });

  it("a request inside the budget keeps its n_sims and says nothing", () => {
    const c = counting();
    const out = run(targets.slice(0, 4), [4], 20000, c.engine);
    expect(c.lines()).toBe(4 * 20000);
    for (const p of out.result.projections) {
      expect(p.assumptions.some((a) => a.text.startsWith("n_sims reduced to"))).toBe(false);
    }
  });

  it("never below the public floor: 64 players × 14 weeks still draws SIMS.min per player-week", () => {
    const c = counting();
    const many = [...targets, ...targets.slice(0, 14)].map((t, i) => ({ ...t, name: String(i) }));
    const weeks = Array.from({ length: 14 }, (_, i) => i + 4);
    run(many, weeks, 20000, c.engine);
    expect([...c.sizes]).toEqual([SIMS.min]); // every simulated player-week (byes draw none)
    expect(c.lines()).toBeLessThanOrEqual(many.length * weeks.length * SIMS.min);
  });
});
