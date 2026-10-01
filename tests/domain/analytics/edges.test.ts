// edges.test.ts — the less-travelled paths of E1/E2/E3/E5, adversarially: a previous-season window,
// hostile readers that over-serve rows, missing/zero/negative betting lines, byes on real fixture
// weeks, illegal current lineups, lone candidates, ties, and the internal ranking-size guard.
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeKdef, type KdefRequest } from "../../../src/domain/analytics/kdef.js";
import { analyzeLineup } from "../../../src/domain/analytics/lineup.js";
import { analyzeMatchupPre } from "../../../src/domain/analytics/matchup.js";
import {
  projectForRanking,
  projectPlayers,
  type ProjectionReaders,
  type ProjectionRequest,
  type ProjectionTarget,
} from "../../../src/domain/analytics/projection.js";
import type {
  NflGame,
  PlayerWeekLine,
  ScheduleReader,
  TeamDefenseWeekLine,
} from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import type { Week } from "../../../src/domain/league/types.js";
import type { ScoringSettings } from "../../../src/domain/scoring/types.js";
import {
  type FixtureData,
  fixtureReaders,
  fixtureStamp,
  loadFixtureData,
} from "../../backtest/helpers/fixture.js";
import { beforeWeek, fixtureLeague, kdefUniverse } from "../../backtest/helpers/league.js";
import { dist, LEAGUE_SLOTS, NOW, PAST, player, SUN_1PM, SUN_425 } from "./helpers.js";

let data: FixtureData;
let settings: ScoringSettings;

beforeAll(async () => {
  data = await loadFixtureData();
  settings = (await fixtureLeague()).settings;
});

const ALLEN: ProjectionTarget = {
  player_key: "manual.p.00-0034857",
  subject: { kind: "player", gsis_id: "00-0034857" },
  name: "Josh Allen",
  position: "QB",
  nfl_team: "BUF",
};
const DET: ProjectionTarget = {
  player_key: "manual.p.def-det",
  subject: { kind: "defense", nfl_team: "DET" },
  name: "DET",
  position: "DEF",
  nfl_team: "DET",
};
const BOSWELL: ProjectionTarget = {
  player_key: "manual.p.00-0031136",
  subject: { kind: "player", gsis_id: "00-0031136" },
  name: "Chris Boswell",
  position: "K",
  nfl_team: "PIT",
};

const req = (over: Partial<ProjectionRequest> = {}): ProjectionRequest => ({
  targets: [ALLEN],
  season: 2026,
  weeks: [3],
  settings,
  readers: fixtureReaders(data),
  clock: fixedClock(beforeWeek(data, 3)),
  rng: seededRng(11),
  n_sims: 1000,
  ...over,
});

function withSchedule(map: (g: NflGame) => NflGame | null): ProjectionReaders {
  const base = fixtureReaders(data);
  const schedules: ScheduleReader = {
    games: (season, weeks) => {
      const r = base.schedules.games(season, weeks);
      return { ...r, rows: r.rows.flatMap((g) => map(g) ?? []) };
    },
    firstKickoff: (season, week) => base.schedules.firstKickoff(season, week),
  };
  return { ...base, schedules };
}

const noLines = (g: NflGame): NflGame => ({ ...g, lines: null });

describe("E1 edges", () => {
  it("week 1 reads the previous season's window (discounted) when it is loaded", () => {
    const base = fixtureReaders(data);
    const shift = <T extends { season: number; week: Week }>(rows: readonly T[]): T[] =>
      rows.map((r) => ({ ...r, season: 2025, week: r.week + 15 }));
    const stamp = fixtureStamp("nflverse:stats_player_week", "2026-01-10T00:00:00.000Z");
    const readers: ProjectionReaders = {
      ...base,
      playerWeeks: {
        lines: (ids, season, weeks) =>
          season === 2025
            ? {
                rows: shift(
                  data.lines.filter((l) => l.season === 2026 && ids.includes(l.gsis_id)),
                ).filter((l: PlayerWeekLine) => weeks.includes(l.week)),
                stamp,
              }
            : base.playerWeeks.lines(ids, season, weeks),
        defenseLines: (teams, season, weeks) =>
          season === 2025
            ? {
                rows: shift(
                  data.defense.filter((l) => l.season === 2026 && teams.includes(l.nfl_team)),
                ).filter((l: TeamDefenseWeekLine) => weeks.includes(l.week)),
                stamp,
              }
            : base.playerWeeks.defenseLines(teams, season, weeks),
      },
    };
    const out = projectPlayers(
      req({ targets: [ALLEN, DET], weeks: [1], readers, clock: fixedClock(beforeWeek(data, 1)) }),
    );
    for (const p of out.result.projections) {
      expect(p.assumptions.some((a) => a.text.startsWith("no trailing games"))).toBe(false);
      expect(p.role_confidence_games).toBe(0);
    }
    const allen = out.result.projections[0];
    expect(allen?.shrinkage[0]?.n).toBeGreaterThan(0);
    expect(allen?.shrinkage[0]?.n).toBeLessThan(3);
  });

  it("over-served injury and defence rows (other weeks, the as-of week) are ignored", () => {
    const base = fixtureReaders(data);
    const readers: ProjectionReaders = {
      ...base,
      injuries: {
        reports: (season, week, ids) => {
          const r = base.injuries.reports(season, week, ids);
          const extra = data.injuries.filter((x) => x.week !== week);
          return { ...r, rows: [...r.rows, ...extra] };
        },
      },
      playerWeeks: {
        lines: (ids, season, weeks) => base.playerWeeks.lines(ids, season, weeks),
        defenseLines: (teams, season) => base.playerWeeks.defenseLines(teams, season, [1, 2, 3, 4]),
      },
    };
    const clean = projectPlayers(req({ targets: [ALLEN, DET] }));
    const dirty = projectPlayers(req({ targets: [ALLEN, DET], readers }));
    expect(dirty.result).toEqual(clean.result);
  });

  it("no betting lines: named once, DEF falls back to its own trailing points allowed", () => {
    const out = projectPlayers(
      req({ targets: [ALLEN, DET], weeks: [3, 4], readers: withSchedule(noLines) }),
    );
    const allen = out.result.projections[0];
    expect(allen?.multipliers.matchup).toBeNull();
    expect(allen?.weeks.every((w) => w.implied_total === null)).toBe(true);
    expect(allen?.assumptions.filter((a) => a.text.startsWith("no betting line"))).toHaveLength(1);
    const def = out.result.projections[1];
    expect(def?.assumptions.some((a) => a.text.includes("points allowed from the defence"))).toBe(
      true,
    );
  });

  it("zero, negative or non-finite implied totals are treated as no line", () => {
    const junk = (g: NflGame): NflGame =>
      g.lines === null
        ? g
        : { ...g, lines: { ...g.lines, implied: { away: 0, home: Number.NaN } } };
    const out = projectPlayers(req({ readers: withSchedule(junk) }));
    expect(out.result.projections[0]?.weeks[0]?.implied_total).toBeNull();
  });

  it("a bye on every horizon week gives a zero ros_total; a free agent's assumption is not repeated", () => {
    const noBuf = (g: NflGame): NflGame | null => (g.home === "BUF" || g.away === "BUF" ? null : g);
    const out = projectPlayers(
      req({
        targets: [
          ALLEN,
          {
            ...ALLEN,
            player_key: null,
            nfl_team: null,
            subject: { kind: "player", gsis_id: "00-0000009" },
          },
        ],
        weeks: [3, 4],
        readers: withSchedule(noBuf),
      }),
    );
    expect(out.result.projections[0]?.ros_total).toMatchObject({ mean: 0, p_zero: 1 });
    const fa = out.result.projections[1];
    expect(fa?.assumptions.filter((a) => a.text.startsWith("no NFL team"))).toHaveLength(1);
  });

  it("a kicker's weather is cited in inputs when the weather dataset stamps it", () => {
    const base = fixtureReaders(data);
    const game = data.games.find((g) => g.game_id === "2026_03_CIN_PIT");
    const readers: ProjectionReaders = {
      ...base,
      weather: {
        forGames: (ids) => ({
          rows: ids.includes("2026_03_CIN_PIT")
            ? [
                {
                  game_id: "2026_03_CIN_PIT",
                  temp_f: 50,
                  wind_mph: 5,
                  gust_mph: null,
                  precip_prob: 0.1,
                  as_of: "2026-09-26T00:00:00.000Z",
                  source: "weather:open_meteo",
                },
              ]
            : [],
          stamp: {
            source: "weather:open_meteo",
            as_of: "2026-09-26T00:00:00.000Z",
            fetched_at: "2026-09-26T00:00:00.000Z",
            checked_at: "2026-09-26T00:00:00.000Z",
            freshness_class: "weather",
            file_version: "f",
          },
        }),
      },
    };
    expect(game?.roof).toBe("outdoors");
    const out = projectPlayers(req({ targets: [BOSWELL], readers }));
    expect(out.result.inputs.map((i) => i.source)).toContain("weather:open_meteo");
    expect(out.result.projections[0]?.multipliers.weather).toBeNull(); // 5 mph: no effect
    const noWeather = projectPlayers(
      req({
        targets: [BOSWELL],
        readers: { ...base, weather: undefined } as unknown as ProjectionReaders,
      }),
    );
    expect(noWeather.result.projections[0]?.multipliers.weather).toBeNull();
  });

  it("projectForRanking refuses a look-ahead size outside [min, n]", () => {
    expect(() => projectForRanking(req({ n_sims: 400 }), 401)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => projectForRanking(req({ n_sims: 400 }), 50)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(() => projectForRanking(req({ n_sims: 50 }), 50)).toThrow(
      expect.objectContaining({ code: "invalid_request" }),
    );
    expect(
      projectForRanking(req({ n_sims: 400, weeks: [3, 4] }), 150).players[0]?.weeks,
    ).toHaveLength(2);
  });
});

describe("E2 / E3 edges", () => {
  const clock = fixedClock(NOW);

  it("an illegal current lineup (two locked QBs in one QB slot, an unknown slot) never crashes", () => {
    const a = player("QB", 10, { slot: "QB", lock_at: PAST });
    const b = player("QB", 12, { slot: "QB", lock_at: PAST });
    const c = player("WR", 9, { slot: "XX" });
    const rec = analyzeLineup({ slots: LEAGUE_SLOTS, players: [a, b, c], opponent: null, clock });
    const at = new Map(rec.recommended_lineup.map((s) => [s.player_key, s.slot]));
    expect(at.get(a.player_key)).toBe("QB");
    expect(at.get(b.player_key)).toBe("BN");
    expect(rec.recommended_lineup.map((s) => s.player_key)).toContain(c.player_key);
  });

  it("blend with a single possible lineup, compare pairs that repeat a swap or name a starter", () => {
    const q = player("QB", 10, { slot: "BN" });
    const opp = [player("QB", 10, { slot: "QB", nfl_team: "KC" })];
    const blend = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [q],
      opponent: opp,
      objective: "blend",
      clock,
    });
    expect(blend.recommended_lineup[0]?.slot).toBe("QB");
    const s1 = player("WR", 5, { slot: "WR" });
    const b1 = player("WR", 20, { slot: "BN" });
    const s2 = player("WR", 6, { slot: "WR" });
    const s3 = player("WR", 7, { slot: "W/R/T" });
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [s1, b1, s2, s3],
      opponent: null,
      compare: [
        { out: s1.player_key, in: b1.player_key },
        { out: s1.player_key, in: s2.player_key },
      ],
      clock,
    });
    expect(rec.swaps.filter((s) => s.out === s1.player_key && s.in === b1.player_key)).toHaveLength(
      1,
    );
    expect(rec.swaps.find((s) => s.in === s2.player_key)?.delta_e).toBe(1);
  });

  it("conditionals skip unknown locks and missing reserves; accept reserves with no lock or unknown P(active)", () => {
    const noLock = player("QB", 15, { slot: "QB", p_active: 0.5, lock_at: null });
    expect(
      analyzeLineup({ slots: LEAGUE_SLOTS, players: [noLock], opponent: null, clock }).conditionals,
    ).toEqual([]);
    const q = player("K", 9, { slot: "K", p_active: 0.5, lock_at: SUN_425 });
    expect(
      analyzeLineup({ slots: LEAGUE_SLOTS, players: [q], opponent: null, clock }).conditionals,
    ).toEqual([]);
    const alt = player("K", 4, { slot: "BN", p_active: null, lock_at: null, nfl_team: null });
    const rec = analyzeLineup({ slots: LEAGUE_SLOTS, players: [q, alt], opponent: null, clock });
    expect(rec.conditionals[0]?.then.in).toBe(alt.player_key);
    expect(rec.stack_flags).toEqual([]);
  });

  it("a roster of injured reserves only: no starters, role_games 0, no move", () => {
    const ir = player("WR", 12, { slot: "IR", status: "O" });
    const rec = analyzeLineup({ slots: LEAGUE_SLOTS, players: [ir], opponent: null, clock });
    expect(rec.no_move).toBe(true);
    expect(rec.rec.confidence.role_games).toBe(0);
    expect(rec.rec.point_estimate).toBe(0);
  });

  it("option value with an unknown P(active) later player and an unknown-slot compare", () => {
    const tue = fixedClock("2026-09-22T12:00:00Z");
    const early = player("K", 9, { slot: "BN", lock_at: "2026-09-25T00:15:00.000Z" });
    const late = player("K", 7, { slot: "K", lock_at: SUN_1PM, p_active: null });
    const odd = player("K", 3, { slot: "ZZ", lock_at: SUN_425 });
    const rec = analyzeLineup({
      slots: LEAGUE_SLOTS,
      players: [early, late, odd],
      opponent: null,
      compare: [{ out: odd.player_key, in: early.player_key }],
      clock: tue,
    });
    const main = rec.swaps.find((s) => s.out === late.player_key);
    expect(main?.option_value).toMatchObject({ kind: "thursday", value: 0 });
    expect(rec.swaps.find((s) => s.out === odd.player_key)?.option_value?.kind).toBe("thursday");
  });

  it("E3 with player_sim Dists, a defence starter, ties and missing role_games", () => {
    const zero = dist(0, 0, "player_sim");
    const me = [
      player("QB", 0, { slot: "QB", points: zero, role_games: undefined as unknown as number }),
      player("DEF", 0, { slot: "DEF", points: zero }),
      player("WR", 0, { slot: "WR", points: zero }),
      player("WR", 0, { slot: "WR", points: zero }),
    ];
    const them = [player("QB", 0, { slot: "QB", points: zero })];
    const r = analyzeMatchupPre({
      slots: LEAGUE_SLOTS,
      players: me,
      opponent: them,
      clock,
      rng: seededRng(1),
      n_sims: 1000,
    });
    expect(r.p_win).toBe(0.5);
    expect(r.rec.distribution.basis).toBe("player_sim");
    expect(r.rec.subjects.find((s) => s.slot === "DEF")?.nfl_team).toBe("BUF");
    expect(r.rec.confidence.role_games).toBe(0);
    expect(r.actionable_slots.map((s) => s.slot)).toEqual(["DEF", "QB", "WR", "WR"]);
  });
});

describe("E5 edges", () => {
  let universe: ReturnType<typeof kdefUniverse>;
  beforeAll(() => {
    universe = kdefUniverse(data);
  });
  const kreq = (over: Partial<KdefRequest> = {}): KdefRequest => ({
    positions: ["K", "DEF"],
    season: 2026,
    week: 5,
    universe,
    current: [],
    availability_known: false,
    settings,
    readers: fixtureReaders(data),
    clock: fixedClock(beforeWeek(data, 5)),
    rng: seededRng(2),
    ...over,
  });

  it("week 5 byes: a bye starter makes streamability undefined (0) and every non-bye candidate beats him", () => {
    const week5 = new Set(
      data.games.filter((g) => g.season === 2026 && g.week === 5).flatMap((g) => [g.home, g.away]),
    );
    const byeDef = universe.find((u) => u.position === "DEF" && !week5.has(u.nfl_team));
    const byeK = universe.find((u) => u.position === "K" && !week5.has(u.nfl_team));
    if (byeDef === undefined || byeK === undefined) throw new Error("fixture: no week-5 bye");
    const out = analyzeKdef(kreq({ current: [byeDef, byeK], look_ahead: 0 }));
    expect(out.analysis.hold_vs_stream?.streamability).toBe(0);
    expect(out.analysis.hold_vs_stream?.current_starter_delta).toBeGreaterThan(0);
    expect(out.analysis.candidates.every((c) => (c.weeks_of_value ?? 0) >= 0)).toBe(true);
    expect(out.analysis.rec.subjects.map((s) => s.role)).toEqual(["stream", "drop"]);
  });

  it("an injected engine and extra stamps are used; duplicates in the universe count once", () => {
    let calls = 0;
    const engineSpy = {
      score: (...a: Parameters<typeof import("../../../src/domain/scoring/engine.js").score>) => {
        calls += 1;
        return scoreImpl(...a);
      },
      explain: (...a: Parameters<typeof import("../../../src/domain/scoring/engine.js").score>) =>
        scoreImpl(...a),
      scoreSamples: (
        ...a: Parameters<typeof import("../../../src/domain/scoring/engine.js").scoreSamples>
      ) => scoreSamplesImpl(...a),
    };
    const one = universe.filter((u) => u.position === "DEF").slice(0, 1);
    const out = analyzeKdef(
      kreq({
        positions: ["DEF"],
        week: 3,
        clock: fixedClock(beforeWeek(data, 3)),
        universe: [...one, ...one],
        engine: engineSpy,
        extra_stamps: [
          {
            source: "manual",
            as_of: "2026-09-20T00:00:00.000Z",
            fetched_at: "2026-09-20T00:00:00.000Z",
            freshness: "manual_league",
            provisional: false,
          },
        ],
      }),
    );
    expect(calls).toBeGreaterThan(0);
    expect(out.analysis.candidates).toHaveLength(1);
    expect(out.analysis.inputs.map((i) => i.source)).toContain("manual");
    // no current starter: the margin is against doing nothing (an empty slot scores 0 — QA-1-060)
    const only = out.analysis.candidates[0]?.marginal_value;
    expect(out.analysis.rec.delta_vs_next.value).toBeCloseTo(only?.mean ?? Number.NaN, 3);
    expect(out.analysis.rec.delta_vs_next.p10).toBeCloseTo(only?.p10 ?? Number.NaN, 3);
    expect(out.analysis.rec.no_move).toBe(false);
  });

  it("no lines: candidates carry no implied_total signal and next_week implied is null", () => {
    const base = fixtureReaders(data);
    const readers: ProjectionReaders = {
      ...base,
      schedules: {
        games: (season, weeks) => {
          const r = base.schedules.games(season, weeks);
          return { ...r, rows: r.rows.map(noLines) };
        },
        firstKickoff: (s, w) => base.schedules.firstKickoff(s, w),
      },
    };
    const out = analyzeKdef(
      kreq({ week: 3, clock: fixedClock(beforeWeek(data, 3)), readers, look_ahead: 1 }),
    );
    for (const c of out.analysis.candidates) {
      expect(c.signals.map((s) => s.kind)).toEqual(["stream"]);
      expect(c.kdef?.implied_total).toBeNull();
      expect(c.kdef?.next_week?.implied_total).toBeNull();
    }
  });
});

import {
  score as scoreImpl,
  scoreSamples as scoreSamplesImpl,
} from "../../../src/domain/scoring/engine.js";
