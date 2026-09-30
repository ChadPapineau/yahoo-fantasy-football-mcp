// types.ts — the recommendation log and retrospective contract (plan 07 E12 record input/output,
// E13 retrospective incl. `n_by_metric` and the "n too small (k of 30)" strings, E14 list items;
// plan 01 §8.2 `recommendation_log`, never pruned; plan 10 §2.1 n-per-metric; OBJ-05: NO
// `parameter_changes_proposed` in v1; OBJ-15: every free-text field here is model-authored and
// untrusted on read — tools path-list it with source `store.recommendation_log`).
import type { Rec } from "../analytics/types.js";
import type { IsoInstant, PageOf, Week } from "../league/types.js";
import type { Dist } from "../scoring/types.js";

/** The provenance tag every read-back free-text field carries in `meta.untrusted_fields[]`. */
export const RECLOG_UNTRUSTED_SOURCE = "store.recommendation_log";

/** Recommendation kinds (plan 07 E12 `kind`). */
export const RECOMMENDATION_KINDS = [
  "lineup",
  "waiver",
  "stream",
  "trade",
  "cascade",
  "schedule",
  "roster",
  "evidence",
  "matchup",
  "onboarding",
  "retro",
  "executed",
  "weekly",
] as const;
/** A recommendation kind. */
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

/** What the user said about following the call, when the model knows (plan 07 E12). */
export type FollowedHint = "unknown" | "user_said_yes" | "user_said_no";

/** An alternative the model offered alongside the recommendation. */
export interface Alternative {
  /** Model-authored text (untrusted on read). */
  readonly action: string;
  readonly point_estimate: number;
  readonly distribution: Dist;
  readonly decision_metric_value: number;
}

/** A tool call the recommendation was derived from. */
export interface SourceCall {
  readonly tool: string;
  readonly request_id: string;
}

/** The validated `ff_record_recommendation` input (plan 07 E12). */
export interface RecordRecommendationInput {
  readonly league_key: string;
  readonly kind: RecommendationKind;
  readonly week: Week;
  readonly rec: Rec;
  readonly alternatives: readonly Alternative[];
  readonly source_calls: readonly SourceCall[];
  readonly followed_hint: FollowedHint;
  /** Deduplication key (≤ 64 chars): a second record with the same key returns the first. */
  readonly client_ref: string | null;
  /** Model-authored note, ≤ 200 chars (untrusted on read). */
  readonly note: string | null;
}

/** One stored log row (plan 01 §8.2; never pruned). */
export interface RecommendationRecord extends RecordRecommendationInput {
  /** Server-minted id, e.g. `rec-<ulid>`. */
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
  /** The settings the call was made under (links the never-pruned `league_settings` row). */
  readonly settings_hash: string | null;
}

/** `ff_record_recommendation` output (plan 07 E12). */
export interface RecordResult {
  readonly log_id: string;
  readonly recorded_at: IsoInstant;
  readonly week: Week;
  readonly kind: RecommendationKind;
  /** True when `client_ref` matched an existing row (idempotent). */
  readonly deduplicated: boolean;
}

/** One `ff_list_recommendations` item (plan 07 E14). */
export interface RecommendationListItem {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly week: Week;
  readonly recorded_at: IsoInstant;
  /** Model-authored summary (untrusted on read). */
  readonly action_summary: string;
  readonly followed: boolean | null;
}

// --- retrospective metrics (plan 07 E13; research 05 §12) --------------------------------------------

/** The sample size below which a metric is reported as "n too small" (research 05 §12.6). */
export const DEFAULT_MIN_N = 30;

/** The literal a metric under its minimum n reports instead of a value: `n too small (k of 30)`. */
export type NTooSmall = `n too small (${number} of ${number})`;

/** Builds the "n too small (k of min)" string (plan 07 E13, plan 10 A9). */
export function nTooSmall(k: number, minN: number = DEFAULT_MIN_N): NTooSmall {
  const kk = Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  const mm = Number.isFinite(minN) && minN > 0 ? Math.floor(minN) : DEFAULT_MIN_N;
  return `n too small (${String(kk)} of ${String(mm)})` as NTooSmall;
}

/** Brier score components (Murphy decomposition: reliability − resolution + uncertainty). */
export interface BrierDecomposition {
  readonly reliability: number;
  readonly resolution: number;
  readonly uncertainty: number;
}

/** A Brier score with its n (and decomposition when computed). */
export interface BrierValue {
  readonly value: number;
  readonly n: number;
  readonly decomposition: BrierDecomposition | null;
}

/** A Brier metric: the value when n reached, else the "n too small" string. */
export type BrierMetric = BrierValue | NTooSmall;

/** Per-player projection error metrics — the ones that reach n within weeks (plan 10 §2.1). */
export interface PerPlayerMetrics {
  readonly crps: number | null;
  readonly pinball: {
    readonly p10: number | null;
    readonly p50: number | null;
    readonly p90: number | null;
  };
  /** Share of outcomes inside the 80 % interval. */
  readonly coverage_80: number | null;
  /** Within-position Spearman correlation of projection vs outcome. */
  readonly spearman_by_position: Readonly<Record<string, number | null>>;
  readonly n_player_weeks: number;
}

/** Swap regret over logged lineup calls. */
export interface SwapRegret {
  readonly total: number;
  readonly per_call_mean: number | null;
  readonly n_swaps: number;
}

/** The v1 metrics block (plan 07 E13 `metrics`). */
export interface RetrospectiveMetrics {
  readonly per_player: PerPlayerMetrics;
  readonly swap_regret: SwapRegret;
  readonly brier: {
    readonly p_active: BrierMetric;
    readonly p_win: BrierMetric;
    readonly p_win_given_bid: BrierMetric;
    readonly p_role_holds: BrierMetric;
  };
  readonly accuracy_gap: number | null;
}

/** Names of the metrics `n_by_metric[]` reports. */
export type MetricName =
  | "per_player"
  | "swap_regret"
  | "brier.p_active"
  | "brier.p_win"
  | "brier.p_win_given_bid"
  | "brier.p_role_holds";

/** One `n_by_metric[]` row: whether a metric has reached its minimum n (plan 10 §2.1 shape). */
export interface NByMetric {
  readonly metric: MetricName;
  readonly n: number;
  readonly min_n: number;
  readonly reached: boolean;
}

/** One scored call (plan 07 E13 `calls[]`). */
export interface RetrospectiveCall {
  readonly log_id: string;
  readonly kind: RecommendationKind;
  readonly followed: boolean | null;
  readonly regret: number | null;
  readonly decisive: boolean | null;
  /** Model-authored (path-listed, source `store.recommendation_log`). */
  readonly recommended: string;
  /** Model-authored (path-listed, source `store.recommendation_log`). */
  readonly best_alternative: string | null;
  readonly realised: number | null;
}

/** Outcome attribution (populated in Phase 3 — plan 10 C8; null in v1). */
export interface OutcomeAttribution {
  readonly opportunity: number;
  readonly efficiency: number;
  readonly td: number;
  readonly matchup_weather: number;
  readonly availability: number;
}

/**
 * `ff_analyze_retrospective` data (plan 07 E13). Deliberately has NO `parameter_changes_proposed`
 * (round 1 OBJ-05: it enters in Phase 3 with held-out seasons; a type test pins its absence).
 */
export interface Retrospective {
  readonly week: Week;
  readonly final: boolean;
  readonly calls: readonly RetrospectiveCall[];
  readonly metrics: RetrospectiveMetrics;
  readonly n_by_metric: readonly NByMetric[];
  readonly attribution: OutcomeAttribution | null;
  /** One line per metric under `min_n`, naming it. */
  readonly sample_size_caveats: readonly string[];
  readonly rec: Rec;
}

// --- the repository port (implemented by src/store; required writes may throw StoreBusyError) --------

/** A list query over the log. */
export interface RecommendationQuery {
  readonly league_key: string;
  readonly week: Week | null;
  readonly kind: RecommendationKind | null;
  readonly limit: number;
  readonly offset: number;
}

/** The recommendation-log repository (a REQUIRED-write family: ≤ 1 s of retries, then STORE_BUSY). */
export interface RecommendationLogRepository {
  /** Inserts (or returns the existing row for the same league + `client_ref`). */
  record(
    input: RecordRecommendationInput,
    recordedAt: IsoInstant,
    settingsHash: string | null,
  ): RecordResult;
  get(logId: string): RecommendationRecord | null;
  list(q: RecommendationQuery): PageOf<RecommendationListItem>;
  forWeek(leagueKey: string, week: Week): readonly RecommendationRecord[];
}
