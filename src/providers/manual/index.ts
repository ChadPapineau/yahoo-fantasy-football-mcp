// index.ts — ManualLeagueProvider (plan 01 §8 X1; plan 10 §3.1a): the FantasyPlatform over
// <config>/league.yaml, its file schema, the hostile-input-safe parser and the scoring presets.
export {
  ManualLeagueProvider,
  ManualNotFoundError,
  type ManualLeagueProviderOptions,
} from "./provider.js";
export { parseLeagueYaml, MAX_LEAGUE_FILE_BYTES, MAX_YAML_DEPTH, MAX_YAML_NODES } from "./parse.js";
export { leagueFileSchema, issuesOf, LEAGUE_FILE_VERSION, type LeagueFile } from "./schema.js";
export {
  normalizeLeague,
  entryKey,
  type ManualLeagueData,
  type ManualPlayer,
  type ManualTeam,
} from "./normalize.js";
export { buildScoringSettings, BASE_SCORING, PRESET_REC } from "./scoring.js";
