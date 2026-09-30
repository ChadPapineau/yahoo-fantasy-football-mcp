// lineup.test.ts — plan 10 A7 replayed on the fixture league (fixtures/manual/league.yaml, Team A vs
// Team B) over fixture weeks 1–3 with v1-trailing projections: (a) `mean` realised regret ≤ the
// "start by last week's points" baseline (hard, weeks 2–3 — week 1 has no last week in the
// fixtures); (b) `pwin` vs `mean` regret reported; (c) `pwin`'s mode matches sign(μ_m − μ_o) on
// every matchup (hard); (d) every Dist carries basis position_cv; (e) ΔP(win) is always the
// {sign, band} form. The numbers are the generated tables of docs/evals/1a-backtest.md.
import { beforeAll, describe, expect, it } from "vitest";
import { type FixtureData, loadFixtureData } from "./helpers/fixture.js";
import { type FixtureLeague, fixtureLeague } from "./helpers/league.js";
import {
  docSection,
  type LineupReplay,
  lineupSection,
  replayLineups,
  walk,
  writeDocSection,
} from "./helpers/metrics.js";

let data: FixtureData;
let lg: FixtureLeague;
let replay: LineupReplay;

beforeAll(async () => {
  data = await loadFixtureData();
  lg = await fixtureLeague();
  replay = await replayLineups(data, lg);
  if (process.env.UPDATE_EVALS === "1") writeDocSection("lineup", lineupSection(replay.rows));
}, 60_000);

describe("A7 start/sit backtest (fixture weeks 1–3)", () => {
  it("replays two teams × three weeks", () => {
    expect(replay.rows).toHaveLength(6);
  });

  it("(a) mean regret ≤ start-by-last-week's-points regret over weeks 2–3 (hard)", () => {
    const w23 = replay.rows.filter((r) => r.week > 1);
    const mean = w23.reduce((s, r) => s + r.mean_regret, 0);
    const base = w23.reduce((s, r) => s + (r.last_week_regret ?? 0), 0);
    expect(mean).toBeLessThanOrEqual(base);
    for (const r of replay.rows) {
      expect(r.mean_regret).toBeGreaterThanOrEqual(0);
      expect(r.pwin_regret).toBeGreaterThanOrEqual(0);
    }
  });

  it("(c) pwin's mode is consistent with sign(μ_m − μ_o) on every matchup (hard)", () => {
    for (const r of replay.rows) expect(r.mode_consistent).toBe(true);
    for (const rec of replay.recs) {
      const d = rec.mode_basis.mu_m - rec.mode_basis.mu_o;
      if (rec.mode === "protect") expect(d).toBeGreaterThan(0);
      if (rec.mode === "chase") expect(d).toBeLessThan(0);
    }
  });

  it("(d) every Dist in every result carries basis position_cv; (e) ΔP(win) is {sign, band}", () => {
    let dists = 0;
    let deltas = 0;
    for (const o of replay.outputs) {
      walk(o, (k, v) => {
        if (k === "basis") {
          dists += 1;
          expect(v).toBe("position_cv");
        }
        if (k === "dist_basis") expect(v).toBe("position_cv");
        if (k === "delta_pwin") {
          deltas += 1;
          expect(typeof v).toBe("object");
          expect(Object.keys(v as object).sort()).toEqual(["band", "sign"]);
        }
      });
    }
    expect(dists).toBeGreaterThan(100);
    expect(deltas).toBeGreaterThan(0);
  });

  it("(b) the reported numbers in docs/evals/1a-backtest.md match this replay", () => {
    expect(docSection("lineup")).toBe(lineupSection(replay.rows));
  });
});
