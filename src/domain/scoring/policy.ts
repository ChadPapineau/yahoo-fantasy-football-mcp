// policy.ts — the golden/live comparison constants: plan 08 §6.1 (|engine − platform| ≤ 0.01, the
// exact total rounded to 2 dp for comparison only, §4.4) and §6.3 c′ (a league-wide block only when
// more than 10 % of rostered player-weeks mismatch — A-5, "the constant lives in one file").

/** Golden tolerance: a player-week matches when |engine − platform| ≤ 0.01 (plan 08 §6.1). */
export const MATCH_TOLERANCE = 0.01;

/** Share of rostered player-weeks above which a mismatch is league-wide (plan 08 §6.3 c′, A-5). */
export const LEAGUE_MISMATCH_SHARE = 0.1;

/** Slack for binary-float noise on top of the 0.01 tolerance (never widens it materially). */
const FLOAT_SLACK = 1e-9;

/**
 * Whether an engine total matches the platform's (plan 08 §6.1). Non-finite inputs never match.
 */
export function pointsMatch(engine: number, platform: number): boolean {
  if (!Number.isFinite(engine) || !Number.isFinite(platform)) return false;
  return Math.abs(engine - platform) <= MATCH_TOLERANCE + FLOAT_SLACK;
}

/**
 * Whether `mismatched` of `total` rostered player-weeks is a settings change rather than a stat
 * correction (plan 08 §6.3 c′): strictly more than 10 %. Zero or invalid totals are never
 * league-wide.
 */
export function isLeagueWideMismatch(mismatched: number, total: number): boolean {
  if (!Number.isInteger(mismatched) || !Number.isInteger(total) || total <= 0 || mismatched < 0) {
    return false;
  }
  return mismatched / total > LEAGUE_MISMATCH_SHARE;
}
