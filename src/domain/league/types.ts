// types.ts — the league model every provider produces and every domain module consumes (plan 01
// §8 "what the interface abstracts": refs, League, LeagueRules + capability predicates, roster
// slots {name, class, count, eligible}, rosters, PlatformPlayer with the crosswalk's fields,
// platform stat lines, matchups, standings, transactions, paging; plan 07 A1–A5/B1 shapes; plan
// 05 §14.2 lock schedule). Wire-free: no XML element, JSON key or nflverse column name appears here.
// Text fields hold RAW third-party strings; src/mcp wraps or path-lists them on output (plan 02 §6).
// Also: the platform provenance stamp every seam read returns (plan 01 §4.2/§5.4; critic C-01), the
// short-code grammars every provider must enforce so no prose rides in a code field (plan 02 §6.2;
// critic C-15), the manual player-key rule (critic C-13) and the league-side repository ports tools
// read (moved out of src/store so src/mcp may type against them; critic C-10).
import { isNflTeam, GSIS_ID_RE } from "../../config/schema.js";
import type { FreshnessClassId } from "../../config/freshness.js";
import type { PlatformId, ProjectionSubject, ScoringSettings } from "../scoring/types.js";

export type { PlatformId, ProjectionSubject } from "../scoring/types.js";

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

/**
 * A platform player key (`461.p.30123`, `manual.p.00-0012345`, `manual.p.def-kc`). Documented as a
 * key, never a name: every field typed PlayerKey must hold a string matching the key grammar
 * (src/config/schema.ts), and tool schemas validate it (critic C-22 — a brand was rejected: see
 * decisions; the walker test + the grammar checks enforce it instead).
 */
export type PlayerKey = string;

// --- provenance of platform facts (plan 01 §4.2 meta, §5.3 force_refresh, §5.4 allow_stale) ---------

/** Which platform produced a fact (the `meta.source[]` tag of a platform input). */
export type PlatformSourceTag = "manual" | "yahoo" | "sleeper" | "espn";

/**
 * Provenance of one platform read (critic C-01): enough for a tool to build its envelope InputStamp
 * without knowing which provider served it. ManualLeagueProvider stamps `as_of` = league.yaml mtime,
 * `fetched_at` = when it read the file, class `manual_league` (basis `file`); YahooProvider (1b)
 * stamps the cache entry's fetch time and its class (`platform_roster`, …).
 */
export interface PlatformStamp {
  readonly source: PlatformSourceTag;
  /** Newest content timestamp (Yahoo response time; the league file's mtime). */
  readonly as_of: IsoInstant;
  /** When the provider fetched/read it. */
  readonly fetched_at: IsoInstant;
  /** The freshness class the value is judged by. */
  readonly freshness: FreshnessClassId;
  /** Platform scoring for the week is not final yet. */
  readonly provisional: boolean;
}

/** A platform value with its provenance: what every seam read returns. */
export interface Stamped<T> {
  readonly value: T;
  readonly stamp: PlatformStamp;
}

/**
 * Per-read options every seam read accepts (plan 07 §2 common inputs): `force_refresh` (bypass the
 * provider cache; platform-fact tools only, once per 60 s per key — plan 01 §5.3) and `allow_stale`
 * (serve beyond the hard limit instead of STALE_ONLY — plan 01 §5.4). The manual provider ignores
 * both (it re-reads the file every time).
 */
export interface ReadOptions {
  readonly force_refresh?: boolean;
  readonly allow_stale?: boolean;
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

// --- short-code grammars (plan 02 §6.2 invariant; critic C-15) --------------------------------------
//
// These fields are CODES, emitted bare and unlisted, so they must never carry prose. A provider's
// normaliser validates each against its grammar: ManualLeagueProvider REJECTS a league.yaml whose
// code field fails (the file is hand/model-written), YahooProvider maps a failing value to null (or
// drops the entry). Free text lives only in the wrapped/path-listed fields (names, status_full,
// injury_note, notes).

/** Injury/status codes: `Q`, `O`, `IR`, `PUP`, `NFI-R`, `SUSP`, `NA`. */
export const STATUS_CODE_RE = /^[A-Z]{1,4}(?:-[A-Z]{1,2})?$/;
/** Display positions: `QB`, `WR`, `K`, `DEF`, IDP `DB`/`LB`/`DL`. */
export const POSITION_RE = /^[A-Z]{1,4}$/;
/** Slot names and eligible positions: `WR`, `W/R/T`, `Q/W/R/T`, `BN`, `IR`, `DEF`. */
export const SLOT_NAME_RE = /^[A-Z][A-Z/+]{0,9}$/;
/** A platform's own team abbreviation (Yahoo spells some differently from nflverse — `Jax`, `WSH`). */
export const TEAM_ABBR_RE = /^[A-Za-z]{2,4}$/;
/** Lowercase platform enums: matchup/transaction status, source/destination types, raw types. */
export const PLATFORM_CODE_RE = /^[a-z][a-z0-9_/]{0,23}$/;

/** Field name → the grammar its value must match (the walker test's allow-list of bare code fields). */
export const CODE_FIELD_GRAMMARS: Readonly<Record<string, RegExp>> = Object.freeze({
  status: STATUS_CODE_RE,
  position: POSITION_RE,
  eligible_positions: SLOT_NAME_RE,
  eligible: SLOT_NAME_RE,
  slot: SLOT_NAME_RE,
  team_abbr: TEAM_ABBR_RE,
  matchup_status: PLATFORM_CODE_RE,
  transaction_status: PLATFORM_CODE_RE,
  transaction_type: PLATFORM_CODE_RE,
  source_type: PLATFORM_CODE_RE,
  destination_type: PLATFORM_CODE_RE,
});

/** A code value if it matches `re`, else null — the Yahoo-side normaliser's mapping. */
export function codeOrNull(value: string | null | undefined, re: RegExp): string | null {
  return typeof value === "string" && value.length <= 32 && re.test(value) ? value : null;
}

/**
 * Statuses that make a player eligible for an IR slot (research 03 §C.1, Yahoo help SLN28136): IR,
 * NFI-R, NFI-A, O, PUP. Everything else (D, NA, P, Q, CEL, SUSP) is ineligible — B1
 * `ir_ineligible_in_ir`, D2 `ir_eligible` (plan 07; critic C-19).
 */
export const IR_ELIGIBLE_STATUSES: readonly string[] = Object.freeze([
  "IR",
  "NFI-R",
  "NFI-A",
  "O",
  "PUP",
]);

// --- manual player keys (plan 01 §8 X1; critic C-13) -------------------------------------------------

/**
 * The ManualLeagueProvider player key for a subject — the ONE rule the provider, E5, C1 and E12/E13
 * all use, so their joins agree: `manual.p.<gsis_id>` for a player, `manual.p.def-<team lowercase>`
 * for a team defence. Throws RangeError on an invalid gsis id or team; every key it returns matches
 * MANUAL_KEY_RE.player (a test pins that for every NFL team).
 */
export function manualPlayerKeyFor(subject: ProjectionSubject): PlayerKey {
  let key: string;
  if (subject.kind === "player") {
    if (!GSIS_ID_RE.test(subject.gsis_id)) throw new RangeError("league: invalid gsis id");
    key = `manual.p.${subject.gsis_id}`;
  } else {
    if (!isNflTeam(subject.nfl_team)) throw new RangeError("league: invalid nfl team");
    key = `manual.p.def-${subject.nfl_team.toLowerCase()}`;
  }
  return key;
}

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
  /** Team abbreviation as the platform spells it (TEAM_ABBR_RE; the crosswalk maps it). */
  readonly team_abbr: string | null;
  /** Display position, e.g. `WR`, `K`, `DEF` (POSITION_RE). */
  readonly position: string;
  /** Positions/slots this player is eligible for in this league (SLOT_NAME_RE each). */
  readonly eligible_positions: readonly string[];
  readonly uniform_number: number | null;
  /** Short status code (`Q`, `O`, `IR`, …; STATUS_CODE_RE) or null. */
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
  /**
   * Where `name` came from: the platform's own record (`platform`, the default when absent), or a
   * third-party dataset the provider merged in (`dataset`: the manual provider's nflverse kicker
   * universe, whose names are roster_weekly text — QA-1-075).
   */
  readonly name_source?: "platform" | "dataset";
}

/** One player on a roster in one week. */
export interface RosterEntry {
  readonly player: PlatformPlayer;
  /** The slot's literal name (`WR`, `W/R/T`, `BN`, `IR`; SLOT_NAME_RE). */
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
  readonly player_keys: readonly PlayerKey[];
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
  /** `preevent` | `midevent` | `postevent` or another PLATFORM_CODE_RE code. */
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

// --- league-side repository ports (implemented by src/store; critic C-10) ---------------------------
//
// Moved here from src/store/types.ts so src/mcp (which may not import src/store, not even types)
// can type G1/A2/A5 and the settings-changed flag against the real contract. Required writes return
// a Promise: the store yields between 100 ms busy_timeout attempts for up to 1 s, then throws
// StoreBusyError, so the stdio event loop is never blocked for the whole budget (critic C-04;
// plan 03 §1.2). Reads stay synchronous (one SQLite statement).

/** A normalised league-settings snapshot (plan 01 §5.2; referenced by the log, never pruned). */
export interface LeagueSettingsRow {
  readonly league_key: string;
  readonly settings_hash: string;
  readonly scoring: ScoringSettings;
  readonly slots: RosterSlots;
  readonly rules: LeagueRules;
  readonly fetched_at: IsoInstant;
}

/** A settings health flag (plan 03 §5 rows 19–20; plan 08 §6.3). */
export interface SettingsFlag {
  readonly league_key: string;
  readonly kind: "scoring_mismatch" | "scoring_mismatch_league" | "settings_changed";
  /** Fixed-vocabulary detail codes (never platform text). */
  readonly detail: readonly string[];
  readonly raised_at: IsoInstant;
  readonly acknowledged: boolean;
}

/** league_settings (required). */
export interface LeagueSettingsRepository {
  put(row: LeagueSettingsRow): Promise<void>;
  byHash(settingsHash: string): LeagueSettingsRow | null;
  latest(leagueKey: string): LeagueSettingsRow | null;
  raiseFlag(flag: SettingsFlag): Promise<void>;
  openFlags(leagueKey: string): readonly SettingsFlag[];
}

/** A roster snapshot (plan 06 §1.3; `ff://roster/snapshot`). */
export interface RosterSnapshot {
  readonly team_key: string;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  readonly roster: Roster;
}

/** roster_snapshot (required). */
export interface RosterSnapshotRepository {
  put(s: RosterSnapshot): Promise<void>;
  /** The newest two snapshots (newest first) for diffs. */
  latestTwo(teamKey: string): readonly RosterSnapshot[];
}

/** A scoreboard snapshot (pre-week platform win probability, for later calibration — tension T11). */
export interface ScoreboardSnapshot {
  readonly league_key: string;
  readonly week: Week;
  readonly taken_at: IsoInstant;
  /** The serialised matchups. */
  readonly matchups_json: string;
}

/** scoreboard_snapshot (required). */
export interface ScoreboardSnapshotRepository {
  put(s: ScoreboardSnapshot): Promise<void>;
  forWeek(leagueKey: string, week: Week): readonly ScoreboardSnapshot[];
}

/** A free-agent pool snapshot (plan 06 §1.3). */
export interface FaPoolSnapshot {
  readonly league_key: string;
  readonly taken_at: IsoInstant;
  readonly players: readonly PlatformPlayer[];
}

/** fa_pool_snapshot (required). */
export interface FaPoolSnapshotRepository {
  put(s: FaPoolSnapshot): Promise<void>;
  latestTwo(leagueKey: string): readonly FaPoolSnapshot[];
}

/** transactions_seen (required, append-only): history beyond the platform's "most recent N". */
export interface TransactionsSeenRepository {
  /** Appends unseen transactions (dedup by key); resolves to how many were new. */
  appendNew(leagueKey: string, txns: readonly Transaction[], seenAt: IsoInstant): Promise<number>;
  list(leagueKey: string, since: IsoInstant | null, limit: number): readonly Transaction[];
  oldestSeen(leagueKey: string): IsoInstant | null;
}
