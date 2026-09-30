// types.ts — the analytics contract (plan 07 legend `Dist`/`Rec`, §2 `data.inputs[]`; E1
// projections with `model_version`; E2 lineup incl. `objective`, `delta_pwin` as {sign, band} in
// `position_cv` mode, `coin_flip`; E3 `pre` win probability; E5 K/DEF streaming candidates), the
// wire-free dataset rows the engines read (schedules/lines, injuries, weather, weekly stat lines —
// plan 01 §5.2), and the read-only dataset ports the store implements (plan 01 §5.5: `ds_*` tables
// live in attached read-only files; the domain sees only these interfaces).
import type { Freshness } from "../../config/freshness.js";
import type { IsoInstant, LockScheduleEntry, Week } from "../league/types.js";
import type { Canonical, Dist, DistBasis, StatLine, StoredProjection } from "../scoring/types.js";

export type { Dist, DistBasis } from "../scoring/types.js";

// --- the recommendation contract (plan 07 legend `Rec`; research 05 §0) ---------------------------

/** One driver of a recommendation and its signed contribution in points. */
export interface Driver {
  readonly name: string;
  readonly contribution: number;
}

/** An assumption the recommendation rests on, and what would make it worth revisiting. */
export interface Assumption {
  readonly text: string;
  readonly revisit_trigger: string;
}

/** One contributing input and its freshness (plan 07 §2 `data.inputs[]`; plan 01 §5.4). */
export interface InputFreshness {
  /** Source tag (`nflverse:schedules`, `manual`, …). */
  readonly source: string;
  readonly as_of: IsoInstant;
  readonly age_s: number;
  readonly freshness: Freshness;
}

/** Confidence evidence (research 05 §0: role games + data freshness timestamps). */
export interface Confidence {
  /** Games of evidence for the player's current role. */
  readonly role_games: number;
  readonly inputs: readonly InputFreshness[];
}

/** The gap to the next-best alternative. */
export interface DeltaVsNext {
  readonly value: number;
  readonly p10: number;
  readonly p90: number;
}

/** What a recommendation optimised. Open-ended for later engines. */
export type DecisionMetric =
  | "expected_points"
  | "p_win"
  | "blend"
  | "marginal_value"
  | "weeks_of_value"
  | "vor"
  | (string & {});

/** The recommendation every analytics tool carries as `data.rec` (plan 07 legend `Rec`). */
export interface Rec {
  /** The recommended action, in words (model-visible; logged later as untrusted). */
  readonly action: string;
  readonly point_estimate: number;
  readonly distribution: Dist;
  readonly delta_vs_next: DeltaVsNext;
  readonly decision_metric: DecisionMetric;
  readonly drivers: readonly Driver[];
  /** Includes every omitted driver by name (plan 01 §5.7: never silently omitted). */
  readonly assumptions: readonly Assumption[];
  readonly confidence: Confidence;
  readonly as_of: IsoInstant;
  /** The last moment the action can still be executed (research 05 §14.2); null when not time-bound. */
  readonly latest_execution_time: IsoInstant | null;
  /** True when the right call is to do nothing. */
  readonly no_move: boolean;
  /** Filled only by `ff_record_recommendation`; null in every analytics result. */
  readonly log_id: string | null;
}

// --- projections (plan 07 E1; plan 08 §5) ---------------------------------------------------------

/** Projection model versions (plan 07 E1): v1 = trailing nflverse lines + position CVs. */
export type ModelVersion = "v1-trailing" | "v2-opportunity";

/** One projected week for one player. */
export interface ProjectionWeek {
  readonly week: Week;
  readonly points: Dist;
  /** Probability the player is active; null when unknown. */
  readonly p_active: number | null;
  readonly opponent: string | null;
  readonly implied_total: number | null;
}

/** A shrinkage applied to a rate: observed n, prior strength k (plan 07 E1 `shrinkage[]`). */
export interface Shrinkage {
  readonly rate: string;
  readonly n: number;
  readonly k: number;
}

/** Opportunity summary (v2; null under v1). */
export interface Opportunity {
  readonly targets: number;
  readonly carries: number;
  readonly rz_targets: number;
  readonly gl_carries: number;
  readonly window_games: number;
}

/** A player's projection (plan 07 E1 `projections[]`). Names are raw; the tool path-lists them. */
export interface Projection {
  readonly player_key: string | null;
  readonly gsis_id: string | null;
  readonly name: string;
  readonly position: string;
  readonly model_version: ModelVersion;
  readonly weeks: readonly ProjectionWeek[];
  readonly ros_total: Dist | null;
  readonly stat_line_expectation: Readonly<Record<Canonical, number>> | null;
  readonly opportunity: Opportunity | null;
  readonly shrinkage: readonly Shrinkage[];
  readonly multipliers: { readonly matchup: number | null; readonly weather: number | null };
  readonly drivers: readonly Driver[];
  readonly role_confidence_games: number;
  readonly assumptions: readonly Assumption[];
}

// --- start/sit (plan 07 E2) -----------------------------------------------------------------------

/** The start/sit objective (plan 07 C11: `mean` is the v1 default; `pwin` opt-in). */
export type Objective = "mean" | "pwin" | "blend";

/** H2H mode from the sign of μ_m − μ_o (research 05 §3.2). */
export type MatchupMode = "protect" | "chase" | "neutral";

/** The coarse ΔP(win) reported in `position_cv` mode (plan 07 C11, round 1 OBJ-04). */
export interface CoarseDelta {
  readonly sign: "+" | "-" | "0";
  readonly band: "small" | "medium" | "large";
}

/** ΔP(win): a number only under `player_sim`; the coarse form whenever `dist_basis = position_cv`. */
export type DeltaPwin = number | CoarseDelta;

/** One slot assignment in a lineup. */
export interface LineupSlotAssignment {
  readonly slot: string;
  readonly player_key: string;
  /** Raw player name (path-listed on output). */
  readonly name: string;
  readonly points: Dist;
  readonly lock_at: IsoInstant | null;
}

/** Option value of holding a decision open (Thursday/Monday/late game; research 05 §3.4). */
export interface OptionValue {
  readonly kind: "thursday" | "monday" | "late_game";
  readonly value: number;
  readonly verdict: string;
}

/** One recommended swap (plan 07 E2 `swaps[]`). */
export interface Swap {
  readonly out: string;
  readonly in: string;
  readonly slot: string;
  /** Change in expected points. */
  readonly delta_e: number;
  readonly delta_pwin: DeltaPwin;
  readonly interval: readonly [number, number];
  /** Too close to call (widened in `position_cv` mode: |ΔP(win)| < 0.04 or interval spans 0). */
  readonly coin_flip: boolean;
  readonly option_value: OptionValue | null;
}

/** A conditional instruction ("if X is inactive by T, start Y"). */
export interface LineupConditional {
  readonly if: {
    readonly player_key: string;
    readonly event: "inactive";
    readonly decided_by: IsoInstant;
  };
  readonly then: { readonly slot: string; readonly in: string };
}

/** A correlation flag between rostered players (research 05 §3.3). */
export interface StackFlag {
  readonly players: readonly string[];
  readonly effect: "ceiling+" | "floor-";
}

/** The inputs behind the protect/chase mode. */
export interface ModeBasis {
  readonly mu_m: number;
  readonly mu_o: number;
  readonly sigma_m: number;
  readonly sigma_o: number;
  readonly rho_lineup: number;
}

/** `ff_analyze_lineup` data (plan 07 E2). */
export interface LineupRecommendation {
  readonly objective_used: Objective;
  readonly dist_basis: DistBasis;
  readonly current_lineup: readonly LineupSlotAssignment[];
  readonly recommended_lineup: readonly LineupSlotAssignment[];
  readonly mode: MatchupMode;
  readonly mode_basis: ModeBasis;
  readonly p_win_before: number | null;
  readonly p_win_after: number | null;
  readonly p_win_interval: readonly [number, number] | null;
  readonly swaps: readonly Swap[];
  readonly conditionals: readonly LineupConditional[];
  readonly stack_flags: readonly StackFlag[];
  readonly lock_schedule: readonly LockScheduleEntry[];
  readonly latest_execution_time: IsoInstant | null;
  readonly no_move: boolean;
  readonly rec: Rec;
}

// --- matchup win probability (plan 07 E3, `pre` mode at P0) -----------------------------------------

/** Win-probability method (research 05 §11.1). */
export type WinProbMethod = "normal" | "mc";

/** Live state (E3 `live`, P1); null in `pre`. */
export interface MatchupLive {
  readonly players_final: readonly string[];
  readonly players_live: readonly {
    readonly player_key: string;
    readonly points_so_far: number;
    readonly fraction_remaining: number;
  }[];
  readonly players_pending: readonly string[];
  readonly points_so_far: { readonly me: number; readonly opp: number };
}

/** Season simulation (E3 `season`, P1); null in `pre`. */
export interface MatchupSeason {
  readonly p_playoffs: number;
  readonly p_bye: number | null;
  readonly p_alive_by_week: readonly { readonly week: Week; readonly p: number }[];
  readonly seed_distribution: readonly number[];
  readonly tiebreak_note: string;
}

/** `ff_analyze_matchup` data (plan 07 E3). */
export interface MatchupWinProb {
  readonly p_win: number;
  readonly interval: readonly [number, number];
  readonly mu_m: number;
  readonly sigma_m: number;
  readonly mu_o: number;
  readonly sigma_o: number;
  readonly cov: number;
  readonly method: WinProbMethod;
  readonly live: MatchupLive | null;
  /** The platform's own numbers (Yahoo in Phase 1b), a cross-check only; null under the manual league. */
  readonly yahoo_cross_check: {
    readonly win_probability: number | null;
    readonly team_projected_points: { readonly me: number | null; readonly opp: number | null };
  } | null;
  readonly actionable_slots: readonly {
    readonly slot: string;
    readonly lock_at: IsoInstant | null;
  }[];
  readonly season: MatchupSeason | null;
  readonly rec: Rec;
}

// --- waivers / K-DEF streaming (plan 07 E5; P0 = K and DEF only) ---------------------------------------

/**
 * A candidate's availability (plan 07 E5, round 2): `FA`/`W`/`T` from a platform FA pool;
 * `unknown` under ManualLeagueProvider, which has none (plan 01 §8 X1).
 */
export type Availability = "FA" | "W" | "T" | "unknown";

/** Detection signals, ranked by lead time (research 05 §4.1). */
export type SignalKind =
  | "injury_cascade"
  | "snap_jump"
  | "target_share_jump"
  | "xfp_gap"
  | "rz_shift"
  | "depth_chart"
  | "implied_total"
  | "stream";

/** One detection signal with numeric evidence (text evidence is wrapped by the tool). */
export interface WaiverSignal {
  readonly kind: SignalKind;
  readonly value: number;
  /** A number, or raw third-party text the tool wraps. */
  readonly evidence: number | string;
}

/** K/DEF streaming detail (research 05 §8). */
export interface KdefDetail {
  readonly implied_total: number | null;
  readonly opp_implied_total: number | null;
  /** Expected points from bracket families (points/yards allowed, FG distance). */
  readonly brackets_e: number | null;
  readonly sacks_e: number | null;
  readonly takeaways_e: number | null;
  /** Rare-event component (defensive/return TDs, safeties). */
  readonly rare_c: number | null;
  readonly next_week: {
    readonly opponent: string | null;
    readonly implied_total: number | null;
    readonly e: number | null;
  } | null;
}

/** FAAB bid model (P1). */
export interface BidModel {
  readonly b_star: number;
  readonly p_win_curve: readonly { readonly bid: number; readonly p_win: number }[];
  readonly lambda: number;
  readonly dollars_per_point: { readonly value: number; readonly n: number };
}

/** Competition for a candidate (P1; null under the manual league). */
export interface Competition {
  readonly rivals_upgraded: readonly string[];
  readonly expected_bids: Dist | null;
  readonly percent_owned_delta: number | null;
  /** Always true: `percent_owned_delta` is a competition signal, never a detection signal. */
  readonly competition_signal: true;
}

/** The suggested drop for a claim (P1; null under the manual league). */
export interface DropSuggestion {
  readonly player_key: string;
  /** Raw name (path-listed). */
  readonly name: string;
  readonly value_ros: Dist;
  readonly re_add_risk: {
    readonly percent_owned: number | null;
    readonly rivals_claiming: number | null;
  };
}

/** One waiver/streaming candidate (plan 07 E5 `candidates[]`). */
export interface StreamingCandidate {
  /** Platform key; null for an nflverse-universe candidate with no platform id (manual league). */
  readonly player_key: string | null;
  readonly gsis_id: string | null;
  /** NFL team — the identity of a team defence. */
  readonly nfl_team: string | null;
  /** Raw name (path-listed). */
  readonly name: string;
  readonly position: string;
  readonly availability: Availability;
  readonly signals: readonly WaiverSignal[];
  readonly weeks_of_value: number | null;
  readonly p_role_holds: readonly { readonly week: Week; readonly p: number }[];
  readonly marginal_value: Dist;
  readonly xfp_gap: number | null;
  readonly competition: Competition | null;
  readonly bid: BidModel | null;
  readonly claim_or_wait: {
    readonly verdict: "claim" | "wait";
    readonly option_value: number;
  } | null;
  readonly drop: DropSuggestion | null;
  readonly invalidators: readonly string[];
  readonly kdef: KdefDetail | null;
}

/** `ff_analyze_waivers` data (plan 07 E5). */
export interface WaiverAnalysis {
  readonly candidates: readonly StreamingCandidate[];
  readonly hold_vs_stream: {
    readonly streamability: number;
    readonly current_starter_delta: number;
  } | null;
  readonly waiver_clearing_time: IsoInstant | null;
  readonly rec: Rec;
}

// --- wire-free dataset rows the engines read (plan 01 §5.2) ---------------------------------------------

/** Betting lines for one game (nflverse `schedules`; sign: positive spread = home favoured). */
export interface GameLines {
  readonly spread_line: number | null;
  readonly total_line: number | null;
  readonly implied: { readonly away: number | null; readonly home: number | null };
  readonly moneyline: { readonly away: number | null; readonly home: number | null };
  readonly as_of: IsoInstant;
}

/** One scheduled NFL game. */
export interface NflGame {
  readonly game_id: string;
  readonly season: number;
  readonly week: Week;
  readonly kickoff: IsoInstant | null;
  readonly away: string;
  readonly home: string;
  /** `outdoors` | `dome` | `closed` | `open` or a source string. */
  readonly roof: string | null;
  readonly surface: string | null;
  readonly divisional: boolean | null;
  readonly rest_days: { readonly away: number | null; readonly home: number | null };
  readonly lines: GameLines | null;
  readonly is_final: boolean;
  readonly score: { readonly away: number; readonly home: number } | null;
}

/** One practice-report day. */
export interface PracticeDay {
  readonly day: string;
  readonly status: string;
}

/** One official injury-report row (nflverse `injuries`). Text fields are raw (wrapped on output). */
export interface InjuryReport {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: Week;
  readonly nfl_team: string;
  readonly report_status: string | null;
  readonly practice: readonly PracticeDay[];
  readonly primary_injury: string | null;
  readonly secondary_injury: string | null;
  readonly as_of: IsoInstant;
}

/** Game-venue weather for one game (Open-Meteo / NWS). */
export interface WeatherObservation {
  readonly game_id: string;
  readonly temp_f: number | null;
  readonly wind_mph: number | null;
  readonly gust_mph: number | null;
  readonly precip_prob: number | null;
  readonly as_of: IsoInstant;
  /** `weather:open_meteo` | `weather:nws`. */
  readonly source: string;
}

/** One player-week of nflverse stats, already translated to a canonical `StatLine`. */
export interface PlayerWeekLine {
  readonly gsis_id: string;
  readonly season: number;
  readonly week: Week;
  readonly nfl_team: string;
  readonly opponent: string | null;
  /** nflverse position (`QB`, `RB`, `WR`, `TE`, `K`). */
  readonly position: string;
  readonly line: StatLine;
}

/** One team-defence week (the DT stat line of a team). */
export interface TeamDefenseWeekLine {
  readonly nfl_team: string;
  readonly season: number;
  readonly week: Week;
  readonly opponent: string | null;
  readonly line: StatLine;
}

/** How a dataset read reports its provenance (feeds `InputFreshness` and `meta`). */
export interface DatasetStamp {
  /** Dataset source id. */
  readonly source: string;
  /** Release `updated_at` / `timestamp.txt` of the attached file version. */
  readonly as_of: IsoInstant;
  /** When `ff refresh` last fetched it. */
  readonly fetched_at: IsoInstant;
  /** The attached file version. */
  readonly file_version: string;
}

/** Rows plus the stamp of the dataset they came from; `stamp` is null when the dataset was never loaded. */
export interface DatasetResult<T> {
  readonly rows: readonly T[];
  readonly stamp: DatasetStamp | null;
}

/** Read-only port over `nflverse:schedules` (implemented by the store over the attached file). */
export interface ScheduleReader {
  games(season: number, weeks: readonly Week[]): DatasetResult<NflGame>;
  /** The first kickoff of a week (for provisional status and lock order), or null. */
  firstKickoff(season: number, week: Week): IsoInstant | null;
}

/** Read-only port over `nflverse:injuries`. */
export interface InjuryReader {
  reports(
    season: number,
    week: Week,
    gsisIds: readonly string[] | null,
  ): DatasetResult<InjuryReport>;
}

/** Read-only port over `nflverse:stats_player_week` (+ team defence lines). */
export interface PlayerWeekReader {
  lines(
    gsisIds: readonly string[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<PlayerWeekLine>;
  defenseLines(
    teams: readonly string[],
    season: number,
    weeks: readonly Week[],
  ): DatasetResult<TeamDefenseWeekLine>;
}

/** Read-only port over the weather datasets. */
export interface WeatherReader {
  forGames(gameIds: readonly string[]): DatasetResult<WeatherObservation>;
}

/** Every dataset port the P0 analytics need, bundled for injection. */
export interface DatasetReaders {
  readonly schedules: ScheduleReader;
  readonly injuries: InjuryReader;
  readonly playerWeeks: PlayerWeekReader;
  readonly weather: WeatherReader;
}

/** Stores and reads format-agnostic projections (plan 08 §5; table `projection`). */
export interface ProjectionRepository {
  /** Best-effort write (a cache): returns false when the store was busy. */
  put(p: StoredProjection): boolean;
  get(
    gsisId: string,
    season: number,
    week: Week,
    modelVersion: ModelVersion,
  ): StoredProjection | null;
}
