// types.ts — the player-crosswalk contract (research 04 §D: `gsis_id` canonical; precedence exact
// id → deterministic name+team+position match → manual override; persist every learned pair; never
// accept name-only), plan 01 §5.2 `crosswalk` row and §5.5 (delta-only writes), plan 07 G1
// `crosswalk` counts and C1 `crosswalk: { method, confidence }`, plan 05 §2 `domain/crosswalk`.
import type { IsoInstant, PlatformId, PlatformPlayer } from "../league/types.js";

/** How a pair was established (plan 07 C1). `none` = unmatched. */
export type CrosswalkMethod = "id" | "match" | "override" | "none";

/** Where the evidence for a pair came from. */
export type CrosswalkSource =
  "nflverse:roster_weekly" | "dynastyprocess:ids" | "sleeper:players" | "platform" | "overrides";

/** A persisted platform-player → gsis_id pair (plan 01 §5.2; survives team changes). */
export interface CrosswalkPair {
  readonly platform: PlatformId;
  /** The platform's player key (opaque per platform). */
  readonly platform_player_id: string;
  readonly gsis_id: string;
  readonly method: Exclude<CrosswalkMethod, "none">;
  readonly source: CrosswalkSource;
  /** 1 for id/override; the matcher's score for `match`. */
  readonly confidence: number;
  readonly first_seen: IsoInstant;
  readonly last_seen: IsoInstant;
}

/** One nflverse weekly-roster row the matcher reads (wire-free; research 04 §D columns). */
export interface NflRosterPlayer {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: number;
  /** Raw full name. */
  readonly full_name: string;
  /** nflverse team abbreviation. */
  readonly team: string;
  readonly position: string;
  readonly jersey_number: number | null;
  /** The platform ids nflverse carries (research 04 §D step 1). */
  readonly yahoo_id: string | null;
  readonly sleeper_id: string | null;
  readonly espn_id: string | null;
  readonly pfr_id: string | null;
  readonly status: string | null;
}

/** A manual override row (checked-in overrides file; research 04 §D step 3). */
export interface CrosswalkOverride {
  readonly platform: PlatformId;
  readonly platform_player_id: string;
  readonly gsis_id: string;
  /** Why (e.g. "same-name practice-squad player"); repo-authored text. */
  readonly note: string | null;
}

/** Why a candidate matched, for diagnostics. */
export type MatchEvidence = "id" | "name" | "team" | "position" | "jersey";

/** A matcher candidate for one platform player. */
export interface MatchCandidate {
  readonly gsis_id: string;
  /** Raw nflverse name. */
  readonly full_name: string;
  readonly team: string;
  readonly position: string;
  readonly jersey_number: number | null;
  /** Which fields agreed. Name alone is never enough to accept. */
  readonly evidence: readonly MatchEvidence[];
  readonly score: number;
}

/** The matcher's decision for one platform player. */
export type MatchDecision =
  | { readonly status: "matched"; readonly pair: CrosswalkPair }
  | { readonly status: "ambiguous"; readonly candidates: readonly MatchCandidate[] }
  | {
      readonly status: "unmatched";
      readonly reason: "no_candidate" | "name_only" | "unknown_team";
    };

/** Crosswalk status of one player as the tools show it (plan 07 C1 `crosswalk`). */
export interface CrosswalkStatus {
  readonly method: CrosswalkMethod;
  readonly confidence: number;
}

/** One unmatched player in the report. */
export interface UnmatchedPlayer {
  readonly player: PlatformPlayer;
  readonly reason: "no_candidate" | "name_only" | "unknown_team" | "ambiguous";
  readonly candidates: readonly MatchCandidate[];
}

/** The unmatched report (plan 07 G1 `crosswalk`; research 04 §D "alert when unmatched exceeds"). */
export interface UnmatchedReport {
  readonly matched: number;
  readonly unmatched_rostered: readonly UnmatchedPlayer[];
  readonly unmatched_top_owned: readonly UnmatchedPlayer[];
}

/** The crosswalk repository port (a REQUIRED-write family: ≤ 1 s of retries, then STORE_BUSY). */
export interface CrosswalkRepository {
  get(platform: PlatformId, platformPlayerId: string): CrosswalkPair | null;
  /** Reverse lookup: every platform key paired with a gsis id. */
  byGsis(gsisId: string): readonly CrosswalkPair[];
  /** Writes only new or changed pairs (plan 01 §5.5: delta, never a full rewrite); returns rows written. */
  upsertDelta(pairs: readonly CrosswalkPair[]): number;
  /** Counts for `ff status`. */
  count(platform: PlatformId): number;
}

/** The nflverse roster port the matcher reads (over the attached `nflverse:roster_weekly` file). */
export interface RosterWeeklyReader {
  /** The latest row per gsis id for a season. */
  latest(season: number): readonly NflRosterPlayer[];
  byPlatformId(platform: "yahoo" | "sleeper" | "espn", id: string): NflRosterPlayer | null;
}
