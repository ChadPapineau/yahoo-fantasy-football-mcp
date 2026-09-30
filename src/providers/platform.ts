// platform.ts — the FantasyPlatform seam (plan 01 §8): four named implementations (YahooProvider
// — Phase 1b, deferred; ManualLeagueProvider — Phase 1a, X1; SleeperProvider — X2/later;
// EspnProvider — seam only). Read methods are required; writes are OPTIONAL methods present only
// when `capabilities().write.*` is true — which no implementation is today (plan 02 §3.4, S5).
// The model types live in src/domain/league/types.ts (the domain may not import providers).
// Contract revision: every read returns `Stamped<T>` (value + provenance) and takes ReadOptions
// (`allow_stale`, `force_refresh`) so tools can fill `meta.as_of/fetched_at/age_s/freshness` for
// platform facts without knowing the provider (plan 01 §4.2/§5.3/§5.4; critic C-01); stats reads
// take week-or-season coverage (plan 07 B2; C-22); and the manual-league conventions for missing
// capabilities are fixed here once (plan 01 §8 X1; critics C-14, C-13b, C-23b).
import type {
  League,
  LeagueRef,
  Matchup,
  Page,
  PageOf,
  PlatformId,
  PlatformPlayer,
  PlatformStatLine,
  PlayerRef,
  ReadOptions,
  Roster,
  RosterSlots,
  Stamped,
  Standing,
  TeamRef,
  Transaction,
  TransactionType,
  Week,
} from "../domain/league/types.js";
import type { ScoringSettings } from "../domain/scoring/types.js";

export type * from "../domain/league/types.js";
export type { ScoringSettings } from "../domain/scoring/types.js";

/** Which write families a platform grant covers (plan 07 G1 `capabilities.write`). */
export interface WriteCapabilities {
  readonly lineup: boolean;
  readonly add_drop: boolean;
  readonly waiver: boolean;
  readonly trade: boolean;
}

/**
 * Which optional read features an implementation supports. A tool whose feature is false does NOT
 * error: platform-fact tools return their empty result plus the fixed MANUAL_FEATURE_WARNINGS entry;
 * E3 (which cannot compute P(win) without an opponent roster) returns NOT_FOUND with
 * MANUAL_NO_OPPONENT_HINT (critic C-14 convention).
 */
export interface ReadFeatures {
  /** `getPlayerStats` returns platform stat lines (false for the manual league: `match` is null). */
  readonly player_stats: boolean;
  /** `listTransactions` returns real history (false → always an empty page). */
  readonly transactions: boolean;
  /** `listPlayers` has a platform FA pool (false → the nflverse universe with `availability: unknown`). */
  readonly free_agent_pool: boolean;
  /** Rosters of other teams are available. */
  readonly other_rosters: boolean;
  /** Matchups/standings are available. */
  readonly matchups: boolean;
  /**
   * Standings are available (additive, optional): when present it overrides `matchups` for
   * `getStandings` — the manual league can know this week's opponent (matchups) without holding
   * standings. Absent → follows `matchups`.
   */
  readonly standings?: boolean;
}

/** What a platform can do right now (plan 01 §8 `capabilities()`). */
export interface PlatformCapabilities {
  readonly read: true;
  readonly write: WriteCapabilities;
  readonly read_features: ReadFeatures;
  /** When these were determined. */
  readonly discovered_at: string;
}

/** The write capabilities of every implementation in this build: all false (read-only product). */
export const NO_WRITES: WriteCapabilities = Object.freeze({
  lineup: false,
  add_drop: false,
  waiver: false,
  trade: false,
});

/** Player-pool status filter (plan 02 §5: `A|FA|W|T|K`). */
export type PlayerStatusFilter = "A" | "FA" | "W" | "T" | "K";

/** A `listPlayers` query (plan 07 C1/C2 inputs, already validated). */
export interface PlayerQuery {
  readonly status: PlayerStatusFilter;
  /** A position or slot name from the league's own roster settings. */
  readonly position: string | null;
  /** Name search, ≤ 64 printable chars. */
  readonly search: string | null;
  /** `OR` | `AR` | `PTS` | `NAME` | a stat id. */
  readonly sort: string | null;
  readonly sort_type: "season" | "week" | null;
  readonly sort_week: Week | null;
}

/** A `listTransactions` query (plan 07 A5). */
export interface TxnQuery {
  readonly types: readonly TransactionType[] | null;
  /** Required for `waiver` / `pending_trade`. */
  readonly team_key: string | null;
  /** 1..200 most recent. */
  readonly count: number;
  readonly since: string | null;
}

// --- write intents (Phase W; present on the seam so it is honest, never implemented today) --------

/** One lineup move: put a player in a slot for a week. */
export interface SlotMove {
  readonly player: PlayerRef;
  readonly to_slot: string;
}

/** An add/drop or waiver claim request. */
export interface AddDropRequest {
  readonly team: TeamRef;
  readonly add: PlayerRef | null;
  readonly drop: PlayerRef | null;
  readonly faab_bid: number | null;
}

/** Proof from the confirmation gate that a human approved this exact write (plan 02 §4.4). */
export interface CommitTicket {
  readonly prepared_id: string;
  readonly ticket: string;
  readonly diff_hash: string;
  readonly precondition_hash: string;
  readonly expires_at: string;
}

/** What a write did (plan 02 §4.1 receipt). */
export interface WriteReceipt {
  readonly prepared_id: string;
  readonly applied: boolean | "unknown";
  readonly upstream_status: number | null;
  readonly at: string;
}

/** A stats query: one week, or season totals (plan 07 B2 `type`, C2 `with_stats.type`). */
export type StatsQuery =
  { readonly coverage: "week"; readonly week: Week } | { readonly coverage: "season" };

/**
 * The seam. Every implementation maps its failures to the plan 01 §4.3 error codes (a provider may
 * not import src/mcp, so it throws Errors carrying `ffCode` — e.g. LeagueFileError). Every read
 * resolves to `Stamped<T>`; a type test pins that no read returns a bare value.
 *
 * Identifier obligation (CLAUDE.md security; critic C-23b): on every load, an implementation
 * registers the operator's identifying strings — league name, team names, manager names, and a
 * user-chosen `manual.l.<slug>` — with the logger's `registerSecret("identifier", …)` BEFORE any of
 * them can reach a log line, so debug fields and echoed arguments are redacted.
 */
export interface FantasyPlatform {
  /** Which platform this is. */
  readonly id: PlatformId;
  /** Read features and (all-false) write capabilities. */
  capabilities(): Promise<PlatformCapabilities>;
  /** The operator's leagues (the manual provider returns exactly one). */
  listMyLeagues(opts?: ReadOptions): Promise<Stamped<readonly LeagueRef[]>>;
  /** League metadata incl. current week, edit week, deadlines and rules. */
  getLeague(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<League>>;
  /** Normalised scoring settings (plan 01 §8.1, plan 08 §2). */
  getScoringSettings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<ScoringSettings>>;
  /** Roster slot configuration. */
  getRosterSlots(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<RosterSlots>>;
  /** A team's roster for a week. */
  getRoster(team: TeamRef, week: Week, opts?: ReadOptions): Promise<Stamped<Roster>>;
  /** A page of the player pool. */
  listPlayers(
    ref: LeagueRef,
    q: PlayerQuery,
    page: Page,
    opts?: ReadOptions,
  ): Promise<Stamped<PageOf<PlatformPlayer>>>;
  /** Platform stat lines for ≤ 25 players (empty when `read_features.player_stats` is false). */
  getPlayerStats(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    q: StatsQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly PlatformStatLine[]>>;
  /** A week's matchups (empty when `read_features.matchups` is false). */
  getMatchups(ref: LeagueRef, week: Week, opts?: ReadOptions): Promise<Stamped<readonly Matchup[]>>;
  /** Current standings (empty when `read_features.matchups` is false). */
  getStandings(ref: LeagueRef, opts?: ReadOptions): Promise<Stamped<readonly Standing[]>>;
  /** Most recent transactions (never pages: plan 01 §4.2; empty when unsupported). */
  listTransactions(
    ref: LeagueRef,
    q: TxnQuery,
    opts?: ReadOptions,
  ): Promise<Stamped<readonly Transaction[]>>;
  /** Phase W only — absent in every implementation today. */
  setLineup?(
    team: TeamRef,
    week: Week,
    moves: readonly SlotMove[],
    ticket: CommitTicket,
  ): Promise<WriteReceipt>;
  /** Phase W only — absent in every implementation today. */
  addDrop?(ref: LeagueRef, txn: AddDropRequest, ticket: CommitTicket): Promise<WriteReceipt>;
}

/** Builds the capabilities of a read-only implementation (every write flag false). */
export function readOnlyCapabilities(
  readFeatures: ReadFeatures,
  discoveredAt: string,
): PlatformCapabilities {
  return Object.freeze({
    read: true,
    write: NO_WRITES,
    read_features: Object.freeze({ ...readFeatures }),
    discovered_at: discoveredAt,
  });
}

// --- manual-league conventions (plan 01 §8 X1; critic C-14) -----------------------------------------
//
// Fixed, server-authored strings (printable ASCII, so the error mapper's hint check accepts them).
// src/mcp/errors.ts honours an Error's `ffHint` ONLY when it is one of SERVER_HINTS — never text from
// a file or upstream.

/** No league.yaml exists → NOT_FOUND with this hint. */
export const MANUAL_LEAGUE_MISSING_HINT =
  "No league configured: create <config>/league.yaml (the onboard Skill helps), then retry.";
/** league.yaml exists but is malformed, a symlink, or not 0600 → INTERNAL with this hint (never VALIDATION). */
export const LEAGUE_FILE_INVALID_HINT =
  "league.yaml is invalid or unsafe: run `ff doctor` in a terminal, fix what it names, then retry.";
/** E3 (and E2 `pwin`) without an opponent roster → NOT_FOUND with this hint. */
export const MANUAL_NO_OPPONENT_HINT =
  "No opponent roster in league.yaml for this week: add it to get a win probability, or use objective mean.";

/** The capabilities the manual league may lack, and the fixed warning a tool adds for each. */
export const MANUAL_FEATURE_WARNINGS = Object.freeze({
  standings: "standings are not available under the manual league (league.yaml has none)",
  matchups: "matchups are not available under the manual league (league.yaml has none)",
  transactions: "transactions are not available under the manual league",
  other_rosters:
    "other teams' rosters are not available under the manual league (league.yaml has none)",
  player_stats: "platform stat lines are not available under the manual league; match is null",
});
/** A manual-league feature key. */
export type ManualFeature = keyof typeof MANUAL_FEATURE_WARNINGS;

/** E5 under the manual league: no platform FA pool (plan 07 E5, round 2). */
export const MANUAL_FA_POOL_WARNING =
  "availability unknown — no platform FA pool under the manual league; check the Yahoo waiver wire before claiming";

/**
 * E1 `pool` under the manual league: the pool resolves through `listPlayers` to the nflverse K/DEF
 * universe; for other positions it holds only players pasted into league.yaml (possibly none) and
 * the result carries this warning (plan 01 §8 X1 "other positions empty unless pasted"; critic C-06).
 */
export const MANUAL_POOL_WARNING =
  "the manual league has no player pool beyond K/DEF and players listed in league.yaml";

/** G1 `auth` under the manual league (no platform sign-in exists; critic C-14 (d)). */
export const MANUAL_AUTH_STATUS = Object.freeze({
  state: "NoTokens",
  provisioning: "unknown",
  access_expires_at: null,
  last_refresh_at: null,
} as const);

/** Every hint a cross-layer Error may carry in `ffHint` (the mapper's allow-list). */
export const SERVER_HINTS: ReadonlySet<string> = new Set([
  MANUAL_LEAGUE_MISSING_HINT,
  LEAGUE_FILE_INVALID_HINT,
  MANUAL_NO_OPPONENT_HINT,
]);

/** One league.yaml problem: a JSON-path-like location and a fixed reason — never the value. */
export interface LeagueFileIssue {
  readonly path: string;
  readonly reason: string;
}

/**
 * The manual league file is missing (`NOT_FOUND`) or unusable (`INTERNAL`) — thrown by
 * ManualLeagueProvider on any read (critic C-13b). Carries value-free issues for `ff doctor` and a
 * server hint for the tool result; the model is never told its arguments are at fault.
 */
export class LeagueFileError extends Error {
  readonly ffCode: "NOT_FOUND" | "INTERNAL";
  readonly ffHint: string;
  readonly kind: "missing" | "invalid";
  readonly issues: readonly LeagueFileIssue[];
  constructor(kind: "missing" | "invalid", issues: readonly LeagueFileIssue[] = []) {
    super(kind === "missing" ? "league.yaml not found" : "league.yaml is invalid");
    this.name = "LeagueFileError";
    this.kind = kind;
    this.ffCode = kind === "missing" ? "NOT_FOUND" : "INTERNAL";
    this.ffHint = kind === "missing" ? MANUAL_LEAGUE_MISSING_HINT : LEAGUE_FILE_INVALID_HINT;
    this.issues = issues;
  }
}
