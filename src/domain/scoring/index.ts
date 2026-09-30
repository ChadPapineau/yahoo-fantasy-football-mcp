// index.ts — the scoring engine's public surface (plan 08 E1): what providers, sources, the store,
// analytics and the tools import. Types live in ./types.js.
export type * from "./types.js";
export {
  BRACKET_FAMILY_KIND,
  BRACKET_FAMILY_RE,
  CANONICAL_NAME_RE,
  KNOWN_CANONICAL,
  POSITION_TYPES,
} from "./types.js";
export { ScoringError, type ScoringErrorCode } from "./errors.js";
export { coerceScalar, denoise, MAX_ABS_MODIFIER, MAX_ABS_STAT, stableSum } from "./numeric.js";
export {
  bonusRuleTarget,
  normalizeStatName,
  REGISTRY,
  type RegistryEntry,
  resolveCanonical,
  YAHOO_SAMPLE_STATS,
  type YahooSampleStat,
} from "./registry.js";
export {
  binCounts,
  bracketize,
  deriveBrackets,
  FAMILY_SCALAR,
  familyKind,
  familyScalar,
  parseBinCanonical,
  slugFamily,
} from "./brackets.js";
export {
  canonicalJson,
  computeSettingsHash,
  createUnmappedLog,
  MAX_BONUSES,
  MAX_RULES,
  normalizeSettings,
  type RuleDraft,
  type SettingsDraft,
  type UnmappedLog,
  unmappedIds,
} from "./settings.js";
export {
  applyPolicy,
  appliedRounding,
  explain,
  floorApplies,
  score,
  scoreSamples,
  scoringEngine,
} from "./engine.js";
export {
  type DefenseLineOptions,
  type LineOptions,
  makeStatLine,
  NFLVERSE_PLAYER_COLUMNS,
  type NflverseRow,
  parseKickList,
  positionTypeForNflPosition,
  rebinKickLine,
  statLineFromPlayerWeek,
  statLineFromTeamDefense,
} from "./nflverse.js";
export {
  isLeagueWideMismatch,
  LEAGUE_MISMATCH_SHARE,
  MATCH_TOLERANCE,
  pointsMatch,
} from "./policy.js";
