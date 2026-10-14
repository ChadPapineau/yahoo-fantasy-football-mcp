// weeks.ts — structural week bounds (season-fresh spec §2.6). Neither number is a season length:
// a season's length comes from the loaded schedule (`SeasonSchedule.last_reg_week` / `last_week`).
// WEEK_INDEX_MAX bounds a week index in data (store readers, the runner, schedule enumeration);
// TOOL_INPUT_WEEK_MAX is the tool-contract-1 input bound, raised only with a contract bump.

/** Structural sanity bound for a week index in data (never a season length). */
export const WEEK_INDEX_MAX = 30;

/** 1..WEEK_INDEX_MAX — enumerate a season's games without assuming its length. */
export const ALL_WEEK_INDEXES: readonly number[] = Object.freeze(
  Array.from({ length: WEEK_INDEX_MAX }, (_, i) => i + 1),
);

/** The tool-input week bound of tool contract 1 (raised only with a contract bump). */
export const TOOL_INPUT_WEEK_MAX = 22;
