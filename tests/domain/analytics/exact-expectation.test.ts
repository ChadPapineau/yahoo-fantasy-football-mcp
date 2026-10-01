// exact-expectation.test.ts — QA-1-003, QA-1-023, QA-1-024, QA-1-025: the engines' decisions and
// point estimates come from the model's expectation, never from simulation noise. A Dist's `mean`
// is the model's expected points (a deterministic quadrature over the same gamma width the samples
// are drawn from), so it — and every ranking, lineup choice and stream call built on it — is
// identical for every seed; only the sampled quantiles move. The drivers decompose that mean
// exactly: `availability` is (p_active − 1) × E[active], 0 for a player certain to play.
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefRequest,
} from "../../../src/domain/analytics/kdef.js";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import {
  projectPlayers,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import { fixedClock, MAX_SEED, seededRng, seedFrom } from "../../../src/domain/clock.js";
import { gammaCdf, gammaNodes, gammaQuantile } from "../../../src/domain/analytics/math.js";
import type { RosterEntry } from "../../../src/domain/league/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import type { RosterSlots } from "../../../src/domain/league/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import {
  beforeWeek,
  fixtureLeague,
  kdefUniverse,
  lineupPlayersFor,
  TEAM_A,
  targetsFor,
} from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let slots: RosterSlots;
let entries: readonly RosterEntry[];
let targets: ProjectionTarget[];
let universe: KdefCandidateInput[];

beforeAll(async () => {
  data = await loadFixtureData();
  const lg = await fixtureLeague();
  settings = lg.settings;
  slots = lg.slots;
  entries = (await lg.provider.getRoster(TEAM_A, 3)).value.entries;
  targets = targetsFor(entries);
  universe = kdefUniverse(data);
});

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

const e1 = (seed: number, over: Partial<ProjectionRequest> = {}): ProjectionRequest => ({
  targets,
  season: 2026,
  weeks: [3],
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(seed),
  n_sims: 1000,
  ...over,
});

const e5 = (seed: number, over: Partial<KdefRequest> = {}): KdefRequest => ({
  positions: ["K", "DEF"],
  season: 2026,
  week: 3,
  universe,
  current: [],
  availability_known: false,
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(seed),
  ...over,
});

describe("QA-1-024/025 — a Dist's mean is the model's expectation, identical for every seed", () => {
  it("every player's mean (and ROS total mean) is seed-independent; quantiles still come from samples", () => {
    const means = SEEDS.map((s) =>
      projectPlayers(e1(s, { weeks: [3, 4] })).result.projections.map((p) => [
        p.player_key,
        p.weeks.map((w) => w.points.mean),
        p.ros_total?.mean ?? null,
      ]),
    );
    for (const m of means) expect(m).toEqual(means[0]);
  });

  it("drivers decompose the mean exactly; availability is 0 when p_active is 1 (seeds 4 and 5)", () => {
    for (const seed of [4, 5]) {
      const out = projectPlayers(e1(seed));
      let checked = 0;
      for (const p of out.result.projections) {
        const w = p.weeks[0];
        if (w === undefined || p.drivers.length === 0) continue;
        const sum = p.drivers.reduce((s, d) => s + d.contribution, 0);
        expect(Math.abs(sum - w.points.mean)).toBeLessThan(0.01);
        const avail = p.drivers.find((d) => d.name === "availability");
        if (avail !== undefined && w.p_active === 1) {
          expect(avail.contribution).toBe(0);
          checked += 1;
        }
        if (avail !== undefined && w.p_active === 0) expect(w.points.mean).toBe(0);
      }
      expect(checked).toBeGreaterThan(5);
    }
  });
});

describe("QA-1-003/023/024 — E5 and E2 decisions do not depend on the seed", () => {
  it("E5: the same candidates in the same order, the same rec, the same point estimates", () => {
    const runs = SEEDS.map((s) => analyzeKdef(e5(s)).analysis);
    const view = (a: (typeof runs)[number]) => ({
      order: a.candidates.map((c) => c.player_key),
      stream: a.candidates.map((c) => c.signals.find((x) => x.kind === "stream")?.value),
      action: a.rec.action,
      subjects: a.rec.subjects,
      point: a.rec.point_estimate,
      no_move: a.rec.no_move,
    });
    for (const r of runs) expect(view(r)).toEqual(view(runs[0] ?? r));
  });

  it("E5: kickers are ranked by expected points (the order a 20 000-sample E1 run agrees with)", () => {
    const out = analyzeKdef(e5(1, { positions: ["K"] })).analysis;
    const ks = out.candidates.map((c) => c.signals.find((x) => x.kind === "stream")?.value ?? 0);
    expect([...ks].sort((a, b) => b - a)).toEqual(ks);
    const byKey = new Map(universe.map((u) => [u.player_key, u]));
    const big = projectPlayers(
      e1(9, {
        targets: out.candidates.map((c) => {
          const u = byKey.get(c.player_key);
          if (u === undefined) throw new Error("universe");
          return { ...u, platform_status: null };
        }),
        n_sims: 20000,
      }),
    );
    out.candidates.forEach((c, i) => {
      const p = big.result.projections[i];
      expect(p?.player_key).toBe(c.player_key);
      const stream = c.signals.find((x) => x.kind === "stream")?.value ?? Number.NaN;
      expect(p?.weeks[0]?.points.mean).toBeCloseTo(stream, 3);
    });
  });

  it("E2: the recommended lineup is the same for every seed (objective mean, week 4)", () => {
    const lineups = [...SEEDS, 9, 10, 11, 12, 13, 14, 15, 16].map((s) => {
      const out = projectPlayers(e1(s, { weeks: [4], clock: fixedClock(beforeWeek(data, 4)) }));
      const players = lineupPlayersFor(entries, out, 4);
      const r = analyzeLineup({
        slots,
        players,
        opponent: null,
        clock: fixedClock(beforeWeek(data, 4)),
      });
      return r.recommended_lineup.map((a) => `${a.slot}:${a.player_key}`);
    });
    for (const l of lineups) expect(l).toEqual(lineups[0]);
  });
});

describe("QA-1-024 — the quadrature kernels", () => {
  it("gammaCdf matches closed forms; gammaQuantile inverts it", () => {
    for (const x of [0.1, 0.5, 1, 2, 5, 20]) {
      expect(gammaCdf(1, x)).toBeCloseTo(1 - Math.exp(-x), 12);
      expect(gammaCdf(2, x)).toBeCloseTo(1 - Math.exp(-x) * (1 + x), 12);
    }
    expect(gammaCdf(3, 0)).toBe(0);
    expect(() => gammaCdf(0, 1)).toThrow(RangeError);
    for (const shape of [0.7, 2.26, 6.25, 25]) {
      for (const p of [0.001, 0.1, 0.5, 0.9, 0.999]) {
        expect(gammaCdf(shape, gammaQuantile(p, shape))).toBeCloseTo(p, 9);
      }
    }
    expect(gammaQuantile(0, 3)).toBe(0);
    expect(gammaQuantile(1, 3)).toBe(Infinity);
  });

  it("gammaNodes: n ascending nodes averaging exactly 1, with the target spread; cv 0 → [1]", () => {
    for (const cv of [0.2, 0.42, 0.625]) {
      const g = gammaNodes(cv, 128);
      expect(g).toHaveLength(128);
      expect(g.reduce((s, x) => s + x, 0) / 128).toBeCloseTo(1, 12);
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThan(g[i - 1] ?? Infinity);
      const sd = Math.sqrt(g.reduce((s, x) => s + (x - 1) ** 2, 0) / 128);
      expect(Math.abs(sd - cv) / cv).toBeLessThan(0.05);
      expect(gammaNodes(cv, 128)).toBe(g); // memoised
    }
    expect(gammaNodes(0, 128)).toEqual([1]);
    expect(() => gammaNodes(0.5, 0)).toThrow(RangeError);
  });
});

describe("QA-1-003/023 — seedFrom: a stable seed from a call's inputs", () => {
  it("is deterministic, in 0..MAX_SEED, and differs for different inputs", () => {
    const keys = ["", "a", "b", "league|team|4|hash|2026-09-30", "league|team|5|hash|2026-09-30"];
    const seeds = keys.map(seedFrom);
    expect(keys.map(seedFrom)).toEqual(seeds);
    for (const s of seeds) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(MAX_SEED);
      expect(() => seededRng(s)).not.toThrow();
    }
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
