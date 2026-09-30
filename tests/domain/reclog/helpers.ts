// helpers.ts — shared builders for the reclog tests: seeded normal draws, a valid E12 input over
// the shared fixture roster (fixtures/players/fixture-roster.json gsis ids), record factories.
import type { Rec, RecSubject } from "../../../src/domain/analytics/types.js";
import { seededRng, type Rng } from "../../../src/domain/clock.js";
import type { Dist } from "../../../src/domain/scoring/types.js";
import type {
  Alternative,
  RecommendationRecord,
  RecordRecommendationInput,
} from "../../../src/domain/reclog/types.js";

/** Standard-normal quantiles at the Dist levels 0.1 / 0.25 / 0.5 / 0.75 / 0.9. */
export const Z = Object.freeze({
  p10: -1.2815515655446004,
  p25: -0.6744897501960817,
  p75: 0.6744897501960817,
  p90: 1.2815515655446004,
});

/** A standard normal draw (Box–Muller) from a seeded Rng. */
export function normal(rng: Rng): number {
  let u = rng.next();
  while (u <= 0) u = rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** `n` seeded N(mu, sigma) draws. */
export function normals(seed: number, n: number, mu = 0, sigma = 1): number[] {
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => mu + sigma * normal(rng));
}

/** The Dist of N(mu, sigma) at the five levels. */
export function normalDist(mu: number, sigma: number): Dist {
  return {
    mean: mu,
    p10: mu + sigma * Z.p10,
    p25: mu + sigma * Z.p25,
    p50: mu,
    p75: mu + sigma * Z.p75,
    p90: mu + sigma * Z.p90,
    p_zero: 0,
    basis: "position_cv",
  };
}

/** A degenerate Dist at `c`. */
export function pointDist(c: number): Dist {
  return {
    mean: c,
    p10: c,
    p25: c,
    p50: c,
    p75: c,
    p90: c,
    p_zero: c === 0 ? 1 : 0,
    basis: "player_sim",
  };
}

// Fixture roster gsis ids (Josh Allen, Jordan Love, Jahmyr Gibbs, Kenneth Walker III, Amon-Ra St. Brown).
export const ALLEN = "00-0034857";
export const LOVE = "00-0036264";
export const GIBBS = "00-0039139";
export const WALKER = "00-0038134";
export const ST_BROWN = "00-0036963";

/** A subject for a gsis id with the manual player key. */
export function subj(
  gsis: string,
  role: RecSubject["role"],
  slot: string | null = null,
): RecSubject {
  return { player_key: `manual.p.${gsis}`, gsis_id: gsis, nfl_team: null, role, slot };
}

/** A valid Rec. */
export function rec(over: Partial<Rec> = {}): Rec {
  return {
    action: "Start Jahmyr Gibbs over Kenneth Walker III at W/R/T",
    subjects: [subj(GIBBS, "start", "W/R/T"), subj(WALKER, "sit", "BN")],
    lineup: null,
    point_estimate: 14.2,
    distribution: normalDist(14.2, 6),
    delta_vs_next: { value: 1.8, p10: -4, p90: 7.5 },
    decision_metric: "expected_points",
    drivers: [{ name: "opportunity", contribution: 1.2 }],
    assumptions: [{ text: "assumes Gibbs active", revisit_trigger: "Friday injury report" }],
    confidence: {
      role_games: 3,
      inputs: [
        {
          source: "nflverse:stats_player_week",
          as_of: "2026-09-30T09:05:48Z",
          age_s: 3600,
          freshness: "fresh",
        },
      ],
    },
    as_of: "2026-09-30T09:05:48Z",
    latest_execution_time: "2026-10-04T17:00:00Z",
    no_move: false,
    log_id: null,
    ...over,
  };
}

/** A valid alternative. */
export function alt(over: Partial<Alternative> = {}): Alternative {
  return {
    action: "Start Kenneth Walker III over Jahmyr Gibbs at W/R/T",
    subjects: [subj(WALKER, "start", "W/R/T"), subj(GIBBS, "sit", "BN")],
    point_estimate: 12.4,
    distribution: normalDist(12.4, 6),
    decision_metric_value: 12.4,
    ...over,
  };
}

/** A valid E12 input (fixture league `manual.l.example`, season 2026, week 4). */
export function input(over: Partial<RecordRecommendationInput> = {}): RecordRecommendationInput {
  return {
    league_key: "manual.l.example",
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: rec(),
    alternatives: [alt()],
    source_calls: [{ tool: "ff_analyze_lineup", request_id: "r-0123456789ab" }],
    followed_hint: "unknown",
    client_ref: null,
    note: null,
    ...over,
  };
}

let seq = 0;
/** A stored record (log id, recorded_at) around an input. */
export function record(over: Partial<RecommendationRecord> = {}): RecommendationRecord {
  seq++;
  const suffix = String(seq).padStart(4, "0");
  return {
    ...input(),
    log_id: `rec-01K6D${"0".repeat(17)}${suffix}`,
    recorded_at: "2026-10-01T12:00:00.000Z",
    settings_hash: null,
    ...over,
  };
}
