// registry.ts — the ONE ordered tool list (plan 01 §3.1: registration order is fixed here, filtered
// in order by FF_TOOLSET and then by capability; plan 07 C3: `core` = the 19 P0 tools). Phase 1a has
// no P1/P2 tools yet, so `full` registers the same list; NO write tool exists in this build, so
// FF_WRITE_ENABLED can never register one (plan 02 §3.4). Fixture mode adds `ff_debug_echo` (G3).
import type { Toolset } from "../config/schema.js";
import type { AnyToolDefinition } from "./define.js";
import {
  analyzeLineupTool,
  analyzeMatchupTool,
  analyzeWaiversTool,
  projectPlayersTool,
} from "./tools/analytics.js";
import { getInjuries, getSchedule } from "./tools/datasets.js";
import {
  getLeague,
  getScoreboard,
  getStandings,
  listLeagues,
  listTransactions,
} from "./tools/league.js";
import { getStatus } from "./tools/ops.js";
import { listPlayers, searchPlayers } from "./tools/players.js";
import { analyzeRetrospective, listRecommendations, recordRecommendation } from "./tools/reclog.js";
import { getPlayerStats, getRoster } from "./tools/roster.js";

/** The tool contract the Skills are stamped with (skills/_shared/manifest.json; check-skills reads it). */
export const TOOL_CONTRACT = 1;

/** The fixture-mode-only spike tool (plan 07 G3); never in a production list. */
export const DEBUG_TOOL_NAME = "ff_debug_echo";

/** Priority of a registered tool (plan 07 legend). */
export type Priority = "P0" | "P1" | "P2";

/** One registry row. */
export interface RegistryEntry {
  readonly tool: AnyToolDefinition;
  readonly priority: Priority;
}

/** Every tool, in registration order (plan 07 §3: A → B → C → D → E → G). */
export const REGISTRY: readonly RegistryEntry[] = Object.freeze([
  { tool: listLeagues, priority: "P0" },
  { tool: getLeague, priority: "P0" },
  { tool: getStandings, priority: "P0" },
  { tool: getScoreboard, priority: "P0" },
  { tool: listTransactions, priority: "P0" },
  { tool: getRoster, priority: "P0" },
  { tool: getPlayerStats, priority: "P0" },
  { tool: searchPlayers, priority: "P0" },
  { tool: listPlayers, priority: "P0" },
  { tool: getInjuries, priority: "P0" },
  { tool: getSchedule, priority: "P0" },
  { tool: projectPlayersTool, priority: "P0" },
  { tool: analyzeLineupTool, priority: "P0" },
  { tool: analyzeMatchupTool, priority: "P0" },
  { tool: analyzeWaiversTool, priority: "P0" },
  { tool: recordRecommendation, priority: "P0" },
  { tool: analyzeRetrospective, priority: "P0" },
  { tool: listRecommendations, priority: "P0" },
  { tool: getStatus, priority: "P0" },
] satisfies RegistryEntry[]);

/** The tools a toolset registers, in registry order (`core` = P0; `full` adds P1/P2 — none in 1a). */
export function toolsFor(toolset: Toolset): readonly AnyToolDefinition[] {
  return REGISTRY.filter((e) => toolset === "full" || e.priority === "P0").map((e) => e.tool);
}

/** The registered tool names for a toolset, plus the debug tool in fixture mode (last). */
export function toolNames(toolset: Toolset, fixtureMode: boolean): string[] {
  const names = toolsFor(toolset).map((t) => t.name);
  return fixtureMode ? [...names, DEBUG_TOOL_NAME] : names;
}
