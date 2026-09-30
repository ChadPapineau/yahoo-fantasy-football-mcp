// projection.test.ts — E1 v1-trailing over the real fixture weeks (plan 07 E1; research 05 §1): basis
// always position_cv, ordered quantiles, determinism and order independence for a seed, P(active)
// paths (Out, game-day, not loaded), byes, no look-ahead leak, the never-loaded refusals, storage,
// multi-week totals, the kicker wind factor, defences, and bounds.
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  projectPlayers,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import type {
  BestEffortOutcome,
  ProjectionRepository,
  ScheduleReader,
} from "../../../src/domain/analytics/types.js";
import { SIMS } from "../../../src/domain/analytics/constants.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { RETRO_SAMPLE_CAP } from "../../../src/mcp/tools/reclog.js";
import type { RosterEntry } from "../../../src/domain/league/types.js";
import type { ScoringSettings, StoredProjection } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, TEAM_A, targetsFor } from "../../backtest/helpers/league.js";

let data: FixtureData;
let settings: ScoringSettings;
let entries: readonly RosterEntry[];
let targets: ProjectionTarget[];

beforeAll(async () => {
  data = await loadFixtureData();
  const lg = await fixtureLeague();
  settings = lg.settings;
  entries = (await lg.provider.getRoster(TEAM_A, 3)).value.entries;
  targets = targetsFor(entries);
});

const req = (over: Partial<ProjectionRequest> = {}): ProjectionRequest => ({
  targets,
  season: 2026,
  weeks: [3],
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(7),
  n_sims: 1000,
  ...over,
});
const byName = (name: string): ProjectionTarget => {
  const t = targets.find((x) => x.name === name);
  if (t === undefined) throw new Error(name);
  return t;
};

describe("projectPlayers — fixture week 3", () => {
  it("every Dist is position_cv with ordered quantiles; inputs name all three datasets", () => {
    const out = projectPlayers(req());
    expect(out.result.model_version).toBe("v1-trailing");
    expect(out.result.projections).toHaveLength(targets.length);
    for (const p of out.result.projections) {
      expect(p.model_version).toBe("v1-trailing");
      expect(p.opportunity).toBeNull();
      expect(p.ros_total).toBeNull();
      expect(p.stat_line_expectation).toBeNull();
      for (const w of p.weeks) {
        const d = w.points;
        expect(d.basis).toBe("position_cv");
        expect(d.p10).toBeLessThanOrEqual(d.p25);
        expect(d.p25).toBeLessThanOrEqual(d.p50);
        expect(d.p50).toBeLessThanOrEqual(d.p75);
        expect(d.p75).toBeLessThanOrEqual(d.p90);
        expect(Number.isFinite(d.mean)).toBe(true);
        expect(w.p_active_basis).toBeDefined();
      }
      expect(p.assumptions.length).toBeGreaterThanOrEqual(3);
    }
    expect(out.result.inputs.map((i) => i.source)).toEqual([
      "nflverse:injuries",
      "nflverse:schedules",
      "nflverse:stats_player_week",
    ]);
    const allen = out.result.projections.find((p) => p.name === "Josh Allen");
    expect(allen?.weeks[0]?.points.mean).toBeGreaterThan(15);
    expect(allen?.weeks[0]?.implied_total).toBeGreaterThan(20);
    expect(allen?.multipliers.matchup).not.toBeNull();
    expect(allen?.drivers.map((d) => d.name)).toEqual([
      "trailing_mean",
      "implied_total",
      "availability",
    ]);
    expect(allen?.shrinkage.find((s) => s.rate === "pass_td")?.k).toBe(5);
    expect(allen?.role_confidence_games).toBe(2);
  });

  it("an Out player (official report) is a zero distribution with p_active 0", () => {
    const out = projectPlayers(req({ targets: [byName("Nico Collins")] }));
    const w = out.result.projections[0]?.weeks[0];
    expect(w?.p_active).toBe(0);
    expect(w?.p_active_basis).toBe("designation_base_rate");
    expect(w?.points).toMatchObject({ mean: 0, p90: 0, p_zero: 1 });
  });

  it("is deterministic for a seed, order independent, and seed sensitive", () => {
    const a = projectPlayers(req());
    const b = projectPlayers(req());
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    const allen = byName("Josh Allen");
    const solo = projectPlayers(req({ targets: [allen] }));
    const inAll = a.result.projections.find((p) => p.name === "Josh Allen");
    expect(solo.result.projections[0]?.weeks).toEqual(inAll?.weeks);
    const other = projectPlayers(req({ targets: [allen], rng: seededRng(8) }));
    expect(other.result.projections[0]?.weeks[0]?.points.p90).not.toBe(inAll?.weeks[0]?.points.p90);
  });

  it("never reads the as-of week or later, even when a reader over-serves", () => {
    const base = fixtureReaders(data);
    const leaky = {
      ...base,
      playerWeeks: {
        lines: (ids: readonly string[], season: number) =>
          base.playerWeeks.lines(ids, season, [1, 2, 3, 4]),
        defenseLines: (
          teams: Parameters<typeof base.playerWeeks.defenseLines>[0],
          season: number,
          weeks: readonly number[],
        ) => base.playerWeeks.defenseLines(teams, season, weeks),
      },
    };
    const clean = projectPlayers(req());
    const dirty = projectPlayers(req({ readers: leaky }));
    expect(dirty.result).toEqual(clean.result);
  });

  it("include_stat_line returns the expected canonical line", () => {
    const out = projectPlayers(req({ targets: [byName("Josh Allen")], include_stat_line: true }));
    const e = out.result.projections[0]?.stat_line_expectation;
    expect(e?.pass_yd).toBeGreaterThan(150);
    expect(Object.keys(e ?? {}).every((k) => /^[a-z][a-z0-9_]*$/.test(k))).toBe(true);
  });

  it("stores every subject-week best-effort and counts busy writes", () => {
    const puts: StoredProjection[] = [];
    let n = 0;
    const repo: ProjectionRepository = {
      put: (p): BestEffortOutcome => {
        puts.push(p);
        n += 1;
        return n % 2 === 0 ? { written: false, reason: "busy" } : { written: true };
      },
      latest: () => null,
      getAsOf: () => null,
    };
    const two = targets.slice(0, 2);
    const out = projectPlayers(req({ targets: two, weeks: [3, 4], repository: repo }));
    expect(puts).toHaveLength(4);
    expect(out.stored).toEqual({ written: 2, busy: 2 });
    expect(puts[0]?.samples).toHaveLength(1000);
    expect(puts[0]?.model_version).toBe("v1-trailing");
    expect(puts[0]?.inputs_as_of).toBe("2026-09-30T15:58:07.000Z");
    expect(out.result.projections[0]?.ros_total).not.toBeNull();
    const w = out.result.projections[0]?.weeks ?? [];
    expect(out.result.projections[0]?.ros_total?.mean).toBeCloseTo(
      (w[0]?.points.mean ?? 0) + (w[1]?.points.mean ?? 0),
      3,
    );
  });

  it("stores a SIMS.stored-sample prefix at any n_sims — enough for the retrospective (A15)", () => {
    const puts: StoredProjection[] = [];
    const repo: ProjectionRepository = {
      put: (p): BestEffortOutcome => {
        puts.push(p);
        return { written: true };
      },
      latest: () => null,
      getAsOf: () => null,
    };
    const one = targets.slice(0, 1);
    projectPlayers(req({ targets: one, n_sims: 4000, repository: repo }));
    projectPlayers(req({ targets: one, n_sims: SIMS.min, repository: repo }));
    expect(puts.map((p) => p.samples.length)).toEqual([SIMS.stored, SIMS.min]);
    expect(SIMS.stored).toBeGreaterThanOrEqual(SIMS.min);
    // the only reader scores at most RETRO_SAMPLE_CAP of them
    expect(RETRO_SAMPLE_CAP).toBeLessThanOrEqual(SIMS.stored);
  });

  it("a defence projects from the opponent's implied total; a kicker loses long FGs in wind", () => {
    const out = projectPlayers(req({ targets: [byName("DET"), byName("Chris Boswell")] }));
    const def = out.result.projections[0];
    expect(def?.drivers.map((d) => d.name)).toEqual([
      "points_allowed_brackets",
      "counts_and_rare_events",
    ]);
    expect(def?.weeks[0]?.p_active).toBe(1);
    expect(def?.weeks[0]?.points.basis).toBe("position_cv");
    const pitGame = data.games.find(
      (g) => g.season === 2026 && g.week === 3 && (g.home === "PIT" || g.away === "PIT"),
    );
    const windy = fixtureReaders(data, {
      weather: [
        {
          game_id: pitGame?.game_id ?? "",
          temp_f: 40,
          wind_mph: 25,
          gust_mph: 35,
          precip_prob: 0.2,
          as_of: "2026-09-26T00:00:00Z",
          source: "weather:open_meteo",
        },
      ],
    });
    const k = projectPlayers(req({ targets: [byName("Chris Boswell")] }));
    const kw = projectPlayers(req({ targets: [byName("Chris Boswell")], readers: windy }));
    const roof = (pitGame?.roof ?? "").toLowerCase();
    if (roof !== "dome" && roof !== "closed") {
      expect(kw.result.projections[0]?.multipliers.weather).toBe(0.75);
      expect(kw.result.projections[0]?.weeks[0]?.points.mean).toBeLessThan(
        k.result.projections[0]?.weeks[0]?.points.mean ?? 0,
      );
    }
    expect(k.result.projections[0]?.multipliers.weather).toBeNull();
  });
});

describe("projectPlayers — availability, byes and gaps", () => {
  it("a provider-stamped game-day status inside the window wins (OBJ-16)", () => {
    const allen = byName("Josh Allen");
    const game = data.games.find(
      (g) => g.season === 2026 && g.week === 3 && (g.home === "BUF" || g.away === "BUF"),
    );
    const ko = Date.parse(game?.kickoff ?? "");
    const out = projectPlayers(
      req({
        targets: [{ ...allen, game_day_status: { status: "O" } }],
        clock: fixedClock(ko - 3600_000),
      }),
    );
    expect(out.result.projections[0]?.weeks[0]).toMatchObject({
      p_active: 0,
      p_active_basis: "yahoo_gameday_status",
    });
    const early = projectPlayers(
      req({ targets: [{ ...allen, game_day_status: { status: "O" } }] }),
    );
    expect(early.result.projections[0]?.weeks[0]?.p_active).toBe(1);
  });

  it("injuries not loaded → p_active null, basis none, named in assumptions", () => {
    const out = projectPlayers(
      req({
        targets: [byName("Josh Allen")],
        readers: fixtureReaders(data, { injuriesLoaded: false }),
      }),
    );
    const p = out.result.projections[0];
    expect(p?.weeks[0]?.p_active).toBeNull();
    expect(p?.weeks[0]?.p_active_basis).toBe("none");
    expect(p?.assumptions.some((a) => a.text.startsWith("availability unknown"))).toBe(true);
    expect(out.result.inputs.map((i) => i.source)).not.toContain("nflverse:injuries");
  });

  it("a bye week is a zero distribution", () => {
    const base = fixtureReaders(data);
    const schedules: ScheduleReader = {
      games: (season, weeks) => {
        const r = base.schedules.games(season, weeks);
        return { ...r, rows: r.rows.filter((g) => g.home !== "BUF" && g.away !== "BUF") };
      },
      firstKickoff: (season, week) => base.schedules.firstKickoff(season, week),
    };
    const out = projectPlayers(
      req({ targets: [byName("Josh Allen")], readers: { ...base, schedules } }),
    );
    const p = out.result.projections[0];
    expect(p?.weeks[0]?.points).toMatchObject({ mean: 0, p_zero: 1 });
    expect(p?.assumptions.some((a) => a.text === "bye in week 3: zero points")).toBe(true);
  });

  it("week 1 without a prior season: the positional prior, said so", () => {
    const out = projectPlayers(req({ weeks: [1], clock: fixedClock(beforeWeek(data, 1)) }));
    for (const p of out.result.projections) {
      if (p.position === "DEF") continue;
      expect(p.assumptions.some((a) => a.text.startsWith("no trailing games"))).toBe(true);
      expect(p.role_confidence_games).toBe(0);
    }
  });

  it("unknown position / no team → zero with a named assumption; hostile names pass through raw", () => {
    const out = projectPlayers(
      req({
        targets: [
          {
            player_key: null,
            subject: { kind: "player", gsis_id: "00-0000001" },
            name: "P‮unter",
            position: "P",
            nfl_team: "BUF",
          },
          {
            player_key: null,
            subject: { kind: "player", gsis_id: "00-0000002" },
            name: "FA",
            position: "WR",
            nfl_team: null,
          },
        ],
      }),
    );
    expect(out.result.projections[0]?.name).toBe("P‮unter");
    expect(out.result.projections[0]?.weeks[0]?.points.p_zero).toBe(1);
    expect(
      out.result.projections[0]?.assumptions.some((a) =>
        a.text.startsWith("position not projected"),
      ),
    ).toBe(true);
    expect(
      out.result.projections[1]?.assumptions.some((a) => a.text.startsWith("no NFL team")),
    ).toBe(true);
  });

  it("never-loaded datasets refuse with STALE_ONLY", () => {
    expect(() =>
      projectPlayers(req({ readers: fixtureReaders(data, { schedulesLoaded: false }) })),
    ).toThrow(expect.objectContaining({ code: "dataset_never_loaded", ffCode: "STALE_ONLY" }));
    expect(() =>
      projectPlayers(req({ readers: fixtureReaders(data, { statsLoaded: false }) })),
    ).toThrow(expect.objectContaining({ code: "dataset_never_loaded" }));
    const defOnly = [byName("DET")];
    const base = fixtureReaders(data);
    const noDef = {
      ...base,
      playerWeeks: { ...base.playerWeeks, defenseLines: () => ({ rows: [], stamp: null }) },
    };
    expect(() => projectPlayers(req({ targets: defOnly, readers: noDef }))).toThrow(
      expect.objectContaining({ code: "dataset_never_loaded" }),
    );
  });

  it("bounds: n_sims, weeks, season, target count", () => {
    const bad =
      (over: Partial<ProjectionRequest>): (() => unknown) =>
      () =>
        projectPlayers(req(over));
    for (const over of [
      { n_sims: 999 },
      { n_sims: 20001 },
      { n_sims: 1000.5 },
      { weeks: [] },
      { weeks: [3, 3] },
      { weeks: [0] },
      { weeks: [23] },
      { weeks: Array.from({ length: 19 }, (_, i) => i + 1) },
      { season: 1990 },
      { season: 2026.5 },
      { targets: Array.from({ length: 65 }, () => byName("Josh Allen")) },
    ]) {
      expect(bad(over)).toThrow(
        expect.objectContaining({ code: "invalid_request", ffCode: "VALIDATION" }),
      );
    }
  });
});

describe("projectPlayers — properties", () => {
  it("any seed and roster subset: basis position_cv, p10 ≤ p50 ≤ p90, deterministic", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.subarray([...Array(16).keys()], { minLength: 1, maxLength: 4 }),
        (seed, idx) => {
          const ts = idx.flatMap((i) =>
            targets.slice(i % targets.length, (i % targets.length) + 1),
          );
          const r = req({ targets: ts, rng: seededRng(seed) });
          const a = projectPlayers(r);
          for (const p of a.result.projections) {
            const d = p.weeks[0]?.points;
            expect(d?.basis).toBe("position_cv");
            expect(d?.p10 ?? 0).toBeLessThanOrEqual(d?.p50 ?? 0);
            expect(d?.p50 ?? 0).toBeLessThanOrEqual(d?.p90 ?? 0);
          }
          expect(projectPlayers(r).result).toEqual(a.result);
        },
      ),
      { numRuns: 15 },
    );
  });
});
