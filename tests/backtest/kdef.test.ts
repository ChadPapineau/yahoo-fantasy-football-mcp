// kdef.test.ts — plan 10 A8 replayed on the fixture league over fixture weeks 1–3:
// `ff_analyze_waivers(positions: [K, DEF])` returns ≥ 3 candidates per position with implied_total
// populated every week (hard); the model's rank correlation with realised points is reported against
// research 05 §8's two baselines — (a) last week's points, (b) the implied total (DEF: facing the
// lowest opponent implied total; K: the highest own implied total). Numbers: the generated table of
// docs/evals/1a-backtest.md.
import { beforeAll, describe, expect, it } from "vitest";
import { type FixtureData, loadFixtureData } from "./helpers/fixture.js";
import { fixtureLeague } from "./helpers/league.js";
import {
  docSection,
  kdefSection,
  type KdefReplay,
  replayKdef,
  walk,
  writeDocSection,
} from "./helpers/metrics.js";

let data: FixtureData;
let replay: KdefReplay;

beforeAll(async () => {
  data = await loadFixtureData();
  const lg = await fixtureLeague();
  replay = replayKdef(data, lg.settings);
  if (process.env.UPDATE_EVALS === "1") writeDocSection("kdef", kdefSection(replay.rows));
}, 60_000);

describe("A8 K/DEF backtest (fixture weeks 1–3)", () => {
  it("≥ 3 K and ≥ 3 DEF candidates per week, implied_total populated (hard)", () => {
    expect(replay.rows).toHaveLength(6);
    for (const r of replay.rows) {
      expect(r.candidates).toBeGreaterThanOrEqual(3);
      expect(r.implied_total_populated).toBe(true);
    }
  });

  it("availability is unknown under the manual league and every Dist is position_cv", () => {
    for (const o of replay.outcomes) {
      expect(o.availability_known).toBe(false);
      for (const c of o.analysis.candidates) expect(c.availability).toBe("unknown");
      walk(o, (k, v) => {
        if (k === "basis") expect(v).toBe("position_cv");
      });
    }
  });

  it("rank correlations are reported against both baselines (docs/evals/1a-backtest.md)", () => {
    for (const r of replay.rows) {
      expect(r.n).toBeGreaterThanOrEqual(20);
      if (r.rho_model !== null) expect(Math.abs(r.rho_model)).toBeLessThanOrEqual(1);
    }
    expect(docSection("kdef")).toBe(kdefSection(replay.rows));
  });
});
