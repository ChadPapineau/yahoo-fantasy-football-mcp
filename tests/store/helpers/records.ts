// records.ts — well-formed domain values for the repository tests (placeholders only: "Example
// League" keys, Team A…; real public player ids from the fixture roster).
import type { Rec } from "../../../src/domain/analytics/types.js";
import type {
  LeagueRules,
  PlatformPlayer,
  Roster,
  RosterSlots,
  Transaction,
} from "../../../src/domain/league/types.js";
import type { RecordRecommendationInput } from "../../../src/domain/reclog/types.js";
import type {
  ScoringSettings,
  StatLine,
  StoredProjection,
} from "../../../src/domain/scoring/types.js";

export const LEAGUE = "manual.l.example";
export const TEAM = "manual.l.example.t.1";

const dist = {
  mean: 10,
  p10: 4,
  p25: 7,
  p50: 10,
  p75: 13,
  p90: 16,
  p_zero: 0.02,
  basis: "position_cv",
} as const;

export function rec(action = "Start Josh Allen over Jordan Love"): Rec {
  return {
    action,
    subjects: [
      {
        player_key: "manual.p.00-0034857",
        gsis_id: "00-0034857",
        nfl_team: null,
        role: "start",
        slot: "QB",
      },
    ],
    lineup: null,
    point_estimate: 21.5,
    distribution: dist,
    delta_vs_next: { value: 3, p10: -2, p90: 8 },
    decision_metric: "expected_points",
    drivers: [{ name: "matchup", contribution: 1.2 }],
    assumptions: [{ text: "healthy", revisit_trigger: "injury report" }],
    confidence: { role_games: 3, inputs: [] },
    as_of: "2026-09-30T12:00:00.000Z",
    latest_execution_time: null,
    no_move: false,
    log_id: null,
  };
}

export function recordInput(
  over: Partial<RecordRecommendationInput> = {},
): RecordRecommendationInput {
  return {
    league_key: LEAGUE,
    season: 2026,
    kind: "lineup",
    week: 4,
    rec: rec(),
    alternatives: [],
    source_calls: [{ tool: "ff_analyze_lineup", request_id: "r-0123456789ab" }],
    followed_hint: "unknown",
    client_ref: null,
    note: null,
    ...over,
  };
}

export const RULES: LeagueRules = {
  waiver_type: null,
  waiver_rule: null,
  waiver_time_days: 2,
  uses_faab: true,
  faab_budget: 100,
  trade_end_date: null,
  trade_ratify_type: null,
  trade_reject_time_days: null,
  can_trade_draft_picks: null,
  max_adds: null,
  max_weekly_adds: null,
  uses_median_score: null,
  playoffs: {
    uses_playoff: true,
    start_week: 15,
    num_teams: 6,
    reseeding: null,
    multiweek_championship: null,
    consolation_teams: null,
  },
  player_pool: null,
  cant_cut_list: null,
  allow_add_to_dl_extra_pos: null,
  unverified_fields: [],
  capabilities: { hasFaab: true, waiverProcessingDays: 2, tradeReviewMode: "unknown" },
};

export const SLOTS: RosterSlots = {
  slots: [{ name: "QB", class: "starter", count: 1, eligible: ["QB"] }],
  starters: 1,
  bench: 0,
  ir: 0,
  total: 1,
};

export function scoring(hash: string): ScoringSettings {
  return {
    platform: "manual",
    rules: [],
    brackets: [],
    uses_fractional_points: true,
    uses_negative_points: true,
    rounding: { mode: "exact", verified: false },
    negative_floor: { scope: "none", verified: false },
    settings_hash: hash,
  };
}

export function player(id = "00-0034857", name = "Josh Allen"): PlatformPlayer {
  return {
    ref: { platform: "manual", id: `manual.p.${id}` },
    name,
    team_abbr: "BUF",
    position: "QB",
    eligible_positions: ["QB"],
    uniform_number: 17,
    status: null,
    status_full: null,
    injury_note: null,
    bye_week: 7,
    percent_owned: null,
    percent_owned_delta: null,
    ownership: null,
    gsis_hint: id,
  };
}

export function roster(week = 4): Roster {
  return {
    team: { platform: "manual", league_key: LEAGUE, team_key: TEAM },
    week,
    is_editable: true,
    entries: [
      {
        player: player(),
        slot: "QB",
        slot_class: "starter",
        is_flex: false,
        is_editable: true,
        week_points: null,
      },
    ],
    roster_adds_week: null,
  };
}

export function txn(key: string, ts: string): Transaction {
  return {
    transaction_key: key,
    type: "add/drop",
    status: "successful",
    timestamp: ts,
    faab_bid: 5,
    waiver_priority: null,
    players: [],
    trader_team_key: null,
    tradee_team_key: null,
    note: null,
  };
}

export function statLine(v: number): StatLine {
  return {
    values: { pass_yd: v },
    present: ["pass_yd"],
    position_type: "O",
    provisional: false,
    source: "projection:v1-trailing",
  };
}

export function projection(madeAt: string, mean: number, gsis = "00-0034857"): StoredProjection {
  return {
    subject: { kind: "player", gsis_id: gsis },
    season: 2026,
    week: 4,
    model_version: "v1-trailing",
    made_at: madeAt,
    inputs_as_of: "2026-09-30T09:00:00.000Z",
    expectation: { pass_yd: mean },
    samples: [statLine(mean - 10), statLine(mean + 10)],
  };
}
