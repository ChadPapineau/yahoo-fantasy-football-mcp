// calls.ts — one valid call per tool on the fixture league (tests/mcp/helpers/env.ts world), for the
// suites that sweep every tool: the answer-time refresh (refresh-meta, on-demand-off, the datasets
// drift guard) and the no-network-in-server spy. ff_record_recommendation logs a real E2 rec.
import type { Client } from "@modelcontextprotocol/client";
import { body, TEAM_A } from "./env.js";

export const ALLEN = "manual.p.00-0034857";
export const CHASE = "manual.p.00-0036900";

/** One valid argument set per tool (ff_record_recommendation is built from a live E2 result). */
export const ONE_CALL: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  ff_list_leagues: {},
  ff_get_league: {},
  ff_get_standings: {},
  ff_get_scoreboard: { week: 3 },
  ff_list_transactions: {},
  ff_get_roster: { week: 4 },
  ff_get_player_stats: { player_keys: [ALLEN, CHASE], type: "week", week: 3 },
  ff_search_players: { query: "Allen" },
  ff_list_players: { position: "K" },
  ff_get_injuries: {},
  ff_get_schedule: { weeks: [4] },
  ff_project_players: { players: { team_key: TEAM_A }, horizon: "week", week: 4, seed: 1 },
  ff_analyze_lineup: { week: 4 },
  ff_analyze_matchup: { week: 3 },
  ff_analyze_waivers: { positions: ["K", "DEF"], look_ahead: 1 },
  ff_analyze_retrospective: { week: 3 },
  ff_list_recommendations: {},
  ff_get_status: { include_checks: true },
});

/** The arguments of a valid ff_record_recommendation: E2's week-4 rec, citing that call. */
export async function recordArgs(client: Client): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name: "ff_analyze_lineup", arguments: { week: 4 } });
  const b = body(r) as { data: { rec: unknown }; meta: { request_id: string } };
  if (r.isError === true) throw new Error(`E2 failed: ${JSON.stringify(b)}`);
  return {
    kind: "lineup",
    week: 4,
    rec: b.data.rec,
    alternatives: [],
    source_calls: [{ tool: "ff_analyze_lineup", request_id: b.meta.request_id }],
    followed_hint: "unknown",
  };
}

/** Every registered tool's call: ONE_CALL plus the record call (built through `client`). */
export async function everyCall(client: Client): Promise<[string, Record<string, unknown>][]> {
  return [...Object.entries(ONE_CALL), ["ff_record_recommendation", await recordArgs(client)]];
}
