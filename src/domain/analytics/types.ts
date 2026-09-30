// types.ts — the analytics contract (plan 07 legend `Dist`/`Rec`, §2 `data.inputs[]` on EVERY
// analytics result; E1 `{ model_version, projections[], inputs[] }`; E2 lineup incl. `objective`,
// `delta_pwin` as {sign, band} whenever `dist_basis = position_cv` — enforced by a discriminated
// union, C11 / plan 10 A7(e) — and `coin_flip`; E3 `pre` win probability; E5 K/DEF streaming
// candidates), the structured Rec subject the retrospective scores (plan 10 A9; critic C-01b), the
// wire-free dataset rows the engines read (schedules/lines incl. venue, injuries, weather, weekly
// stat lines — plan 01 §5.2), the read-only dataset ports with release-check stamps (plan 01 §5.4/
// §5.5), and the projection + ops-status ports the store implements (critics C-03b, C-10b).
import type { NflTeam } from "../../config/schema.js";
import type { DatasetSourceId, Freshness, FreshnessClassId } from "../../config/freshness.js";
import type { IsoInstant, LockScheduleEntry, PlayerKey, Week } from "../league/types.js";
import type {
  Canonical,
  Dist,
  DistBasis,
  ProjectionSubject,
  StatLine,
  StoredProjection,
} from "../scoring/types.js";

export type { Dist, DistBasis, ProjectionSubject } from "../scoring/types.js";

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

/** What a subject's role in a recommendation is. */
export type SubjectRole = "start" | "sit" | "add" | "drop" | "stream" | "trade_in" | "trade_out";

/**
 * A structured, server-authored subject of a recommendation (critic C-01b; plan 10 A9): which
 * player/defence the call is about and in what role. The retrospective computes regret, swap regret,
 * `followed` and `realised` from these fields ONLY — never by parsing the free-text `action`, which
 * is model-authored and untrusted on read (OBJ-15). At least one of the three ids is non-null.
 */
export interface RecSubject {
  readonly player_key: PlayerKey | null;
  readonly gsis_id: string | null;
  /** The identity of a team defence. */
  readonly nfl_team: NflTeam | null;
  readonly role: SubjectRole;
  /** The slot, for lineup roles (`WR`, `W/R/T`); null otherwise. */
  readonly slot: string | null;
}

/** One slot of a recommended lineup (lineup recs only). */
export interface RecLineupSlot {
  readonly slot: string;
  readonly player_key: PlayerKey;
}

/** The recommendation every analytics tool carries as `data.rec` (plan 07 legend `Rec`). */
export interface Rec {
  /** The recommended action, in words (model-visible; logged later as untrusted). */
  readonly action: string;
  /** Structured subjects — what the retrospective joins on (never `action`). */
  readonly subjects: readonly RecSubject[];
  /** The full recommended lineup for lineup recs; null for every other kind. */
  readonly lineup: readonly RecLineupSlot[] | null;
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
  readonly player_key: PlayerKey | null;
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

/** `ff_project_players` data (plan 07 E1): `{ model_version, projections[], inputs[] }`. */
export interface ProjectionResult {
  readonly model_version: ModelVersion;
  readonly projections: readonly Projection[];
  /** Every contributing dataset with its age and freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
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

/**
 * The `coin_flip` threshold on |ΔP(win)| per basis (plan 07 E2/C11: widened to 0.04 in `position_cv`
 * mode; research 05 §3.2: 0.02 otherwise). A swap is also a coin flip when its interval spans 0.
 */
export const COIN_FLIP_DPWIN: Readonly<Record<DistBasis, number>> = Object.freeze({
  position_cv: 0.04,
  player_sim: 0.02,
});

/**
 * Band cutoffs for the coarse ΔP(win) (the plan names the bands but not the cutoffs — decision
 * recorded): |Δ| < 0.04 `small` (the position_cv coin-flip width: indistinguishable under v1
 * widths), < 0.10 `medium`, else `large`; sign `0` when |Δ| < 0.005.
 */
export const COARSE_BAND_CUTOFFS = Object.freeze({ zero: 0.005, small: 0.04, medium: 0.1 });

/** The coarse form of a ΔP(win) (never a two-decimal number — plan 10 A7(e)). NaN reads `0`/small. */
export function toCoarseDelta(delta: number): CoarseDelta {
  const a = Number.isFinite(delta) ? Math.abs(delta) : 0;
  const sign = a < COARSE_BAND_CUTOFFS.zero ? "0" : delta > 0 ? "+" : "-";
  const band =
    a < COARSE_BAND_CUTOFFS.small ? "small" : a < COARSE_BAND_CUTOFFS.medium ? "medium" : "large";
  return { sign, band };
}

/** Whether a swap is a coin flip under `basis` (|ΔP(win)| under the threshold, or interval spans 0). */
export function isCoinFlip(
  basis: DistBasis,
  deltaPwin: number,
  interval: readonly [number, number],
): boolean {
  if (!Number.isFinite(deltaPwin)) return true;
  return Math.abs(deltaPwin) < COIN_FLIP_DPWIN[basis] || (interval[0] <= 0 && interval[1] >= 0);
}

/** One slot assignment in a lineup. */
export interface LineupSlotAssignment {
  readonly slot: string;
  readonly player_key: PlayerKey;
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

/** One recommended swap (plan 07 E2 `swaps[]`); `D` is the ΔP(win) form its basis allows. */
export interface SwapOf<D extends DeltaPwin> {
  /** Player key leaving the slot. */
  readonly out: PlayerKey;
  /** Player key entering the slot. */
  readonly in: PlayerKey;
  readonly slot: string;
  /** Change in expected points. */
  readonly delta_e: number;
  readonly delta_pwin: D;
  readonly interval: readonly [number, number];
  /** Too close to call (widened in `position_cv` mode: |ΔP(win)| < 0.04 or interval spans 0). */
  readonly coin_flip: boolean;
  readonly option_value: OptionValue | null;
}

/** A swap of either basis. */
export type Swap = SwapOf<DeltaPwin>;

/** A conditional instruction ("if X is inactive by T, start Y"). */
export interface LineupConditional {
  readonly if: {
    readonly player_key: PlayerKey;
    readonly event: "inactive";
    readonly decided_by: IsoInstant;
  };
  readonly then: { readonly slot: string; readonly in: PlayerKey };
}

/** A correlation flag between rostered players (research 05 §3.3). */
export interface StackFlag {
  readonly players: readonly PlayerKey[];
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

/** The fields of `ff_analyze_lineup` data common to both bases. */
interface LineupRecommendationBase {
  readonly objective_used: Objective;
  readonly current_lineup: readonly LineupSlotAssignment[];
  readonly recommended_lineup: readonly LineupSlotAssignment[];
  readonly mode: MatchupMode;
  readonly mode_basis: ModeBasis;
  readonly p_win_before: number | null;
  readonly p_win_after: number | null;
  readonly p_win_interval: readonly [number, number] | null;
  readonly conditionals: readonly LineupConditional[];
  readonly stack_flags: readonly StackFlag[];
  readonly lock_schedule: readonly LockScheduleEntry[];
  readonly latest_execution_time: IsoInstant | null;
  readonly no_move: boolean;
  readonly rec: Rec;
  /** Every contributing input with its age and freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
}

/**
 * `ff_analyze_lineup` data (plan 07 E2), discriminated on `dist_basis` so a two-decimal ΔP(win)
 * cannot type-check under `position_cv` (plan 10 A7(e); critic C-07).
 */
export type LineupRecommendation =
  | (LineupRecommendationBase & {
      readonly dist_basis: "position_cv";
      readonly swaps: readonly SwapOf<CoarseDelta>[];
    })
  | (LineupRecommendationBase & {
      readonly dist_basis: "player_sim";
      readonly swaps: readonly SwapOf<number>[];
    });

// --- matchup win probability (plan 07 E3, `pre` mode at P0) -----------------------------------------

/** Win-probability method (research 05 §11.1). */
export type WinProbMethod = "normal" | "mc";

/** Live state (E3 `live`, P1); null in `pre`. */
export interface MatchupLive {
  readonly players_final: readonly PlayerKey[];
  readonly players_live: readonly {
    readonly player_key: PlayerKey;
    readonly points_so_far: number;
    readonly fraction_remaining: number;
  }[];
  readonly players_pending: readonly PlayerKey[];
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
  /** Every contributing input with its age and freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
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
  readonly player_key: PlayerKey;
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
  /**
   * Always a key: the platform's, or — for an nflverse-universe candidate under the manual league —
   * `manualPlayerKeyFor(subject)`, so the E5 `candidates` filter and E13 `followed` joins agree.
   */
  readonly player_key: PlayerKey;
  /** Who the candidate is (a player's gsis id or a team defence). */
  readonly subject: ProjectionSubject;
  readonly gsis_id: string | null;
  /** NFL team — the identity of a team defence. */
  readonly nfl_team: NflTeam | null;
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
  /** Every contributing input with its age and freshness (plan 07 §2). */
  readonly inputs: readonly InputFreshness[];
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

/**
 * One venue row of the read-only stadium table the schedules source owns (plan 01 §5.2 weather row;
 * research 04 §B7: stadium lat/lon from our own table; critic C-16). `tz` is an IANA zone.
 */
export interface VenueInfo {
  readonly stadium_id: string;
  readonly tz: string;
  readonly lat: number;
  readonly lon: number;
  /** The roof when schedules does not say: `outdoors` | `dome` | `closed` | `open`. */
  readonly roof_default: string;
}

/** One scheduled NFL game. */
export interface NflGame {
  readonly game_id: string;
  readonly season: number;
  readonly week: Week;
  readonly kickoff: IsoInstant | null;
  readonly away: NflTeam;
  readonly home: NflTeam;
  /** Venue id (joins the stadium table); null when the source omits it. */
  readonly stadium_id: string | null;
  /** Raw stadium name (third-party; wrapped as `dataset_text` on output). */
  readonly stadium: string | null;
  /** IANA zone of the venue (D3 `kickoff_local`); null when unknown. */
  readonly venue_tz: string | null;
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
  readonly nfl_team: NflTeam;
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
  readonly nfl_team: NflTeam;
  readonly opponent: NflTeam | null;
  /** nflverse position (`QB`, `RB`, `WR`, `TE`, `K`). */
  readonly position: string;
  readonly line: StatLine;
}

/** One team-defence week (the DT stat line of a team). */
export interface TeamDefenseWeekLine {
  readonly nfl_team: NflTeam;
  readonly season: number;
  readonly week: Week;
  readonly opponent: NflTeam | null;
  readonly line: StatLine;
}

/**
 * How a dataset read reports its provenance (feeds `InputFreshness` and `meta`). State is judged by
 * `stampState` (src/config/freshness.ts) from the class's basis: for release-basis classes that is
 * `checked_at` (the last successful release check), NOT `fetched_at` — an unchanged release checked
 * an hour ago is fresh (critics C-12, C-08b).
 */
export interface DatasetStamp {
  /** Dataset source id. */
  readonly source: DatasetSourceId;
  /** Release `updated_at` / `timestamp.txt` of the attached file version. */
  readonly as_of: IsoInstant;
  /** When `ff refresh` last downloaded it. */
  readonly fetched_at: IsoInstant;
  /** Last successful release check, even when unchanged (refresh_log `checked_at`). */
  readonly checked_at: IsoInstant;
  /** The freshness class its rows are judged by. */
  readonly freshness_class: FreshnessClassId;
  /** The attached file version. */
  readonly file_version: string;
}

/**
 * Rows plus the stamp of the dataset they came from. `stamp` is null exactly when the dataset was
 * never loaded (no file attached) — the tool answers STALE_ONLY with the fixed "run `ff refresh
 * nflverse`" hint (DATASET_NEVER_LOADED_HINT), never an empty success.
 */
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
    teams: readonly NflTeam[],
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

/** A best-effort (cache) write's outcome: a lock timeout is a counted miss, never an error. */
export type BestEffortOutcome =
  { readonly written: true } | { readonly written: false; readonly reason: "busy" };

/**
 * Stores and reads format-agnostic projections (plan 08 §5; table `projection`, never pruned —
 * plan 10 T12). Append-only per (subject, season, week, model_version, made_at). Writes stay
 * best-effort (a busy lock during `ff refresh` must not fail E1/E2), so the retrospective's
 * per-player n counts only persisted rows — `n_player_weeks` says so (decision recorded).
 */
export interface ProjectionRepository {
  /** Best-effort append. */
  put(p: StoredProjection): BestEffortOutcome;
  /** The newest projection for the subject-week. */
  latest(
    subject: ProjectionSubject,
    season: number,
    week: Week,
    modelVersion: ModelVersion,
  ): StoredProjection | null;
  /**
   * The newest projection made strictly before `before` (the subject's lock / kickoff) — the only
   * read the retrospective may score, so no outcome leaks into CRPS/pinball/coverage.
   */
  getAsOf(
    subject: ProjectionSubject,
    season: number,
    week: Week,
    modelVersion: ModelVersion,
    before: IsoInstant,
  ): StoredProjection | null;
}

// --- dataset + ops status ports (moved from src/store for src/mcp G1/`ff status`; critic C-10b) ------

/** One refresh_log row (plan 01 §5.5). */
export interface RefreshLogRow {
  readonly source: DatasetSourceId;
  readonly file: string | null;
  readonly file_version: string | null;
  readonly release_updated_at: IsoInstant | null;
  /** The seasons the published file holds (critic C-06b). */
  readonly seasons: readonly number[];
  readonly rows: number | null;
  readonly columns_hash: string | null;
  readonly started_at: IsoInstant;
  readonly finished_at: IsoInstant;
  readonly ok: boolean;
  /** Fixed-vocabulary error summary (never an upstream body). */
  readonly error: string | null;
  /** Last time the release version was checked successfully, even when unchanged (the "release" age basis). */
  readonly checked_at: IsoInstant;
}

/** refresh_log (required; written by the refresh process's DatasetPublisher). */
export interface RefreshLogRepository {
  record(row: RefreshLogRow): Promise<void>;
  /** The newest successful row per source (what is attached / should be attached). */
  current(): readonly RefreshLogRow[];
  latest(source: DatasetSourceId): RefreshLogRow | null;
  /** Consecutive failures since the last success. */
  consecutiveFailures(source: DatasetSourceId): number;
}

/** One dataset file currently ATTACHed read-only on the server connection. */
export interface AttachedDataset {
  readonly source: DatasetSourceId;
  /** SQLite schema name (`ds_nflverse__stats_player_week`). */
  readonly schema: string;
  readonly file: string;
  readonly file_version: string;
  /** Identity of the attached inode, for the cheap `stat` change check. */
  readonly inode: number;
  readonly mtime_ms: number;
  readonly size_bytes: number;
  readonly attached_at: IsoInstant;
}

/** Store health for `ff status` / `ff_get_status` (plan 01 §7). */
export interface StoreStats {
  readonly path: string;
  readonly size_bytes: number;
  readonly schema_version: number;
  /** Best-effort writes skipped because the lock was busy, since open. */
  readonly cache_misses_busy: number;
  readonly attached: readonly AttachedDataset[];
}

/** Write-journal states (plan 02 §4.5). Phase W — the table exists from migration 001. */
export type JournalStatus =
  | "prepared"
  | "denied"
  | "expired"
  | "voided_precondition"
  | "sent"
  | "applied"
  | "rejected_validation"
  | "rejected_not_provisioned"
  | "sent_unknown"
  | "confirmed_applied"
  | "confirmed_not_applied";

/** write_journal (read-only use in this build: counts for `ff status` / G1 `journal`). */
export interface WriteJournalRepository {
  countByStatus(): Readonly<Partial<Record<JournalStatus, number>>>;
  oldestPendingAgeSeconds(now: IsoInstant): number | null;
}
