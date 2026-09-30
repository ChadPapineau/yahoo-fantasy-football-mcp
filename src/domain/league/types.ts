// types.ts — the league model every provider produces and every domain module consumes (plan 01
// §8 "what the interface abstracts": refs, League, LeagueRules + capability predicates, roster
// slots {name, class, count, eligible}, rosters, PlatformPlayer with the crosswalk's fields,
// platform stat lines, matchups, standings, transactions, paging; plan 07 A1–A5/B1 shapes; plan
// 05 §14.2 lock schedule). Wire-free: no XML element, JSON key or nflverse column name appears here.
// Text fields hold RAW third-party strings; src/mcp wraps or path-lists them on output (plan 02 §6).
import type { PlatformId } from "../scoring/types.js";

export type { PlatformId } from "../scoring/types.js";

/** An NFL week number, 1..22 (plan 02 §5 bound). */
export type Week = number;

/** An ISO-8601 UTC instant string. */
export type IsoInstant = string;

/** A league reference: the platform plus its league key (`461.l.1000`, `manual.l.example`). */
export interface LeagueRef {
  readonly platform: PlatformId;
  readonly league_key: string;
}

/** A team reference: its league plus the team key (`461.l.1000.t.1`). */
export interface TeamRef {
  readonly platform: PlatformId;
  readonly league_key: string;
  readonly team_key: string;
}

/**
 * A player reference, opaque per platform (plan 01 §8: no universal player id on the seam; the only
 * cross-platform identity is `gsis_id` through the crosswalk). `id` is the platform's player key.
 */
export interface PlayerRef {
  readonly platform: PlatformId;
  readonly id: string;
}

/** A page request (plan 01 §4.2: `limit` 1..100, `offset` 0..10 000). */
export interface Page {
  readonly limit: number;
  readonly offset: number;
}

/** A page of results. `total` is known only when the platform reports it. */
export interface PageOf<T> {
  readonly items: readonly T[];
  readonly limit: number;
  readonly offset: number;
  /** `items.length`. */
  readonly count: number;
  readonly has_more: boolean;
  /** `offset + count` when `has_more`, else null. */
  readonly next_offset: number | null;
  readonly total: number | null;
}

/** One week of a league's calendar. */
export interface LeagueWeek {
  readonly week: Week;
  /** First day of the week (YYYY-MM-DD). */
  readonly start: string;
  /** Last day of the week (YYYY-MM-DD). */
  readonly end: string;
  readonly is_current: boolean;
  /** Platform scoring for the week not final yet. */
  readonly provisional: boolean;
}

/** Playoff settings (plan 07 A2 `rules.playoffs`). */
export interface PlayoffRules {
  readonly uses_playoff: boolean;
  readonly start_week: Week | null;
  readonly num_teams: number | null;
  readonly reseeding: boolean | null;
  readonly multiweek_championship: boolean | null;
  readonly consolation_teams: number | null;
}

/** How trades are reviewed (plan 01 §8 capability predicate `tradeReviewMode`). */
export type TradeReviewMode = "none" | "commissioner" | "league_vote" | "unknown";

/**
 * The capability predicates the domain needs (plan 01 §8), derived by the provider's normaliser
 * from the platform's own rule set; unknown platform values map conservatively.
 */
export interface RuleCapabilities {
  /** The league runs FAAB bidding. */
  readonly hasFaab: boolean;
  /** Days a dropped player sits on waivers; null when unknown. */
  readonly waiverProcessingDays: number | null;
  /** Trade review mode. */
  readonly tradeReviewMode: TradeReviewMode;
}

/**
 * The platform's own waiver/FAAB/trade rules (plan 01 §8, plan 07 A2 `rules`), passed through as
 * strings where enumerations are unverified (research 03 §F.9), plus the derived predicates.
 */
export interface LeagueRules {
  readonly waiver_type: string | null;
  readonly waiver_rule: string | null;
  readonly waiver_time_days: number | null;
  readonly uses_faab: boolean;
  /** Research 03 §E: not reliably exposed — null unless known. */
  readonly faab_budget: number | null;
  readonly trade_end_date: string | null;
  readonly trade_ratify_type: string | null;
  readonly trade_reject_time_days: number | null;
  readonly can_trade_draft_picks: boolean | null;
  readonly max_adds: number | null;
  readonly max_weekly_adds: number | null;
  readonly uses_median_score: boolean | null;
  readonly playoffs: PlayoffRules;
  readonly player_pool: string | null;
  readonly cant_cut_list: string | null;
  readonly allow_add_to_dl_extra_pos: boolean | null;
  /** Names of fields whose enumeration is unverified (plan 07 A2 clean negative). */
  readonly unverified_fields: readonly string[];
  /** The derived predicates. */
  readonly capabilities: RuleCapabilities;
}

/** League metadata (plan 01 §8 `getLeague`, plan 07 A1/A2 `league`). */
export interface League {
  readonly ref: LeagueRef;
  /** Raw league name (manager-authored; wrapped on output). */
  readonly name: string;
  readonly season: number;
  readonly num_teams: number;
  /** `head` | `headpoint` | `point` | `roto` or a platform string. */
  readonly scoring_type: string;
  readonly current_week: Week;
  readonly start_week: Week;
  readonly end_week: Week;
  /** The week lineup edits currently apply to; null when unknown. */
  readonly edit_key: Week | null;
  readonly weekly_deadline: string | null;
  readonly league_update_timestamp: string | null;
  readonly draft_status: string | null;
  readonly is_finished: boolean;
  /** The operator's team in this league, when known. */
  readonly my_team: TeamRef | null;
  /** Raw team name of `my_team` (wrapped on output). */
  readonly my_team_name: string | null;
  readonly weeks: readonly LeagueWeek[];
  readonly rules: LeagueRules;
}

/** A roster slot's class (plan 01 §8). */
export type SlotClass = "starter" | "flex" | "bench" | "ir" | "other";

/** Positions a slot accepts (platform position strings, e.g. `WR`, `RB`, `TE`). */
export type PositionSet = readonly string[];

/** One slot type: the platform's literal name (`W/R/T`, `BN`, `IR`), class, count, eligibility. */
export interface RosterSlot {
  readonly name: string;
  readonly class: SlotClass;
  readonly count: number;
  readonly eligible: PositionSet;
}

/** The league's roster configuration (plan 01 §8 `getRosterSlots`, plan 07 A2 `roster`). */
export interface RosterSlots {
  readonly slots: readonly RosterSlot[];
  /** Starter + flex slot count. */
  readonly starters: number;
  readonly bench: number;
  readonly ir: number;
  readonly total: number;
}

/** Ownership of a player in the league (plan 07 C1 `ownership`). */
export interface PlayerOwnership {
  readonly type: "team" | "waivers" | "freeagents" | "unknown";
  readonly owner_team_key: string | null;
  /** Raw owner team name (wrapped on output). */
  readonly owner_name: string | null;
  readonly waiver_date: string | null;
}

/**
 * A platform's player record with the fields the crosswalk needs (plan 01 §8: name, team abbr,
 * position, jersey number) and the per-league status fields the tools show.
 */
export interface PlatformPlayer {
  readonly ref: PlayerRef;
  /** Raw full name (bare, path-listed on output). */
  readonly name: string;
  /** Team abbreviation as the platform spells it (the crosswalk maps it). */
  readonly team_abbr: string | null;
  /** Display position, e.g. `WR`, `K`, `DEF`. */
  readonly position: string;
  /** Positions this player is eligible for in this league. */
  readonly eligible_positions: readonly string[];
  readonly uniform_number: number | null;
  /** Short status code (`Q`, `O`, `IR`, …) or null. */
  readonly status: string | null;
  /** Raw long status text (editor-authored; wrapped). */
  readonly status_full: string | null;
  /** Raw injury note (editor-authored; wrapped). */
  readonly injury_note: string | null;
  readonly bye_week: Week | null;
  readonly percent_owned: number | null;
  readonly percent_owned_delta: number | null;
  readonly ownership: PlayerOwnership | null;
  /** A gsis id the platform itself supplies (Sleeper, or a manual league.yaml entry); crosswalk seed. */
  readonly gsis_hint: string | null;
}

/** One player on a roster in one week. */
export interface RosterEntry {
  readonly player: PlatformPlayer;
  /** The slot's literal name (`WR`, `W/R/T`, `BN`, `IR`). */
  readonly slot: string;
  readonly slot_class: SlotClass;
  readonly is_flex: boolean;
  /** Can still be moved this week (not locked). */
  readonly is_editable: boolean;
  /** League-scored points so far this week, when known. */
  readonly week_points: number | null;
}

/** A team's roster for a week (plan 01 §8 `getRoster`). */
export interface Roster {
  readonly team: TeamRef;
  readonly week: Week;
  readonly is_editable: boolean;
  readonly entries: readonly RosterEntry[];
  /** Adds used this week, when the platform reports it. */
  readonly roster_adds_week: number | null;
}

/** One lock instant and the players that lock at it (plan 07 B1 `lock_schedule[]`, 05 §14.2). */
export interface LockScheduleEntry {
  readonly lock_at: IsoInstant;
  readonly player_keys: readonly string[];
}

/** A player's platform stat line: platform stat ids → values (plan 01 §8 `getPlayerWeekStats`). */
export interface PlatformStatLine {
  readonly player: PlayerRef;
  /** `week` for a single week, `season` for season totals. */
  readonly coverage: "week" | "season";
  /** The week, when `coverage = week`. */
  readonly week: Week | null;
  /** Platform stat id → value; absent ids were not reported. */
  readonly values: Readonly<Record<string, number>>;
  readonly provisional: boolean;
  /** The platform's own league-scored total (the golden check's reference), when reported. */
  readonly platform_points: number | null;
}

/** One side of a matchup. */
export interface MatchupTeam {
  readonly team: TeamRef;
  /** Raw team name (wrapped on output). */
  readonly name: string;
  readonly points: number | null;
  /** The platform's own projection — a cross-check, never our input (plan 07 A4). */
  readonly projected_points_platform: number | null;
  /** The platform's own win probability — a cross-check, never ground truth. */
  readonly win_probability_platform: number | null;
}

/** A head-to-head matchup (plan 07 A4). */
export interface Matchup {
  readonly week: Week;
  /** `preevent` | `midevent` | `postevent` or a platform string. */
  readonly status: string;
  readonly is_playoffs: boolean;
  readonly is_consolation: boolean;
  readonly is_tied: boolean;
  readonly winner_team_key: string | null;
  readonly teams: readonly [MatchupTeam, MatchupTeam];
}

/** A team's standing and the scalars rivals' decisions depend on (plan 07 A3). */
export interface Standing {
  readonly team: TeamRef;
  /** Raw team name (wrapped). */
  readonly name: string;
  /** Raw manager nickname (wrapped). */
  readonly manager: string | null;
  readonly rank: number | null;
  readonly playoff_seed: number | null;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pct: number | null;
  readonly streak: { readonly type: "win" | "loss" | "tie" | null; readonly value: number } | null;
  readonly points_for: number | null;
  readonly points_against: number | null;
  readonly waiver_priority: number | null;
  readonly faab_balance: number | null;
  readonly number_of_moves: number | null;
  readonly number_of_trades: number | null;
  readonly roster_adds_week: number | null;
  readonly clinched_playoffs: boolean | null;
}

/** Transaction types (plan 07 A5). */
export type TransactionType =
  "add" | "drop" | "add/drop" | "trade" | "commish" | "waiver" | "pending_trade";

/** One player movement inside a transaction. */
export interface TransactionPlayer {
  readonly player: PlayerRef;
  /** Raw player name (bare, path-listed). */
  readonly name: string;
  readonly position: string | null;
  readonly team_abbr: string | null;
  readonly action: "add" | "drop" | "trade";
  readonly source_type: string | null;
  readonly source_team_key: string | null;
  readonly destination_type: string | null;
  readonly destination_team_key: string | null;
}

/** A league transaction (plan 07 A5; persisted in `transactions_seen`). */
export interface Transaction {
  readonly transaction_key: string;
  readonly type: TransactionType | (string & {});
  readonly status: string;
  readonly timestamp: IsoInstant;
  readonly faab_bid: number | null;
  readonly waiver_priority: number | null;
  readonly players: readonly TransactionPlayer[];
  readonly trader_team_key: string | null;
  readonly tradee_team_key: string | null;
  /** Raw trade note (manager-authored; wrapped). */
  readonly note: string | null;
}
