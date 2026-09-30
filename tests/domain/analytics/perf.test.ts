// perf.test.ts — plan 10 A15 (the analytics share of it): `ff_project_players` for 32 players with
// n_sims = 4000 answers in < 3 s (sizes named: 32 fixture subjects — 28 players + 4 defences — × 1
// week × 4000 samples = 128 000 scored lines), and E5 K/DEF over the 64-subject universe with a
// 2-week look-ahead stays well inside the P0 budget once warm. The end-to-end latency test
// (tests/process/latency.test.ts) owns the tool-level numbers.
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeKdef } from "../../../src/domain/analytics/kdef.js";
import { projectPlayers, type ProjectionTarget } from "../../../src/domain/analytics/projection.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let targets: ProjectionTarget[];

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
  const seen = new Set<string>();
  const players: ProjectionTarget[] = [];
  for (const l of data.lines) {
    if (l.week !== 2 || seen.has(l.gsis_id) || players.length >= 28) continue;
    if (!["QB", "RB", "WR", "TE", "K"].includes(l.position)) continue;
    seen.add(l.gsis_id);
    players.push({
      player_key: null,
      subject: { kind: "player", gsis_id: l.gsis_id },
      name: l.gsis_id,
      position: l.position,
      nfl_team: l.nfl_team,
    });
  }
  const defs: ProjectionTarget[] = (["DET", "HOU", "PIT", "SEA"] as const).map((t) => ({
    player_key: null,
    subject: { kind: "defense", nfl_team: t },
    name: t,
    position: "DEF",
    nfl_team: t,
  }));
  targets = [...players, ...defs];
});

describe("latency (A15, analytics share)", () => {
  it("32 players × n_sims 4000 in < 3 s", () => {
    expect(targets).toHaveLength(32);
    const run = (): number => {
      const t0 = performance.now();
      const out = projectPlayers({
        targets,
        season: 2026,
        weeks: [3],
        settings,
        readers: fixtureReaders(data),
        clock: fixedClock(beforeWeek(data, 3)),
        rng: seededRng(1),
        n_sims: 4000,
      });
      expect(out.result.projections).toHaveLength(32);
      return performance.now() - t0;
    };
    run(); // warm (JIT, settings compile)
    // best of three: a parallel suite shares the CPU, and the budget is about the code, not the load
    const ms = Math.min(run(), run(), run());
    console.info(`[perf] ff_project_players 32 × 4000: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(3000);
  }, 60_000);

  it("E5 K/DEF over the 64-subject universe, look-ahead 2, warm", () => {
    const universe = kdefUniverse(data);
    const run = (): number => {
      const t0 = performance.now();
      analyzeKdef({
        positions: ["K", "DEF"],
        season: 2026,
        week: 3,
        universe,
        current: [],
        availability_known: false,
        settings,
        readers: fixtureReaders(data),
        clock: fixedClock(beforeWeek(data, 3)),
        rng: seededRng(1),
      });
      return performance.now() - t0;
    };
    run();
    const ms = Math.min(run(), run(), run());
    console.info(
      `[perf] ff_analyze_waivers K/DEF ${String(universe.length)} subjects: ${ms.toFixed(0)} ms`,
    );
    expect(ms).toBeLessThan(1500);
  }, 60_000);
});
