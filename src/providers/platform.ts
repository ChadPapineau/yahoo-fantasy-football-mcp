// platform.ts — the FantasyPlatform seam (plan 01 §8): four named implementations (YahooProvider
// — Phase 1b, deferred; ManualLeagueProvider — Phase 1a, X1; SleeperProvider — X2/later;
// EspnProvider — seam only). Read methods are required; writes are OPTIONAL methods present only
// when `capabilities().write.*` is true — which no implementation is today (plan 02 §3.4, S5).
// The model types live in src/domain/league/types.ts (the domain may not import providers).
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
  Roster,
  RosterSlots,
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

/** Which optional read features an implementation supports (lets tools say "unsupported" cleanly). */
export interface ReadFeatures {
  /** `getPlayerWeekStats` returns platform stat lines (false for the manual league: `match` is null). */
  readonly player_stats: boolean;
  /** `listTransactions` returns real history (false → always an empty page). */
  readonly transactions: boolean;
  /** `listPlayers` has a platform FA pool (false → the nflverse universe with `availability: unknown`). */
  readonly free_agent_pool: boolean;
  /** Rosters of other teams are available. */
  readonly other_rosters: boolean;
  /** Matchups/standings are available. */
  readonly matchups: boolean;
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

/** The seam. Every implementation maps its failures to the plan 01 §4.3 error codes. */
export interface FantasyPlatform {
  /** Which platform this is. */
  readonly id: PlatformId;
  /** Read features and (all-false) write capabilities. */
  capabilities(): Promise<PlatformCapabilities>;
  /** The operator's leagues (the manual provider returns exactly one). */
  listMyLeagues(): Promise<readonly LeagueRef[]>;
  /** League metadata incl. current week, edit week, deadlines and rules. */
  getLeague(ref: LeagueRef): Promise<League>;
  /** Normalised scoring settings (plan 01 §8.1, plan 08 §2). */
  getScoringSettings(ref: LeagueRef): Promise<ScoringSettings>;
  /** Roster slot configuration. */
  getRosterSlots(ref: LeagueRef): Promise<RosterSlots>;
  /** A team's roster for a week. */
  getRoster(team: TeamRef, week: Week): Promise<Roster>;
  /** A page of the player pool. */
  listPlayers(ref: LeagueRef, q: PlayerQuery, page: Page): Promise<PageOf<PlatformPlayer>>;
  /** Platform stat lines for ≤ 25 players (empty when `read_features.player_stats` is false). */
  getPlayerWeekStats(
    ref: LeagueRef,
    players: readonly PlayerRef[],
    week: Week,
  ): Promise<readonly PlatformStatLine[]>;
  /** A week's matchups. */
  getMatchups(ref: LeagueRef, week: Week): Promise<readonly Matchup[]>;
  /** Current standings. */
  getStandings(ref: LeagueRef): Promise<readonly Standing[]>;
  /** Most recent transactions (never pages: plan 01 §4.2). */
  listTransactions(ref: LeagueRef, q: TxnQuery): Promise<readonly Transaction[]>;
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
