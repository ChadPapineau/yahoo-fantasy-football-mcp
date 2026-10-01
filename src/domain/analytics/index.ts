// index.ts — the P0 analytics engines (plan 07 E1 projections v1-trailing, E2 lineup, E3 `pre`
// matchup, E5 K/DEF streaming) and their shared kernels; the contract types live in ./types.ts.
export type * from "./types.js";
export { COARSE_BAND_CUTOFFS, COIN_FLIP_DPWIN, isCoinFlip, toCoarseDelta } from "./types.js";
export * from "./constants.js";
export {
  AnalyticsError,
  INCOMPLETE_OPPONENT_HINT,
  NO_OPPONENT_HINT,
  type AnalyticsErrorCode,
} from "./errors.js";
export { collectInputs, mergeInputs, newestAsOf, type AnyStamp } from "./inputs.js";
export { pActive, type Availability as PActive, type AvailabilityInput } from "./availability.js";
export {
  projectPlayers,
  type ProjectedPlayer,
  type ProjectedWeek,
  type ProjectionOutcome,
  type ProjectionReaders,
  type ProjectionRequest,
  type ProjectionTarget,
} from "./projection.js";
export { solveAssignment, FORBIDDEN } from "./assignment.js";
export {
  lineupCov,
  lineupMoments,
  pairMoments,
  pWinInterval,
  pWinNormal,
  diffSd,
  rho,
  type PairMoments,
  type TotalMember,
} from "./totals.js";
export {
  analyzeLineup,
  bestLineup,
  emptyStartSeats,
  opponentLineup,
  type LineupPlayer,
  type LineupRequest,
} from "./lineup.js";
export { analyzeMatchupPre, distQuantile, cholesky, type MatchupRequest } from "./matchup.js";
export {
  analyzeKdef,
  type KdefCandidateInput,
  type KdefOutcome,
  type KdefPosition,
  type KdefRequest,
} from "./kdef.js";
export {
  clamp,
  distFromSamples,
  gammaDraw,
  gammaMultiplier,
  normalCdf,
  normalDist,
  normalDraw,
  poissonDraw,
  quantileSorted,
  ranks,
  round,
  sigmaOf,
  spearman,
  zeroDist,
} from "./math.js";
