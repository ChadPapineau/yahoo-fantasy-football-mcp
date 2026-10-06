// retrospective.test.ts — src/domain/reclog/retrospective.ts (plan 07 E13 + C12; research 05 §12;
// plan 10 §2.1 + A9): outcome joining (followed/regret/decisive/realised from structured subjects
// only), swap regret, per-player metrics, the Brier suite with "n too small (k of 30)", n_by_metric,
// sample-size caveats, the A9 week-N-logged / week-N+1-scored flow, the absence of
// `parameter_changes_proposed` (schema test), and hostile rows (NaN, conflicts, wrong week, bad ids).
// QA-2-040: `followed` of a past week never flips with a later roster (a final outcome's answer is
// E14's; an earlier answer carries forward; a current-only roster is evidence only while unchanged
// since the week's last lock). QA-2-041: an alternative's regret compares like with like.
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { InputFreshness, RecSubject } from "../../../src/domain/analytics/types.js";
import { fixedClock, seededRng } from "../../../src/domain/clock.js";
import { lockAtFor } from "../../../src/domain/league/schedule.js";
import { crpsFromDist, crpsFromSamples } from "../../../src/domain/reclog/metrics.js";
import { buildRecord } from "../../../src/domain/reclog/record.js";
import {
  DEFAULT_MIN_N,
  METRIC_ORDER,
  SubjectIndex,
  brierMetric,
  buildRetrospective,
  caveat,
  compareRecords,
  followedOf,
  outcomeOf,
  perPlayerMetrics,
  pointsIndex,
  realisedOf,
  regretAgainst,
  resolveFollowed,
  retroRec,
  rosterHoldsWeek,
  sameSubject,
  scoreCall,
  swapRegretOf,
  toListItem,
  weekLastLock,
  type PlayerForecast,
  type RetrospectiveInput,
  type SubjectPoints,
} from "../../../src/domain/reclog/retrospective.js";
import type {
  RecommendationOutcome,
  RecommendationRecord,
  Retrospective,
} from "../../../src/domain/reclog/types.js";
import { WEEK1 } from "../league/fixtures.js";
import {
  ALLEN,
  GIBBS,
  LOVE,
  ST_BROWN,
  WALKER,
  alt,
  input,
  normal,
  normalDist,
  pointDist,
  rec,
  record,
  subj,
} from "./helpers.js";

const NOW = "2026-10-06T12:00:00.000Z";
const clock = () => fixedClock(NOW);

const pts = (gsis: string, points: number | null): SubjectPoints => ({
  player_key: `manual.p.${gsis}`,
  gsis_id: gsis,
  nfl_team: null,
  points,
});
const def = (team: "DET" | "PIT", points: number | null): SubjectPoints => ({
  player_key: null,
  gsis_id: null,
  nfl_team: team,
  points,
});
const teamSubj = (team: "DET" | "PIT", role: "stream" | "drop" | "start") => ({
  player_key: null,
  gsis_id: null,
  nfl_team: team,
  role,
  slot: null,
});

const REALISED: SubjectPoints[] = [
  pts(GIBBS, 20),
  pts(WALKER, 8),
  pts(ALLEN, 25),
  pts(LOVE, 15),
  pts(ST_BROWN, 12),
  def("DET", 7),
  def("PIT", 12),
];

const ROSTER = [
  { player_key: `manual.p.${GIBBS}`, gsis_id: GIBBS, nfl_team: null, started: true },
  { player_key: `manual.p.${WALKER}`, gsis_id: WALKER, nfl_team: null, started: false },
  { player_key: `manual.p.${ALLEN}`, gsis_id: ALLEN, nfl_team: null, started: true },
  { player_key: `manual.p.${LOVE}`, gsis_id: LOVE, nfl_team: null, started: false },
  { player_key: `manual.p.${ST_BROWN}`, gsis_id: ST_BROWN, nfl_team: null, started: true },
  { player_key: "manual.p.def-det", gsis_id: null, nfl_team: "DET" as const, started: true },
];

/** The week's calls: good lineup call, bad lineup call, waiver add, DEF stream, trade. */
function weekCalls(): RecommendationRecord[] {
  return [
    record({ log_id: "rec-01K6D00000000000000000000A", recorded_at: "2026-10-01T12:00:00.000Z" }),
    record({
      log_id: "rec-01K6D00000000000000000000B",
      recorded_at: "2026-10-01T13:00:00.000Z",
      rec: rec({
        action: "Start Jordan Love over Josh Allen",
        subjects: [subj(LOVE, "start", "QB"), subj(ALLEN, "sit", "BN")],
      }),
      alternatives: [
        alt({
          action: "Start Josh Allen",
          subjects: [subj(ALLEN, "start", "QB"), subj(LOVE, "sit", "BN")],
        }),
      ],
    }),
    record({
      log_id: "rec-01K6D00000000000000000000C",
      recorded_at: "2026-10-01T11:00:00.000Z",
      kind: "waiver",
      rec: rec({ action: "Add Amon-Ra St. Brown", subjects: [subj(ST_BROWN, "add")] }),
      alternatives: [],
      followed_hint: "user_said_no",
    }),
    record({
      log_id: "rec-01K6D00000000000000000000D",
      recorded_at: "2026-10-01T12:00:00.000Z",
      kind: "stream",
      rec: rec({ action: "Stream the Lions defence", subjects: [teamSubj("DET", "stream")] }),
      alternatives: [
        alt({ action: "Stream the Steelers defence", subjects: [teamSubj("PIT", "stream")] }),
      ],
    }),
  ];
}

function baseInput(over: Partial<RetrospectiveInput> = {}): RetrospectiveInput {
  return {
    week: 4,
    final: true,
    records: weekCalls(),
    kinds: null,
    realised: REALISED,
    roster: ROSTER,
    team_result: { my_points: 100, opponent_points: 90 },
    player_forecasts: [],
    probabilities: { p_active: [], p_win: [], p_win_given_bid: [], p_role_holds: [] },
    min_n: DEFAULT_MIN_N,
    inputs: [],
    ...over,
  };
}

/** Calibrated per-player forecasts across four positions (outcome ~ its own Dist). */
function forecasts(n: number, seed = 11): PlayerForecast[] {
  const rng = seededRng(seed);
  const positions = ["QB", "RB", "WR", "TE"];
  return Array.from({ length: n }, (_, i) => {
    const mu = 5 + 20 * rng.next();
    const sigma = 3 + 3 * rng.next();
    return {
      position: positions[i % 4]!,
      dist: normalDist(mu, sigma),
      samples: i % 5 === 0 ? Array.from({ length: 200 }, () => mu + sigma * normal(rng)) : null,
      outcome: mu + sigma * normal(rng),
    };
  });
}

function walkKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) walkKeys(x, out);
  else if (typeof v === "object" && v !== null)
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      walkKeys(x, out);
    }
  return out;
}

describe("joining a call to what happened", () => {
  const points = pointsIndex(REALISED);
  const roster = new SubjectIndex(ROSTER.map((r) => ({ ...r, value: r.started })));

  it("SubjectIndex joins on player_key, then gsis_id, then nfl_team", () => {
    const idx = new SubjectIndex([
      { player_key: "461.p.1", gsis_id: GIBBS, nfl_team: null, value: "a" },
      { player_key: null, gsis_id: WALKER, nfl_team: null, value: "b" },
      { player_key: null, gsis_id: null, nfl_team: "DET" as const, value: "c" },
    ]);
    expect(idx.get({ player_key: "461.p.1", gsis_id: null, nfl_team: null })).toBe("a");
    expect(idx.get({ player_key: "461.p.999", gsis_id: GIBBS, nfl_team: null })).toBe("a");
    expect(idx.get({ player_key: "461.p.999", gsis_id: WALKER, nfl_team: "DET" })).toBe("b");
    expect(idx.get({ player_key: null, gsis_id: ALLEN, nfl_team: "DET" })).toBe("c");
    expect(idx.get({ player_key: null, gsis_id: ALLEN, nfl_team: "PIT" })).toBeUndefined();
    expect(idx.get({ player_key: null, gsis_id: null, nfl_team: null })).toBeUndefined();
  });

  it("an id seen twice with different values is ambiguous (null), never a silent pick", () => {
    const idx = pointsIndex([
      pts(GIBBS, 20),
      pts(GIBBS, 3),
      pts(GIBBS, 20),
      pts(WALKER, 8),
      pts(WALKER, 8),
    ]);
    expect(idx.get(subj(GIBBS, "start"))).toBeNull();
    expect(idx.get(subj(WALKER, "start"))).toBe(8);
  });

  it("non-finite or out-of-range realised points read as unknown", () => {
    const idx = pointsIndex([
      pts(GIBBS, Number.NaN),
      pts(WALKER, Number.POSITIVE_INFINITY),
      pts(ALLEN, 2e6),
      pts(LOVE, null),
    ]);
    for (const g of [GIBBS, WALKER, ALLEN, LOVE]) expect(idx.get(subj(g, "start"))).toBeNull();
  });

  it("realisedOf: gains minus trade_out; sit/drop gain nothing; unknown → null", () => {
    expect(realisedOf([subj(GIBBS, "start"), subj(WALKER, "sit")], points)).toBe(20);
    expect(realisedOf([subj(ST_BROWN, "add"), subj(WALKER, "drop")], points)).toBe(12);
    expect(realisedOf([subj(ALLEN, "trade_in"), subj(LOVE, "trade_out")], points)).toBe(10);
    expect(realisedOf([teamSubj("DET", "stream")], points)).toBe(7);
    expect(realisedOf([subj(WALKER, "sit")], points)).toBeNull();
    expect(realisedOf([], points)).toBeNull();
    expect(realisedOf([subj("00-0000001", "start")], points)).toBeNull();
    expect(realisedOf([subj(GIBBS, "start"), subj("00-0000001", "trade_out")], points)).toBeNull();
    expect(realisedOf([subj(GIBBS, "start")], pointsIndex([pts(GIBBS, null)]))).toBeNull();
  });

  it("followedOf reads the roster role by role; without a roster the hint decides", () => {
    const r = (
      subjects: ReturnType<typeof subj>[],
      hint: RecommendationRecord["followed_hint"] = "unknown",
    ) => record({ rec: rec({ subjects }), followed_hint: hint });
    expect(followedOf(r([subj(GIBBS, "start"), subj(WALKER, "sit")]), roster)).toBe(true);
    expect(followedOf(r([subj(WALKER, "start")]), roster)).toBe(false);
    expect(followedOf(r([subj(GIBBS, "sit")]), roster)).toBe(false);
    expect(followedOf(r([subj("00-0000001", "sit")]), roster)).toBe(true);
    expect(followedOf(r([subj(WALKER, "add")]), roster)).toBe(true);
    expect(followedOf(r([subj("00-0000001", "add")]), roster)).toBe(false);
    expect(followedOf(r([subj("00-0000001", "drop")]), roster)).toBe(true);
    expect(followedOf(r([subj(WALKER, "drop")]), roster)).toBe(false);
    expect(followedOf(r([subj(WALKER, "trade_out")]), roster)).toBe(false);
    expect(followedOf(r([subj(ALLEN, "trade_in")]), roster)).toBe(true);
    expect(followedOf(r([teamSubj("DET", "stream")]), roster)).toBe(true);
    expect(followedOf(r([], "user_said_yes"), roster)).toBe(true);
    expect(followedOf(r([subj(GIBBS, "start")], "user_said_yes"), null)).toBe(true);
    expect(followedOf(r([subj(GIBBS, "start")], "user_said_no"), null)).toBe(false);
    expect(followedOf(r([subj(GIBBS, "start")], "unknown"), null)).toBeNull();
    // roster evidence beats the model's hint
    expect(followedOf(r([subj(WALKER, "start")], "user_said_yes"), roster)).toBe(false);
  });

  it("scoreCall: signed regret vs the best alternative in hindsight, decisive, swaps", () => {
    const [good, bad, waiver, stream] = weekCalls();
    const team = { my_points: 100, opponent_points: 90 };
    const g = scoreCall(good!, points, roster, team);
    expect(g.call).toEqual({
      log_id: good!.log_id,
      kind: "lineup",
      followed: true,
      regret: -12,
      decisive: true,
      recommended: good!.rec.action,
      best_alternative: good!.alternatives[0]!.action,
      realised: 20,
    });
    expect(g.swaps).toEqual([0]);
    const b = scoreCall(bad!, points, roster, team);
    expect(b.call.regret).toBe(10);
    expect(b.call.followed).toBe(false);
    expect(b.call.decisive).toBeNull();
    expect(b.swaps).toEqual([10]);
    const w = scoreCall(waiver!, points, roster, team);
    expect(w.call).toMatchObject({
      regret: null,
      best_alternative: null,
      realised: 12,
      followed: true,
      decisive: null,
    });
    expect(w.swaps).toEqual([]);
    const s = scoreCall(stream!, points, roster, team);
    expect(s.call).toMatchObject({ regret: 5, decisive: false, followed: true });
    expect(
      scoreCall(stream!, points, roster, { my_points: 90, opponent_points: 90 }).call.decisive,
    ).toBe(true);
    expect(scoreCall(stream!, points, roster, null).call.decisive).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        scoreCall(stream!, points, roster, { my_points: bad, opponent_points: 90 }).call.decisive,
      ).toBeNull();
      expect(
        scoreCall(stream!, points, roster, { my_points: 90, opponent_points: bad }).call.decisive,
      ).toBeNull();
    }
    expect(
      scoreCall(stream!, points, roster, { my_points: 80, opponent_points: 90 }).call.decisive,
    ).toBe(false);
  });

  it("the best alternative is the one with the most realised points; unscorable ones are skipped", () => {
    const r = record({
      alternatives: [
        alt({ action: "unknown player", subjects: [subj("00-0000001", "start")] }),
        alt({ action: "Start Love", subjects: [subj(LOVE, "start")] }),
        alt({ action: "Start Allen", subjects: [subj(ALLEN, "start")] }),
        alt({ action: "Start Walker", subjects: [subj(WALKER, "start")] }),
      ],
    });
    const c = scoreCall(r, points, null, null).call;
    expect(c.best_alternative).toBe("Start Allen");
    expect(c.regret).toBe(5);
  });

  it("swap regret pairs the k-th start with the k-th sit and skips pairs with unknown points", () => {
    const r = record({
      rec: rec({
        subjects: [
          subj(GIBBS, "start"),
          subj(LOVE, "start"),
          subj("00-0000001", "start"),
          subj(WALKER, "sit"),
          subj(ALLEN, "sit"),
          subj(ST_BROWN, "sit"),
        ],
      }),
    });
    expect(scoreCall(r, points, null, null).swaps).toEqual([0, 10]);
    const nonLineup = record({ kind: "matchup" });
    expect(scoreCall(nonLineup, points, null, null).swaps).toEqual([]);
  });

  it("outcomeOf and toListItem", () => {
    const [good] = weekCalls();
    const c = scoreCall(good!, points, roster, null).call;
    const o = outcomeOf(c, NOW, false);
    expect(o).toEqual({
      log_id: good!.log_id,
      followed: true,
      realised: 20,
      regret: -12,
      decisive: null,
      scored_at: NOW,
      week_final: false,
    });
    expect(toListItem(good!, o)).toEqual({
      log_id: good!.log_id,
      kind: "lineup",
      season: 2026,
      week: 4,
      recorded_at: good!.recorded_at,
      action_summary: good!.rec.action,
      followed: true,
    });
    expect(toListItem(good!, null).followed).toBeNull();
  });
});

describe("metric blocks", () => {
  it("per-player metrics: null under min_n with a caveat per metric and per position", () => {
    const r = perPlayerMetrics(forecasts(8), 30);
    expect(r.metrics).toEqual({
      crps: null,
      pinball: { p10: null, p50: null, p90: null },
      coverage_80: null,
      spearman_by_position: { QB: null, RB: null, TE: null, WR: null },
      n_player_weeks: 8,
    });
    expect(r.accuracy_gap).toBeNull();
    expect(r.caveats).toEqual([
      "per_player.spearman_by_position.QB: n too small (2 of 30)",
      "per_player.spearman_by_position.RB: n too small (2 of 30)",
      "per_player.spearman_by_position.TE: n too small (2 of 30)",
      "per_player.spearman_by_position.WR: n too small (2 of 30)",
    ]);
  });

  it("per-player metrics at n: CRPS from samples where present, else from quantiles", () => {
    const fs = forecasts(200);
    const r = perPlayerMetrics(fs, 30);
    const expected =
      fs.reduce(
        (s, f) =>
          s +
          (f.samples === null
            ? crpsFromDist(f.dist, f.outcome)
            : crpsFromSamples(f.samples, f.outcome)),
        0,
      ) / fs.length;
    expect(r.metrics.crps).toBeCloseTo(expected, 9);
    expect(r.metrics.n_player_weeks).toBe(200);
    expect(Math.abs(r.metrics.coverage_80! - 0.8)).toBeLessThan(0.1);
    for (const p of [r.metrics.pinball.p10, r.metrics.pinball.p50, r.metrics.pinball.p90])
      expect(p).toBeGreaterThan(0);
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const s = r.metrics.spearman_by_position[pos]!;
      expect(s).toBeGreaterThan(0.3);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(r.accuracy_gap).toBeGreaterThan(0);
    expect(r.caveats).toEqual([]);
    expect(Object.keys(r.metrics.spearman_by_position)).toEqual(["QB", "RB", "TE", "WR"]);
  });

  it("a perfect projection has zero accuracy gap and Spearman 1", () => {
    const fs = Array.from({ length: 40 }, (_, i) => ({
      position: "WR",
      dist: pointDist(i),
      samples: null,
      outcome: i,
    }));
    const r = perPlayerMetrics(fs, 30);
    expect(r.accuracy_gap).toBe(0);
    expect(r.metrics.crps).toBe(0);
    expect(r.metrics.coverage_80).toBe(1);
    expect(r.metrics.spearman_by_position.WR).toBeCloseTo(1, 12);
  });

  it("brierMetric: a value with decomposition at n, else the n-too-small string", () => {
    const pairs = Array.from({ length: 30 }, (_, i) => ({ p: 0.5, outcome: i % 2 === 0 }));
    const v = brierMetric(pairs, 30);
    expect(typeof v).toBe("object");
    expect(v).toMatchObject({ value: 0.25, n: 30 });
    expect(brierMetric(pairs.slice(0, 14), 30)).toBe("n too small (14 of 30)");
    expect(brierMetric([], 30)).toBe("n too small (0 of 30)");
    expect(brierMetric([], 0)).toBe("n too small (0 of 30)");
    expect(brierMetric(pairs.slice(0, 1), 1)).toMatchObject({ n: 1 });
  });

  it("swapRegretOf: total and n always; per_call_mean only at n", () => {
    const scored = [
      { call: {} as never, swaps: [0, 4], incomparable: 0 },
      { call: {} as never, swaps: [], incomparable: 0 },
      { call: {} as never, swaps: [2], incomparable: 0 },
    ];
    expect(swapRegretOf(scored, 30)).toEqual({ total: 6, per_call_mean: null, n_swaps: 3 });
    expect(swapRegretOf(scored, 3)).toEqual({ total: 6, per_call_mean: 3, n_swaps: 3 });
    expect(swapRegretOf([], 1)).toEqual({ total: 0, per_call_mean: null, n_swaps: 0 });
  });

  it("caveat names the metric", () => {
    expect(caveat("brier.p_win", 14, 30)).toBe("brier.p_win: n too small (14 of 30)");
  });
});

describe("retroRec", () => {
  const swap = { total: 10, per_call_mean: null, n_swaps: 2 };
  const call = (regret: number | null) => ({
    log_id: "rec-01K6D00000000000000000000A",
    kind: "lineup" as const,
    followed: null,
    regret,
    decisive: null,
    recommended: "x",
    best_alternative: null,
    realised: null,
  });

  it("is always a no-move whose spread is the per-call regrets", () => {
    const r = retroRec(
      [call(-12), call(10), call(0), call(null), call(5)],
      swap,
      [],
      fixedClock(NOW),
    );
    expect(r.no_move).toBe(true);
    expect(r.log_id).toBeNull();
    expect(r.subjects).toEqual([]);
    expect(r.decision_metric).toBe("regret");
    expect(r.point_estimate).toBeCloseTo(0.75, 12);
    expect(r.distribution).toMatchObject({ p50: 2.5, p_zero: 0.25, basis: "position_cv" });
    expect(r.distribution.p10).toBeCloseTo(-12 + 0.3 * 12, 12);
    expect(r.distribution.p90).toBeCloseTo(5 + 0.7 * 5, 12);
    expect(r.confidence.role_games).toBe(4);
    expect(r.as_of).toBe(NOW);
    expect(r.drivers.map((d) => d.contribution)).toEqual([0.75, 10]);
  });

  it("no scored calls: a zero distribution; as_of is the newest input", () => {
    const inputs: InputFreshness[] = [
      { source: "manual", as_of: "2026-10-05T10:00:00Z", age_s: 1, freshness: "fresh" },
      {
        source: "nflverse:stats_player_week",
        as_of: "2026-10-06T09:00:00+02:00",
        age_s: 1,
        freshness: "fresh",
      },
      { source: "nflverse:schedules", as_of: "2026-10-06T06:00:00Z", age_s: 1, freshness: "stale" },
      { source: "manual", as_of: "not a time", age_s: 1, freshness: "stale" },
    ];
    const r = retroRec([call(null)], swap, inputs, fixedClock(NOW));
    expect(r.distribution).toMatchObject({ mean: 0, p10: 0, p90: 0, p_zero: 0 });
    expect(r.as_of).toBe("2026-10-06T09:00:00+02:00");
    expect(r.confidence.inputs).toHaveLength(4);
    expect(retroRec([], swap, [inputs[3]!], fixedClock(NOW)).as_of).toBe(NOW);
    const many = Array.from({ length: 30 }, () => inputs[0]!);
    expect(retroRec([], swap, many, fixedClock(NOW)).confidence.inputs).toHaveLength(25);
  });

  it("one scored call: every quantile is that regret", () => {
    const r = retroRec([call(3)], swap, [], fixedClock(NOW));
    expect(r.distribution).toMatchObject({
      mean: 3,
      p10: 3,
      p25: 3,
      p50: 3,
      p75: 3,
      p90: 3,
      p_zero: 0,
    });
  });
});

describe("buildRetrospective (plan 07 E13, plan 10 A9)", () => {
  it("A9: log in week N, score in week N+1 — regret, followed, per-player, swap regret, P(active) Brier", () => {
    // week N = 4: the Skills log their calls through the real record builder
    const rng = seededRng(4);
    const logClock = fixedClock("2026-10-01T12:00:00Z");
    const first = buildRecord(input(), { clock: logClock, rng, settingsHash: null });
    logClock.advance(60_000);
    const logged = [
      first,
      buildRecord(
        input({
          rec: rec({
            action: "Start Jordan Love",
            subjects: [subj(LOVE, "start", "QB"), subj(ALLEN, "sit", "BN")],
          }),
          alternatives: [
            alt({
              action: "Start Josh Allen",
              subjects: [subj(ALLEN, "start", "QB"), subj(LOVE, "sit", "BN")],
            }),
          ],
        }),
        { clock: logClock, rng, settingsHash: null },
      ),
    ];
    // week N+1: the retrospective scores week 4
    const pActive = Array.from({ length: 40 }, (_, i) => ({
      p: i % 4 === 0 ? 0.25 : 0.9,
      outcome: i % 5 !== 0,
    }));
    const res = buildRetrospective(
      baseInput({
        records: logged,
        player_forecasts: forecasts(180),
        probabilities: {
          p_active: pActive,
          p_win: [
            { p: 0.6, outcome: true },
            { p: 0.4, outcome: false },
            { p: 0.55, outcome: false },
          ],
          p_win_given_bid: [],
          p_role_holds: [{ p: 0.7, outcome: true }],
        },
        inputs: [
          {
            source: "nflverse:stats_player_week",
            as_of: "2026-10-06T09:05:48Z",
            age_s: 10,
            freshness: "fresh",
          },
        ],
      }),
      clock(),
    );
    const r = res.retrospective;
    expect(r.week).toBe(4);
    expect(r.final).toBe(true);
    expect(r.calls.map((c) => [c.followed, c.regret])).toEqual([
      [true, -12],
      [false, 10],
    ]);
    expect(r.metrics.per_player.crps).toBeGreaterThan(0);
    expect(r.metrics.per_player.pinball.p50).toBeGreaterThan(0);
    expect(r.metrics.per_player.coverage_80).toBeGreaterThan(0.6);
    expect(r.metrics.swap_regret).toEqual({ total: 10, per_call_mean: null, n_swaps: 2 });
    expect(typeof r.metrics.brier.p_active).toBe("object");
    expect(r.metrics.brier.p_win).toBe("n too small (3 of 30)");
    expect(r.metrics.brier.p_win_given_bid).toBe("n too small (0 of 30)");
    expect(r.metrics.brier.p_role_holds).toBe("n too small (1 of 30)");
    // n_by_metric has the plan 10 §2.1 shape, in its order
    expect(r.n_by_metric).toEqual([
      { metric: "per_player", n: 180, min_n: 30, reached: true },
      { metric: "swap_regret", n: 2, min_n: 30, reached: false },
      { metric: "brier.p_active", n: 40, min_n: 30, reached: true },
      { metric: "brier.p_win", n: 3, min_n: 30, reached: false },
      { metric: "brier.p_win_given_bid", n: 0, min_n: 30, reached: false },
      { metric: "brier.p_role_holds", n: 1, min_n: 30, reached: false },
    ]);
    expect(r.n_by_metric.map((x) => x.metric)).toEqual([...METRIC_ORDER]);
    // sample_size_caveats names each metric under n
    for (const m of ["swap_regret", "brier.p_win", "brier.p_win_given_bid", "brier.p_role_holds"])
      expect(r.sample_size_caveats.some((c) => c.startsWith(`${m}: n too small (`))).toBe(true);
    expect(r.sample_size_caveats).toContain("brier.p_win: n too small (3 of 30)");
    expect(r.attribution).toBeNull();
    expect(r.rec.no_move).toBe(true);
    expect(r.rec.as_of).toBe("2026-10-06T09:05:48Z");
    expect(res.outcomes.map((o) => o.log_id)).toEqual(logged.map((l) => l.log_id));
    expect(res.outcomes.every((o) => o.scored_at === NOW && o.week_final)).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("schema: parameter_changes_proposed is absent from the v1 output (OBJ-05)", () => {
    expectTypeOf<Retrospective>().not.toHaveProperty("parameter_changes_proposed");
    const res = buildRetrospective(baseInput({ player_forecasts: forecasts(60) }), clock());
    const keys = walkKeys(res);
    expect(keys).not.toContain("parameter_changes_proposed");
    expect(keys.some((k) => /parameter/i.test(k))).toBe(false);
    expect(Object.keys(res.retrospective).sort()).toEqual(
      [
        "attribution",
        "calls",
        "final",
        "inputs",
        "metrics",
        "n_by_metric",
        "rec",
        "sample_size_caveats",
        "week",
      ].sort(),
    );
  });

  it("orders calls by recording time then log id, and scores every kind", () => {
    const res = buildRetrospective(baseInput(), clock());
    expect(res.retrospective.calls.map((c) => c.log_id.slice(-1))).toEqual(["C", "A", "D", "B"]);
    expect(res.retrospective.calls.map((c) => c.decisive)).toEqual([null, true, false, null]);
    // waiver: roster evidence (added) beats the model's "user_said_no"
    expect(res.retrospective.calls[0]!.followed).toBe(true);
  });

  it("compareRecords orders by recorded_at, then log_id", () => {
    const a = record({
      log_id: "rec-01K6D00000000000000000000A",
      recorded_at: "2026-10-01T12:00:00.000Z",
    });
    const b = record({
      log_id: "rec-01K6D00000000000000000000B",
      recorded_at: "2026-10-01T12:00:00.000Z",
    });
    const c = record({
      log_id: "rec-01K6D000000000000000000000",
      recorded_at: "2026-10-01T12:00:00.001Z",
    });
    expect(compareRecords(a, b)).toBe(-1);
    expect(compareRecords(b, a)).toBe(1);
    expect(compareRecords(a, a)).toBe(0);
    expect(compareRecords(a, c)).toBe(-1);
    expect(compareRecords(c, a)).toBe(1);
  });

  it("filters by kinds and skips records from other weeks with a warning", () => {
    const records = [...weekCalls(), record({ week: 3, log_id: "rec-01K6D00000000000000000000E" })];
    const res = buildRetrospective(baseInput({ records, kinds: ["lineup"] }), clock());
    expect(res.retrospective.calls.map((c) => c.kind)).toEqual(["lineup", "lineup"]);
    expect(res.warnings).toEqual(["retrospective: 1 records from other weeks skipped"]);
    expect(buildRetrospective(baseInput({ kinds: [] }), clock()).retrospective.calls).toEqual([]);
  });

  it("no roster and no team result: hints decide followed, decisive is null", () => {
    const res = buildRetrospective(baseInput({ roster: null, team_result: null }), clock());
    expect(res.retrospective.calls.map((c) => c.followed)).toEqual([false, null, null, null]);
    expect(res.retrospective.calls.every((c) => c.decisive === null)).toBe(true);
  });

  it("a provisional week is scored and marked not final", () => {
    const res = buildRetrospective(baseInput({ final: false }), clock());
    expect(res.retrospective.final).toBe(false);
    expect(res.outcomes.every((o) => !o.week_final)).toBe(true);
  });

  it("an empty week: nothing scored, every metric named as under n", () => {
    const res = buildRetrospective(baseInput({ records: [], realised: [], roster: [] }), clock());
    const r = res.retrospective;
    expect(r.calls).toEqual([]);
    expect(r.metrics.per_player.crps).toBeNull();
    expect(r.metrics.accuracy_gap).toBeNull();
    expect(r.n_by_metric.every((x) => !x.reached && x.n === 0)).toBe(true);
    expect(r.sample_size_caveats).toEqual(METRIC_ORDER.map((m) => `${m}: n too small (0 of 30)`));
    expect(res.outcomes).toEqual([]);
  });

  it("min_n is honoured (a lower bar reaches n sooner)", () => {
    const res = buildRetrospective(
      baseInput({
        min_n: 1,
        player_forecasts: forecasts(4),
        probabilities: {
          p_active: [{ p: 1, outcome: true }],
          p_win: [{ p: 0.5, outcome: true }],
          p_win_given_bid: [],
          p_role_holds: [],
        },
      }),
      clock(),
    );
    const r = res.retrospective;
    expect(r.metrics.swap_regret.per_call_mean).toBe(5);
    expect(r.metrics.brier.p_win).toMatchObject({ value: 0.25, n: 1 });
    expect(r.metrics.brier.p_win_given_bid).toBe("n too small (0 of 1)");
    expect(r.sample_size_caveats).toEqual([
      "brier.p_win_given_bid: n too small (0 of 1)",
      "brier.p_role_holds: n too small (0 of 1)",
    ]);
  });

  it("hostile rows are excluded and counted, never fatal", () => {
    const good = forecasts(1)[0]!;
    const res = buildRetrospective(
      baseInput({
        player_forecasts: [
          good,
          { ...good, outcome: Number.NaN },
          { ...good, position: "wide receiver" },
          { ...good, position: "wr" },
          { ...good, dist: { ...good.dist, p25: good.dist.p75 + 1 } },
          { ...good, dist: { ...good.dist, mean: Number.POSITIVE_INFINITY } },
          { ...good, samples: [] },
          { ...good, samples: [1, Number.NaN] },
          { ...good, outcome: 5e6 },
        ],
        probabilities: {
          p_active: [
            { p: 0.5, outcome: true },
            { p: Number.NaN, outcome: true },
            { p: 1.5, outcome: false },
            { p: 0.5, outcome: "yes" as unknown as boolean },
          ],
          p_win: [{ p: -0.1, outcome: true }],
          p_win_given_bid: [],
          p_role_holds: [],
        },
      }),
      clock(),
    );
    expect(res.retrospective.metrics.per_player.n_player_weeks).toBe(1);
    expect(res.retrospective.n_by_metric[2]).toMatchObject({ metric: "brier.p_active", n: 1 });
    expect(res.warnings).toEqual([
      "retrospective: 8 player forecasts excluded (invalid position, dist, samples or outcome)",
      "retrospective: 3 p_active forecasts excluded (invalid probability or outcome)",
      "retrospective: 1 p_win forecasts excluded (invalid probability or outcome)",
    ]);
    // warnings are fixed vocabulary: no row content
    expect(res.warnings.join(" ")).not.toContain("wide receiver");
  });

  it("rejects an invalid week or min_n", () => {
    for (const week of [0, 23, 1.5, Number.NaN])
      expect(() => buildRetrospective(baseInput({ week }), clock())).toThrow(/week/);
    for (const min_n of [0, 10_001, 2.5, Number.NaN])
      expect(() => buildRetrospective(baseInput({ min_n }), clock())).toThrow(/min_n/);
  });

  it("is deterministic and never mutates its input", () => {
    const inp = baseInput({ player_forecasts: forecasts(50) });
    const snapshot = JSON.stringify(inp);
    const a = buildRetrospective(inp, clock());
    const b = buildRetrospective(inp, clock());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(inp)).toBe(snapshot);
  });

  it("scales to a season of logged calls and 20 000 player-weeks", () => {
    const records = Array.from({ length: 2000 }, (_, i) =>
      record({
        log_id: `rec-01K6D${String(i).padStart(21, "0")}`,
        recorded_at: `2026-10-01T12:${String(i % 60).padStart(2, "0")}:00.000Z`,
      }),
    );
    const t0 = performance.now();
    const res = buildRetrospective(
      baseInput({ records, player_forecasts: forecasts(20_000) }),
      clock(),
    );
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(res.retrospective.calls).toHaveLength(2000);
    expect(res.retrospective.metrics.swap_regret.n_swaps).toBe(2000);
    expect(res.retrospective.metrics.swap_regret.per_call_mean).toBe(0);
  });
});

// --- QA-2-041: regret compares like with like --------------------------------------------------------

/** A whole starting lineup over the fixture league's slots (8 starters), and 4 bench players. */
const LINEUP_SLOTS = ["QB", "WR", "WR", "RB", "RB", "TE", "W/R/T", "K"] as const;
/** Indexes of the slots a lineup holds once (a start-only alternative there names its seat). */
const SINGLE_SEATS = [0, 5, 6, 7] as const;
/** Indexes of the slots a lineup holds twice (a start-only alternative there is ambiguous). */
const DOUBLE_SEATS = [1, 2, 3, 4] as const;
const gid = (i: number): string => `00-009${String(i).padStart(4, "0")}`;
const STARTER = (i: number): string => gid(i);
const BENCH = (j: number): string => gid(100 + j);
const lineupSubjects = (): RecSubject[] =>
  LINEUP_SLOTS.map((slot, i) => subj(STARTER(i), "start", slot));
/** Realised points: 8 starters then 4 bench players, `shift` added to every starter but `keep`. */
const lineupPoints = (pts: readonly number[], shift = 0, keep = -1): SubjectPoints[] => [
  ...LINEUP_SLOTS.map((_, i) => pts_(STARTER(i), (pts[i] ?? 0) + (i === keep ? 0 : shift))),
  ...[0, 1, 2, 3].map((j) => pts_(BENCH(j), pts[8 + j] ?? 0)),
];
function pts_(gsis: string, points: number): SubjectPoints {
  return { player_key: `manual.p.${gsis}`, gsis_id: gsis, nfl_team: null, points };
}
/** The three shapes of "bench player y replaces the starter in seat x". */
function shapes(x: number, y: number): Record<"whole" | "swap" | "start_only", RecSubject[]> {
  const slot = LINEUP_SLOTS[x]!;
  return {
    whole: LINEUP_SLOTS.map((s, i) => subj(i === x ? BENCH(y) : STARTER(i), "start", s)),
    swap: [subj(BENCH(y), "start", slot), subj(STARTER(x), "sit", slot)],
    start_only: [subj(BENCH(y), "start", slot)],
  };
}
const lineupCall = (alternatives: RecSubject[][], over: Partial<RecommendationRecord> = {}) =>
  record({
    kind: "lineup",
    rec: rec({ action: "keep the current lineup", subjects: lineupSubjects() }),
    alternatives: alternatives.map((subjects, i) => alt({ action: `alt ${String(i)}`, subjects })),
    ...over,
  });
const POINT = fc.double({ min: -5, max: 60, noNaN: true, noDefaultInfinity: true });

describe("QA-2-041: an alternative's regret compares like with like", () => {
  it("every shape of the same alternative scores the same regret, from the changed players only", () => {
    fc.assert(
      fc.property(
        fc.array(POINT, { minLength: 12, maxLength: 12 }),
        fc.constantFrom(...SINGLE_SEATS),
        fc.integer({ min: 0, max: 3 }),
        fc.double({ min: -30, max: 30, noNaN: true, noDefaultInfinity: true }),
        (p, x, y, shift) => {
          const want = p[8 + y]! - p[x]!;
          for (const [name, s] of Object.entries(shapes(x, y))) {
            for (const realised of [lineupPoints(p), lineupPoints(p, shift, x)]) {
              const c = scoreCall(lineupCall([s]), pointsIndex(realised), null, null).call;
              expect(c.regret, name).not.toBeNull();
              expect(c.regret!, name).toBeCloseTo(want, 6);
              expect(c.best_alternative, name).toBe("alt 0");
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("the finding's call: one alternative QB against a whole lineup is a QB-for-QB regret", () => {
    // the whole lineup realised 170.82; the alternative is one player, "start Jordan Love at QB"
    const p = [20.3, 31.2, 18.4, 22.1, 25.6, 14.5, 19.82, 18.9, 20.82, 3, 4, 5];
    const realised = lineupPoints(p);
    const c = scoreCall(
      lineupCall([shapes(0, 0).start_only], { followed_hint: "user_said_yes" }),
      pointsIndex(realised),
      null,
      { my_points: 170.82, opponent_points: 160 },
    ).call;
    expect(c.realised).toBeCloseTo(170.82, 9);
    expect(c.regret).toBeCloseTo(0.52, 9);
    // a 10.82-point win that one QB swap (+0.52) could not have changed
    expect(c.decisive).toBe(false);
  });

  it("decisive is the H2H result flipping under the like-for-like regret, never under a whole total", () => {
    fc.assert(
      fc.property(
        fc.array(POINT, { minLength: 12, maxLength: 12 }),
        fc.constantFrom(...SINGLE_SEATS),
        fc.integer({ min: 0, max: 3 }),
        fc.double({ min: -40, max: 40, noNaN: true, noDefaultInfinity: true }),
        (p, x, y, margin) => {
          const r = p[8 + y]! - p[x]!;
          const c = scoreCall(
            lineupCall([shapes(x, y).start_only], { followed_hint: "user_said_yes" }),
            pointsIndex(lineupPoints(p)),
            null,
            { my_points: margin, opponent_points: 0 },
          ).call;
          const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
          expect(c.decisive).toBe(sign(margin) !== sign(margin + c.regret!));
          expect(c.regret!).toBeCloseTo(r, 6);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("an alternative that is not comparable like with like is not scored, and is counted", () => {
    fc.assert(
      fc.property(
        fc.array(POINT, { minLength: 12, maxLength: 12 }),
        fc.constantFrom(...DOUBLE_SEATS),
        fc.integer({ min: 0, max: 3 }),
        (p, x, y) => {
          const points = pointsIndex(lineupPoints(p));
          const s = shapes(x, y);
          // a start-only alternative into a slot the lineup holds twice: which starter it replaces
          // is unknown — but the same move with its sit named, or as a whole lineup, is scored
          expect(scoreCall(lineupCall([s.start_only]), points, null, null).call.regret).toBeNull();
          for (const ok of [s.swap, s.whole])
            expect(scoreCall(lineupCall([ok]), points, null, null).call.regret!).toBeCloseTo(
              p[8 + y]! - p[x]!,
              6,
            );
          // unbalanced: two players in, one out
          const unbalanced = [...s.swap, subj(BENCH((y + 1) % 4), "start", "RB")];
          expect(scoreCall(lineupCall([unbalanced]), points, null, null).call.regret).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
    // two adds against one: not a like-for-like waiver comparison
    const waiver = record({
      kind: "waiver",
      rec: rec({ action: "Add St. Brown", subjects: [subj(ST_BROWN, "add")] }),
      alternatives: [
        alt({ action: "Add Love and Allen", subjects: [subj(LOVE, "add"), subj(ALLEN, "add")] }),
      ],
    });
    expect(scoreCall(waiver, pointsIndex(REALISED), null, null).call.regret).toBeNull();
    const res = buildRetrospective(
      baseInput({
        records: [waiver, lineupCall([shapes(1, 0).start_only, shapes(0, 0).start_only])],
        realised: [...REALISED, ...lineupPoints([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
      }),
      clock(),
    );
    // the scorable alternative still scores its call
    expect(res.retrospective.calls.map((c) => c.regret)).toEqual([null, 8]);
    expect(res.warnings).toEqual([
      "retrospective: 2 alternatives not scored: not like-for-like with the recommended move",
    ]);
  });

  it("regretAgainst: an identical move regrets exactly 0; an unknown changed player is null", () => {
    fc.assert(
      fc.property(fc.array(POINT, { minLength: 12, maxLength: 12 }), (p) => {
        const points = pointsIndex(lineupPoints(p));
        // the same lineup listed in another order: every term cancels, no float residue
        expect(regretAgainst(lineupSubjects(), lineupSubjects().reverse(), points)).toBe(0);
      }),
    );
    const points = pointsIndex(REALISED);
    const unknown = subj("00-0000001", "start", "QB");
    expect(regretAgainst([unknown], [subj(LOVE, "start", "QB")], points)).toBeNull();
    expect(regretAgainst([subj(LOVE, "start", "QB")], [unknown], points)).toBeNull();
    expect(regretAgainst([subj(ALLEN, "start", "QB")], [subj(LOVE, "start", "QB")], points)).toBe(
      -10,
    );
  });

  it("sameSubject: the first id both subjects carry decides; no shared id is never a match", () => {
    const key = { player_key: `manual.p.${LOVE}`, gsis_id: null, nfl_team: null };
    const gsis = { player_key: null, gsis_id: LOVE, nfl_team: null };
    const both = { player_key: `manual.p.${LOVE}`, gsis_id: LOVE, nfl_team: null };
    const det = { player_key: null, gsis_id: null, nfl_team: "DET" as const };
    expect(sameSubject(both, gsis)).toBe(true);
    expect(sameSubject(both, key)).toBe(true);
    expect(sameSubject(key, gsis)).toBe(false);
    expect(sameSubject(det, { ...det })).toBe(true);
    expect(sameSubject(det, { ...det, nfl_team: "PIT" })).toBe(false);
    // a player is never a defence, even one listed with a team
    expect(sameSubject(det, { ...gsis, nfl_team: "DET" })).toBe(false);
    expect(sameSubject({ ...both, player_key: "manual.p.other" }, both)).toBe(false);
  });

  it("other kinds keep their own shape: a stream against a stream, a trade nets its trade_outs", () => {
    const points = pointsIndex(REALISED);
    const stream = record({
      kind: "stream",
      rec: rec({ subjects: [teamSubj("DET", "stream"), subj(WALKER, "drop")] }),
      alternatives: [alt({ action: "PIT", subjects: [teamSubj("PIT", "stream")] })],
    });
    expect(scoreCall(stream, points, null, null).call.regret).toBe(5);
    const trade = record({
      kind: "trade",
      rec: rec({ subjects: [subj(ALLEN, "trade_in"), subj(LOVE, "trade_out")] }),
      alternatives: [
        alt({ action: "other", subjects: [subj(GIBBS, "trade_in"), subj(WALKER, "trade_out")] }),
      ],
    });
    // (Gibbs − Walker) − (Allen − Love) = (20 − 8) − (25 − 15)
    expect(scoreCall(trade, points, null, null).call.regret).toBe(2);
    // a K/DEF hold against streaming the alternative (it drops the held starter)
    const hold = record({
      kind: "stream",
      rec: rec({ subjects: [teamSubj("DET", "start")] }),
      alternatives: [
        alt({
          action: "stream PIT",
          subjects: [teamSubj("PIT", "stream"), teamSubj("DET", "drop")],
        }),
      ],
    });
    expect(scoreCall(hold, points, null, null).call.regret).toBe(5);
  });
});

// --- QA-2-040: followed for a past week never flips with a later roster -----------------------------

const outcome = (
  log_id: string,
  followed: boolean | null,
  week_final: boolean,
): RecommendationOutcome => ({
  log_id,
  followed,
  realised: null,
  regret: null,
  decisive: null,
  scored_at: "2026-09-29T12:00:00.000Z",
  week_final,
});

describe("QA-2-040: followed for a past week never flips with a later roster", () => {
  const call = (hint: RecommendationRecord["followed_hint"]) =>
    record({
      log_id: "rec-01K6D0000000000000000000FA",
      rec: rec({ subjects: [subj(GIBBS, "start", "W/R/T")] }),
      alternatives: [],
      followed_hint: hint,
    });
  const ROSTERS = {
    none: null,
    started: [{ player_key: `manual.p.${GIBBS}`, gsis_id: GIBBS, nfl_team: null, started: true }],
    benched: [{ player_key: `manual.p.${GIBBS}`, gsis_id: GIBBS, nfl_team: null, started: false }],
  } as const;
  const HINT_FOLLOWED = { unknown: null, user_said_yes: true, user_said_no: false } as const;

  it("a final outcome's answer is what E13 reports and persists, whatever the roster says now", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("unknown", "user_said_yes", "user_said_no" as const),
        fc.constantFrom("none", "started", "benched" as const),
        fc.option(
          fc.record({ followed: fc.constantFrom(true, false, null), final: fc.boolean() }),
          { nil: null },
        ),
        (hint, rosterName, prior) => {
          const r = call(hint);
          const roster = ROSTERS[rosterName];
          const res = buildRetrospective(
            baseInput({
              records: [r],
              roster,
              prior_outcomes:
                prior === null ? [] : [outcome(r.log_id, prior.followed, prior.final)],
            }),
            clock(),
          );
          const got = res.retrospective.calls[0]!.followed;
          // E14 lists what is persisted: E13's answer is always the persisted one
          expect(res.outcomes[0]!.followed).toBe(got);
          if (prior?.final === true) expect(got).toBe(prior.followed);
          else if (roster !== null) expect(got).toBe(rosterName === "started");
          else if (prior !== null && prior.followed !== null) expect(got).toBe(prior.followed);
          else expect(got).toBe(HINT_FOLLOWED[hint]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("resolveFollowed: an earlier answer is never replaced by the hint when the roster is gone", () => {
    const r = call("user_said_no");
    expect(resolveFollowed(r, null, outcome(r.log_id, true, false))).toBe(true);
    expect(resolveFollowed(r, null, outcome(r.log_id, null, false))).toBe(false);
    expect(resolveFollowed(r, null, null)).toBe(false);
    const benched = new SubjectIndex(ROSTERS.benched.map((x) => ({ ...x, value: x.started })));
    expect(resolveFollowed(r, benched, outcome(r.log_id, true, false))).toBe(false);
    expect(resolveFollowed(r, benched, outcome(r.log_id, true, true))).toBe(true);
    // a prior of another call is ignored by buildRetrospective (matched by log_id)
    const res = buildRetrospective(
      baseInput({
        records: [r],
        roster: null,
        prior_outcomes: [outcome("rec-01K6D0000000000000000000FB", true, true)],
      }),
      clock(),
    );
    expect(res.retrospective.calls[0]!.followed).toBe(false);
  });

  it("rosterHoldsWeek: a current-only roster is the week's only if unchanged since its last lock", () => {
    const LOCK = "2026-09-29T00:15:00.000Z";
    const lockMs = Date.parse(LOCK);
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: -10 * 86_400_000, max: 10 * 86_400_000 }),
        (currentOnly, offset) => {
          const asOf = new Date(lockMs + offset).toISOString();
          expect(rosterHoldsWeek(currentOnly, asOf, LOCK)).toBe(!currentOnly || offset <= 0);
          // unknown edit time or unknown lock: not evidence for a current-only roster
          expect(rosterHoldsWeek(currentOnly, null, LOCK)).toBe(!currentOnly);
          expect(rosterHoldsWeek(currentOnly, asOf, null)).toBe(!currentOnly);
        },
      ),
    );
    expect(rosterHoldsWeek(true, LOCK, LOCK)).toBe(true);
    expect(rosterHoldsWeek(true, "2026-09-29T00:15:00.001Z", LOCK)).toBe(false);
    expect(rosterHoldsWeek(true, "not a date", LOCK)).toBe(false);
  });

  it("weekLastLock: no player of the week locks after it, and one locks at it", () => {
    for (const mode of ["per_game", "weekly"] as const) {
      const last = weekLastLock(WEEK1, mode);
      const locks = WEEK1.flatMap((g) => [g.away, g.home]).map((t) => lockAtFor(t, WEEK1, mode));
      expect(last).not.toBeNull();
      expect(locks.every((l) => l !== null && Date.parse(l) <= Date.parse(last!))).toBe(true);
      expect(locks).toContain(last);
    }
    expect(weekLastLock([], "per_game")).toBeNull();
  });
});
